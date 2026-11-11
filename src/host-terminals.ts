/**
 * Terminal section (design §12). Two kinds of terminal channels:
 *
 *  - SYNTHETIC (`ahp-terminal:` prefix): read-only renderings of
 *    foreground `shell`-tool executions, host-managed, turn-scoped
 *    catalog retention.
 *  - PTY (client-chosen channel URI): interactive shells spawned via
 *    `createTerminal` (the `spawnPty` seam — Bun in production, a fake
 *    in tests), with real input/resize, claim/title/clear through the
 *    official reducer, and a rolling content-buffer trim the official
 *    append-only reducer never performs.
 */

import { fileURLToPath } from "node:url";
import { HostChangesets } from "./host-changesets.js";
import {
  ActionOrigin,
  ActionType,
  StateAction,
  TerminalClaim,
  TerminalClaimedAction,
  TerminalClaimKind,
  TerminalContentPart,
  TerminalInfo,
  TerminalInputAction,
  TerminalLifecycleStatus,
  TerminalResizedAction,
  TerminalState,
  TerminalTitleChangedAction,
} from "@microsoft/agent-host-protocol";
import { directoryUri, FacadeToolContent } from "./bridge.js";
import { ROOT_CHANNEL, channelKind, terminalChannelURI } from "./channels.js";
import {
  ERROR_ALREADY_EXISTS,
  ERROR_INTERNAL,
  ERROR_INVALID_REQUEST,
  ERROR_METHOD_NOT_FOUND,
  ERROR_PERMISSION_DENIED,
} from "./host-errors.js";
import { ERROR_INVALID_PARAMS } from "./handshake.js";
import { isRecord } from "./options.js";
import { createTerminalStateStore } from "./state.js";
import { ChatRuntime, PtyTerminalRecord, RpcMessage, SessionRecord } from "./host-types.js";
import { errorMessage, isPathInside, shellExitCodeOf } from "./host-util.js";

/**
 * The opencode tool names whose executions render as synthetic
 * `ahp-terminal:` channels. `shell`
 * is the v2 core tool name; `bash` is its pre-rename alias (kept so an
 * older provider-side tool name still maps).
 */
const SHELL_TOOL_NAMES = new Set(["shell", "bash"]);

/**
 * Max characters of the command line kept in the terminal title (the
 * catalog row and the state title share it — long pipelines stay
 * one-line in the Agents-window list).
 */
const TERMINAL_TITLE_MAX = 64;

/**
 * Rolling buffer budget for pty terminal content — the VS Code reference
 * client's terminalConstants: once the stored content exceeds the max,
 * trim back to the target (drop whole parts from the front, then slice
 * the head part). The official terminal reducer is append-only and never
 * trims, so the host does it after each `terminal/data` apply.
 */
const TERMINAL_MAX_CONTENT_LENGTH = 100_000;
const TERMINAL_TRIMMED_CONTENT_LENGTH = 80_000;

/** A positive integer, or null. */
function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** The character size of a content part (command parts count their output). */
function partSize(part: TerminalContentPart): number {
  return part.type === "command" ? part.output.length : part.value.length;
}

/**
 * Validate a wire `TerminalClaim` (createTerminal params, the
 * terminal/claimed action payload): a client claim naming the dispatching
 * client (a claim is not a credential — naming someone else is
 * rejected), or a session claim with its session/chat URIs (optional
 * turnId/toolCallId scope passed through). Null when the shape is wrong.
 */
function normalizeTerminalClaim(claim: unknown, clientId: string | null): TerminalClaim | null {
  if (!isRecord(claim)) return null;
  if (claim["kind"] === TerminalClaimKind.Client) {
    const id = claim["clientId"];
    if (typeof id !== "string" || id.length === 0) return null;
    if (clientId !== null && id !== clientId) return null;
    return { kind: TerminalClaimKind.Client, clientId: id };
  }
  if (claim["kind"] === TerminalClaimKind.Session) {
    if (typeof claim["session"] !== "string" || claim["session"].length === 0) return null;
    if (typeof claim["chat"] !== "string" || claim["chat"].length === 0) return null;
    return {
      kind: TerminalClaimKind.Session,
      session: claim["session"],
      chat: claim["chat"],
      ...(typeof claim["turnId"] === "string" ? { turnId: claim["turnId"] } : {}),
      ...(typeof claim["toolCallId"] === "string" ? { toolCallId: claim["toolCallId"] } : {}),
    };
  }
  return null;
}

/**
 * Unwrap the client's agent-host URI wrapper to the original file path.
 * The VS Code 1.145.2 scheme
 * (`vscode-agent-host://<authority>/<path>?_ah=<urlsafe-base64 JSON>`)
 * keeps the original path verbatim in the URI path and carries the
 * original scheme/authority/path in the `_ah` query parameter — the `_ah`
 * meta path wins when present (the content path); otherwise the URI path
 * is used. Null when the URI does not parse to a path.
 */
function unwrapAgentHostCwd(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const meta = url.searchParams.get("_ah");
  if (meta !== null) {
    try {
      const decoded: unknown = JSON.parse(Buffer.from(meta, "base64url").toString("utf8"));
      if (isRecord(decoded) && typeof decoded["path"] === "string" && decoded["path"].length > 0) {
        return decoded["path"];
      }
    } catch {
      // Malformed `_ah` meta — fall through to the URI path.
    }
  }
  return url.pathname.length > 0 ? url.pathname : null;
}

export class HostTerminals extends HostChangesets {
  // ── pty terminals (createTerminal / disposeTerminal) ─────────────────

  /**
   * `createTerminal` (AHP 1.0.0): spawn an interactive pty shell in the
   * resolved working directory and register the client-chosen channel.
   * The result is `null` per the AHP message contract — the client then
   * subscribes to the channel for the state snapshot. Errors: -32601 when
   * the terminal capability is off or the runtime cannot spawn ptys;
   * -32600 for a channel URI inside the host namespace (including the
   * reserved `ahp-terminal:` synthetic prefix); -32010 (AHP
   * AlreadyExists) for a duplicate channel; -32602 for malformed params;
   * -32603 when the spawn itself throws (R2 — logged, the host survives,
   * and the command answers the error).
   */
  async handleCreateTerminal(socketId: number, msg: RpcMessage): Promise<void> {
    if (!this.opts.terminals) {
      this.sendError(socketId, msg.id, ERROR_METHOD_NOT_FOUND, "createTerminal is not enabled on this host");
      return;
    }
    const params = isRecord(msg.params) ? msg.params : {};
    const channel = params["channel"];
    if (typeof channel !== "string" || channel.length === 0) {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "createTerminal requires a channel URI");
      return;
    }
    // The channel must be client-chosen: anything that classifies as a
    // host channel (ahp-root/session/chat/changeset/terminal) is refused —
    // including the reserved `ahp-terminal:` synthetic prefix.
    if (channelKind(channel) !== "unknown") {
      this.sendError(
        socketId,
        msg.id,
        ERROR_INVALID_REQUEST,
        `createTerminal channel ${channel} must not use the host channel namespace`,
      );
      return;
    }
    const socket = this.sockets.get(socketId);
    const claim = normalizeTerminalClaim(params["claim"], socket?.clientId ?? null);
    if (claim === null) {
      this.sendError(
        socketId,
        msg.id,
        ERROR_INVALID_PARAMS,
        "createTerminal requires a valid claim (a client claim for the dispatching client, or a session claim)",
      );
      return;
    }
    if (this.terminals.has(channel)) {
      this.sendError(socketId, msg.id, ERROR_ALREADY_EXISTS, `terminal ${channel} already exists`);
      return;
    }
    const spawn = this.opts.spawnPty;
    if (spawn === undefined) {
      this.sendError(socketId, msg.id, ERROR_METHOD_NOT_FOUND, "interactive terminal spawning is unavailable in this runtime");
      return;
    }
    const cwd = this.resolveTerminalCwd(typeof params["cwd"] === "string" ? params["cwd"] : undefined);
    const cols = positiveInt(params["cols"]) ?? 80;
    const rows = positiveInt(params["rows"]) ?? 24;
    const name = typeof params["name"] === "string" && params["name"].length > 0 ? params["name"] : undefined;
    // The output/exit callbacks re-look-up the record so a dispose that
    // races the pty callbacks no-ops cleanly (post-dispose race).
    const onOutput = (data: string): void => {
      const rec = this.terminals.get(channel);
      if (rec === undefined || rec.kind !== "pty") return;
      this.appendPtyOutput(rec, data);
    };
    const onExit = (code: number | undefined): void => {
      const rec = this.terminals.get(channel);
      if (rec === undefined || rec.kind !== "pty") return;
      this.ptyExited(rec, code);
    };
    let pty: PtyTerminalRecord["process"];
    try {
      pty = spawn({ cwd, cols, rows, onOutput, onExit });
    } catch (err) {
      this.log(`terminal ${channel}: spawn failed: ${errorMessage(err)}`);
      this.sendError(socketId, msg.id, ERROR_INTERNAL, `failed to spawn the terminal process: ${errorMessage(err)}`);
      return;
    }
    this.terminals.set(channel, {
      uri: channel,
      kind: "pty",
      process: pty,
      cwd,
      startedAt: Date.now(),
      store: createTerminalStateStore({
        title: name ?? "Shell",
        content: [],
        lifecycle: { status: TerminalLifecycleStatus.Running },
        claim,
        isPty: true,
        // A directory URI (trailing slash — RFC 8089).
        cwd: directoryUri(cwd),
        cols,
        rows,
      } satisfies TerminalState),
    });
    this.channels.addTerminal(channel);
    // No terminal-channel action announces the creation (AHP has none) —
    // the client subscribes for the snapshot; the root catalog gets the
    // row via root/terminalsChanged.
    this.refreshTerminals();
    this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, result: null });
  }

  /**
   * `disposeTerminal` (AHP 1.0.0): kill the pty and drop its record.
   * Idempotent success (`null`) for unknown channels — the VS Code
   * client's shutdown path disposes terminals that may already be gone
   * (its reference manager no-ops unknown URIs). Synthetic
   * (session-owned) terminals are host-managed: -32009 (AHP
   * PermissionDenied — the client is not permitted to dispose them).
   */
  async handleDisposeTerminal(socketId: number, msg: RpcMessage): Promise<void> {
    if (!this.opts.terminals) {
      this.sendError(socketId, msg.id, ERROR_METHOD_NOT_FOUND, "disposeTerminal is not enabled on this host");
      return;
    }
    const params = isRecord(msg.params) ? msg.params : {};
    const channel = params["channel"];
    if (typeof channel !== "string" || channel.length === 0) {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "disposeTerminal requires a channel URI");
      return;
    }
    const t = this.terminals.get(channel);
    if (t === undefined) {
      this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, result: null });
      return;
    }
    if (t.kind === "synthetic") {
      this.sendError(
        socketId,
        msg.id,
        ERROR_PERMISSION_DENIED,
        `shell-tool terminals are host-managed and cannot be disposed by a client`,
      );
      return;
    }
    this.disposePtyTerminal(t);
    this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, result: null });
  }

  /**
   * Resolve a `createTerminal` cwd to an absolute path inside the
   * location directory. Accepted: a plain `file://` URI (what the VS
   * Code client sends — it unwraps its own wrapper before the wire), the
   * client's `vscode-agent-host:`/`agent-host:` wrapper (supported for
   * robustness), and a bare absolute path. Anything malformed — and
   * anything outside the location directory — falls back to the location
   * directory: the shell is a tool of the session's agent and must not
   * be spawned outside its working root.
   */
  protected resolveTerminalCwd(raw: string | undefined): string {
    const fallback = this.opts.defaultDirectory ?? process.cwd();
    if (raw === undefined || raw.length === 0) return fallback;
    let path: string | null = null;
    if (raw.startsWith("file://")) {
      try {
        path = fileURLToPath(raw);
      } catch {
        path = null;
      }
    } else if (raw.startsWith("vscode-agent-host:") || raw.startsWith("agent-host:")) {
      path = unwrapAgentHostCwd(raw);
    } else if (raw.startsWith("/")) {
      path = raw;
    }
    if (path === null || !path.startsWith("/")) {
      this.log(`terminal cwd ${raw} is not a usable path; falling back to ${fallback}`);
      return fallback;
    }
    if (this.opts.defaultDirectory !== undefined && !isPathInside(path, this.opts.defaultDirectory)) {
      this.log(`terminal cwd ${path} is outside the location directory; clamping to ${fallback}`);
      return fallback;
    }
    return path;
  }

  /**
   * Dispatch a client-dispatchable action on a live pty terminal:
   * `terminal/input` and `terminal/resized` drive the process (rejected
   * once it has exited — a dead pty has no stdin to write to);
   * `terminal/claimed` applies only when the dispatching client
   * currently holds the client claim (the AHP spec's SHOULD; session
   * claims are host-mediated here and never client-dispatchable);
   * `terminal/titleChanged` (non-empty) and `terminal/cleared` apply
   * through the official reducer (the cleared action resets the content
   * parts) and are allowed even after exit — the state still exists.
   * Accepted title/claim changes refresh the root catalog (the row's
   * title/claim fields are denormalized from the state — VS Code
   * reference parity: _setTitle/_setClaim → _broadcastTerminalList).
   */
  protected dispatchPtyTerminal(t: PtyTerminalRecord, action: StateAction, origin: ActionOrigin | undefined): void {
    const channel = t.uri;
    const exited = t.store.state.lifecycle.status === TerminalLifecycleStatus.Exited;
    switch (action.type) {
      case ActionType.TerminalInput: {
        const a = action as TerminalInputAction;
        if (typeof a.data !== "string") {
          this.echo(channel, action, origin, "invalid terminal/input params (data must be a string)");
          return;
        }
        if (exited) {
          this.echo(channel, action, origin, "terminal process has exited; input is no longer accepted");
          return;
        }
        t.process.write(a.data);
        this.echo(channel, action, origin);
        return;
      }
      case ActionType.TerminalResized: {
        const a = action as TerminalResizedAction;
        const cols = positiveInt(a.cols);
        const rows = positiveInt(a.rows);
        if (cols === null || rows === null) {
          this.echo(channel, action, origin, "invalid terminal/resized params (cols/rows must be positive integers)");
          return;
        }
        if (exited) {
          this.echo(channel, action, origin, "terminal process has exited; it cannot be resized");
          return;
        }
        t.process.resize(cols, rows);
        this.echo(channel, action, origin);
        return;
      }
      case ActionType.TerminalClaimed: {
        const a = action as TerminalClaimedAction;
        const current = t.store.state.claim;
        if (current.kind !== TerminalClaimKind.Client || current.clientId !== (origin?.clientId ?? null)) {
          this.echo(channel, action, origin, "only the client currently holding this terminal may re-claim it");
          return;
        }
        const next = normalizeTerminalClaim(a.claim, origin?.clientId ?? null);
        if (next === null) {
          this.echo(channel, action, origin, "invalid terminal/claimed params (claim must be a client or session claim)");
          return;
        }
        this.echo(channel, action, origin);
        this.refreshTerminals();
        return;
      }
      case ActionType.TerminalTitleChanged: {
        const a = action as TerminalTitleChangedAction;
        if (typeof a.title !== "string" || a.title.length === 0) {
          this.echo(channel, action, origin, "invalid terminal/titleChanged params (title must be a non-empty string)");
          return;
        }
        this.echo(channel, action, origin);
        this.refreshTerminals();
        return;
      }
      case ActionType.TerminalCleared:
        // The official reducer resets the content parts.
        this.echo(channel, action, origin);
        return;
      default:
        this.echo(channel, action, origin, `unsupported action on terminal channel: ${String(action.type)}`);
    }
  }

  /**
   * Append pty output: publish `terminal/data` (the official reducer
   * appends to the content tail — one growing unclassified part while no
   * command is executing), then trim the stored content back to the
   * rolling-buffer budget (the host-side transition — see
   * `trimPtyContent`).
   */
  protected appendPtyOutput(t: PtyTerminalRecord, data: string): void {
    if (data.length === 0) return;
    this.publish({ channel: t.uri, action: { type: ActionType.TerminalData, data } });
    this.trimPtyContent(t);
  }

  /**
   * Host-side trim of the pty content parts (the official terminal
   * reducer never trims — append-only). Mirrors the VS Code reference
   * client's `_trimContent`: drop whole parts from the front while the
   * size exceeds the trimmed target and more than one part remains, then
   * slice the head part by the excess. The replay window still carries
   * the raw `terminal/data` actions (inherent — the window is shared).
   */
  protected trimPtyContent(t: PtyTerminalRecord): void {
    const s = t.store.state;
    let size = 0;
    for (const part of s.content) size += partSize(part);
    if (size <= TERMINAL_MAX_CONTENT_LENGTH) return;
    const content = [...s.content];
    while (size > TERMINAL_TRIMMED_CONTENT_LENGTH && content.length > 1) {
      const removed = content.shift()!;
      size -= partSize(removed);
    }
    if (size > TERMINAL_TRIMMED_CONTENT_LENGTH && content.length > 0) {
      const head = content[0]!;
      const excess = size - TERMINAL_TRIMMED_CONTENT_LENGTH;
      content[0] =
        head.type === "command"
          ? { ...head, output: head.output.slice(excess) }
          : { ...head, value: head.value.slice(excess) };
    }
    t.store.replace({ ...s, content });
  }

  /**
   * A pty process exited on its own: publish `terminal/exited` (the
   * exit code when the runtime reported one) and refresh the catalog —
   * the row stays listed with its (final) exited lifecycle until the
   * client disposes it or the location tears down. Idempotent: a
   * record that already exited (or was disposed) is left alone.
   */
  protected ptyExited(t: PtyTerminalRecord, code: number | undefined): void {
    if (t.store.state.lifecycle.status === TerminalLifecycleStatus.Exited) return;
    this.publish({
      channel: t.uri,
      action: { type: ActionType.TerminalExited, ...(code !== undefined ? { exitCode: code } : {}) },
    });
    this.refreshTerminals();
  }

  /**
   * Kill a pty terminal and drop its record (shared by the client's
   * `disposeTerminal` and location teardown): a still-running process
   * gets a final `terminal/exited` (no exit code — a host-initiated
   * kill), the process is killed, the record and the registry entry go,
   * and the root catalog refreshes (the row drops). The pty's own
   * `onExit` callback finds no record and no-ops (post-dispose race).
   */
  protected disposePtyTerminal(t: PtyTerminalRecord): void {
    if (t.store.state.lifecycle.status === TerminalLifecycleStatus.Running) {
      this.publish({ channel: t.uri, action: { type: ActionType.TerminalExited } });
    }
    try {
      t.process.kill();
    } catch (err) {
      this.log(`terminal ${t.uri}: kill failed: ${errorMessage(err)}`);
    }
    this.terminals.delete(t.uri);
    this.channels.removeTerminal(t.uri);
    this.refreshTerminals();
  }

  /**
   * Kill every live pty terminal (location teardown — called before the
   * listener stops so the final `terminal/exited` actions still reach
   * subscribers). Synthetic terminals are chat/record-scoped — their
   * teardown rides the session-removal path and there is nothing to
   * kill.
   */
  stopTerminals(): void {
    for (const t of [...this.terminals.values()]) {
      if (t.kind !== "pty") continue;
      this.disposePtyTerminal(t);
    }
  }

  // ── synthetic shell-command terminals ───────────────────────────────────

  /**
   * Open the synthetic `ahp-terminal:` channel for a foreground
   * `shell`-tool call (read-only rendering of the command execution):
   * seed the state (`isPty: false`, session claim scoped to
   * chat/turn/toolCall, `supportsCommandDetection: true`), publish
   * `terminal/commandExecuted` (commandId = toolCallId), register the
   * channel, and refresh the root catalog. No-op for the excluded shapes
   * (capability off, no active turn, non-shell tool, malformed input,
   * background calls — the background result carries no turn-scoped
   * completion).
   */
  protected openTerminalForToolCall(rec: SessionRecord, chat: ChatRuntime, toolCallId: string, inputJson: string): void {
    if (!this.opts.terminals) return;
    const turnId = chat.currentTurnId;
    if (turnId === null) return;
    const name = chat.toolName.get(toolCallId);
    if (name === undefined || !SHELL_TOOL_NAMES.has(name)) return;
    let input: unknown;
    try {
      input = JSON.parse(inputJson);
    } catch {
      return; // malformed input text — nothing to render
    }
    if (!isRecord(input)) return;
    const command = input["command"];
    if (typeof command !== "string" || command.length === 0) return;
    if (input["background"] === true) return; // excluded: no synchronous completion
    const uri = terminalChannelURI(toolCallId);
    if (this.terminals.has(uri)) {
      this.log(`terminal ${uri} already exists (duplicate toolCallId ${toolCallId}); not reopening`);
      return;
    }
    const now = Date.now();
    const initial: TerminalState = {
      title:
        command.length > TERMINAL_TITLE_MAX ? `${command.slice(0, TERMINAL_TITLE_MAX - 1)}…` : command,
      content: [],
      lifecycle: { status: TerminalLifecycleStatus.Running },
      claim: { kind: TerminalClaimKind.Session, session: rec.channel, chat: chat.uri, turnId, toolCallId },
      supportsCommandDetection: true,
      isPty: false,
      // A directory URI (trailing slash — RFC 8089).
      ...(this.opts.defaultDirectory !== undefined ? { cwd: directoryUri(this.opts.defaultDirectory) } : {}),
    };
    this.terminals.set(uri, {
      uri,
      kind: "synthetic",
      rec,
      chat,
      toolCallId,
      turnId,
      store: createTerminalStateStore(initial),
      commandLine: command,
      startedAt: now,
    });
    this.channels.addTerminal(uri);
    this.publish({
      channel: uri,
      action: { type: ActionType.TerminalCommandExecuted, commandId: toolCallId, commandLine: command, timestamp: now },
    });
    this.refreshTerminals();
  }

  /**
   * Complete the synthetic terminal of a `shell`-tool call: publish
   * `terminal/data` (the output — the tool's text content on success,
   * the error message on failure), `terminal/commandFinished` (exitCode
   * + duration), and `terminal/exited`, then refresh the root catalog
   * (the listed lifecycle flips to exited while the turn still runs).
   * Idempotent — a terminal that already exited is left alone. The
   * record itself is retained (retention); only the state moves on.
   */
  protected finishTerminal(
    chat: ChatRuntime,
    toolCallId: string,
    result: { ok: true; content: FacadeToolContent[] } | { ok: false; message: string },
  ): void {
    if (!this.opts.terminals) return;
    const uri = terminalChannelURI(toolCallId);
    const t = this.terminals.get(uri);
    // Synthetic URIs can never hold pty records (createTerminal refuses
    // the reserved prefix) — the guard is the union's narrowing.
    if (t === undefined || t.kind !== "synthetic") return;
    if (t.store.state.lifecycle.status === TerminalLifecycleStatus.Exited) return;
    const output = result.ok
      ? result.content
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string)
          .join("\n")
      : result.message;
    if (output.length > 0) {
      this.publish({ channel: uri, action: { type: ActionType.TerminalData, data: output } });
    }
    const exitCode = result.ok ? (shellExitCodeOf(result.content) ?? undefined) : undefined;
    const durationMs = Math.max(0, Date.now() - t.startedAt);
    this.publish({
      channel: uri,
      action: {
        type: ActionType.TerminalCommandFinished,
        commandId: toolCallId,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(durationMs > 0 ? { durationMs } : {}),
      },
    });
    this.publish({
      channel: uri,
      action: { type: ActionType.TerminalExited, ...(exitCode !== undefined ? { exitCode } : {}) },
    });
    this.refreshTerminals();
  }

  /**
   * Republish the root terminal catalog (`root/terminalsChanged`, full
   * replacement). Synthetic terminals are turn-scoped: listed while
   * their turn is still the owning chat's active turn (finished commands
   * keep their (final) lifecycle row until the turn ends, then the row
   * drops — host-controlled retention). Pty terminals are listed while
   * their record is alive (running or exited) until disposed. No-op when
   * the serialized list is unchanged.
   */
  protected refreshTerminals(): void {
    if (!this.opts.terminals) return;
    const terminals: TerminalInfo[] = [];
    for (const t of this.terminals.values()) {
      if (t.kind === "synthetic" && t.chat.currentTurnId !== t.turnId) continue;
      const s = t.store.state;
      terminals.push({ resource: t.uri, title: s.title, claim: s.claim, lifecycle: s.lifecycle });
    }
    if (JSON.stringify(this.state.state.terminals) === JSON.stringify(terminals)) return;
    this.publish({ channel: ROOT_CHANNEL, action: { type: ActionType.RootTerminalsChanged, terminals } });
  }

  /**
   * Drop a chat's SYNTHETIC terminal channels (removeChat — covers both
   * chat disposal and record removal): a still-running command gets a
   * final `terminal/exited` (it dies with the chat), then the records and
   * registry entries go and the root catalog refreshes. Existing socket
   * subscriptions linger (the session-removal precedent) — no further
   * actions will reach them. Pty terminals are not chat-owned — they are
   * never touched here.
   */
  protected teardownTerminalsForChat(chat: ChatRuntime): void {
    let changed = false;
    for (const t of [...this.terminals.values()]) {
      if (t.kind !== "synthetic" || t.chat !== chat) continue;
      if (t.store.state.lifecycle.status === TerminalLifecycleStatus.Running) {
        this.publish({ channel: t.uri, action: { type: ActionType.TerminalExited } });
      }
      this.terminals.delete(t.uri);
      this.channels.removeTerminal(t.uri);
      changed = true;
    }
    if (changed) this.refreshTerminals();
  }
}
