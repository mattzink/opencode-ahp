/**
 * Changesets section (design §11): turn before/after file capture, changeset recomputation, `resourceRead`, and the `discard-changes` operation.
 */

import { HostBase } from "./host-base.js";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionType, ChangesetOperationScope, ChangesetOperationStatus, ChangesetStatus } from "@microsoft/agent-host-protocol";
import { buildTurnChangesetFiles, buildWorkingChangesetFiles, discardOperation, fileUri, parseContentRef } from "./bridge.js";
import { parseChangesetChannel, sessionChangesetURI, turnChangesetURI, uncommittedChangesetURI } from "./channels.js";
import { ERROR_INVALID_PARAMS } from "./handshake.js";
import { isRecord } from "./options.js";
import { ERROR_METHOD_NOT_FOUND, ERROR_INTERNAL, ERROR_SESSION_NOT_FOUND, ERROR_NOT_FOUND, ERROR_PERMISSION_DENIED } from "./host-errors.js";
import { RpcMessage, ChatRuntime, SessionRecord } from "./host-types.js";
import { errorMessage, isPathInside } from "./host-util.js";

/**
 * The file-mutating opencode tools whose inputs carry a target path — the
 * turn-changeset before-capture watches only these (`tool.input.ended`
 * fires before execution, so the pre-edit content is still on disk).
 */
const SNAPSHOT_TOOLS = new Set(["write", "edit", "apply", "patch"]);

/** The tool-input keys that carry a file path (checked in order). */
const SNAPSHOT_PATH_KEYS = ["path", "file_path", "filePath", "file"] as const;

export class HostChangesets extends HostBase {
  /**
   * Capture the pre-edit content of a file-mutating tool's target file for
   * the current turn's changeset (first capture per file wins — the
   * pre-turn content survives later edits in the same turn). No-op when
   * the tool is not file-mutating, the input carries no parseable path,
   * or the path resolves outside the location directory.
   */
  // ── changesets ────────────────────────────────────────────────
  protected async captureTurnBefore(chat: ChatRuntime, toolCallId: string, inputJson: string): Promise<void> {
    const turnId = chat.currentTurnId;
    const toolName = chat.toolName.get(toolCallId);
    if (turnId === null || toolName === undefined || !SNAPSHOT_TOOLS.has(toolName)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(inputJson);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const rawPath = SNAPSHOT_PATH_KEYS.map((k) => parsed[k]).find((v) => typeof v === "string" && (v as string).length > 0);
    if (typeof rawPath !== "string") return;
    const absPath = this.resolveSnapshotPath(rawPath);
    if (absPath === null) {
      this.log(`turn snapshot: ${toolName} target ${rawPath} is outside the location directory; not captured`);
      return;
    }
    let before: string | null;
    try {
      before = await this.opts.facade.readFile(absPath);
    } catch (err) {
      this.log(`turn snapshot: read of ${absPath} failed: ${errorMessage(err)}`);
      return;
    }
    // The pump is sequential, so the turn cannot have ended between the
    // call and the await — but the chat may be gone (session deleted or
    // chat disposed).
    if (chat.currentTurnId !== turnId || !this.byOpencode.has(chat.sessionID)) return;
    const turnFiles = chat.turnSnapshots.get(turnId) ?? new Map();
    if (!turnFiles.has(absPath)) turnFiles.set(absPath, { before, after: null });
    chat.turnSnapshots.set(turnId, turnFiles);
  }

  /** Resolve a tool-input path against the location directory (must stay inside it). */
  private resolveSnapshotPath(rawPath: string): string | null {
    const dir = this.opts.defaultDirectory;
    if (dir === undefined) return null;
    const absPath = resolvePath(dir, rawPath);
    return isPathInside(absPath, dir) ? absPath : null;
  }

  /**
   * Recompute one changeset and publish the delta (gateway's
   * `updateChangesetChannel` pattern): `changeset/contentChanged` when the
   * file list changed (the discard operation is (re)attached while files
   * exist, and cleared when they vanish), then `changeset/statusChanged`
   * to ready when the status was not ready. A failed computation publishes
   * `changeset/statusChanged` with an error.
   */
  protected async refreshChangeset(rec: SessionRecord, uri: string): Promise<void> {
    const parsed = parseChangesetChannel(uri);
    if (parsed === null) return;
    const store = this.changesetStore(rec, uri);
    if (store === null) return; // owner gone (disposed chat)
    let files;
    try {
      if (parsed.kind === "turn") {
        // The turn's snapshots live on the owning chat; the content refs
        // carry its opencode session id (the byOpencode join key).
        const chat = rec.chats.get(parsed.ownerUri);
        if (chat === undefined) return;
        files = buildTurnChangesetFiles({
          sessionID: chat.sessionID,
          turnId: parsed.turnId ?? "",
          files: chat.turnSnapshots.get(parsed.turnId ?? "") ?? new Map(),
          reviewedById: this.reviewedById(store),
        });
      } else {
        const diffs = await this.opts.facade.vcsDiffWorking();
        files = buildWorkingChangesetFiles({ diffs, reviewedById: this.reviewedById(store) });
      }
    } catch (err) {
      this.publish({
        channel: uri,
        action: {
          type: ActionType.ChangesetStatusChanged,
          status: ChangesetStatus.Error,
          error: { errorType: "changeset-computation", message: errorMessage(err) },
        },
      });
      return;
    }
    const state = store.state;
    const hadFiles = state.files.length > 0;
    const hasFiles = files.length > 0;
    if (JSON.stringify(state.files) !== JSON.stringify(files)) {
      this.publish({
        channel: uri,
        action: {
          type: ActionType.ChangesetContentChanged,
          files,
          ...(hasFiles ? { operations: [discardOperation()] } : {}),
        },
      });
      // operations persist across contentChanged — clear them explicitly
      // when the changeset empties out.
      if (!hasFiles && state.operations !== undefined && state.operations.length > 0) {
        this.publish({ channel: uri, action: { type: ActionType.ChangesetOperationsChanged, operations: undefined } });
      }
    }
    if (!hadFiles && hasFiles && state.operations === undefined) {
      // contentChanged above already attached the operation; this branch
      // is unreachable unless the reducer drops it — kept as a guard.
      this.publish({ channel: uri, action: { type: ActionType.ChangesetOperationsChanged, operations: [discardOperation()] } });
    }
    if (state.status !== ChangesetStatus.Ready) {
      this.publish({ channel: uri, action: { type: ActionType.ChangesetStatusChanged, status: ChangesetStatus.Ready } });
    }
  }

  /**
   * At a turn terminal: read the disk into each captured file's `after`
   * (a file deleted during the turn stays null → "deleted"), then refresh
   * the uncommitted, session, and ended-turn changesets — only the ones a
   * client has subscribed (unsubscribed changesets cost no seq).
   */
  protected async refreshTurnChangesets(rec: SessionRecord, chat: ChatRuntime, turnId: string): Promise<void> {
    const turnFiles = chat.turnSnapshots.get(turnId);
    if (turnFiles !== undefined) {
      for (const [absPath, snap] of turnFiles) {
        if (snap.after === null) {
          try {
            snap.after = await this.opts.facade.readFile(absPath);
          } catch {
            snap.after = null;
          }
        }
      }
    }
    // The chat's own uncommitted + turn changesets, plus the session-wide
    // one (shared by all chats). Only the ones a client has subscribed.
    for (const uri of [
      uncommittedChangesetURI(chat.uri),
      sessionChangesetURI(rec.channel),
      turnChangesetURI(chat.uri, turnId),
    ]) {
      if (this.changesetStoreOf(rec, uri) !== undefined) await this.refreshChangeset(rec, uri);
    }
  }

  /**
   * `resourceRead` (AHP root command): serve file content for the URIs
   * this host advertises in changesets —
   *  - `file://` → live disk, confined to the location directory;
   *  - `ahp-content://head/…` → the file's HEAD content;
   *  - `ahp-content://snap/…` → a turn's captured before/after content.
   * Errors: -32008 (not found), -32009 (path outside the location).
   */
  protected async handleResourceRead(socketId: number, msg: RpcMessage): Promise<void> {
    const params = isRecord(msg.params) ? msg.params : {};
    const uri = params["uri"];
    if (typeof uri !== "string" || uri.length === 0) {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "resourceRead requires a content URI");
      return;
    }
    const encoding: "base64" | "utf-8" = params["encoding"] === "utf-8" ? "utf-8" : "base64";
    if (uri.startsWith("file://")) {
      let absPath: string;
      try {
        absPath = fileURLToPath(uri);
      } catch {
        this.sendError(socketId, msg.id, ERROR_NOT_FOUND, `not found: ${uri}`);
        return;
      }
      if (this.opts.defaultDirectory !== undefined && !isPathInside(absPath, this.opts.defaultDirectory)) {
        this.sendError(socketId, msg.id, ERROR_PERMISSION_DENIED, "path is outside the location directory");
        return;
      }
      let content: string | null;
      try {
        content = await this.opts.facade.readFile(absPath);
      } catch (err) {
        this.sendError(socketId, msg.id, ERROR_PERMISSION_DENIED, `read failed: ${errorMessage(err)}`);
        return;
      }
      if (content === null) {
        this.sendError(socketId, msg.id, ERROR_NOT_FOUND, `not found: ${uri}`);
        return;
      }
      this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, result: this.encodeContent(content, encoding) });
      return;
    }
    // Opaque content refs require the changesets capability.
    if (!this.opts.changesets) {
      this.sendError(socketId, msg.id, ERROR_NOT_FOUND, `not found: ${uri}`);
      return;
    }
    const ref = parseContentRef(uri);
    if (ref === null) {
      this.sendError(socketId, msg.id, ERROR_NOT_FOUND, `not found: ${uri}`);
      return;
    }
    if (ref.kind === "head") {
      if (this.opts.defaultDirectory !== undefined && !isPathInside(ref.path, this.opts.defaultDirectory)) {
        this.sendError(socketId, msg.id, ERROR_PERMISSION_DENIED, "path is outside the location directory");
        return;
      }
      let content: string | null;
      try {
        content = await this.opts.facade.gitHeadFile(ref.path);
      } catch (err) {
        this.sendError(socketId, msg.id, ERROR_INTERNAL, `HEAD read failed: ${errorMessage(err)}`);
        return;
      }
      if (content === null) {
        this.sendError(socketId, msg.id, ERROR_NOT_FOUND, `not in HEAD: ${ref.path}`);
        return;
      }
      this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, result: this.encodeContent(content, encoding) });
      return;
    }
    // snap — in-memory turn snapshot of a live chat's opencode session.
    const binding = this.byOpencode.get(ref.sessionID);
    if (binding === undefined) {
      this.sendError(socketId, msg.id, ERROR_NOT_FOUND, "no such session");
      return;
    }
    const snap = binding.chat.turnSnapshots.get(ref.turnId)?.get(ref.path);
    const content = snap === undefined ? null : ref.part === "before" ? snap.before : snap.after;
    if (content === null) {
      this.sendError(socketId, msg.id, ERROR_NOT_FOUND, `not found: ${uri}`);
      return;
    }
    this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, result: this.encodeContent(content, encoding) });
  }

  /** Encode content for a `resourceRead` result (utf-8 or base64). */
  private encodeContent(content: string, encoding: "base64" | "utf-8") {
    return {
      data: encoding === "utf-8" ? content : Buffer.from(content, "utf-8").toString("base64"),
      encoding,
    };
  }

  /**
   * `invokeChangesetOperation`: the host's only operation is
   * `discard-changes` (resource-scoped) — restore one file from the
   * changeset's "before" content. Status flows through the
   * `changeset/operationStatusChanged` stream; the JSON-RPC result carries
   * a human-readable message.
   */
  protected async handleInvokeChangesetOperation(socketId: number, msg: RpcMessage): Promise<void> {
    const params = isRecord(msg.params) ? msg.params : {};
    const channel = params["channel"];
    const operationId = params["operationId"];
    if (typeof channel !== "string" || channel.length === 0 || typeof operationId !== "string" || operationId.length === 0) {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "invokeChangesetOperation requires channel + operationId");
      return;
    }
    const parsed = parseChangesetChannel(channel);
    if (parsed === null) {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, `not a changeset channel: ${channel}`);
      return;
    }
    const rec = this.byChannel.get(parsed.ownerUri);
    if (rec === undefined) {
      this.sendError(socketId, msg.id, ERROR_SESSION_NOT_FOUND, "no such session");
      return;
    }
    const store = this.changesetStoreOf(rec, channel);
    if (store === undefined) {
      this.sendError(socketId, msg.id, ERROR_SESSION_NOT_FOUND, `no such changeset: ${channel}`);
      return;
    }
    const op = store.state.operations?.find((o) => o.id === operationId);
    if (op === undefined) {
      this.sendError(socketId, msg.id, ERROR_METHOD_NOT_FOUND, `unknown operation: ${operationId}`);
      return;
    }
    if (!op.scopes.includes(ChangesetOperationScope.Resource)) {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, `operation ${operationId} is not resource-scoped`);
      return;
    }
    const target = params["target"];
    if (!isRecord(target) || target["kind"] !== "resource" || typeof target["resource"] !== "string") {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "resource-scoped operation requires a resource target");
      return;
    }
    let absPath: string;
    try {
      absPath = fileURLToPath(target["resource"] as string);
    } catch {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "target.resource must be a file URI");
      return;
    }
    if (!store.state.files.some((f) => f.id === fileUri(absPath))) {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, `no such file in changeset: ${target["resource"]}`);
      return;
    }
    if (this.opts.defaultDirectory !== undefined && !isPathInside(absPath, this.opts.defaultDirectory)) {
      this.sendError(socketId, msg.id, ERROR_PERMISSION_DENIED, "path is outside the location directory");
      return;
    }
    this.publish({
      channel,
      action: { type: ActionType.ChangesetOperationStatusChanged, operationId, status: ChangesetOperationStatus.Running },
    });
    try {
      if (parsed.kind === "turn" && parsed.turnId !== undefined) {
        // A live turn-changeset store implies a live owning chat
        // (changesetStoreOf resolved it above).
        await this.restoreTurnFile(rec.chats.get(parsed.ownerUri)!, parsed.turnId, absPath);
      } else {
        await this.opts.facade.discardFile(absPath);
      }
    } catch (err) {
      this.publish({
        channel,
        action: {
          type: ActionType.ChangesetOperationStatusChanged,
          operationId,
          status: ChangesetOperationStatus.Error,
          error: { errorType: "operation-failed", message: errorMessage(err) },
        },
      });
      this.sendError(socketId, msg.id, ERROR_INTERNAL, errorMessage(err));
      return;
    }
    await this.refreshChangeset(rec, channel);
    this.publish({
      channel,
      action: { type: ActionType.ChangesetOperationStatusChanged, operationId, status: ChangesetOperationStatus.Idle },
    });
    this.sendFrame(socketId, {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      result: { message: `Discarded changes to ${absPath}` },
    });
  }

  /**
   * Restore one file from a turn's before-snapshot: the file was added by
   * the turn (before === null) → delete it; otherwise write the pre-edit
   * content back.
   */
  private async restoreTurnFile(chat: ChatRuntime, turnId: string, absPath: string): Promise<void> {
    const snap = chat.turnSnapshots.get(turnId)?.get(absPath);
    const before = snap?.before ?? null;
    if (before === null) {
      await this.opts.facade.deleteFile(absPath);
    } else {
      await this.opts.facade.writeFile(absPath, before);
    }
  }
}
