/**
 * The AHP host: the JSON-RPC 2.0 router over transport connections that
 * ties the sequencer, channel registry, root state store, and bridge
 * together (plan §6.1).
 *
 * Deviation (plan §14): the plan's §7 module list stopped at bridge.ts;
 * the router that wires the pure modules to sockets is extracted here (a
 * `Host` class) so the whole protocol layer is unit-testable and
 * exercisable by the spike client without a WebSocket runtime.
 *
 * Connection model (AHP 1.0.0 lifecycle spec):
 *  - the first request on a socket is `initialize` (new client) or
 *    `reconnect` (known clientId — the host keeps a per-clientId registry
 *    across sockets);
 *  - `ping` is answered even before initialize;
 *  - `serverSeq` is a single host-wide sequence (seq.ts);
 *  - `dispatchAction` and `unsubscribe` are notifications (no id); a
 *    dispatched action comes back on the `action` notification stream
 *    (write-ahead reconciliation; rejections carry `rejectionReason`).
 *
 * Phase 1 (plan §11): `createSession` + `listSessions`, session/chat
 * snapshots, the opencode event pump (streaming text/reasoning, tool-call
 * lifecycle, permission prompts, usage, turn terminals + steering/queue
 * handoff), and the client-dispatchable actions VS Code sends
 * (`chat/turnStarted`, `chat/pendingMessageSet`, `chat/toolCallConfirmed`,
 * `chat/turnCancelled`, drafts/read/title/activeClient echoes, …).
 *
 * Session model: one opencode session = one AHP session channel = one
 * default chat channel (plan §3.2 gap, same as pi-ahp). Channel suffixes
 * are opaque; opencode session ids start with "ses" and double as
 * suffixes for externally created sessions.
 *
 * Root session lifecycle events (`root/sessionAdded`,
 * `root/sessionRemoved`, `root/sessionSummaryChanged`) are JSON-RPC
 * *notifications* in AHP 1.0.0 (ephemeral, not replayed) — only
 * `root/activeSessionsChanged` is a sequencer action.
 */
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionType,
  ChangesetOperationScope,
  ChangesetOperationStatus,
  ChangesetStatus,
  PendingMessageKind,
  ReconnectResultType,
  ResponsePartKind,
  SessionInputRequestKind,
  SessionStatus,
  ToolCallConfirmationReason,
  ToolCallContributorKind,
  ToolCallStatus,
  ToolResultContentType,
  isClientDispatchable,
  type ActionEnvelope,
  type ActionOrigin,
  type ChatAction,
  type ChatSummary,
  type ChatState,
  type ChatToolCallCompleteAction,
  type ChatToolCallConfirmedAction,
  type ChatToolCallContentChangedAction,
  type ChatToolCallResultConfirmedAction,
  type ChatTurnCancelledAction,
  type ChatTurnStartedAction,
  type ChangesetAction,
  type ChangesetFilesReviewChangedAction,
  type ErrorResponsePart,
  type Implementation,
  type Message,
  type ReconnectResult,
  type RootAction,
  type SessionAction,
  type SessionActiveClient,
  type SessionState,
  type SessionSummary,
  type SessionToolClientExecutionRequest,
  type SessionToolConfirmationRequest,
  type Snapshot,
  type StateAction,
  type StringOrMarkdown,
  type ToolCallConfirmationState,
  type ToolCallResult,
  type ToolCallState,
  type ToolDefinition,
  type ToolResultContent,
} from "@microsoft/agent-host-protocol";
import {
  agentDirectoryCustomization,
  agentIDFromUri,
  buildSessionSummary,
  buildTurnChangesetFiles,
  buildWorkingChangesetFiles,
  chatChangesetCatalog,
  chatSummaryOf,
  displayNameFor,
  discardOperation,
  fileUri,
  initialChatState,
  initialSessionState,
  invocationMessageFor,
  mapCatalog,
  mapAgentCustomizations,
  parseContentRef,
  pastTenseMessageFor,
  sessionChangesetCatalog,
  userMessage,
  type FacadeClientTool,
  type FacadeClientToolResult,
  type FacadeDelivery,
  type FacadeEvent,
  type FacadeModelRef,
  type FacadeSession,
  type OpencodeFacade,
} from "./bridge.js";
import {
  descriptionFor,
  findProvider,
  inputSchemaFor,
  normalizeToolDefinitions,
  toolUnion,
  type ClientToolInvocation,
} from "./client-tools.js";
import {
  ChannelRegistry,
  ROOT_CHANNEL,
  channelKind,
  chatChannelURI,
  parseChangesetChannel,
  sessionChannelURI,
  sessionChangesetURI,
  sessionIDOf,
  turnChangesetURI,
  uncommittedChangesetURI,
} from "./channels.js";
import { ERROR_INVALID_PARAMS, handleInitialize } from "./handshake.js";
import { isRecord } from "./options.js";
import { Sequencer } from "./seq.js";
import {
  createChatStateStore,
  createChangesetStateStore,
  createRootStateStore,
  createSessionStateStore,
  type ChatStateStore,
  type ChangesetStateStore,
  type RootStateStore,
  type SessionStateStore,
} from "./state.js";

export const ERROR_PARSE = -32700;
export const ERROR_INVALID_REQUEST = -32600;
export const ERROR_METHOD_NOT_FOUND = -32601;
export const ERROR_INTERNAL = -32603;
export const ERROR_SESSION_NOT_FOUND = -32001;
export const ERROR_NO_PROVIDER = -32002;
export const ERROR_SESSION_EXISTS = -32003;
export const ERROR_NOT_FOUND = -32008;
export const ERROR_PERMISSION_DENIED = -32009;

// ActionType / ReconnectResultType are `declare const enum` in the package
// but are also real runtime objects (verified against the published dist),
// so the value imports are safe under both tsc (inlined) and Bun.

interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface SocketState {
  initialized: boolean;
  /** Negotiated version (set by initialize, inherited on reconnect). */
  version: string | null;
  clientId: string | null;
}

/**
 * Per-clientId registry record — survives socket closes so `reconnect`
 * can replay for the same client (AHP lifecycle spec).
 */
interface ClientRecord {
  version: string;
  socketId: number | null;
}

/**
 * Everything the host knows about one live opencode session: the two
 * official-reducer stores (session + its single chat), the denormalized
 * summary fields for root notifications, and the per-turn tracking the
 * event pump needs to join opencode events to AHP turns.
 */
interface SessionRecord {
  /** The opencode session id (`ses_…`). */
  sessionID: string;
  /** The AHP session channel URI (`ahp-session:/<suffix>`). */
  channel: string;
  /** Identity `SessionSummary.provider` (fixed at registration). */
  provider: string;
  createdAt: string;
  /** Denormalized `SessionSummary.modifiedAt` (ISO; lexicographic = chronological). */
  modifiedAt: string;
  sessionStore: SessionStateStore;
  chatStore: ChatStateStore;
  // ── turn tracking (event-pump join state) ────────────────────────────
  /** The AHP turnId the pump joins opencode events to, or null. */
  currentTurnId: string | null;
  turnStartedAt: number | null;
  /** `<providerID>/<modelID>` captured from `session.step.started` (usage model ref). */
  turnModelRef: string | null;
  // ── part / tool tracking ─────────────────────────────────────────────
  /** Emitted part keys (`<assistantMessageID>:<kind>:<ordinal>`). */
  parts: Set<string>;
  /** toolCallId → raw JSON input text (`session.tool.input.ended.text`). */
  toolInput: Map<string, string>;
  /** toolCallId → opencode tool name (`session.tool.input.started.name`). */
  toolName: Map<string, string>;
  /** toolCallIds that already received `chat/toolCallReady`. */
  toolReady: Set<string>;
  /** toolCallId → opencode permission request id. */
  permissionForTool: Map<string, string>;
  /** opencode permission request id → toolCallId. */
  toolForPermission: Map<string, string>;
  /**
   * Phase 4 extension 1: toolCallId → client-executed tool call tracking
   * (created at `tool.input.started`, removed at the opencode-side
   * terminal — plan §14.12).
   */
  clientToolCalls: Map<string, ClientToolInvocation>;
  /** The most recent `session.inbox.enqueued` (external/TUI prompt tracking). */
  lastInbox: { text: string; delivery: string } | null;
  // ── Phase 2: changesets ────────────────────────────────────────────────
  /** Live changeset stores, keyed by changeset URI (created on subscribe). */
  changesets: Map<string, ChangesetStateStore>;
  /**
   * Per-turn file snapshots for the turn changesets: turnId → absPath →
   * captured {before (pre-edit disk read), after (disk at turn end)}.
   * `null` = the file was absent on that side. Kept until the session is
   * removed (content refs + discard-restore read them, plan §14.10).
   */
  turnSnapshots: Map<string, Map<string, { before: string | null; after: string | null }>>;
}

export interface HostOptions {
  serverInfo: Implementation;
  facade: OpencodeFacade;
  replayWindow: number;
  /** The opencode instance's working directory (InitializeResult.defaultDirectory). */
  defaultDirectory?: string;
  /** Advertise + serve the changeset channels (catalogues, snapshots, discard). */
  changesets: boolean;
  /** Deliver a JSON-serializable frame to a connection. */
  send: (socketId: number, message: unknown) => void;
  /** Close one connection (a superseded duplicate clientId). */
  close?: (socketId: number, code?: number, reason?: string) => void;
  log?: (message: string) => void;
}

/** Version assumed for a reconnecting client the host has never seen (host restart). */
const RECONNECT_DEFAULT_VERSION = "1.0.0";
/**
 * Grace before the pump registers an externally created session
 * (`session.created`): a concurrent `createSession` may still be resolving
 * for the same opencode session under a client-chosen channel; the slower
 * path is healed by the delete+recreate remap in `handleCreateSession`.
 */
const EXTERNAL_REGISTER_GRACE_MS = 250;
/** Default page size for `listSessions` (AHP `PaginatedParams.limit`). */
const LIST_SESSIONS_DEFAULT_LIMIT = 100;
/**
 * The file-mutating opencode tools whose inputs carry a target path — the
 * turn-changeset before-capture watches only these (`tool.input.ended`
 * fires before execution, so the pre-edit content is still on disk).
 */
const SNAPSHOT_TOOLS = new Set(["write", "edit", "apply", "patch"]);
/** The tool-input keys that carry a file path (checked in order). */
const SNAPSHOT_PATH_KEYS = ["path", "file_path", "filePath", "file"] as const;

export class Host {
  private readonly seq: Sequencer;
  private readonly channels = new ChannelRegistry();
  private readonly state: RootStateStore;
  private readonly sockets = new Map<number, SocketState>();
  private readonly clients = new Map<string, ClientRecord>();
  /**
   * Live sessions, keyed by opencode session id (the event-pump join key).
   * `byChannel` maps a session/chat channel URI to the same record for the
   * client-facing lookups — the channel suffix is not always the opencode id
   * (client-chosen suffixes), so the two keyings differ.
   */
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly byChannel = new Map<string, SessionRecord>();
  private readonly opts: HostOptions;
  private readonly log: (message: string) => void;
  private turnCounter = 0;
  private pumpController: AbortController | null = null;

  constructor(opts: HostOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.seq = new Sequencer(opts.replayWindow);
    this.state = createRootStateStore({ agents: [] });
  }

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
      // Phase 4 extension 1: the spec says the server SHOULD remove an
      // active client when it disconnects (plan §14.12). Safe: the
      // official client re-dispatches `activeClientSet` on re-subscribe.
      this.evictActiveClient(socket.clientId);
    }
    this.channels.removeSocket(socketId);
    this.sockets.delete(socketId);
  }

  /**
   * Phase 4 extension 1: evict a disconnected client's active-client
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
      for (const [toolCallId, inv] of rec.clientToolCalls) {
        if (inv.clientId !== clientId || inv.result !== undefined) continue;
        inv.result = { ok: false, error: `client ${clientId} disconnected before completing the tool call` };
        this.settleClientTool(rec, inv);
        // The reducer's inputNeededRemoved is a no-op when the id is
        // absent, so this is safe for an invocation whose request was
        // already cleared on the normal completion path.
        this.publish({
          channel: rec.channel,
          action: { type: ActionType.SessionInputNeededRemoved, id: toolCallId },
        });
      }
    }
    if (evicted) void this.syncClientToolsToOpencode();
  }

  // ── event pump ─────────────────────────────────────────────────────────

  /**
   * Start the opencode event → AHP action pump. Idempotent. The pump is a
   * single sequential async loop, so event handling and client-dispatch
   * handling (same event loop) interleave without races on the per-turn
   * join state.
   */
  startEventPump(): void {
    if (this.pumpController !== null) return;
    const controller = new AbortController();
    this.pumpController = controller;
    void (async () => {
      try {
        for await (const event of this.opts.facade.events(controller.signal)) {
          if (controller.signal.aborted) break;
          await this.handleEvent(event);
        }
      } catch (err) {
        this.log(`event pump failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      } finally {
        if (this.pumpController === controller) this.pumpController = null;
      }
    })();
  }

  /** Stop the event pump (teardown). Idempotent. */
  stopEventPump(): void {
    this.pumpController?.abort();
    this.pumpController = null;
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
      case "createSession":
        await this.handleCreateSession(socketId, msg);
        break;
      case "resourceRead":
        await this.handleResourceRead(socketId, msg);
        break;
      case "invokeChangesetOperation":
        await this.handleInvokeChangesetOperation(socketId, msg);
        break;
      case "setClientManagedSettingsPermissions":
        // VS Code-specific post-init notification (plan §14.7): the
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

  private sendFrame(socketId: number, message: unknown): void {
    this.opts.send(socketId, message);
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
   * `createSession` (AHP 1.0.0 session-channel command). Creates a real
   * opencode session, seeds its session/chat stores, publishes the
   * session-channel lifecycle actions, announces the session on the root
   * channel, and responds `null` (per the command contract).
   *
   * Error codes: -32002 (no agent for the requested provider),
   * -32003 (the session URI already exists).
   */
  private async handleCreateSession(socketId: number, msg: RpcMessage): Promise<void> {
    const params = isRecord(msg.params) ? msg.params : {};
    const channel = params["channel"];
    if (typeof channel !== "string" || channelKind(channel) !== "session") {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "createSession requires an ahp-session:/… channel");
      return;
    }
    const suffix = sessionIDOf(channel) as string;
    // A suffix containing the changeset marker would make this session
    // channel string-identical to the changeset URI of the session before
    // the marker — the changeset kind would win (channelKind), making the
    // session channel un-subscribable. Reject it instead.
    if (suffix.includes("/changeset/")) {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "channel suffix must not contain \"/changeset/\"");
      return;
    }
    for (const rec of this.sessions.values()) {
      if (rec.channel === channel) {
        this.sendError(socketId, msg.id, ERROR_SESSION_EXISTS, "Session already exists");
        return;
      }
    }

    // Resolve the provider/model for the new session.
    const providers = await this.opts.facade.listCatalog();
    const providerParam = params["provider"];
    let provider;
    if (typeof providerParam === "string" && providerParam.length > 0) {
      provider = providers.find((p) => p.providerID === providerParam && p.activation !== "disabled");
      if (provider === undefined) {
        this.sendError(socketId, msg.id, ERROR_NO_PROVIDER, `No agent for provider ${providerParam}`);
        return;
      }
    } else {
      provider = providers.find((p) => p.activation !== "disabled");
    }
    const model = provider !== undefined ? firstEnabledModelRef(provider.models) : undefined;

    // `activeClient` eagerly claims an active-client role; the spec requires
    // the clientId to match the creating client.
    let activeClients: SessionActiveClient[] = [];
    const activeClientParam = params["activeClient"];
    if (activeClientParam !== undefined) {
      const socket = this.sockets.get(socketId);
      const ac = activeClientParam as Record<string, unknown>;
      if (
        !isRecord(ac) ||
        typeof ac["clientId"] !== "string" ||
        ac["clientId"] !== socket?.clientId
      ) {
        this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "activeClient.clientId must match the initializing clientId");
        return;
      }
      activeClients = [normalizeActiveClient(ac)];
    }

    // opencode SessionIDs must start with "ses": pass the suffix through
    // only when it already is one; otherwise let opencode mint an id and
    // record the suffix→id mapping (the record key is the opencode id).
    const passID = suffix.startsWith("ses") ? suffix : undefined;
    const created = await this.opts.facade.createSession({ id: passID, model });

    // Slow-create race: the pump may have registered this opencode session
    // under its own id as an external session while `createSession` was in
    // flight. Remap: drop the interim record (root/sessionRemoved) and
    // re-register under the client-chosen channel below.
    const interim = this.sessions.get(created.sessionID);
    if (interim !== undefined && interim.channel !== channel) {
      this.removeRecord(interim);
    }

    const agents = await this.opts.facade.listAgents();
    const customizations =
      mapAgentCustomizations(agents).length > 0 && this.opts.defaultDirectory !== undefined
        ? [agentDirectoryCustomization(this.opts.defaultDirectory, agents)]
        : undefined;
    const now = new Date().toISOString();
    const sessionStore = createSessionStateStore(
      initialSessionState({
        sessionID: created.sessionID,
        provider: created.model?.providerID ?? provider?.providerID ?? "opencode",
        title: created.title ?? "New Session",
        activeClients,
        customizations,
      }),
    );
    const chatStore = createChatStateStore(
      initialChatState({ resource: chatChannelURI(created.sessionID), title: "Chat 1", modifiedAt: now }),
    );
    const rec: SessionRecord = {
      sessionID: created.sessionID,
      channel,
      provider: sessionStore.state.provider,
      createdAt: new Date(created.time.created).toISOString(),
      modifiedAt: new Date(created.time.updated).toISOString() > now
        ? new Date(created.time.updated).toISOString()
        : now,
      sessionStore,
      chatStore,
      currentTurnId: null,
      turnStartedAt: null,
      turnModelRef: null,
      parts: new Set(),
      toolInput: new Map(),
      toolName: new Map(),
      toolReady: new Set(),
      permissionForTool: new Map(),
      toolForPermission: new Map(),
      lastInbox: null,
      changesets: new Map(),
      turnSnapshots: new Map(),
      clientToolCalls: new Map(),
    };
    this.sessions.set(created.sessionID, rec);
    this.byChannel.set(channel, rec);
    this.byChannel.set(chatChannelURI(created.sessionID), rec);
    // The session channel carries the client-chosen suffix; the chat
    // channel and the event pump carry the opencode id — both must
    // resolve in the registry.
    this.channels.addSession(suffix);
    this.channels.addSession(created.sessionID);

    // Phase 4 extension 1: a createSession `activeClient` seeds the
    // session's tools — register them with opencode now.
    if (activeClients.length > 0) void this.syncClientToolsToOpencode();

    // Session-channel lifecycle (server-side, no origin).
    this.publish({ channel, action: { type: ActionType.SessionReady } });
    this.publish({
      channel,
      action: { type: ActionType.SessionChatAdded, summary: chatSummaryOf(chatStore.state) },
    });
    this.publish({
      channel,
      action: { type: ActionType.SessionDefaultChatChanged, defaultChat: chatChannelURI(created.sessionID) },
    });
    // Phase 2: advertise the changeset catalogues (session channel: the
    // session-wide changeset; chat channel: uncommitted + session + the
    // per-turn template).
    if (this.opts.changesets) {
      this.publish({
        channel,
        action: { type: ActionType.SessionChangesetsChanged, changesets: sessionChangesetCatalog(created.sessionID) },
      });
      this.publish({
        channel: chatChannelURI(created.sessionID),
        action: { type: ActionType.ChatChangesetsChanged, changesets: chatChangesetCatalog(created.sessionID) },
      });
    }
    // Root: active-session count (action, replayed) + sessionAdded (notification).
    this.publish({
      channel: ROOT_CHANNEL,
      action: { type: ActionType.RootActiveSessionsChanged, activeSessions: this.sessions.size },
    });
    this.notifyRoot("root/sessionAdded", {
      channel: ROOT_CHANNEL,
      summary: this.sessionSummary(rec),
    });

    this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, result: null });
  }

  /**
   * `listSessions` (AHP 1.0.0 root command): all opencode sessions,
   * most-recently-modified first, with in-memory cursor pagination.
   * Unknown sessions are lazily registered (so their channels become
   * subscribable); registration is idempotent per opencode session id.
   */
  private async handleListSessions(socketId: number, msg: RpcMessage): Promise<void> {
    const params = isRecord(msg.params) ? msg.params : {};
    const limit =
      typeof params["limit"] === "number" && Number.isInteger(params["limit"]) && (params["limit"] as number) > 0
        ? (params["limit"] as number)
        : LIST_SESSIONS_DEFAULT_LIMIT;
    let offset = 0;
    if (typeof params["cursor"] === "string" && params["cursor"].length > 0) {
      const parsed = Number.parseInt(params["cursor"], 10);
      if (Number.isInteger(parsed) && parsed > 0) offset = parsed;
    }
    const listed = await this.opts.facade.listSessions();
    const records: (SessionRecord | undefined)[] = [];
    for (const fs of listed) {
      records.push(this.registerExternal(fs) ?? this.sessions.get(fs.sessionID));
    }
    const sorted = records
      .filter((r): r is SessionRecord => r !== undefined)
      .sort((a, b) => {
        const ta = this.sessions.get(a.sessionID)?.modifiedAt ?? a.modifiedAt;
        const tb = this.sessions.get(b.sessionID)?.modifiedAt ?? b.modifiedAt;
        return ta < tb ? 1 : ta > tb ? -1 : 0;
      });
    const page = sorted.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    const result: { items: SessionSummary[]; nextCursor?: string } = {
      items: page.map((rec) => this.sessionSummary(rec)),
    };
    if (nextOffset < sorted.length) result.nextCursor = String(nextOffset);
    this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, result });
  }

  // ── client-dispatchable actions (Phase 1) ──────────────────────────────

  /**
   * `dispatchAction` is a notification — the response is the `action`
   * notification stream itself. Phase 1 routes the client-dispatchable
   * actions VS Code sends; everything else is acknowledged with a
   * rejection on that stream.
   */
  private async handleDispatchAction(socketId: number, msg: RpcMessage): Promise<void> {
    const params = isRecord(msg.params) ? msg.params : {};
    const channel = params["channel"];
    const clientSeq = params["clientSeq"];
    const action = params["action"];
    if (
      typeof channel !== "string" ||
      channel.length === 0 ||
      !Number.isInteger(clientSeq) ||
      !isRecord(action) ||
      typeof action["type"] !== "string"
    ) {
      this.log(`malformed dispatchAction on socket ${socketId} (dropped)`);
      return;
    }

    const socket = this.sockets.get(socketId);
    const clientId = socket?.clientId ?? null;
    const origin: ActionOrigin | undefined =
      clientId !== null ? { clientId, clientSeq: clientSeq as number } : undefined;

    const stateAction = action as unknown as StateAction;
    const rejectionReason = this.dispatchRejectionReason(channel, stateAction, clientId);
    if (rejectionReason !== null) {
      this.echo(channel, stateAction, origin, rejectionReason);
      return;
    }

    const kind = channelKind(channel);
    if (kind === "changeset") {
      // The only client-dispatchable changeset action is the per-file
      // review toggle — echo it through the official reducer.
      if (stateAction.type === ActionType.ChangesetFilesReviewChanged) {
        this.dispatchChangesetFilesReviewChanged(channel, stateAction, origin);
      } else {
        this.echo(channel, stateAction, origin, `unsupported action on changeset channel: ${String(action.type)}`);
      }
      return;
    }
    if (kind !== "session" && kind !== "chat") {
      this.echo(channel, stateAction, origin, `unsupported action on ${channelKind(channel)} channel: ${String(action.type)}`);
      return;
    }
    const rec = this.byChannel.get(channel);
    if (rec === undefined) {
      this.echo(channel, stateAction, origin, `no such session: ${channel}`);
      return;
    }

    // From here on every branch either echoes (accepted or rejected).
    switch (stateAction.type) {
      case ActionType.ChatTurnStarted:
        await this.dispatchTurnStarted(rec, stateAction, origin);
        return;
      case ActionType.ChatPendingMessageSet:
        await this.dispatchPendingMessageSet(rec, stateAction, origin);
        return;
      case ActionType.ChatToolCallConfirmed:
        await this.dispatchToolCallConfirmed(rec, stateAction, origin);
        return;
      case ActionType.ChatToolCallComplete:
        await this.dispatchToolCallComplete(rec, stateAction, origin);
        return;
      case ActionType.ChatToolCallContentChanged:
        this.dispatchToolCallContentChanged(rec, stateAction, origin);
        return;
      case ActionType.ChatToolCallResultConfirmed:
        this.dispatchToolCallResultConfirmed(rec, stateAction, origin);
        return;
      case ActionType.ChatTurnCancelled:
        await this.dispatchTurnCancelled(rec, stateAction, origin);
        return;
      case ActionType.SessionTitleChanged:
        await this.dispatchTitleChanged(rec, stateAction, origin);
        return;
      case ActionType.SessionActiveClientSet:
        this.dispatchActiveClientSet(rec, stateAction, origin, clientId);
        return;
      case ActionType.SessionActiveClientRemoved:
        this.dispatchActiveClientRemoved(rec, stateAction, origin, clientId);
        return;
      case ActionType.ChatPendingMessageRemoved:
        // Honest gap: the opencode plugin surface has no inbox cancel —
        // a pending (steer/queue) message cannot be withdrawn once sent.
        this.echo(channel, stateAction, origin, "cannot remove a pending message: opencode has no inbox cancel");
        return;
      case ActionType.ChatDraftChanged:
      case ActionType.ChatIsReadChanged:
      case ActionType.ChatIsArchivedChanged:
      case ActionType.SessionIsReadChanged:
      case ActionType.SessionIsArchivedChanged:
        this.echo(channel, stateAction, origin);
        return;
      default:
        this.echo(channel, stateAction, origin, `unsupported action (Phase 1): ${String(stateAction.type)}`);
    }
  }

  /**
   * Shared pre-checks for a dispatched action; null when the action may
   * proceed to per-type handling.
   */
  private dispatchRejectionReason(channel: string, action: StateAction, clientId: string | null): string | null {
    if (channelKind(channel) === "unknown") return `unknown channel: ${channel}`;
    let dispatchable: boolean;
    try {
      dispatchable = isClientDispatchable(action as Parameters<typeof isClientDispatchable>[0]);
    } catch {
      dispatchable = false;
    }
    if (!dispatchable) return `action ${String(action.type)} is not client-dispatchable`;
    if (clientId === null) return "client is not initialized";
    return null;
  }

  /** Publish an accepted echo (or a rejection) on the action stream. */
  private echo(
    channel: string,
    action: StateAction,
    origin: ActionOrigin | undefined,
    rejectionReason?: string,
  ): void {
    const envelope = this.publish({
      channel,
      action,
      origin,
      ...(rejectionReason !== undefined ? { rejectionReason } : {}),
    });
    if (rejectionReason !== undefined && origin !== undefined) {
      // A rejection must reach the dispatching socket even when it is not
      // subscribed to the channel (write-ahead dispatch: the client applied
      // the action optimistically and needs the rejection to roll it back).
      const socketId = this.socketIdForClient(origin.clientId);
      if (socketId !== undefined && !this.channels.socketsSubscribedTo(channel).includes(socketId)) {
        this.opts.send(socketId, { jsonrpc: "2.0", method: "action", params: envelope });
      }
    }
  }

  /** The socket currently bound to a clientId (rejection delivery target). */
  private socketIdForClient(clientId: string): number | undefined {
    for (const [socketId, socket] of this.sockets) {
      if (socket.clientId === clientId) return socketId;
    }
    return undefined;
  }

  private async dispatchTurnStarted(rec: SessionRecord, action: StateAction, origin: ActionOrigin | undefined): Promise<void> {
    const chatURI = chatChannelURI(rec.sessionID);
    const a = action as ChatTurnStartedAction;
    const turnId = typeof a.turnId === "string" && a.turnId.length > 0 ? a.turnId : null;
    const message =
      isRecord(a.message) && typeof a.message["text"] === "string"
        ? (a.message as unknown as Message)
        : null;
    if (turnId === null || message === null) {
      this.echo(chatURI, action, origin, "invalid chat/turnStarted params");
      return;
    }
    // `startedAt` is required on the wire (the reducer uses it for the
    // chat's `modifiedAt`); fall back to the host clock when the client
    // did not supply a parseable one.
    const normalized: ChatTurnStartedAction =
      typeof a.startedAt === "string" && !Number.isNaN(Date.parse(a.startedAt))
        ? a
        : { ...a, startedAt: new Date().toISOString() };
    if (rec.chatStore.state.activeTurn !== undefined) {
      this.echo(
        chatURI,
        action,
        origin,
        "a turn is already active; follow-up messages go via chat/pendingMessageSet",
      );
      return;
    }

    // Apply the message's model/agent selection before the prompt
    // (`SessionPromptInput` carries no model/agent fields).
    try {
      if (message.model?.id !== undefined && message.model.id.includes("/")) {
        const sep = message.model.id.indexOf("/");
        const providerID = message.model.id.slice(0, sep);
        const modelID = message.model.id.slice(sep + 1);
        if (providerID.length > 0 && modelID.length > 0) {
          await this.opts.facade.switchModel({ sessionID: rec.sessionID, model: { providerID, modelID } });
        }
      }
      if (message.agent?.uri !== undefined) {
        const agentID = agentIDFromUri(message.agent.uri);
        if (agentID !== null) {
          await this.opts.facade.switchAgent({ sessionID: rec.sessionID, agent: agentID });
        }
      }
    } catch (err) {
      this.echo(chatURI, action, origin, `failed to apply model/agent selection: ${errorMessage(err)}`);
      return;
    }

    // Write-ahead: claim the turn BEFORE the prompt so the
    // `session.execution.started` event joins it even when it races the
    // prompt's resolve; revert on failure.
    rec.currentTurnId = turnId;
    rec.turnStartedAt = Date.now();
    try {
      await this.opts.facade.prompt({ sessionID: rec.sessionID, text: message.text });
    } catch (err) {
      rec.currentTurnId = null;
      rec.turnStartedAt = null;
      this.echo(chatURI, action, origin, `prompt failed: ${errorMessage(err)}`);
      return;
    }
    this.echo(chatURI, normalized, origin);
  }

  private async dispatchPendingMessageSet(rec: SessionRecord, action: StateAction, origin: ActionOrigin | undefined): Promise<void> {
    const chatURI = chatChannelURI(rec.sessionID);
    const a = action as { kind?: unknown; id?: unknown; message?: unknown };
    const kind = a.kind === "steering" || a.kind === "queued" ? a.kind : null;
    const id = typeof a.id === "string" && a.id.length > 0 ? a.id : null;
    const message =
      isRecord(a.message) && typeof a.message["text"] === "string"
        ? (a.message as unknown as Message)
        : null;
    if (kind === null || id === null || message === null) {
      this.echo(chatURI, action, origin, "invalid chat/pendingMessageSet params");
      return;
    }
    const hasActiveTurn = rec.chatStore.state.activeTurn !== undefined;
    // steer → delivery "steer" (only while a turn is active); queued →
    // delivery "queue"; a steering message with no active turn falls back
    // to a plain prompt (it becomes the next turn).
    const delivery: FacadeDelivery | undefined = hasActiveTurn
      ? kind === "steering"
        ? "steer"
        : "queue"
      : undefined;
    try {
      await this.opts.facade.prompt({ sessionID: rec.sessionID, text: message.text, delivery });
    } catch (err) {
      this.echo(chatURI, action, origin, `prompt failed: ${errorMessage(err)}`);
      return;
    }
    if (hasActiveTurn) {
      this.echo(chatURI, action, origin);
      return;
    }
    // No active turn: the message starts a turn right now. Echo the
    // pending-message first, then a host-minted turnStarted carrying
    // `queuedMessageId` — the reducer dequeues it.
    this.echo(chatURI, action, origin);
    const turnId = this.mintTurnId();
    rec.currentTurnId = turnId;
    rec.turnStartedAt = Date.now();
    this.publish({
      channel: chatURI,
      action: {
        type: ActionType.ChatTurnStarted,
        turnId,
        startedAt: new Date().toISOString(),
        message,
        queuedMessageId: id,
      },
    });
  }

  private async dispatchToolCallConfirmed(rec: SessionRecord, action: StateAction, origin: ActionOrigin | undefined): Promise<void> {
    const chatURI = chatChannelURI(rec.sessionID);
    const a = action as ChatToolCallConfirmedAction;
    const toolCallId = typeof a.toolCallId === "string" ? a.toolCallId : null;
    if (toolCallId === null) {
      this.echo(chatURI, action, origin, "invalid chat/toolCallConfirmed params");
      return;
    }
    const permissionID = rec.permissionForTool.get(toolCallId);
    if (permissionID === undefined) {
      this.echo(chatURI, action, origin, `no pending permission for tool call ${toolCallId}`);
      return;
    }
    try {
      await this.opts.facade.replyPermission({
        sessionID: rec.sessionID,
        requestID: permissionID,
        decision: a.approved === true ? "once" : "reject",
      });
    } catch (err) {
      this.echo(chatURI, action, origin, `permission reply failed: ${errorMessage(err)}`);
      return;
    }
    // Echo the confirmation (reducer → running/cancelled), then clear the
    // session-level input request. The `permission.replied` event is a
    // safety net (its tracking is already gone → no-op).
    this.echo(chatURI, action, origin);
    this.publish({
      channel: rec.channel,
      action: { type: ActionType.SessionInputNeededRemoved, id: toolCallId },
    });
    rec.permissionForTool.delete(toolCallId);
    rec.toolForPermission.delete(permissionID);
  }

  // ── Phase 4 extension 1: client-executed tool calls ───────────────────

  /**
   * `chat/toolCallComplete` (client-dispatchable): the owning client
   * finished executing a delegated tool call. Only valid for
   * client-executed calls (the host emits its own complete for
   * server-executed ones); the dispatching client must be the
   * contributor. Echoes the action (reducer: running → completed, or
   * → pending-result-confirmation when `requiresResultConfirmation`),
   * clears the execution input request, and settles the opencode-side
   * waiter with the client's result.
   */
  private async dispatchToolCallComplete(rec: SessionRecord, action: StateAction, origin: ActionOrigin | undefined): Promise<void> {
    const chatURI = chatChannelURI(rec.sessionID);
    const a = action as ChatToolCallCompleteAction;
    const toolCallId = typeof a.toolCallId === "string" ? a.toolCallId : null;
    const invocation = toolCallId !== null ? rec.clientToolCalls.get(toolCallId) : undefined;
    if (toolCallId === null || invocation === undefined) {
      this.echo(chatURI, action, origin, `tool call ${toolCallId ?? "?"} is not a client-executed call`);
      return;
    }
    if (origin !== undefined && invocation.clientId !== origin.clientId) {
      this.echo(chatURI, action, origin, `only the contributing client (${invocation.clientId}) may complete this call`);
      return;
    }
    const result = normalizeToolCallResult(a.result);
    if (result === null) {
      this.echo(chatURI, action, origin, "invalid chat/toolCallComplete params (result.success must be a boolean)");
      return;
    }
    const status = this.toolCallState(rec, toolCallId)?.status;
    if (status !== ToolCallStatus.Running && status !== ToolCallStatus.PendingConfirmation) {
      this.echo(chatURI, action, origin, `tool call ${toolCallId} is not ready to complete (status ${status ?? "absent"})`);
      return;
    }
    const requiresConfirmation = a.requiresResultConfirmation === true;
    // Echo first: the reducer moves running → completed (or
    // pending-result-confirmation); the settle below must observe the
    // new state for the confirmation input request.
    this.echo(chatURI, action, origin);
    if (requiresConfirmation) {
      // Hold the client's result until the approval reply; surface the
      // user-facing confirmation on the session channel (this variant,
      // unlike the execution request, raises SessionStatus.InputNeeded).
      invocation.pendingResult = result;
      const pending = this.pendingToolCall(rec, toolCallId);
      if (pending !== null && rec.currentTurnId !== null) {
        this.publish({
          channel: rec.channel,
          action: {
            type: ActionType.SessionInputNeededSet,
            request: {
              id: toolCallId,
              chat: chatURI,
              kind: SessionInputRequestKind.ToolConfirmation,
              turnId: rec.currentTurnId,
              toolCall: pending,
            } satisfies SessionToolConfirmationRequest,
          },
        });
      }
    } else {
      this.publish({
        channel: rec.channel,
        action: { type: ActionType.SessionInputNeededRemoved, id: toolCallId },
      });
      this.settleClientTool(rec, invocation, clientResultToFacade(result));
    }
  }

  /**
   * `chat/toolCallContentChanged` (client-dispatchable): the owning
   * client streams partial content while executing (the reducer
   * replaces the running call's `content`). Echo-only — opencode needs
   * no counterpart; the spec says the server SHOULD reject dispatches
   * from a client that is not the contributor.
   */
  private dispatchToolCallContentChanged(rec: SessionRecord, action: StateAction, origin: ActionOrigin | undefined): void {
    const chatURI = chatChannelURI(rec.sessionID);
    const a = action as ChatToolCallContentChangedAction;
    const toolCallId = typeof a.toolCallId === "string" ? a.toolCallId : null;
    const invocation = toolCallId !== null ? rec.clientToolCalls.get(toolCallId) : undefined;
    if (toolCallId === null || invocation === undefined) {
      this.echo(chatURI, action, origin, `tool call ${toolCallId ?? "?"} is not a client-executed call`);
      return;
    }
    if (origin !== undefined && invocation.clientId !== origin.clientId) {
      this.echo(chatURI, action, origin, `only the contributing client (${invocation.clientId}) may stream content for this call`);
      return;
    }
    if (!Array.isArray(a.content)) {
      this.echo(chatURI, action, origin, "invalid chat/toolCallContentChanged params (content must be an array)");
      return;
    }
    if (this.toolCallState(rec, toolCallId)?.status !== ToolCallStatus.Running) {
      this.echo(chatURI, action, origin, `tool call ${toolCallId} is not running`);
      return;
    }
    this.echo(chatURI, action, origin);
  }

  /**
   * `chat/toolCallResultConfirmed` (client-dispatchable): the user
   * approved or denied a client tool's result after a
   * `requiresResultConfirmation` completion. Echoes (reducer:
   * pending-result-confirmation → completed / cancelled with reason
   * `result-denied`), clears the confirmation input request, and
   * settles the opencode-side waiter (approved → the held client
   * result; denied → a Tool.Error the model sees).
   */
  private dispatchToolCallResultConfirmed(rec: SessionRecord, action: StateAction, origin: ActionOrigin | undefined): void {
    const chatURI = chatChannelURI(rec.sessionID);
    const a = action as ChatToolCallResultConfirmedAction;
    const toolCallId = typeof a.toolCallId === "string" ? a.toolCallId : null;
    if (toolCallId === null || typeof a.approved !== "boolean") {
      this.echo(chatURI, action, origin, "invalid chat/toolCallResultConfirmed params");
      return;
    }
    const invocation = rec.clientToolCalls.get(toolCallId);
    if (invocation === undefined) {
      this.echo(chatURI, action, origin, `no pending result confirmation for tool call ${toolCallId}`);
      return;
    }
    if (origin !== undefined && invocation.clientId !== origin.clientId) {
      this.echo(chatURI, action, origin, `only the contributing client (${invocation.clientId}) may confirm this result`);
      return;
    }
    if (this.toolCallState(rec, toolCallId)?.status !== ToolCallStatus.PendingResultConfirmation) {
      this.echo(chatURI, action, origin, `tool call ${toolCallId} is not awaiting result confirmation`);
      return;
    }
    this.echo(chatURI, action, origin);
    this.publish({
      channel: rec.channel,
      action: { type: ActionType.SessionInputNeededRemoved, id: toolCallId },
    });
    const held = invocation.pendingResult;
    if (held === undefined) {
      // Unreachable in practice (the state only reaches
      // pending-result-confirmation through our complete path); fail
      // closed so the opencode tool cannot hang.
      this.settleClientTool(rec, invocation, { ok: false, error: "no recorded result to confirm" });
      return;
    }
    if (a.approved) {
      this.settleClientTool(rec, invocation, clientResultToFacade(held as ToolCallResult));
    } else {
      this.settleClientTool(rec, invocation, { ok: false, error: "the client denied the tool result" });
    }
  }

  private async dispatchTurnCancelled(rec: SessionRecord, action: StateAction, origin: ActionOrigin | undefined): Promise<void> {
    const chatURI = chatChannelURI(rec.sessionID);
    const a = action as ChatTurnCancelledAction;
    const turnId = typeof a.turnId === "string" && a.turnId.length > 0 ? a.turnId : null;
    const active = rec.chatStore.state.activeTurn;
    if (turnId === null || active === undefined || active.id !== turnId) {
      this.echo(chatURI, action, origin, "no active turn to cancel");
      return;
    }
    try {
      await this.opts.facade.interrupt({ sessionID: rec.sessionID });
    } catch (err) {
      this.echo(chatURI, action, origin, `interrupt failed: ${errorMessage(err)}`);
      return;
    }
    // `duration` is required on the wire (the reducer derives the final
    // `modifiedAt` from it); the host clock is authoritative when the
    // client did not supply one.
    const duration =
      typeof a.duration === "number" && Number.isFinite(a.duration) ? a.duration : this.turnDuration(rec);
    this.echo(chatURI, { ...a, duration }, origin);
    // The opencode `session.execution.interrupted` event finds no active
    // turn after the echo finalized it (skipped); run the queued/steering
    // handoff now, on the host side.
    await this.finishTurn(rec);
  }

  /**
   * `changeset/filesReviewChanged` (the only client-dispatchable changeset
   * action): validate the channel resolves to a live store, then echo —
   * the official reducer toggles `reviewed` per matched file id.
   */
  private dispatchChangesetFilesReviewChanged(channel: string, action: StateAction, origin: ActionOrigin | undefined): void {
    const a = action as ChangesetFilesReviewChangedAction;
    if (!Array.isArray(a.files) || !a.files.every((f) => typeof f === "string") || typeof a.reviewed !== "boolean") {
      this.echo(channel, action, origin, "invalid changeset/filesReviewChanged params");
      return;
    }
    const parsed = parseChangesetChannel(channel);
    const rec = parsed !== null ? this.sessions.get(parsed.sessionID) : undefined;
    const store = rec !== undefined ? rec.changesets.get(channel) : undefined;
    if (rec === undefined || store === undefined) {
      this.echo(channel, action, origin, "no such changeset");
      return;
    }
    this.echo(channel, action, origin);
  }

  private async dispatchTitleChanged(rec: SessionRecord, action: StateAction, origin: ActionOrigin | undefined): Promise<void> {
    const a = action as { title?: unknown };
    const title = typeof a.title === "string" && a.title.length > 0 ? a.title : null;
    if (title === null) {
      this.echo(rec.channel, action, origin, "invalid session/titleChanged params");
      return;
    }
    try {
      await this.opts.facade.rename({ sessionID: rec.sessionID, title });
    } catch (err) {
      this.echo(rec.channel, action, origin, `rename failed: ${errorMessage(err)}`);
      return;
    }
    this.echo(rec.channel, action, origin);
  }

  private dispatchActiveClientSet(
    rec: SessionRecord,
    action: StateAction,
    origin: ActionOrigin | undefined,
    clientId: string | null,
  ): void {
    const a = action as { activeClient?: unknown };
    const ac = a.activeClient;
    if (!isRecord(ac) || typeof ac["clientId"] !== "string" || (clientId !== null && ac["clientId"] !== clientId)) {
      this.echo(rec.channel, action, origin, "activeClient.clientId must match the dispatching client");
      return;
    }
    const tools = normalizeToolDefinitions(ac["tools"]);
    const normalized: SessionActiveClient = {
      clientId: ac["clientId"] as string,
      tools,
      ...(typeof ac["displayName"] === "string" ? { displayName: ac["displayName"] as string } : {}),
    };
    this.publish({
      channel: rec.channel,
      action: { type: ActionType.SessionActiveClientSet, activeClient: normalized },
      origin,
    });
    // Phase 4 extension 1: the session's tool contribution changed —
    // re-sync the location-global opencode tool union.
    void this.syncClientToolsToOpencode();
  }

  private dispatchActiveClientRemoved(
    rec: SessionRecord,
    action: StateAction,
    origin: ActionOrigin | undefined,
    clientId: string | null,
  ): void {
    const a = action as { clientId?: unknown };
    if (typeof a.clientId !== "string" || (clientId !== null && a.clientId !== clientId)) {
      this.echo(rec.channel, action, origin, "clientId must match the dispatching client");
      return;
    }
    this.echo(rec.channel, action, origin);
    // Phase 4 extension 1: the session's tool contribution shrank —
    // re-sync the location-global opencode tool union.
    void this.syncClientToolsToOpencode();
  }

  // ── opencode event pump handlers ───────────────────────────────────────

  private async handleEvent(ev: FacadeEvent): Promise<void> {
    if (ev.type === "session.created") {
      if (this.sessions.has(ev.sessionID)) return;
      // Deferred registration: a concurrent `createSession` may still be
      // resolving for this opencode session under a client-chosen channel;
      // the grace + existence check avoids the double registration, and
      // the delete+recreate remap in `handleCreateSession` heals the slow
      // path.
      const sessionID = ev.sessionID;
      setTimeout(() => {
        void this.registerExternalDeferred(sessionID).catch((err) =>
          this.log(`external session registration failed: ${errorMessage(err)}`),
        );
      }, EXTERNAL_REGISTER_GRACE_MS);
      return;
    }

    const rec = this.sessions.get(ev.sessionID);
    if (rec === undefined) return; // only session.created registers sessions

    const chatURI = chatChannelURI(rec.sessionID);
    switch (ev.type) {
      case "session.deleted":
        this.removeRecord(rec);
        return;
      case "session.renamed":
        this.publish({ channel: rec.channel, action: { type: ActionType.SessionTitleChanged, title: ev.title } });
        return;
      case "inbox.enqueued":
        rec.lastInbox = { text: ev.text, delivery: ev.delivery };
        return;
      case "inbox.delivered":
        // Steering consumption is handled at turn end (finishTurn).
        return;
      case "execution.started":
        if (rec.currentTurnId !== null) return; // write-ahead already claimed the turn
        // Orphan turn (an external TUI prompt, or a handoff this host did
        // not initiate): start it with the last-seen inbox message.
        this.startTurn(rec, rec.lastInbox !== null ? userMessage(rec.lastInbox.text) : userMessage(""));
        return;
      case "execution.succeeded":
        if (rec.currentTurnId === null) return;
        this.publish({
          channel: chatURI,
          action: { type: ActionType.ChatTurnComplete, turnId: rec.currentTurnId, duration: this.turnDuration(rec) },
        });
        await this.finishTurn(rec);
        return;
      case "execution.failed":
        if (rec.currentTurnId === null) return;
        const part: ErrorResponsePart = {
          kind: ResponsePartKind.Error,
          error: { errorType: ev.error.type, message: ev.error.message },
        };
        this.publish({
          channel: chatURI,
          action: { type: ActionType.ChatError, turnId: rec.currentTurnId, duration: this.turnDuration(rec), part },
        });
        await this.finishTurn(rec);
        return;
      case "execution.interrupted":
        // Skipped when the client's own `chat/turnCancelled` echo already
        // finalized the turn (currentTurnId is null).
        if (rec.currentTurnId === null) return;
        this.publish({
          channel: chatURI,
          action: { type: ActionType.ChatTurnCancelled, turnId: rec.currentTurnId, duration: this.turnDuration(rec) },
        });
        await this.finishTurn(rec);
        return;
      case "step.started":
        rec.turnModelRef = `${ev.model.providerID}/${ev.model.modelID}`;
        return;
      case "text.delta":
      case "reasoning.delta": {
        if (rec.currentTurnId === null) return;
        const kind = ev.type === "text.delta" ? ResponsePartKind.Markdown : ResponsePartKind.Reasoning;
        const key = `${ev.assistantMessageID}:${kind}:${ev.ordinal}`;
        const first = !rec.parts.has(key);
        rec.parts.add(key);
        const partId = `part-${key}`;
        if (first) {
          // Lazily emit the part on the first delta; it carries the
          // initial content.
          this.publish({
            channel: chatURI,
            action: {
              type: ActionType.ChatResponsePart,
              turnId: rec.currentTurnId,
              part: { kind, id: partId, content: ev.delta },
            },
          });
        } else {
          this.publish({
            channel: chatURI,
            action:
              kind === ResponsePartKind.Markdown
                ? { type: ActionType.ChatDelta, turnId: rec.currentTurnId, partId, content: ev.delta }
                : { type: ActionType.ChatReasoning, turnId: rec.currentTurnId, partId, content: ev.delta },
          });
        }
        return;
      }
      case "text.ended":
      case "reasoning.ended": {
        if (rec.currentTurnId === null) return;
        // Fallback for non-streaming providers that emit only the final
        // text: if no delta opened the part, emit it now with the full text.
        const kind = ev.type === "text.ended" ? ResponsePartKind.Markdown : ResponsePartKind.Reasoning;
        const key = `${ev.assistantMessageID}:${kind}:${ev.ordinal}`;
        if (!rec.parts.has(key)) {
          rec.parts.add(key);
          this.publish({
            channel: chatURI,
            action: {
              type: ActionType.ChatResponsePart,
              turnId: rec.currentTurnId,
              part: { kind, id: `part-${key}`, content: ev.text },
            },
          });
        }
        return;
      }
      case "tool.input.started": {
        if (rec.currentTurnId === null) {
          this.log(`tool.input.started outside a turn (session ${rec.sessionID}, tool ${ev.name}); ignored`);
          return;
        }
        rec.toolName.set(ev.id, ev.name);
        // Phase 4 extension 1: when the session's active clients provide
        // this tool, the call is client-executed — the client
        // `contributor` must be established at start (the official
        // reducer ignores a late one), and the call is tracked for the
        // `execute` bridge + the client's dispatchable actions.
        const clientTool = this.clientToolContributor(rec, ev.name);
        if (clientTool !== null) {
          rec.clientToolCalls.set(ev.id, { clientId: clientTool, turnId: rec.currentTurnId });
        }
        this.publish({
          channel: chatURI,
          action: {
            type: ActionType.ChatToolCallStart,
            turnId: rec.currentTurnId,
            toolCallId: ev.id,
            toolName: ev.name,
            displayName: displayNameFor(ev.name),
            ...(clientTool !== null
              ? { contributor: { kind: ToolCallContributorKind.Client, clientId: clientTool } }
              : {}),
          },
        });
        return;
      }
      case "tool.input.ended": {
        rec.toolInput.set(ev.id, ev.text);
        // Phase 2: for file-mutating tools, capture the pre-edit file
        // content now (the event fires before execution — the last safe
        // point). Awaited in the sequential pump so the capture is
        // complete before `execution.*` can end the turn.
        if (this.opts.changesets) await this.captureTurnBefore(rec, ev.id, ev.text);
        // Phase 4 extension 1: a client-executed call clears its
        // confirmation gate here (no opencode permission can fire for
        // it) — ready straight to running, then surface the execution
        // request so the owning client picks up the work.
        if (rec.clientToolCalls.has(ev.id)) {
          this.ensureToolReady(rec, ev.id, false);
          const invocation = rec.clientToolCalls.get(ev.id);
          const running = this.toolCallState(rec, ev.id);
          if (invocation !== undefined && running !== null && running.status === ToolCallStatus.Running && rec.currentTurnId !== null) {
            const request: SessionToolClientExecutionRequest = {
              id: ev.id,
              chat: chatURI,
              kind: SessionInputRequestKind.ToolClientExecution,
              turnId: rec.currentTurnId,
              clientId: invocation.clientId,
              toolCall: running,
            };
            this.publish({
              channel: rec.channel,
              action: { type: ActionType.SessionInputNeededSet, request },
            });
          }
        }
        return;
      }
      case "tool.progress":
        // First sign the tool is actually running (opencode auto-approved):
        // finalize the tool call as running.
        this.ensureToolReady(rec, ev.id, false);
        return;
      case "tool.success": {
        if (rec.currentTurnId === null) return;
        this.ensureToolReady(rec, ev.id, false);
        if (this.toolCallTerminal(rec, ev.id)) {
          // e.g. denied → already cancelled, or a client-executed call
          // the client already completed: no echo, but the tracking
          // (including the client-tool record) must still be cleared.
          this.clearToolTracking(rec, ev.id);
          return;
        }
        const name = rec.toolName.get(ev.id) ?? "tool";
        const input = rec.toolInput.get(ev.id);
        this.publish({
          channel: chatURI,
          action: {
            type: ActionType.ChatToolCallComplete,
            turnId: rec.currentTurnId,
            toolCallId: ev.id,
            result: {
              success: true,
              pastTenseMessage: pastTenseMessageFor(name, input),
              content: mapToolResultContent(ev.content),
            },
          },
        });
        this.clearToolTracking(rec, ev.id);
        return;
      }
      case "tool.failed": {
        if (rec.currentTurnId === null) return;
        this.ensureToolReady(rec, ev.id, false);
        if (this.toolCallTerminal(rec, ev.id)) {
          // Already terminal (client-executed call completed by the
          // client, or a call cancelled upstream) — clear the tracking.
          this.clearToolTracking(rec, ev.id);
          return;
        }
        const name = rec.toolName.get(ev.id) ?? "tool";
        const input = rec.toolInput.get(ev.id);
        this.publish({
          channel: chatURI,
          action: {
            type: ActionType.ChatToolCallComplete,
            turnId: rec.currentTurnId,
            toolCallId: ev.id,
            result: {
              success: false,
              pastTenseMessage: pastTenseMessageFor(name, input),
              error: { message: ev.error.message },
            },
          },
        });
        this.clearToolTracking(rec, ev.id);
        return;
      }
      case "usage.updated":
        // Session-cumulative tokens; the chat reducer replaces the turn's
        // usage, so the latest cumulative values are the turn's view.
        if (rec.currentTurnId === null) return;
        this.publish({
          channel: chatURI,
          action: {
            type: ActionType.ChatUsage,
            turnId: rec.currentTurnId,
            usage: {
              inputTokens: ev.tokens.input,
              outputTokens: ev.tokens.output,
              cacheReadTokens: ev.tokens.cache.read,
              ...(rec.turnModelRef !== null ? { model: rec.turnModelRef } : {}),
            },
          },
        });
        return;
      case "permission.asked":
        // Only tool-sourced permissions map to a tool confirmation;
        // anything else has no AHP counterpart in this MVP (gap).
        if (ev.source === undefined) {
          this.log(`ignoring non-tool permission.asked ${ev.id} (action: ${ev.action})`);
          return;
        }
        const toolCallId = ev.source.id;
        rec.permissionForTool.set(toolCallId, ev.id);
        rec.toolForPermission.set(ev.id, toolCallId);
        this.ensureToolReady(rec, toolCallId, true);
        const pending = this.pendingToolCall(rec, toolCallId);
        if (pending !== null && rec.currentTurnId !== null) {
          const request: SessionToolConfirmationRequest = {
            id: toolCallId,
            chat: chatURI,
            kind: SessionInputRequestKind.ToolConfirmation,
            turnId: rec.currentTurnId,
            toolCall: pending,
          };
          this.publish({
            channel: rec.channel,
            action: { type: ActionType.SessionInputNeededSet, request },
          });
        }
        return;
      case "permission.replied": {
        const toolCallId = rec.toolForPermission.get(ev.requestID);
        rec.toolForPermission.delete(ev.requestID);
        if (toolCallId !== undefined) {
          rec.permissionForTool.delete(toolCallId);
          // Safety net: the client's `chat/toolCallConfirmed` normally
          // removes the input request first; this covers the reply
          // arriving without (or before) the echo.
          this.publish({
            channel: rec.channel,
            action: { type: ActionType.SessionInputNeededRemoved, id: toolCallId },
          });
        }
        return;
      }
      default:
        return;
    }
  }

  // ── turn helpers ───────────────────────────────────────────────────────

  private mintTurnId(): string {
    this.turnCounter += 1;
    return `turn_${Date.now().toString(36)}_${this.turnCounter.toString(36)}`;
  }

  private turnDuration(rec: SessionRecord): number {
    return Math.max(0, Date.now() - (rec.turnStartedAt ?? Date.now()));
  }

  /** Claim a turn (write-ahead) and publish `chat/turnStarted`. */
  private startTurn(rec: SessionRecord, message: Message, queuedMessageId?: string): void {
    const turnId = this.mintTurnId();
    rec.currentTurnId = turnId;
    rec.turnStartedAt = Date.now();
    this.publish({
      channel: chatChannelURI(rec.sessionID),
      action: {
        type: ActionType.ChatTurnStarted,
        turnId,
        startedAt: new Date().toISOString(),
        message,
        ...(queuedMessageId !== undefined ? { queuedMessageId } : {}),
      },
    });
  }

  /**
   * After a turn terminal: clear the steering message opencode consumed
   * during the turn, and auto-start the next turn from the queue (the
   * queued prompt was already sent with `delivery: "queue"` — opencode
   * starts it automatically; this only updates the AHP state).
   *
   * Phase 2: then refresh the session's changesets — the turn's captured
   * "after" content is read from disk here, and the uncommitted/session/
   * turn changesets recompute (async: awaits the facade).
   */
  private async finishTurn(rec: SessionRecord): Promise<void> {
    const endedTurnId = rec.currentTurnId;
    rec.currentTurnId = null;
    rec.turnStartedAt = null;
    const state = rec.chatStore.state;
    if (state.steeringMessage !== undefined) {
      this.publish({
        channel: chatChannelURI(rec.sessionID),
        action: {
          type: ActionType.ChatPendingMessageRemoved,
          kind: PendingMessageKind.Steering,
          id: state.steeringMessage.id,
        },
      });
    }
    const queued = state.queuedMessages;
    if (queued !== undefined && queued.length > 0) {
      const next = queued[0]!;
      this.startTurn(rec, next.message, next.id);
    } else if (rec.lastInbox !== null && rec.lastInbox.delivery === "queue") {
      // A queued prompt from outside AHP (e.g. the TUI).
      this.startTurn(rec, userMessage(rec.lastInbox.text));
    }
    if (this.opts.changesets && endedTurnId !== null) {
      await this.refreshTurnChangesets(rec, endedTurnId);
    }
  }

  // ── Phase 2: changesets ────────────────────────────────────────────────

  /**
   * Capture the pre-edit content of a file-mutating tool's target file for
   * the current turn's changeset (first capture per file wins — the
   * pre-turn content survives later edits in the same turn). No-op when
   * the tool is not file-mutating, the input carries no parseable path,
   * or the path resolves outside the location directory.
   */
  private async captureTurnBefore(rec: SessionRecord, toolCallId: string, inputJson: string): Promise<void> {
    const turnId = rec.currentTurnId;
    const toolName = rec.toolName.get(toolCallId);
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
    // call and the await — but the record may be gone (session deleted).
    if (rec.currentTurnId !== turnId || !this.sessions.has(rec.sessionID)) return;
    const turnFiles = rec.turnSnapshots.get(turnId) ?? new Map();
    if (!turnFiles.has(absPath)) turnFiles.set(absPath, { before, after: null });
    rec.turnSnapshots.set(turnId, turnFiles);
  }

  /** Resolve a tool-input path against the location directory (must stay inside it). */
  private resolveSnapshotPath(rawPath: string): string | null {
    const dir = this.opts.defaultDirectory;
    if (dir === undefined) return null;
    const absPath = resolvePath(dir, rawPath);
    return isPathInside(absPath, dir) ? absPath : null;
  }

  /** Get-or-create the changeset store for a URI (fresh stores start computing). */
  private changesetStore(rec: SessionRecord, uri: string): ChangesetStateStore {
    let store = rec.changesets.get(uri);
    if (store === undefined) {
      store = createChangesetStateStore({ status: ChangesetStatus.Computing, files: [] });
      rec.changesets.set(uri, store);
    }
    return store;
  }

  /** The store's current per-file review flags, keyed by file id. */
  private reviewedById(store: ChangesetStateStore): Map<string, boolean> {
    const out = new Map<string, boolean>();
    for (const f of store.state.files) {
      if (typeof f.reviewed === "boolean") out.set(f.id, f.reviewed);
    }
    return out;
  }

  /**
   * Recompute one changeset and publish the delta (gateway's
   * `updateChangesetChannel` pattern): `changeset/contentChanged` when the
   * file list changed (the discard operation is (re)attached while files
   * exist, and cleared when they vanish), then `changeset/statusChanged`
   * to ready when the status was not ready. A failed computation publishes
   * `changeset/statusChanged` with an error.
   */
  private async refreshChangeset(rec: SessionRecord, uri: string): Promise<void> {
    const parsed = parseChangesetChannel(uri);
    if (parsed === null) return;
    const store = this.changesetStore(rec, uri);
    let files;
    try {
      if (parsed.kind === "turn") {
        files = buildTurnChangesetFiles({
          sessionID: parsed.sessionID,
          turnId: parsed.turnId ?? "",
          files: rec.turnSnapshots.get(parsed.turnId ?? "") ?? new Map(),
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
  private async refreshTurnChangesets(rec: SessionRecord, turnId: string): Promise<void> {
    const turnFiles = rec.turnSnapshots.get(turnId);
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
    for (const uri of [
      uncommittedChangesetURI(rec.sessionID),
      sessionChangesetURI(rec.sessionID),
      turnChangesetURI(rec.sessionID, turnId),
    ]) {
      if (rec.changesets.has(uri)) await this.refreshChangeset(rec, uri);
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
  private async handleResourceRead(socketId: number, msg: RpcMessage): Promise<void> {
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
    // snap — in-memory turn snapshot of a live session.
    const rec = this.sessions.get(ref.sessionID);
    if (rec === undefined) {
      this.sendError(socketId, msg.id, ERROR_NOT_FOUND, "no such session");
      return;
    }
    const snap = rec.turnSnapshots.get(ref.turnId)?.get(ref.path);
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
  private async handleInvokeChangesetOperation(socketId: number, msg: RpcMessage): Promise<void> {
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
    const rec = this.sessions.get(parsed.sessionID);
    if (rec === undefined) {
      this.sendError(socketId, msg.id, ERROR_SESSION_NOT_FOUND, "no such session");
      return;
    }
    const store = rec.changesets.get(channel);
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
        await this.restoreTurnFile(rec, parsed.turnId, absPath);
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
  private async restoreTurnFile(rec: SessionRecord, turnId: string, absPath: string): Promise<void> {
    const snap = rec.turnSnapshots.get(turnId)?.get(absPath);
    const before = snap?.before ?? null;
    if (before === null) {
      await this.opts.facade.deleteFile(absPath);
    } else {
      await this.opts.facade.writeFile(absPath, before);
    }
  }

  /**
   * Lazily publish `chat/toolCallReady` for a tool call (first of
   * progress/success/failed/permission.asked):
   *  - permission trigger → no `confirmed` → the reducer parks it in
   *    `pending-confirmation` (the caller then raises `inputNeededSet`);
   *  - otherwise → `confirmed: "not-needed"` → straight to `running`
   *    (opencode auto-approved).
   */
  private ensureToolReady(rec: SessionRecord, toolCallId: string, permission: boolean): void {
    if (rec.toolReady.has(toolCallId) || rec.currentTurnId === null) return;
    rec.toolReady.add(toolCallId);
    const name = rec.toolName.get(toolCallId) ?? "tool";
    const input = rec.toolInput.get(toolCallId);
    this.publish({
      channel: chatChannelURI(rec.sessionID),
      action: {
        type: ActionType.ChatToolCallReady,
        turnId: rec.currentTurnId,
        toolCallId,
        invocationMessage: invocationMessageFor(name, input),
        toolInput: input,
        ...(permission ? {} : { confirmed: ToolCallConfirmationReason.NotNeeded }),
      },
    });
  }

  /** The live tool-call state in the current turn, or null when absent. */
  private toolCallState(rec: SessionRecord, toolCallId: string): ToolCallState | null {
    const turn = rec.chatStore.state.activeTurn;
    if (turn === undefined) return null;
    for (const part of turn.responseParts) {
      if (part.kind === ResponsePartKind.ToolCall && part.toolCall.toolCallId === toolCallId) {
        return part.toolCall;
      }
    }
    return null;
  }

  /**
   * The tool call's state when it is awaiting confirmation (the
   * `SessionToolConfirmationRequest.toolCall` shape), or null otherwise.
   */
  private pendingToolCall(rec: SessionRecord, toolCallId: string): ToolCallConfirmationState | null {
    const tc = this.toolCallState(rec, toolCallId);
    if (tc === null) return null;
    if (tc.status === ToolCallStatus.PendingConfirmation || tc.status === ToolCallStatus.PendingResultConfirmation) {
      return tc;
    }
    return null;
  }

  /** True when the tool call already left the ready states (completed/cancelled). */
  private toolCallTerminal(rec: SessionRecord, toolCallId: string): boolean {
    const tc = this.toolCallState(rec, toolCallId);
    return tc !== null && (tc.status === ToolCallStatus.Completed || tc.status === ToolCallStatus.Cancelled);
  }

  private clearToolTracking(rec: SessionRecord, toolCallId: string): void {
    rec.toolInput.delete(toolCallId);
    rec.toolName.delete(toolCallId);
    rec.toolReady.delete(toolCallId);
    rec.clientToolCalls.delete(toolCallId);
  }

  // ── Phase 4 extension 1: client-tool helpers ───────────────────────────

  /**
   * The session's active client providing `toolName` (the tool-call
   * contributor), or null when no active client provides it (a
   * server-executed call — the normal path).
   */
  private clientToolContributor(rec: SessionRecord, toolName: string): string | null {
    return findProvider(rec.sessionStore.state.activeClients, toolName);
  }

  /**
   * Re-sync the location-global opencode tool registry with the
   * cross-session union of every live session's active-client tools
   * (first-registered wins per name). Location-global by design —
   * opencode's tool state is per-location, not per-session (plan
   * §14.12): the `execute` bridge re-checks per-session ownership at
   * runtime.
   */
  private async syncClientToolsToOpencode(): Promise<void> {
    const clients: SessionActiveClient[] = [];
    for (const rec of this.sessions.values()) {
      for (const client of rec.sessionStore.state.activeClients) clients.push(client);
    }
    const tools = toolUnion(clients).map(
      (t): FacadeClientTool => ({
        name: t.name,
        description: descriptionFor(t),
        inputSchema: inputSchemaFor(t),
      }),
    );
    try {
      await this.opts.facade.syncClientTools(tools);
    } catch (err) {
      // R2: a tool-registry failure must not break the AHP surface —
      // the active-client state stays authoritative on the AHP side.
      this.log(`client tool sync failed: ${errorMessage(err)}`);
    }
  }

  /**
   * Settle a client-tool invocation with its final result: the
   * opencode-side `execute` (blocked on the waiter) unblocks and
   * returns/throws, which drives the pump's `tool.success`/
   * `tool.failed` terminal (the AHP state is already terminal — the
   * pump's `toolCallTerminal` check suppresses a duplicate echo and
   * clears the tracking). Settling twice is a no-op.
   *
   * `result` may be omitted when the invocation's `result` was already
   * set by the caller (the eviction / session-removal paths set it
   * first and then settle to deliver it).
   */
  private settleClientTool(rec: SessionRecord, invocation: ClientToolInvocation, result?: FacadeClientToolResult): void {
    if (invocation.result === undefined) {
      if (result === undefined) return; // nothing to settle
      invocation.result = result;
    }
    if (invocation.waiter !== undefined && invocation.waiter !== null) {
      invocation.waiter(invocation.result);
      invocation.waiter = null;
    }
  }

  /**
   * The opencode tool `execute` bridge (called from the
   * `ctx.tool.transform` registration in src/index.ts): route one
   * client-tool invocation to the owning AHP client and wait for its
   * result.
   *
   * Per-session scoping (plan §14.12): the tool is visible location-
   * globally, but execution only resolves when *this* session is an
   * AHP session with an active client providing the tool — otherwise
   * the opencode tool fails (a `Tool.Error` the model sees), so e.g. a
   * TUI session can see the tool but not execute it.
   */
  executeClientTool(input: {
    sessionID: string;
    toolCallId: string;
    name: string;
    signal: AbortSignal;
  }): Promise<FacadeClientToolResult> {
    const rec = this.sessions.get(input.sessionID);
    if (rec === undefined) {
      return Promise.resolve({
        ok: false,
        error: `no AHP session for tool "${input.name}" (session ${input.sessionID} is not an AHP session)`,
      });
    }
    const invocation = rec.clientToolCalls.get(input.toolCallId);
    if (invocation === undefined) {
      return Promise.resolve({
        ok: false,
        error: `no client-executed call in flight for tool "${input.name}" (it was not registered by this session's active client)`,
      });
    }
    if (findProvider(rec.sessionStore.state.activeClients, input.name) !== invocation.clientId) {
      return Promise.resolve({
        ok: false,
        error: `session ${rec.sessionID} has no active client providing tool "${input.name}"`,
      });
    }
    if (input.signal.aborted) {
      const result: FacadeClientToolResult = { ok: false, error: `execution of "${input.name}" was cancelled` };
      this.settleClientTool(rec, invocation, result);
      return Promise.resolve(result);
    }
    // The invocation may already be settled (the client completed before
    // opencode started the execute — possible: the client only needs the
    // pump's ready/inputNeeded actions, not our execute). Deliver the
    // settled result; otherwise register the waiter.
    const settled = invocation.result;
    if (settled !== undefined) return Promise.resolve(settled);
    return new Promise<FacadeClientToolResult>((resolve) => {
      invocation.waiter = resolve;
      const onAbort = () => {
        if (invocation.result === undefined) {
          this.settleClientTool(rec, invocation, {
            ok: false,
            error: `execution of "${input.name}" was cancelled (turn interrupted)`,
          });
        }
        // If already settled, the waiter is gone — the abort is a no-op.
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // ── session registration / removal ─────────────────────────────────────

  /**
   * Verify a `session.created` event via the session API and register the
   * session under its own id as the channel suffix (the suffix starts
   * with "ses" — opencode ids are valid suffixes). No-op when the session
   * is gone, already registered, or a createSession remap is pending.
   */
  private async registerExternalDeferred(sessionID: string): Promise<void> {
    if (this.sessions.has(sessionID)) return;
    let fs: FacadeSession | null;
    try {
      fs = await this.opts.facade.getSession(sessionID);
    } catch {
      return;
    }
    if (fs === null || this.sessions.has(fs.sessionID)) return;
    this.registerExternal(fs);
  }

  /**
   * Register an opencode session the host did not create (TUI, another
   * client). Applied directly to the fresh stores (no seq, no actions) —
   * the registration is server-side bookkeeping, not a client-visible
   * state transition; the root announcement carries the lifecycle.
   */
  private registerExternal(fs: FacadeSession): SessionRecord | undefined {
    const existing = this.sessions.get(fs.sessionID);
    if (existing !== undefined) return existing;
    const channel = sessionChannelURI(fs.sessionID);
    const modifiedAt = new Date(fs.time.updated).toISOString();
    const sessionStore = createSessionStateStore(
      initialSessionState({
        sessionID: fs.sessionID,
        provider: fs.model?.providerID ?? "opencode",
        title: fs.title ?? "New Session",
        status: fs.archived
          ? ((SessionStatus.Idle | SessionStatus.IsRead | SessionStatus.IsArchived) as SessionStatus)
          : undefined, // Idle | IsRead | IsArchived
      }),
    );
    const chatStore = createChatStateStore(
      initialChatState({ resource: chatChannelURI(fs.sessionID), title: "Chat 1", modifiedAt }),
    );
    sessionStore.apply({ type: ActionType.SessionReady });
    sessionStore.apply({ type: ActionType.SessionChatAdded, summary: chatSummaryOf(chatStore.state) });
    sessionStore.apply({ type: ActionType.SessionDefaultChatChanged, defaultChat: chatChannelURI(fs.sessionID) });
    // Phase 2: advertise the changeset catalogues directly on the fresh
    // stores (registration is server-side bookkeeping — no seq, no actions).
    if (this.opts.changesets) {
      sessionStore.apply({ type: ActionType.SessionChangesetsChanged, changesets: sessionChangesetCatalog(fs.sessionID) });
      chatStore.apply({ type: ActionType.ChatChangesetsChanged, changesets: chatChangesetCatalog(fs.sessionID) });
    }
    const rec: SessionRecord = {
      sessionID: fs.sessionID,
      channel,
      provider: sessionStore.state.provider,
      createdAt: new Date(fs.time.created).toISOString(),
      modifiedAt,
      sessionStore,
      chatStore,
      currentTurnId: null,
      turnStartedAt: null,
      turnModelRef: null,
      parts: new Set(),
      toolInput: new Map(),
      toolName: new Map(),
      toolReady: new Set(),
      permissionForTool: new Map(),
      toolForPermission: new Map(),
      lastInbox: null,
      changesets: new Map(),
      turnSnapshots: new Map(),
      clientToolCalls: new Map(),
    };
    this.sessions.set(fs.sessionID, rec);
    this.byChannel.set(channel, rec);
    this.byChannel.set(chatChannelURI(fs.sessionID), rec);
    this.channels.addSession(fs.sessionID);
    this.publish({
      channel: ROOT_CHANNEL,
      action: { type: ActionType.RootActiveSessionsChanged, activeSessions: this.sessions.size },
    });
    this.notifyRoot("root/sessionAdded", { channel: ROOT_CHANNEL, summary: this.sessionSummary(rec) });
    return rec;
  }

  /** Drop a session record and announce the removal on the root channel. */
  private removeRecord(rec: SessionRecord): void {
    // Phase 2: every live changeset URI is about to become un-subscribable —
    // dispatch `changeset/cleared` (protocol case 2) before the teardown so
    // subscribers release their references.
    for (const uri of rec.changesets.keys()) {
      this.publish({ channel: uri, action: { type: ActionType.ChangesetCleared } });
    }
    rec.changesets.clear();
    rec.turnSnapshots.clear();
    // Phase 4 extension 1: fail any in-flight client-tool executions
    // (the session is going away — the waiters must not leak) and
    // re-sync the opencode tool union (this session's clients' tools
    // leave the cross-session set).
    for (const inv of rec.clientToolCalls.values()) {
      if (inv.result !== undefined) continue;
      inv.result = { ok: false, error: "session removed before the client completed the tool call" };
      this.settleClientTool(rec, inv);
    }
    rec.clientToolCalls.clear();
    const hadClients = rec.sessionStore.state.activeClients.length > 0;
    this.sessions.delete(rec.sessionID);
    this.byChannel.delete(rec.channel);
    this.byChannel.delete(chatChannelURI(rec.sessionID));
    const id = sessionIDOf(rec.channel);
    if (id !== null) this.channels.removeSession(id);
    this.channels.removeSession(rec.sessionID);
    this.publish({
      channel: ROOT_CHANNEL,
      action: { type: ActionType.RootActiveSessionsChanged, activeSessions: this.sessions.size },
    });
    this.notifyRoot("root/sessionRemoved", { channel: ROOT_CHANNEL, session: rec.channel });
    if (hadClients) void this.syncClientToolsToOpencode();
  }

  // ── state / publishing ─────────────────────────────────────────────────

  /**
   * Snapshot for a channel URI, or null when the channel is not
   * subscribable right now.
   *
   * Root snapshots re-derive the catalog from the facade on every call
   * (registry reads reflect every registration so far; in-process reads
   * are cheap). Session/chat snapshots read the official-reducer stores.
   */
  private async snapshotFor(uri: string): Promise<Snapshot | null> {
    const kind = channelKind(uri);
    if (kind === "unknown") return null;
    if (kind === "changeset") {
      if (!this.opts.changesets) return null;
      const parsed = parseChangesetChannel(uri);
      if (parsed === null) return null;
      const rec = this.sessions.get(parsed.sessionID);
      if (rec === undefined) return null;
      const store = this.changesetStore(rec, uri);
      // First subscribe (or a failed computation) triggers the computation;
      // subsequent subscribes return the last completed state.
      if (store.state.status === ChangesetStatus.Computing || store.state.status === ChangesetStatus.Error) {
        await this.refreshChangeset(rec, uri);
      }
      return { resource: uri, state: store.state, fromSeq: this.seq.seq };
    }
    if (kind !== "root") {
      const rec = this.byChannel.get(uri);
      if (rec === undefined) return null;
      if (uri === rec.channel) {
        return { resource: uri, state: rec.sessionStore.state, fromSeq: this.seq.seq };
      }
      if (uri === chatChannelURI(rec.sessionID)) {
        return { resource: uri, state: rec.chatStore.state, fromSeq: this.seq.seq };
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

  /** The denormalized `SessionSummary` view of a record. */
  private sessionSummary(rec: SessionRecord): SessionSummary {
    const s = rec.sessionStore.state;
    const c = rec.chatStore.state;
    const modifiedAt = c.modifiedAt > rec.modifiedAt ? c.modifiedAt : rec.modifiedAt;
    return buildSessionSummary({
      channel: rec.channel,
      provider: rec.provider,
      title: s.title,
      status: s.status,
      activity: s.activity,
      createdAt: rec.createdAt,
      modifiedAt,
      chat: chatSummaryOf(c),
      defaultChat: chatChannelURI(rec.sessionID),
    });
  }

  /**
   * Assign a global seq, update state for accepted actions, retain for
   * replay. Session/chat actions apply to the per-session stores through
   * the official reducers; a changed chat summary is propagated to the
   * session store via `session/chatUpdated`, and any summary-level change
   * is announced on the root channel (notification).
   */
  private publish(draft: {
    channel: string;
    action: StateAction;
    origin?: ActionOrigin;
    rejectionReason?: string;
  }): ActionEnvelope {
    const envelope = this.seq.publish(draft);
    if (draft.rejectionReason === undefined) {
      const kind = channelKind(draft.channel);
      if (kind === "root") {
        this.state.apply(draft.action as RootAction);
      } else if (kind === "changeset") {
        // Changeset stores live on the record (keyed by URI), resolved
        // through the parsed owner session.
        const parsed = parseChangesetChannel(draft.channel);
        const rec = parsed !== null ? this.sessions.get(parsed.sessionID) : undefined;
        const store = rec !== undefined ? rec.changesets.get(draft.channel) : undefined;
        if (store !== undefined) store.apply(draft.action as ChangesetAction);
      } else {
        // byChannel, not sessions.get(sessionIDOf(…)): the channel suffix
        // is not always the opencode session id (client-chosen suffixes).
        const rec = this.byChannel.get(draft.channel);
        if (rec !== undefined) {
          const before = this.sessionSummary(rec);
          if (kind === "session") rec.sessionStore.apply(draft.action as SessionAction);
          else rec.chatStore.apply(draft.action as ChatAction);
          if (kind === "chat") this.syncChatSummary(rec);
          const after = this.sessionSummary(rec);
          this.maybeNotifySummaryChanged(rec, before, after);
        }
      }
    }
    // Every published action — accepted and rejected alike — is an
    // `action` notification on its channel to the subscribers.
    this.notifyAction(envelope);
    return envelope;
  }

  /**
   * Propagate a changed chat summary into the session store's chat catalog
   * (`session/chatUpdated`) — the session status itself is only
   * reducer-reachable for read/archive/input-needed bits, so the chat
   * summary is the activity source of truth.
   */
  private syncChatSummary(rec: SessionRecord): void {
    const chat = rec.chatStore.state;
    const entry = rec.sessionStore.state.chats.find((c) => c.resource === chat.resource);
    if (entry === undefined) return;
    const next = chatSummaryOf(chat);
    const changes: Record<string, unknown> = {};
    let changed = false;
    for (const key of ["title", "status", "activity", "modifiedAt"] as const) {
      if (entry[key] !== next[key]) {
        changes[key] = next[key];
        changed = true;
      }
    }
    if (changed) {
      this.publish({
        channel: rec.channel,
        action: { type: ActionType.SessionChatUpdated, chat: chat.resource, changes: changes as Partial<ChatSummary> },
      });
    }
  }

  /**
   * Announce summary-level changes on the root channel (`root/
   * sessionSummaryChanged` notification — ephemeral, not replayed).
   * Identity fields (resource/provider/createdAt) never change.
   */
  private maybeNotifySummaryChanged(rec: SessionRecord, before: SessionSummary, after: SessionSummary): void {
    const changes: Record<string, unknown> = {};
    for (const key of ["title", "status", "activity", "modifiedAt", "chats", "defaultChat"] as const) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        changes[key] = after[key];
      }
    }
    if (Object.keys(changes).length === 0) return;
    if (after.modifiedAt > rec.modifiedAt) rec.modifiedAt = after.modifiedAt;
    this.notifyRoot("root/sessionSummaryChanged", {
      channel: ROOT_CHANNEL,
      session: rec.channel,
      changes,
    });
  }

  /** Send a root-channel notification frame to every root subscriber. */
  private notifyRoot(method: string, params: unknown): void {
    const frame = { jsonrpc: "2.0", method, params };
    for (const socketId of this.channels.socketsSubscribedTo(ROOT_CHANNEL)) {
      this.opts.send(socketId, frame);
    }
  }

  /** Send an `action` notification to every socket subscribed to the channel. */
  private notifyAction(envelope: ActionEnvelope): void {
    const frame = { jsonrpc: "2.0", method: "action", params: envelope };
    for (const socketId of this.channels.socketsSubscribedTo(envelope.channel)) {
      this.opts.send(socketId, frame);
    }
  }

  private sendError(socketId: number, id: unknown, code: number, message: string): void {
    this.sendFrame(socketId, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  }
}

function sameAgents(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Short, stable description of untrusted params for log lines. */
function describeParams(params: unknown): string {
  if (!isRecord(params)) return String(typeof params);
  try {
    const raw = JSON.stringify(Object.keys(params));
    return raw.length > 120 ? raw.slice(0, 120) + "…" : raw;
  } catch {
    return "unserializable";
  }
}

/** The first enabled model of a provider, as a FacadeModelRef. */
function firstEnabledModelRef(models: readonly { providerID: string; modelID: string; enabled: boolean }[]): FacadeModelRef | undefined {
  const m = models.find((x) => x.enabled);
  return m !== undefined ? { providerID: m.providerID, modelID: m.modelID } : undefined;
}

/** Normalize an untrusted `activeClient` payload (untrusted JSON-RPC). */
function normalizeActiveClient(ac: Record<string, unknown>): SessionActiveClient {
  return {
    clientId: ac["clientId"] as string,
    tools: normalizeToolDefinitions(ac["tools"]),
    ...(typeof ac["displayName"] === "string" ? { displayName: ac["displayName"] as string } : {}),
  };
}

/**
 * Wire-validate a client-dispatched `toolCallComplete` result (plan
 * §14.12): `success` is the one field the host depends on (it decides
 * the facade result + the Tool.Error path); the rest is stored
 * verbatim for the AHP state mirror.
 */
function normalizeToolCallResult(raw: unknown): ToolCallResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["success"] !== "boolean") return null;
  const pastTense = r["pastTenseMessage"];
  return {
    success: r["success"],
    pastTenseMessage:
      typeof pastTense === "string"
        ? pastTense
        : (isRecord(pastTense) && typeof pastTense["markdown"] === "string"
            ? (pastTense["markdown"] as string)
            : ""),
    ...(Array.isArray(r["content"]) ? { content: r["content"] as ToolResultContent[] } : {}),
    ...(isRecord(r["structuredContent"]) ? { structuredContent: r["structuredContent"] as Record<string, unknown> } : {}),
    ...(isRecord(r["error"]) ? { error: r["error"] as { message: string; code?: string } } : {}),
  };
}

/** StringOrMarkdown → plain string (the facade result carries text). */
function stringOrMarkdownToText(v: StringOrMarkdown | undefined): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  return typeof v.markdown === "string" ? v.markdown : "";
}

/**
 * A validated client `ToolCallResult` → the opencode-side result:
 * success:false → the `Tool.Error` message (the model sees the
 * failure); success → the text content blocks joined (non-text blocks
 * stay in the AHP state for the client's UI; the model gets the text +
 * the past-tense message).
 */
function clientResultToFacade(result: ToolCallResult): FacadeClientToolResult {
  if (!result.success) {
    return { ok: false, error: result.error?.message ?? "the client reported a tool failure" };
  }
  const texts: string[] = [];
  for (const c of result.content ?? []) {
    // The content came from the wire (untrusted) — guard the shape.
    if (c.type === ToolResultContentType.Text && typeof c.text === "string") texts.push(c.text);
  }
  const content = texts.join("\n\n");
  return {
    ok: true,
    pastTenseMessage: stringOrMarkdownToText(result.pastTenseMessage),
    ...(content.length > 0 ? { content } : {}),
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
  };
}

/**
 * Map opencode tool result content blocks to AHP `ToolResultContent`
 * (only text blocks are representable in this MVP; file/patch text is
 * carried as text).
 */
function mapToolResultContent(content: readonly { type: string; text?: string }[]): ToolResultContent[] {
  const out: ToolResultContent[] = [];
  for (const c of content) {
    if (c.type === "text" || c.type === "file" || c.type === "patch") {
      out.push({ type: ToolResultContentType.Text, text: c.text ?? "" });
    }
  }
  return out;
}

/**
 * True when `child` is `parent` itself or strictly inside it (both resolved
 * first, so relative segments and `..` cannot escape the comparison). Used
 * to confine turn-snapshot paths and `resourceRead`/`invokeChangesetOperation`
 * targets to the location directory.
 */
function isPathInside(child: string, parent: string): boolean {
  const a = resolvePath(child);
  const b = resolvePath(parent);
  return a === b || a.startsWith(b + "/");
}
