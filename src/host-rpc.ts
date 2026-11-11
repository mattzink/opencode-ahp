/**
 * RPC section (design §4, §13): JSON-RPC frame handling, routing, the initialize/reconnect/subscribe handshake, and snapshot serving.
 */

import { HostEvents } from "./host-events.js";
import { ActionType, ChangesetStatus, ReconnectResultType, ReconnectResult, Snapshot } from "@microsoft/agent-host-protocol";
import { mapCatalog } from "./bridge.js";
import { ROOT_CHANNEL, parseChangesetChannel } from "./channels.js";
import { ERROR_INVALID_PARAMS, handleInitialize } from "./handshake.js";
import { isRecord } from "./options.js";
import { ERROR_PARSE, ERROR_INVALID_REQUEST, ERROR_METHOD_NOT_FOUND, ERROR_INTERNAL, ERROR_SESSION_NOT_FOUND, ERROR_NOT_FOUND } from "./host-errors.js";
import { RpcMessage } from "./host-types.js";
import { sameAgents, describeParams } from "./host-util.js";

/** Version assumed for a reconnecting client the host has never seen (host restart). */
const RECONNECT_DEFAULT_VERSION = "1.0.0";

export class HostRpc extends HostEvents {
  // ── transport callbacks ────────────────────────────────────────────────
  onOpen(socketId: number): void {
    this.sockets.set(socketId, { initialized: false, version: null, clientId: null });
  }

  onMessage(socketId: number, text: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.sendFrame(socketId, {
        jsonrpc: "2.0",
        id: null,
        error: { code: ERROR_PARSE, message: "parse error" },
      });
      return;
    }
    if (!isRecord(raw) || raw.jsonrpc !== "2.0" || typeof raw.method !== "string") {
      this.sendFrame(socketId, {
        jsonrpc: "2.0",
        id: isRecord(raw) ? raw.id ?? null : null,
        error: { code: ERROR_INVALID_REQUEST, message: "invalid request" },
      });
      return;
    }
    // The routing is async (catalog reads await the opencode registry);
    // each message is handled independently.
    void this.route(socketId, raw).catch((err) => {
      // R2: a bad frame or a bridge error must never take down the host.
      this.log(
        `error handling ${String(raw.method)}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
      if (raw.id !== undefined) {
        this.sendFrame(socketId, {
          jsonrpc: "2.0",
          id: raw.id,
          error: { code: ERROR_INTERNAL, message: "internal error" },
        });
      }
    });
  }

  onClose(socketId: number): void {
    const socket = this.sockets.get(socketId);
    if (socket?.clientId) {
      const record = this.clients.get(socket.clientId);
      if (record && record.socketId === socketId) record.socketId = null;
      // The spec says the server SHOULD remove an
      // active client when it disconnects. Safe: the
      // official client re-dispatches `activeClientSet` on re-subscribe.
      this.evictActiveClient(socket.clientId);
    }
    this.channels.removeSocket(socketId);
    this.sockets.delete(socketId);
  }

  /**
   * Evict a disconnected client's active-client
   * role from every session it holds (server-side
   * `session/activeClientRemoved`), fail its in-flight client-tool
   * executions (the opencode tool then fails → the pump's normal
   * `tool.failed` path completes the AHP tool call — the state is still
   * `running`, so the terminal suppression does not apply), clear the
   * session input request each execution raised (the
   * `toolClientExecution` request, or the `toolConfirmation` that
   * replaced it under the same id when the result was held for
   * approval — without this the session keeps a stale request and, for
   * a held result, sits in InputNeeded forever), and re-sync the
   * opencode tool union (it shrank).
   */
  private evictActiveClient(clientId: string): void {
    let evicted = false;
    for (const rec of this.sessions.values()) {
      if (!rec.sessionStore.state.activeClients.some((c) => c.clientId === clientId)) continue;
      evicted = true;
      this.publish({
        channel: rec.channel,
        action: { type: ActionType.SessionActiveClientRemoved, clientId },
      });
      // In-flight client-tool calls are per-chat.
      for (const chat of rec.chats.values()) {
        for (const [toolCallId, inv] of chat.clientToolCalls) {
          if (inv.clientId !== clientId || inv.result !== undefined) continue;
          inv.result = { ok: false, error: `client ${clientId} disconnected before completing the tool call` };
          this.settleClientTool(inv);
          // The reducer's inputNeededRemoved is a no-op when the id is
          // absent, so this is safe for an invocation whose request was
          // already cleared on the normal completion path.
          this.publish({
            channel: rec.channel,
            action: { type: ActionType.SessionInputNeededRemoved, id: toolCallId },
          });
        }
      }
    }
    if (evicted) void this.syncClientToolsToOpencode();
  }

  // ── routing ────────────────────────────────────────────────────────────
  private async route(socketId: number, msg: RpcMessage): Promise<void> {
    const socket = this.sockets.get(socketId);
    if (!socket) return;
    const method = msg.method as string;

    if (!socket.initialized) {
      if (method === "ping") {
        // ping is answered even before initialize (AHP transport spec).
        this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, result: null });
        return;
      }
      if (method === "initialize") {
        await this.handleInitialize(socketId, msg);
        return;
      }
      if (method === "reconnect") {
        await this.handleReconnect(socketId, msg);
        return;
      }
      if (msg.id !== undefined) {
        this.sendFrame(socketId, {
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: ERROR_INVALID_REQUEST,
            message: `not initialized: ${method} must follow initialize or reconnect`,
          },
        });
        return;
      }
      this.log(`ignoring pre-initialize notification ${method} on socket ${socketId}`);
      return;
    }

    switch (method) {
      case "ping":
        this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, result: null });
        break;
      case "subscribe":
        await this.handleSubscribe(socketId, msg);
        break;
      case "unsubscribe":
        this.handleUnsubscribe(socketId, msg); // notification (no id)
        break;
      case "dispatchAction":
        await this.handleDispatchAction(socketId, msg); // notification (no id)
        break;
      case "listSessions":
        await this.handleListSessions(socketId, msg);
        break;
      case "resolveSessionConfig":
        this.handleResolveSessionConfig(socketId, msg);
        break;
      case "createSession":
        await this.handleCreateSession(socketId, msg);
        break;
      case "createChat":
        await this.handleCreateChat(socketId, msg);
        break;
      case "disposeChat":
        await this.handleDisposeChat(socketId, msg);
        break;
      case "resourceRead":
        await this.handleResourceRead(socketId, msg);
        break;
      case "invokeChangesetOperation":
        await this.handleInvokeChangesetOperation(socketId, msg);
        break;
      case "createTerminal":
        await this.handleCreateTerminal(socketId, msg);
        break;
      case "disposeTerminal":
        await this.handleDisposeTerminal(socketId, msg);
        break;
      case "setClientManagedSettingsPermissions":
        // VS Code-specific post-init notification: the
        // permissions VS Code manages in its own settings UI. AHP 1.0.0
        // has no counterpart — accept deliberately (parse + log), never
        // error; the connection stays up.
        this.log(
          `setClientManagedSettingsPermissions received (${describeParams(msg.params)}); accepted (no-op)`,
        );
        break;
      case "initialize":
      case "reconnect":
        this.sendFrame(socketId, {
          jsonrpc: "2.0",
          id: msg.id ?? null,
          error: {
            code: ERROR_INVALID_REQUEST,
            message: `${method} is only valid before the handshake`,
          },
        });
        break;
      default:
        if (msg.id !== undefined) {
          this.sendFrame(socketId, {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: ERROR_METHOD_NOT_FOUND, message: `unknown method: ${method}` },
          });
        } else {
          this.log(`ignoring unknown notification ${method} on socket ${socketId}`);
        }
    }
  }

  // ── commands ───────────────────────────────────────────────────────────
  private async handleInitialize(socketId: number, msg: RpcMessage): Promise<void> {
    const socket = this.sockets.get(socketId)!;
    const outcome = await handleInitialize({
      params: msg.params,
      serverInfo: this.opts.serverInfo,
      serverSeq: this.seq.seq,
      defaultDirectory: this.opts.defaultDirectory,
      snapshotFor: (uri) => this.snapshotFor(uri),
    });
    if (!outcome.ok) {
      this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, error: outcome.error });
      return;
    }

    const clientId = (msg.params as { clientId: string }).clientId;
    const existing = this.clients.get(clientId);
    if (existing && existing.socketId !== null && existing.socketId !== socketId) {
      // A newer connection with the same clientId supersedes the old one.
      this.log(`client ${clientId} re-initialized on socket ${socketId}; closing socket ${existing.socketId}`);
      this.opts.close?.(existing.socketId, 4000, "superseded by a newer connection");
    }

    socket.initialized = true;
    socket.version = outcome.result.protocolVersion;
    socket.clientId = clientId;
    this.clients.set(clientId, { version: outcome.result.protocolVersion, socketId });

    // Register the initial subscriptions right after the snapshot
    // computation above; no action can slip in between.
    const params = isRecord(msg.params) ? msg.params : {};
    const initial = Array.isArray(params["initialSubscriptions"])
      ? params["initialSubscriptions"]
      : [];
    for (const uri of initial) {
      if (typeof uri === "string" && uri.length > 0) {
        this.channels.subscribe(socketId, uri);
      }
    }

    this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, result: outcome.result });
  }

  private async handleReconnect(socketId: number, msg: RpcMessage): Promise<void> {
    const params = msg.params;
    if (!isRecord(params) || params["channel"] !== ROOT_CHANNEL) {
      this.sendFrame(socketId, {
        jsonrpc: "2.0",
        id: msg.id ?? null,
        error: { code: ERROR_INVALID_PARAMS, message: `reconnect must target ${ROOT_CHANNEL}` },
      });
      return;
    }
    const clientId = params["clientId"];
    const lastSeen = params["lastSeenServerSeq"];
    const subscriptions = params["subscriptions"];
    if (typeof clientId !== "string" || clientId.length === 0 ||
        !Number.isInteger(lastSeen) || (lastSeen as number) < 0 ||
        !Array.isArray(subscriptions) || !subscriptions.every((u) => typeof u === "string")) {
      this.sendFrame(socketId, {
        jsonrpc: "2.0",
        id: msg.id ?? null,
        error: { code: ERROR_INVALID_PARAMS, message: "invalid reconnect params" },
      });
      return;
    }
    const clientSubs = subscriptions as string[];

    const record = this.clients.get(clientId);
    const known = record !== undefined;
    const version = record?.version ?? RECONNECT_DEFAULT_VERSION;

    const socket = this.sockets.get(socketId)!;
    socket.initialized = true;
    socket.version = version;
    socket.clientId = clientId;
    this.clients.set(clientId, { version, socketId });

    // Resolve every requested subscription; unresolvable ones are reported
    // in `missing` (the client drops them — AHP lifecycle spec).
    const snapshots: Snapshot[] = [];
    const missing: string[] = [];
    for (const uri of clientSubs) {
      const snap = await this.snapshotFor(uri);
      if (snap) snapshots.push(snap);
      else missing.push(uri);
    }
    for (const uri of clientSubs) {
      this.channels.subscribe(socketId, uri);
    }

    // Replay when the client is known and its gap is still in the window;
    // otherwise fresh snapshots.
    let result: ReconnectResult;
    const replay = this.seq.since(lastSeen as number);
    if (known && replay !== null) {
      const set = new Set(clientSubs);
      result = {
        type: ReconnectResultType.Replay,
        actions: replay.filter((a) => set.has(a.channel)),
        missing,
      };
    } else {
      result = { type: ReconnectResultType.Snapshot, snapshots };
    }
    this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, result });
  }

  private async handleSubscribe(socketId: number, msg: RpcMessage): Promise<void> {
    const params = isRecord(msg.params) ? msg.params : {};
    const uri = params["channel"];
    if (typeof uri !== "string" || uri.length === 0) {
      this.sendFrame(socketId, {
        jsonrpc: "2.0",
        id: msg.id ?? null,
        error: { code: ERROR_INVALID_PARAMS, message: "subscribe requires a channel URI" },
      });
      return;
    }
    const outcome = this.channels.subscribe(socketId, uri);
    if (!outcome.ok) {
      this.sendFrame(socketId, {
        jsonrpc: "2.0",
        id: msg.id ?? null,
        error: {
          code:
            outcome.reason === "no-such-session"
              ? ERROR_SESSION_NOT_FOUND
              : outcome.reason === "no-such-terminal"
                ? ERROR_NOT_FOUND
                : ERROR_INVALID_PARAMS,
          message: `cannot subscribe to ${uri}`,
        },
      });
      return;
    }
    const snap = await this.snapshotFor(uri);
    this.sendFrame(socketId, {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      result: snap ? { snapshot: snap } : {},
    });
  }

  private handleUnsubscribe(socketId: number, msg: RpcMessage): void {
    const params = isRecord(msg.params) ? msg.params : {};
    const uri = params["channel"];
    if (typeof uri !== "string" || uri.length === 0) return;
    this.channels.unsubscribe(socketId, uri);
  }

  /**
   * Snapshot for a channel URI, or null when the channel is not
   * subscribable right now.
   *
   * Root snapshots re-derive the catalog from the facade on every call
   * (registry reads reflect every registration so far; in-process reads
   * are cheap). Session/chat snapshots read the official-reducer stores.
   */
  // ── state / publishing ─────────────────────────────────────────────────
  private async snapshotFor(uri: string): Promise<Snapshot | null> {
    // kindOf, not channelKind: client-chosen pty terminal URIs classify
    // "unknown" by prefix and resolve only while their record is live.
    const kind = this.kindOf(uri);
    if (kind === "unknown") return null;
    if (kind === "changeset") {
      if (!this.opts.changesets) return null;
      const parsed = parseChangesetChannel(uri);
      if (parsed === null) return null;
      // The owner is the session/chat channel (owner-aware).
      const rec = this.byChannel.get(parsed.ownerUri);
      if (rec === undefined) return null;
      const store = this.changesetStore(rec, uri);
      if (store === null) return null; // owner gone (disposed chat)
      // First subscribe (or a failed computation) triggers the computation;
      // subsequent subscribes return the last completed state.
      if (store.state.status === ChangesetStatus.Computing || store.state.status === ChangesetStatus.Error) {
        await this.refreshChangeset(rec, uri);
      }
      return { resource: uri, state: store.state, fromSeq: this.seq.seq };
    }
    if (kind === "terminal") {
      // The synthetic terminal's official-reducer
      // state; null once the record is torn down (the chat is gone).
      const t = this.terminals.get(uri);
      if (t === undefined) return null;
      return { resource: uri, state: t.store.state, fromSeq: this.seq.seq };
    }
    if (kind !== "root") {
      const rec = this.byChannel.get(uri);
      if (rec === undefined) return null;
      if (uri === rec.channel) {
        return { resource: uri, state: rec.sessionStore.state, fromSeq: this.seq.seq };
      }
      const chat = rec.chats.get(uri);
      if (chat !== undefined) {
        return { resource: uri, state: chat.chatStore.state, fromSeq: this.seq.seq };
      }
      return null;
    }
    const [providers, agents] = await Promise.all([
      this.opts.facade.listCatalog(),
      this.opts.facade.listAgents(),
    ]);
    const catalog = mapCatalog(providers, agents, this.opts.defaultDirectory);
    if (!sameAgents(this.state.state.agents, catalog)) {
      this.state.apply({ type: ActionType.RootAgentsChanged, agents: catalog });
    }
    return { resource: ROOT_CHANNEL, state: this.state.state, fromSeq: this.seq.seq };
  }
}
