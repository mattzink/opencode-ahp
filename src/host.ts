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
 * Session model: one AHP session = one opencode location session record
 * holding a chat catalog; one AHP chat = one opencode session (plan
 * §14.13). The default chat reuses the record's opencode session, so
 * single-chat clients see zero wire change; peer chats created via
 * `createChat` bind fresh opencode sessions to client-chosen chat URIs.
 * Channel suffixes are opaque; opencode session ids start with "ses"
 * and double as suffixes for externally created sessions.
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
 * Phase 4 extension 2: everything the host tracks for one AHP chat —
 * the backing opencode session, its chat-state store, and the per-turn
 * tracking the event pump needs to join opencode events to AHP turns.
 * One AHP chat ↔ one opencode session (plan §14.13).
 */
interface ChatRuntime {
  /** The AHP chat channel URI (`ahp-chat:/…`). */
  uri: string;
  /** The opencode session id backing this chat (`ses_…`). */
  sessionID: string;
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
  /**
   * Live chat-owned changeset stores (uncommitted + turn), keyed by
   * changeset URI (created on subscribe). The session-kind changeset
   * store lives on the record instead (the session channel owns it).
   */
  changesets: Map<string, ChangesetStateStore>;
  /**
   * Per-turn file snapshots for the turn changesets: turnId → absPath →
   * captured {before (pre-edit disk read), after (disk at turn end)}.
   * `null` = the file was absent on that side. Kept until the chat is
   * removed (content refs + discard-restore read them, plan §14.10).
   */
  turnSnapshots: Map<string, Map<string, { before: string | null; after: string | null }>>;
}

/**
 * Everything the host knows about one AHP session: the session store,
 * its chat catalog (default chat first, then insertion order), and the
 * denormalized summary fields for root notifications. `sessionID` is the
 * default chat's opencode id — the key of the `sessions` map and the
 * event-pump join key for the default chat.
 */
interface SessionRecord {
  /** The default chat's opencode session id (`ses_…`). */
  sessionID: string;
  /** The AHP session channel URI (`ahp-session:/<suffix>`). */
  channel: string;
  /** Identity `SessionSummary.provider` (fixed at registration). */
  provider: string;
  createdAt: string;
  /** Denormalized `SessionSummary.modifiedAt` (ISO; lexicographic = chronological). */
  modifiedAt: string;
  sessionStore: SessionStateStore;
  /** Chat runtimes keyed by chat channel URI (default first, insertion order). */
  chats: Map<string, ChatRuntime>;
  /** The chat channel URI that receives input when none is selected. */
  defaultChatURI: string;
  /** The session-kind changeset store (owned by the session channel). */
  sessionChangesets: Map<string, ChangesetStateStore>;
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
/**
 * Phase 4 extension 2 (durability): the opencode session-metadata key
 * carrying the AHP markers (plan §14.13.1). Two shapes, same key:
 *   - on a peer-chat backend:
 *     `{ chat: <chat channel URI>, owner: <the opencode session id of
 *     the owning AHP session> }` — `owner` is the opencode id, not the
 *     channel suffix (a client-chosen suffix differs from the minted
 *     opencode id);
 *   - on the default backend of a minted-id session:
 *     `{ channel: <session channel URI> }` — the client-chosen session
 *     channel (a "ses" suffix is its own opencode id and needs none).
 * (The keep-alive anchor uses the same key with a STRING value —
 * `parseAhpMarker` ignores non-record markers.)
 */
const AHP_METADATA_KEY = "opencode-ahp";

/**
 * Parse the AHP markers from an opencode session's durable metadata.
 * Defensive: a malformed shape (missing key, non-record marker — e.g.
 * the keep-alive anchor — or wrong-kind fields) means "no marker" —
 * standalone registration under the opencode id.
 */
function parseAhpMarker(metadata: unknown): { chat?: string; owner?: string; channel?: string } | null {
  if (!isRecord(metadata)) return null;
  const marker = metadata[AHP_METADATA_KEY];
  if (!isRecord(marker)) return null;
  const out: { chat?: string; owner?: string; channel?: string } = {};
  const chat = marker["chat"];
  if (typeof chat === "string" && channelKind(chat) === "chat") out.chat = chat;
  const owner = marker["owner"];
  if (typeof owner === "string" && owner.startsWith("ses")) out.owner = owner;
  const channel = marker["channel"];
  if (typeof channel === "string" && channelKind(channel) === "session") out.channel = channel;
  return Object.keys(out).length > 0 ? out : null;
}

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
  /**
   * Phase 4 extension 2: opencode session id → the (record, chat) the id
   * backs. The event pump's join key — every chat has its own opencode
   * session, and the pump must land on the owning chat, not just the
   * record (plan §14.13).
   */
  private readonly byOpencode = new Map<string, { rec: SessionRecord; chat: ChatRuntime }>();
  /**
   * Phase 4 extension 2 (durability): marked peer backends whose owner
   * AHP session is not registered yet, keyed by the marker's `owner`
   * (opencode session id). A peer can be listed before its owner in the
   * same synchronous `listSessions` pass, and after a restart the owner
   * record does not exist until it is listed (there is no boot-time
   * event replay). Drained when the owner registers; an entry whose
   * owner is gone from opencode falls back to standalone registration
   * after the grace window.
   */
  private readonly pendingChatBindings = new Map<string, { fs: FacadeSession; chatURI: string }[]>();
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
      // In-flight client-tool calls are per-chat (plan §14.13).
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
    const created = await this.opts.facade.createSession({
      id: passID,
      model,
      // Durability (plan §14.13.1): a minted-id default backend carries
      // the client-chosen session channel in its opencode metadata —
      // after a restart the session resurfaces under the ORIGINAL channel
      // instead of its opencode id (a "ses" suffix IS the opencode id and
      // needs no marker).
      ...(passID === undefined ? { metadata: { [AHP_METADATA_KEY]: { channel } } } : {}),
    });

    // Slow-create race: the pump may have registered this opencode session
    // under its own id as an external session while `createSession` was in
    // flight. Remap: drop the interim record (root/sessionRemoved) and
    // re-register under the client-chosen channel below.
    //
    // Marker interaction (plan §14.13.1): with the channel marker, the
    // interim external registration lands under the MARKED channel (the
    // client's own), so `interim.channel !== channel` is false and the
    // remap is skipped — the re-registration below then re-announces the
    // session (a duplicate root/sessionAdded in this rare race; cosmetic,
    // the client converges on the snapshot, and the race requires
    // createSession to exceed the 250 ms external-register grace).
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
    const rec: SessionRecord = {
      sessionID: created.sessionID,
      channel,
      provider: sessionStore.state.provider,
      createdAt: new Date(created.time.created).toISOString(),
      modifiedAt: new Date(created.time.updated).toISOString() > now
        ? new Date(created.time.updated).toISOString()
        : now,
      sessionStore,
      chats: new Map(),
      defaultChatURI: chatChannelURI(created.sessionID),
      sessionChangesets: new Map(),
    };
    this.sessions.set(created.sessionID, rec);
    this.byChannel.set(channel, rec);
    // The session channel carries the client-chosen suffix; the chat
    // channel and the event pump carry the opencode id — both must
    // resolve in the registry.
    this.channels.addSession(suffix);
    this.channels.addSession(created.sessionID);
    const defaultChat = this.newChatRuntime(rec.defaultChatURI, created.sessionID, "Chat 1", now);
    this.bindChat(rec, defaultChat);

    // Phase 4 extension 1: a createSession `activeClient` seeds the
    // session's tools — register them with opencode now.
    if (activeClients.length > 0) void this.syncClientToolsToOpencode();

    // Session-channel lifecycle (server-side, no origin).
    this.publish({ channel, action: { type: ActionType.SessionReady } });
    this.publish({
      channel,
      action: { type: ActionType.SessionChatAdded, summary: chatSummaryOf(defaultChat.chatStore.state) },
    });
    this.publish({
      channel,
      action: { type: ActionType.SessionDefaultChatChanged, defaultChat: rec.defaultChatURI },
    });
    // Phase 2: advertise the changeset catalogues (session channel: the
    // session-wide changeset; chat channel: uncommitted + session + the
    // per-turn template).
    if (this.opts.changesets) {
      this.publish({
        channel,
        action: { type: ActionType.SessionChangesetsChanged, changesets: sessionChangesetCatalog(channel) },
      });
      this.publish({
        channel: rec.defaultChatURI,
        action: {
          type: ActionType.ChatChangesetsChanged,
          changesets: chatChangesetCatalog(rec.defaultChatURI, channel),
        },
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

  // ── Phase 4 extension 2: multi-chat ────────────────────────────────────

  /**
   * Fresh per-chat runtime (plan §14.13): one AHP chat = one opencode
   * session, with its own chat-state store and all the per-turn tracking
   * the event pump joins opencode events to.
   */
  private newChatRuntime(uri: string, sessionID: string, title: string, modifiedAt: string): ChatRuntime {
    return {
      uri,
      sessionID,
      chatStore: createChatStateStore(initialChatState({ resource: uri, title, modifiedAt })),
      currentTurnId: null,
      turnStartedAt: null,
      turnModelRef: null,
      parts: new Set(),
      toolInput: new Map(),
      toolName: new Map(),
      toolReady: new Set(),
      permissionForTool: new Map(),
      toolForPermission: new Map(),
      clientToolCalls: new Map(),
      lastInbox: null,
      changesets: new Map(),
      turnSnapshots: new Map(),
    };
  }

  /**
   * Bind a chat runtime to its record: the record's catalog, the
   * channel→record lookup, and the opencode-id→(record, chat) reverse
   * binding (the event pump's join key). The channel registry gets the
   * chat URI's suffix — that is what makes the chat channel and its
   * changesets (whose owner is the chat channel) subscribable. The
   * default chat's suffix IS its opencode id, added by the
   * registration paths; a peer chat's opencode id gets no registry
   * entry (it has no subscribable session channel of its own — plan
   * §14.13).
   */
  private bindChat(rec: SessionRecord, chat: ChatRuntime): void {
    rec.chats.set(chat.uri, chat);
    this.byChannel.set(chat.uri, rec);
    this.byOpencode.set(chat.sessionID, { rec, chat });
    const suffix = sessionIDOf(chat.uri);
    if (suffix !== null) this.channels.addSession(suffix);
  }

  /**
   * Unbind a chat runtime (dispose or record removal): clear its live
   * changesets (`changeset/cleared` — protocol case 2), fail its
   * in-flight client-tool executions (the waiters must not leak), and
   * drop every binding.
   */
  private removeChat(rec: SessionRecord, chat: ChatRuntime, toolError = "chat removed before the client completed the tool call"): void {
    for (const uri of chat.changesets.keys()) {
      this.publish({ channel: uri, action: { type: ActionType.ChangesetCleared } });
    }
    chat.changesets.clear();
    chat.turnSnapshots.clear();
    for (const inv of chat.clientToolCalls.values()) {
      if (inv.result !== undefined) continue;
      inv.result = { ok: false, error: toolError };
      this.settleClientTool(inv);
    }
    chat.clientToolCalls.clear();
    rec.chats.delete(chat.uri);
    this.byChannel.delete(chat.uri);
    this.byOpencode.delete(chat.sessionID);
    const suffix = sessionIDOf(chat.uri);
    if (suffix !== null) this.channels.removeSession(suffix);
    this.channels.removeSession(chat.sessionID);
  }

  /**
   * `createChat` (AHP 1.0.0 chat command): create a new chat in an
   * existing session. The 1:1 mapping (plan §14.13): mint a fresh
   * opencode session (same provider/model resolution as `createSession`)
   * and bind it to the client-chosen chat URI. Result: `null` (the
   * client waits for `session/chatAdded` on the session channel, and
   * rolls back with `disposeChat` when the chat never surfaces — so
   * everything below is published before the response). `source` and
   * `workingDirectories` are rejected with INVALID_PARAMS: the
   * capability is advertised without fork/sideChat/
   * multipleWorkingDirectories, so conformant clients never send them.
   *
   * Error codes: -32602 (invalid params, including `source`/
   * `workingDirectories`), -32001 (no such session), -32003 (chat URI
   * already exists), -32603 (backend session creation or initial
   * message failure — the chat is rolled back in that case).
   */
  private async handleCreateChat(socketId: number, msg: RpcMessage): Promise<void> {
    const params = isRecord(msg.params) ? msg.params : {};
    const channel = params["channel"];
    const chatURI = params["chat"];
    if (typeof channel !== "string" || channelKind(channel) !== "session") {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "createChat requires an ahp-session:/… channel");
      return;
    }
    const rec = this.byChannel.get(channel);
    if (rec === undefined) {
      this.sendError(socketId, msg.id, ERROR_SESSION_NOT_FOUND, `no such session: ${channel}`);
      return;
    }
    if (typeof chatURI !== "string" || channelKind(chatURI) !== "chat") {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "createChat requires an ahp-chat:/… chat URI");
      return;
    }
    // A marker in the chat suffix would make the chat channel
    // string-identical to a changeset URI of the chat before the marker
    // (the same trap createSession rejects for session suffixes).
    if (chatURI.includes("/changeset/")) {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "chat URI must not contain \"/changeset/\"");
      return;
    }
    if (chatURI === rec.defaultChatURI || rec.chats.has(chatURI)) {
      this.sendError(socketId, msg.id, ERROR_SESSION_EXISTS, `chat already exists: ${chatURI}`);
      return;
    }
    if (params["source"] !== undefined) {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "createChat `source` is not supported (no fork/sideChat capability)");
      return;
    }
    if (params["workingDirectories"] !== undefined) {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "createChat `workingDirectories` is not supported (no multipleWorkingDirectories capability)");
      return;
    }

    // Same provider/model resolution as createSession's default path:
    // the first non-disabled provider's first enabled model.
    const providers = await this.opts.facade.listCatalog();
    const provider = providers.find((p) => p.activation !== "disabled");
    const model = provider !== undefined ? firstEnabledModelRef(provider.models) : undefined;
    const now = new Date().toISOString();
    let created;
    try {
      // Plan §14.13.1: write the chat-binding marker atomically at
      // create — it is what re-attaches this backend to this session's
      // chat catalog after an opencode/plugin restart (opencode session
      // metadata is the only durable surface a plugin has).
      created = await this.opts.facade.createSession({
        model,
        metadata: { [AHP_METADATA_KEY]: { chat: chatURI, owner: rec.sessionID } },
      });
    } catch (err) {
      this.sendError(socketId, msg.id, ERROR_INTERNAL, `failed to create the chat's backend session: ${errorMessage(err)}`);
      return;
    }
    const chat = this.newChatRuntime(chatURI, created.sessionID, `Chat ${rec.chats.size + 1}`, now);
    this.bindChat(rec, chat);
    // Session-channel lifecycle (server-side, no origin): the catalog
    // mutation the client is waiting for, plus the changeset catalogue
    // on the new chat channel.
    this.publish({
      channel,
      action: { type: ActionType.SessionChatAdded, summary: chatSummaryOf(chat.chatStore.state) },
    });
    if (this.opts.changesets) {
      this.publish({
        channel: chatURI,
        action: { type: ActionType.ChatChangesetsChanged, changesets: chatChangesetCatalog(chatURI, rec.channel) },
      });
    }

    // initialMessage → the chat's first turn (write-ahead, same
    // claim-then-prompt semantics as dispatchTurnStarted). A failure
    // rolls the whole chat back — the client never sees a chat whose
    // promised first turn never happened.
    const initialParam = params["initialMessage"];
    if (initialParam !== undefined) {
      if (!isRecord(initialParam) || typeof initialParam["text"] !== "string" || (initialParam["text"] as string).length === 0) {
        await this.disposeChatBackend(rec, chat);
        this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "createChat `initialMessage` requires a message with non-empty text");
        return;
      }
      const message = initialParam as unknown as Message;
      const selectionError = await this.applyMessageSelection(chat, message);
      if (selectionError !== null) {
        await this.disposeChatBackend(rec, chat);
        this.sendError(socketId, msg.id, ERROR_INTERNAL, `failed to apply initial message model/agent selection: ${selectionError}`);
        return;
      }
      const turnId = this.mintTurnId();
      chat.currentTurnId = turnId;
      chat.turnStartedAt = Date.now();
      try {
        await this.opts.facade.prompt({ sessionID: chat.sessionID, text: message.text });
      } catch (err) {
        chat.currentTurnId = null;
        chat.turnStartedAt = null;
        await this.disposeChatBackend(rec, chat);
        this.sendError(socketId, msg.id, ERROR_INTERNAL, `initial message failed: ${errorMessage(err)}`);
        return;
      }
      this.publish({
        channel: chatURI,
        action: {
          type: ActionType.ChatTurnStarted,
          turnId,
          startedAt: new Date().toISOString(),
          message,
        },
      });
    }

    this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, result: null });
  }

  /**
   * `disposeChat` (AHP 1.0.0 chat command): remove a chat and its
   * opencode session from the session catalog. Result: `null`. The
   * default chat cannot be disposed — a session keeps its default chat
   * (there is no re-home mechanism; disposing it would leave the
   * `defaultChat` hint dangling). VS Code's createChat-rollback path
   * relies on `disposeChat` being answerable for any chat it created.
   */
  private async handleDisposeChat(socketId: number, msg: RpcMessage): Promise<void> {
    const params = isRecord(msg.params) ? msg.params : {};
    const channel = params["channel"];
    if (typeof channel !== "string" || channelKind(channel) !== "chat") {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "disposeChat requires an ahp-chat:/… channel");
      return;
    }
    const rec = this.byChannel.get(channel);
    const chat = rec !== undefined ? rec.chats.get(channel) : undefined;
    if (rec === undefined || chat === undefined) {
      this.sendError(socketId, msg.id, ERROR_SESSION_NOT_FOUND, `no such chat: ${channel}`);
      return;
    }
    if (channel === rec.defaultChatURI) {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "the default chat cannot be disposed");
      return;
    }
    await this.disposeChatBackend(rec, chat);
    this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, result: null });
  }

  /**
   * Remove a chat from the AHP surface, then its opencode session. The
   * AHP-side unbind goes FIRST: opencode's `session.deleted` event for
   * the backend races this call through the event pump, and the pump
   * must see the chat already unbound (its `byOpencode` guard) or it
   * would publish a duplicate `session/chatRemoved`. R2: a failed
   * removal still drops the AHP chat — the lingering opencode session
   * shows up in the TUI (and lazily in `listSessions`) until deleted
   * there.
   */
  private async disposeChatBackend(rec: SessionRecord, chat: ChatRuntime): Promise<void> {
    this.removeChat(rec, chat);
    try {
      await this.opts.facade.removeSession(chat.sessionID);
    } catch (err) {
      this.log(`failed to remove the chat's opencode session ${chat.sessionID}: ${errorMessage(err)}`);
    }
    this.publish({ channel: rec.channel, action: { type: ActionType.SessionChatRemoved, chat: chat.uri } });
  }

  /**
   * Apply a message's model/agent selection to a chat's opencode session
   * before its prompt (`SessionPromptInput` carries no model/agent
   * fields). Null on success, the error message on failure.
   */
  private async applyMessageSelection(chat: ChatRuntime, message: Message): Promise<string | null> {
    try {
      if (message.model?.id !== undefined && message.model.id.includes("/")) {
        const sep = message.model.id.indexOf("/");
        const providerID = message.model.id.slice(0, sep);
        const modelID = message.model.id.slice(sep + 1);
        if (providerID.length > 0 && modelID.length > 0) {
          await this.opts.facade.switchModel({ sessionID: chat.sessionID, model: { providerID, modelID } });
        }
      }
      if (message.agent?.uri !== undefined) {
        const agentID = agentIDFromUri(message.agent.uri);
        if (agentID !== null) {
          await this.opts.facade.switchAgent({ sessionID: chat.sessionID, agent: agentID });
        }
      }
    } catch (err) {
      return errorMessage(err);
    }
    return null;
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
      this.echo(
        channel,
        stateAction,
        origin,
        kind === "chat" ? `no such chat: ${channel}` : `no such session: ${channel}`,
      );
      return;
    }
    if (kind === "chat" && !rec.chats.has(channel)) {
      this.echo(channel, stateAction, origin, `no such chat: ${channel}`);
      return;
    }
    // Chat actions run against the owning chat runtime (plan §14.13);
    // a chat action on a session channel is rejected (a session no
    // longer identifies a single chat once multi-chat is on).
    const chat = rec.chats.get(channel);
    const noChat = () => this.echo(channel, stateAction, origin, `chat actions require a chat channel: ${channel}`);

    // From here on every branch either echoes (accepted or rejected).
    switch (stateAction.type) {
      case ActionType.ChatTurnStarted:
        if (chat === undefined) { noChat(); return; }
        await this.dispatchTurnStarted(chat, stateAction, origin);
        return;
      case ActionType.ChatPendingMessageSet:
        if (chat === undefined) { noChat(); return; }
        await this.dispatchPendingMessageSet(chat, stateAction, origin);
        return;
      case ActionType.ChatToolCallConfirmed:
        if (chat === undefined) { noChat(); return; }
        await this.dispatchToolCallConfirmed(chat, stateAction, origin);
        return;
      case ActionType.ChatToolCallComplete:
        if (chat === undefined) { noChat(); return; }
        await this.dispatchToolCallComplete(chat, stateAction, origin);
        return;
      case ActionType.ChatToolCallContentChanged:
        if (chat === undefined) { noChat(); return; }
        this.dispatchToolCallContentChanged(chat, stateAction, origin);
        return;
      case ActionType.ChatToolCallResultConfirmed:
        if (chat === undefined) { noChat(); return; }
        this.dispatchToolCallResultConfirmed(chat, stateAction, origin);
        return;
      case ActionType.ChatTurnCancelled:
        if (chat === undefined) { noChat(); return; }
        await this.dispatchTurnCancelled(chat, stateAction, origin);
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

  private async dispatchTurnStarted(chat: ChatRuntime, action: StateAction, origin: ActionOrigin | undefined): Promise<void> {
    const chatURI = chat.uri;
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
    if (chat.chatStore.state.activeTurn !== undefined) {
      this.echo(
        chatURI,
        action,
        origin,
        "a turn is already active; follow-up messages go via chat/pendingMessageSet",
      );
      return;
    }

    // Apply the message's model/agent selection to THIS chat's opencode
    // session before the prompt (per-chat isolation, plan §14.13).
    const selectionError = await this.applyMessageSelection(chat, message);
    if (selectionError !== null) {
      this.echo(chatURI, action, origin, `failed to apply model/agent selection: ${selectionError}`);
      return;
    }

    // Write-ahead: claim the turn BEFORE the prompt so the
    // `session.execution.started` event joins it even when it races the
    // prompt's resolve; revert on failure.
    chat.currentTurnId = turnId;
    chat.turnStartedAt = Date.now();
    try {
      await this.opts.facade.prompt({ sessionID: chat.sessionID, text: message.text });
    } catch (err) {
      chat.currentTurnId = null;
      chat.turnStartedAt = null;
      this.echo(chatURI, action, origin, `prompt failed: ${errorMessage(err)}`);
      return;
    }
    this.echo(chatURI, normalized, origin);
  }

  private async dispatchPendingMessageSet(chat: ChatRuntime, action: StateAction, origin: ActionOrigin | undefined): Promise<void> {
    const chatURI = chat.uri;
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
    const hasActiveTurn = chat.chatStore.state.activeTurn !== undefined;
    // steer → delivery "steer" (only while a turn is active); queued →
    // delivery "queue"; a steering message with no active turn falls back
    // to a plain prompt (it becomes the next turn).
    const delivery: FacadeDelivery | undefined = hasActiveTurn
      ? kind === "steering"
        ? "steer"
        : "queue"
      : undefined;
    try {
      await this.opts.facade.prompt({ sessionID: chat.sessionID, text: message.text, delivery });
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
    chat.currentTurnId = turnId;
    chat.turnStartedAt = Date.now();
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

  private async dispatchToolCallConfirmed(chat: ChatRuntime, action: StateAction, origin: ActionOrigin | undefined): Promise<void> {
    const chatURI = chat.uri;
    const rec = this.byChannel.get(chatURI)!;
    const a = action as ChatToolCallConfirmedAction;
    const toolCallId = typeof a.toolCallId === "string" ? a.toolCallId : null;
    if (toolCallId === null) {
      this.echo(chatURI, action, origin, "invalid chat/toolCallConfirmed params");
      return;
    }
    const permissionID = chat.permissionForTool.get(toolCallId);
    if (permissionID === undefined) {
      this.echo(chatURI, action, origin, `no pending permission for tool call ${toolCallId}`);
      return;
    }
    try {
      await this.opts.facade.replyPermission({
        sessionID: chat.sessionID,
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
    chat.permissionForTool.delete(toolCallId);
    chat.toolForPermission.delete(permissionID);
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
  private async dispatchToolCallComplete(chat: ChatRuntime, action: StateAction, origin: ActionOrigin | undefined): Promise<void> {
    const chatURI = chat.uri;
    const rec = this.byChannel.get(chatURI)!;
    const a = action as ChatToolCallCompleteAction;
    const toolCallId = typeof a.toolCallId === "string" ? a.toolCallId : null;
    const invocation = toolCallId !== null ? chat.clientToolCalls.get(toolCallId) : undefined;
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
    const status = this.toolCallState(chat, toolCallId)?.status;
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
      const pending = this.pendingToolCall(chat, toolCallId);
      if (pending !== null && chat.currentTurnId !== null) {
        this.publish({
          channel: rec.channel,
          action: {
            type: ActionType.SessionInputNeededSet,
            request: {
              id: toolCallId,
              chat: chatURI,
              kind: SessionInputRequestKind.ToolConfirmation,
              turnId: chat.currentTurnId,
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
      this.settleClientTool(invocation, clientResultToFacade(result));
    }
  }

  /**
   * `chat/toolCallContentChanged` (client-dispatchable): the owning
   * client streams partial content while executing (the reducer
   * replaces the running call's `content`). Echo-only — opencode needs
   * no counterpart; the spec says the server SHOULD reject dispatches
   * from a client that is not the contributor.
   */
  private dispatchToolCallContentChanged(chat: ChatRuntime, action: StateAction, origin: ActionOrigin | undefined): void {
    const chatURI = chat.uri;
    const a = action as ChatToolCallContentChangedAction;
    const toolCallId = typeof a.toolCallId === "string" ? a.toolCallId : null;
    const invocation = toolCallId !== null ? chat.clientToolCalls.get(toolCallId) : undefined;
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
    if (this.toolCallState(chat, toolCallId)?.status !== ToolCallStatus.Running) {
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
  private dispatchToolCallResultConfirmed(chat: ChatRuntime, action: StateAction, origin: ActionOrigin | undefined): void {
    const chatURI = chat.uri;
    const rec = this.byChannel.get(chatURI)!;
    const a = action as ChatToolCallResultConfirmedAction;
    const toolCallId = typeof a.toolCallId === "string" ? a.toolCallId : null;
    if (toolCallId === null || typeof a.approved !== "boolean") {
      this.echo(chatURI, action, origin, "invalid chat/toolCallResultConfirmed params");
      return;
    }
    const invocation = chat.clientToolCalls.get(toolCallId);
    if (invocation === undefined) {
      this.echo(chatURI, action, origin, `no pending result confirmation for tool call ${toolCallId}`);
      return;
    }
    if (origin !== undefined && invocation.clientId !== origin.clientId) {
      this.echo(chatURI, action, origin, `only the contributing client (${invocation.clientId}) may confirm this result`);
      return;
    }
    if (this.toolCallState(chat, toolCallId)?.status !== ToolCallStatus.PendingResultConfirmation) {
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
      this.settleClientTool(invocation, { ok: false, error: "no recorded result to confirm" });
      return;
    }
    if (a.approved) {
      this.settleClientTool(invocation, clientResultToFacade(held as ToolCallResult));
    } else {
      this.settleClientTool(invocation, { ok: false, error: "the client denied the tool result" });
    }
  }

  private async dispatchTurnCancelled(chat: ChatRuntime, action: StateAction, origin: ActionOrigin | undefined): Promise<void> {
    const chatURI = chat.uri;
    const a = action as ChatTurnCancelledAction;
    const turnId = typeof a.turnId === "string" && a.turnId.length > 0 ? a.turnId : null;
    const active = chat.chatStore.state.activeTurn;
    if (turnId === null || active === undefined || active.id !== turnId) {
      this.echo(chatURI, action, origin, "no active turn to cancel");
      return;
    }
    try {
      await this.opts.facade.interrupt({ sessionID: chat.sessionID });
    } catch (err) {
      this.echo(chatURI, action, origin, `interrupt failed: ${errorMessage(err)}`);
      return;
    }
    // `duration` is required on the wire (the reducer derives the final
    // `modifiedAt` from it); the host clock is authoritative when the
    // client did not supply one.
    const duration =
      typeof a.duration === "number" && Number.isFinite(a.duration) ? a.duration : this.turnDuration(chat);
    this.echo(chatURI, { ...a, duration }, origin);
    // The opencode `session.execution.interrupted` event finds no active
    // turn after the echo finalized it (skipped); run the queued/steering
    // handoff now, on the host side.
    await this.finishTurn(chat);
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
    const rec = parsed !== null ? this.byChannel.get(parsed.ownerUri) : undefined;
    const store = rec !== undefined ? this.changesetStoreOf(rec, channel) : undefined;
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
      // Every live chat has its own opencode session (plan §14.13), so a
      // created event for an already-bound id is ours (a createChat
      // backend) and never an external session.
      if (this.sessions.has(ev.sessionID) || this.byOpencode.has(ev.sessionID)) return;
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

    // The opencode session id joins to (record, chat) — every chat has
    // its own backend session, and per-turn state lives on the chat
    // (plan §14.13). Only session.created registers sessions.
    const binding = this.byOpencode.get(ev.sessionID);
    if (binding === undefined) return;
    const { rec, chat } = binding;
    const chatURI = chat.uri;
    switch (ev.type) {
      case "session.deleted":
        if (chat.uri === rec.defaultChatURI) {
          this.removeRecord(rec);
        } else {
          // Peer-chat backend gone (deleted in the TUI or by another
          // surface): drop the AHP chat only — the record and its other
          // chats stay.
          this.removeChat(rec, chat);
          this.publish({ channel: rec.channel, action: { type: ActionType.SessionChatRemoved, chat: chat.uri } });
        }
        return;
      case "session.renamed":
        if (chat.uri === rec.defaultChatURI) {
          this.publish({ channel: rec.channel, action: { type: ActionType.SessionTitleChanged, title: ev.title } });
        } else {
          // No chat-title session action exists; the chat summary carries
          // the title (the chat store's own title stays original — same
          // pre-existing behavior as the default chat's titleChanged).
          this.publish({
            channel: rec.channel,
            action: { type: ActionType.SessionChatUpdated, chat: chat.uri, changes: { title: ev.title } },
          });
        }
        return;
      case "inbox.enqueued":
        chat.lastInbox = { text: ev.text, delivery: ev.delivery };
        return;
      case "inbox.delivered":
        // Steering consumption is handled at turn end (finishTurn).
        return;
      case "execution.started":
        if (chat.currentTurnId !== null) return; // write-ahead already claimed the turn
        // Orphan turn (an external TUI prompt, or a handoff this host did
        // not initiate): start it with the last-seen inbox message.
        this.startTurn(chat, chat.lastInbox !== null ? userMessage(chat.lastInbox.text) : userMessage(""));
        return;
      case "execution.succeeded":
        if (chat.currentTurnId === null) return;
        this.publish({
          channel: chatURI,
          action: { type: ActionType.ChatTurnComplete, turnId: chat.currentTurnId, duration: this.turnDuration(chat) },
        });
        await this.finishTurn(chat);
        return;
      case "execution.failed":
        if (chat.currentTurnId === null) return;
        const part: ErrorResponsePart = {
          kind: ResponsePartKind.Error,
          error: { errorType: ev.error.type, message: ev.error.message },
        };
        this.publish({
          channel: chatURI,
          action: { type: ActionType.ChatError, turnId: chat.currentTurnId, duration: this.turnDuration(chat), part },
        });
        await this.finishTurn(chat);
        return;
      case "execution.interrupted":
        // Skipped when the client's own `chat/turnCancelled` echo already
        // finalized the turn (currentTurnId is null).
        if (chat.currentTurnId === null) return;
        this.publish({
          channel: chatURI,
          action: { type: ActionType.ChatTurnCancelled, turnId: chat.currentTurnId, duration: this.turnDuration(chat) },
        });
        await this.finishTurn(chat);
        return;
      case "step.started":
        chat.turnModelRef = `${ev.model.providerID}/${ev.model.modelID}`;
        return;
      case "text.delta":
      case "reasoning.delta": {
        if (chat.currentTurnId === null) return;
        const kind = ev.type === "text.delta" ? ResponsePartKind.Markdown : ResponsePartKind.Reasoning;
        const key = `${ev.assistantMessageID}:${kind}:${ev.ordinal}`;
        const first = !chat.parts.has(key);
        chat.parts.add(key);
        const partId = `part-${key}`;
        if (first) {
          // Lazily emit the part on the first delta; it carries the
          // initial content.
          this.publish({
            channel: chatURI,
            action: {
              type: ActionType.ChatResponsePart,
              turnId: chat.currentTurnId,
              part: { kind, id: partId, content: ev.delta },
            },
          });
        } else {
          this.publish({
            channel: chatURI,
            action:
              kind === ResponsePartKind.Markdown
                ? { type: ActionType.ChatDelta, turnId: chat.currentTurnId, partId, content: ev.delta }
                : { type: ActionType.ChatReasoning, turnId: chat.currentTurnId, partId, content: ev.delta },
          });
        }
        return;
      }
      case "text.ended":
      case "reasoning.ended": {
        if (chat.currentTurnId === null) return;
        // Fallback for non-streaming providers that emit only the final
        // text: if no delta opened the part, emit it now with the full text.
        const kind = ev.type === "text.ended" ? ResponsePartKind.Markdown : ResponsePartKind.Reasoning;
        const key = `${ev.assistantMessageID}:${kind}:${ev.ordinal}`;
        if (!chat.parts.has(key)) {
          chat.parts.add(key);
          this.publish({
            channel: chatURI,
            action: {
              type: ActionType.ChatResponsePart,
              turnId: chat.currentTurnId,
              part: { kind, id: `part-${key}`, content: ev.text },
            },
          });
        }
        return;
      }
      case "tool.input.started": {
        if (chat.currentTurnId === null) {
          this.log(`tool.input.started outside a turn (session ${chat.sessionID}, tool ${ev.name}); ignored`);
          return;
        }
        chat.toolName.set(ev.id, ev.name);
        // Phase 4 extension 1: when the session's active clients provide
        // this tool, the call is client-executed — the client
        // `contributor` must be established at start (the official
        // reducer ignores a late one), and the call is tracked for the
        // `execute` bridge + the client's dispatchable actions.
        // (Active clients are session-level; the chat tracks the call.)
        const clientTool = this.clientToolContributor(rec, ev.name);
        if (clientTool !== null) {
          chat.clientToolCalls.set(ev.id, { clientId: clientTool, turnId: chat.currentTurnId });
        }
        this.publish({
          channel: chatURI,
          action: {
            type: ActionType.ChatToolCallStart,
            turnId: chat.currentTurnId,
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
        chat.toolInput.set(ev.id, ev.text);
        // Phase 2: for file-mutating tools, capture the pre-edit file
        // content now (the event fires before execution — the last safe
        // point). Awaited in the sequential pump so the capture is
        // complete before `execution.*` can end the turn.
        if (this.opts.changesets) await this.captureTurnBefore(chat, ev.id, ev.text);
        // Phase 4 extension 1: a client-executed call clears its
        // confirmation gate here (no opencode permission can fire for
        // it) — ready straight to running, then surface the execution
        // request so the owning client picks up the work.
        if (chat.clientToolCalls.has(ev.id)) {
          this.ensureToolReady(chat, ev.id, false);
          const invocation = chat.clientToolCalls.get(ev.id);
          const running = this.toolCallState(chat, ev.id);
          if (invocation !== undefined && running !== null && running.status === ToolCallStatus.Running && chat.currentTurnId !== null) {
            const request: SessionToolClientExecutionRequest = {
              id: ev.id,
              chat: chatURI,
              kind: SessionInputRequestKind.ToolClientExecution,
              turnId: chat.currentTurnId,
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
        this.ensureToolReady(chat, ev.id, false);
        return;
      case "tool.success": {
        if (chat.currentTurnId === null) return;
        this.ensureToolReady(chat, ev.id, false);
        if (this.toolCallTerminal(chat, ev.id)) {
          // e.g. denied → already cancelled, or a client-executed call
          // the client already completed: no echo, but the tracking
          // (including the client-tool record) must still be cleared.
          this.clearToolTracking(chat, ev.id);
          return;
        }
        const name = chat.toolName.get(ev.id) ?? "tool";
        const input = chat.toolInput.get(ev.id);
        this.publish({
          channel: chatURI,
          action: {
            type: ActionType.ChatToolCallComplete,
            turnId: chat.currentTurnId,
            toolCallId: ev.id,
            result: {
              success: true,
              pastTenseMessage: pastTenseMessageFor(name, input),
              content: mapToolResultContent(ev.content),
            },
          },
        });
        this.clearToolTracking(chat, ev.id);
        return;
      }
      case "tool.failed": {
        if (chat.currentTurnId === null) return;
        this.ensureToolReady(chat, ev.id, false);
        if (this.toolCallTerminal(chat, ev.id)) {
          // Already terminal (client-executed call completed by the
          // client, or a call cancelled upstream) — clear the tracking.
          this.clearToolTracking(chat, ev.id);
          return;
        }
        const name = chat.toolName.get(ev.id) ?? "tool";
        const input = chat.toolInput.get(ev.id);
        this.publish({
          channel: chatURI,
          action: {
            type: ActionType.ChatToolCallComplete,
            turnId: chat.currentTurnId,
            toolCallId: ev.id,
            result: {
              success: false,
              pastTenseMessage: pastTenseMessageFor(name, input),
              error: { message: ev.error.message },
            },
          },
        });
        this.clearToolTracking(chat, ev.id);
        return;
      }
      case "usage.updated":
        // Session-cumulative tokens; the chat reducer replaces the turn's
        // usage, so the latest cumulative values are the turn's view.
        if (chat.currentTurnId === null) return;
        this.publish({
          channel: chatURI,
          action: {
            type: ActionType.ChatUsage,
            turnId: chat.currentTurnId,
            usage: {
              inputTokens: ev.tokens.input,
              outputTokens: ev.tokens.output,
              cacheReadTokens: ev.tokens.cache.read,
              ...(chat.turnModelRef !== null ? { model: chat.turnModelRef } : {}),
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
        chat.permissionForTool.set(toolCallId, ev.id);
        chat.toolForPermission.set(ev.id, toolCallId);
        this.ensureToolReady(chat, toolCallId, true);
        const pending = this.pendingToolCall(chat, toolCallId);
        if (pending !== null && chat.currentTurnId !== null) {
          const request: SessionToolConfirmationRequest = {
            id: toolCallId,
            chat: chatURI,
            kind: SessionInputRequestKind.ToolConfirmation,
            turnId: chat.currentTurnId,
            toolCall: pending,
          };
          this.publish({
            channel: rec.channel,
            action: { type: ActionType.SessionInputNeededSet, request },
          });
        }
        return;
      case "permission.replied": {
        const toolCallId = chat.toolForPermission.get(ev.requestID);
        chat.toolForPermission.delete(ev.requestID);
        if (toolCallId !== undefined) {
          chat.permissionForTool.delete(toolCallId);
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

  private turnDuration(chat: ChatRuntime): number {
    return Math.max(0, Date.now() - (chat.turnStartedAt ?? Date.now()));
  }

  /** Claim a turn (write-ahead) and publish `chat/turnStarted`. */
  private startTurn(chat: ChatRuntime, message: Message, queuedMessageId?: string): void {
    const turnId = this.mintTurnId();
    chat.currentTurnId = turnId;
    chat.turnStartedAt = Date.now();
    this.publish({
      channel: chat.uri,
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
  private async finishTurn(chat: ChatRuntime): Promise<void> {
    const endedTurnId = chat.currentTurnId;
    chat.currentTurnId = null;
    chat.turnStartedAt = null;
    const state = chat.chatStore.state;
    if (state.steeringMessage !== undefined) {
      this.publish({
        channel: chat.uri,
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
      this.startTurn(chat, next.message, next.id);
    } else if (chat.lastInbox !== null && chat.lastInbox.delivery === "queue") {
      // A queued prompt from outside AHP (e.g. the TUI).
      this.startTurn(chat, userMessage(chat.lastInbox.text));
    }
    if (this.opts.changesets && endedTurnId !== null) {
      await this.refreshTurnChangesets(this.byChannel.get(chat.uri)!, chat, endedTurnId);
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
  private async captureTurnBefore(chat: ChatRuntime, toolCallId: string, inputJson: string): Promise<void> {
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
   * The changeset store's owner (plan §14.13): session-kind changesets
   * live on the record (the session channel owns them); uncommitted/turn
   * changesets live on the owning chat. Null when the owner is gone
   * (a disposed chat's changesets are un-subscribable).
   */
  private changesetOwner(rec: SessionRecord, uri: string): { kind: "session" } | { kind: "chat"; chat: ChatRuntime } | null {
    const parsed = parseChangesetChannel(uri);
    if (parsed === null) return null;
    if (parsed.kind === "session") return { kind: "session" };
    const chat = rec.chats.get(parsed.ownerUri);
    return chat === undefined ? null : { kind: "chat", chat };
  }

  /**
   * Get-or-create the changeset store for a URI (fresh stores start
   * computing). Owner-aware — see `changesetOwner`; null when the owner
   * is gone.
   */
  private changesetStore(rec: SessionRecord, uri: string): ChangesetStateStore | null {
    const owner = this.changesetOwner(rec, uri);
    if (owner === null) return null;
    const map = owner.kind === "chat" ? owner.chat.changesets : rec.sessionChangesets;
    let store = map.get(uri);
    if (store === undefined) {
      store = createChangesetStateStore({ status: ChangesetStatus.Computing, files: [] });
      map.set(uri, store);
    }
    return store;
  }

  /** The live store for a URI, or undefined when it has never been created. */
  private changesetStoreOf(rec: SessionRecord, uri: string): ChangesetStateStore | undefined {
    const owner = this.changesetOwner(rec, uri);
    if (owner === null) return undefined;
    const map = owner.kind === "chat" ? owner.chat.changesets : rec.sessionChangesets;
    return map.get(uri);
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
    if (store === null) return; // owner gone (disposed chat)
    let files;
    try {
      if (parsed.kind === "turn") {
        // The turn's snapshots live on the owning chat; the content refs
        // carry its opencode session id (the byOpencode join key, plan
        // §14.13).
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
  private async refreshTurnChangesets(rec: SessionRecord, chat: ChatRuntime, turnId: string): Promise<void> {
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

  /**
   * Lazily publish `chat/toolCallReady` for a tool call (first of
   * progress/success/failed/permission.asked):
   *  - permission trigger → no `confirmed` → the reducer parks it in
   *    `pending-confirmation` (the caller then raises `inputNeededSet`);
   *  - otherwise → `confirmed: "not-needed"` → straight to `running`
   *    (opencode auto-approved).
   */
  private ensureToolReady(chat: ChatRuntime, toolCallId: string, permission: boolean): void {
    if (chat.toolReady.has(toolCallId) || chat.currentTurnId === null) return;
    chat.toolReady.add(toolCallId);
    const name = chat.toolName.get(toolCallId) ?? "tool";
    const input = chat.toolInput.get(toolCallId);
    this.publish({
      channel: chat.uri,
      action: {
        type: ActionType.ChatToolCallReady,
        turnId: chat.currentTurnId,
        toolCallId,
        invocationMessage: invocationMessageFor(name, input),
        toolInput: input,
        ...(permission ? {} : { confirmed: ToolCallConfirmationReason.NotNeeded }),
      },
    });
  }

  /** The live tool-call state in the chat's current turn, or null when absent. */
  private toolCallState(chat: ChatRuntime, toolCallId: string): ToolCallState | null {
    const turn = chat.chatStore.state.activeTurn;
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
  private pendingToolCall(chat: ChatRuntime, toolCallId: string): ToolCallConfirmationState | null {
    const tc = this.toolCallState(chat, toolCallId);
    if (tc === null) return null;
    if (tc.status === ToolCallStatus.PendingConfirmation || tc.status === ToolCallStatus.PendingResultConfirmation) {
      return tc;
    }
    return null;
  }

  /** True when the tool call already left the ready states (completed/cancelled). */
  private toolCallTerminal(chat: ChatRuntime, toolCallId: string): boolean {
    const tc = this.toolCallState(chat, toolCallId);
    return tc !== null && (tc.status === ToolCallStatus.Completed || tc.status === ToolCallStatus.Cancelled);
  }

  private clearToolTracking(chat: ChatRuntime, toolCallId: string): void {
    chat.toolInput.delete(toolCallId);
    chat.toolName.delete(toolCallId);
    chat.toolReady.delete(toolCallId);
    chat.clientToolCalls.delete(toolCallId);
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
  private settleClientTool(invocation: ClientToolInvocation, result?: FacadeClientToolResult): void {
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
    // The opencode session id joins to the (record, chat) that owns it —
    // every chat has its own backend session (plan §14.13).
    const binding = this.byOpencode.get(input.sessionID);
    if (binding === undefined) {
      return Promise.resolve({
        ok: false,
        error: `no AHP session for tool "${input.name}" (session ${input.sessionID} is not an AHP session)`,
      });
    }
    const { rec, chat } = binding;
    const invocation = chat.clientToolCalls.get(input.toolCallId);
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
      this.settleClientTool(invocation, result);
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
          this.settleClientTool(invocation, {
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
    if (this.sessions.has(sessionID) || this.byOpencode.has(sessionID)) return;
    let fs: FacadeSession | null;
    try {
      fs = await this.opts.facade.getSession(sessionID);
    } catch {
      return;
    }
    if (fs === null || this.sessions.has(fs.sessionID) || this.byOpencode.has(fs.sessionID)) return;
    this.registerExternal(fs);
  }

  /**
   * Register an opencode session the host did not create (TUI, another
   * client, or a session resurfacing after a restart).
   * Outcomes (plan §14.13 / §14.13.1):
   *
   *  - the opencode id already backs a chat of a live record → skip
   *    (undefined); `listSessions` must not surface peer-chat backends
   *    as their own AHP sessions;
   *  - the session carries a peer marker and the owner record is
   *    registered (and the marker's chat URI is free) → re-attach it to
   *    the owner's chat catalog (undefined — no standalone session);
   *  - the peer marker's owner is not registered yet → queue the
   *    binding (undefined) — the owner may be listed later in the same
   *    `listSessions` pass (there is no boot-time event replay);
   *  - the session carries a channel marker (minted-id default backend)
   *    and the marked channel is free → a standalone session registered
   *    under the ORIGINAL client-chosen channel;
   *  - otherwise → a standalone session whose channel reuses the
   *    opencode id (the record).
   */
  private registerExternal(fs: FacadeSession): SessionRecord | undefined {
    const existing = this.sessions.get(fs.sessionID);
    if (existing !== undefined) return existing;
    if (this.byOpencode.has(fs.sessionID)) return undefined;
    const marker = parseAhpMarker(fs.metadata);
    if (marker !== null) {
      if (marker.chat !== undefined && marker.owner !== undefined) {
        const owner = this.sessions.get(marker.owner);
        if (owner !== undefined) {
          if (this.byChannel.has(marker.chat)) {
            // The marker's chat is already bound — e.g. a fork inherited
            // the parent's metadata (core documents the inheritance).
            // Standalone fallback: the data stays reachable in AHP.
            this.log(
              `ignoring the AHP marker on ${fs.sessionID}: chat ${marker.chat} is already bound (registering standalone)`,
            );
          } else {
            return this.reattachPeerChat(owner, fs, marker.chat);
          }
        } else {
          this.enqueueChatBinding(marker.owner, fs, marker.chat);
          return undefined;
        }
      } else if (marker.channel !== undefined) {
        // The default backend of a minted-id session carries the
        // client-chosen session channel — resurface under it.
        if (this.byChannel.has(marker.channel)) {
          this.log(
            `ignoring the AHP channel marker on ${fs.sessionID}: ${marker.channel} is already bound (registering under the opencode id)`,
          );
        } else {
          return this.registerExternalStandalone(fs, marker.channel);
        }
      }
    }
    return this.registerExternalStandalone(fs);
  }

  /**
   * Re-attach a marked peer backend to its owner session's chat catalog
   * after a restart (plan §14.13.1). The owner store is LIVE (unlike a
   * fresh standalone registration), so the catalog change goes through
   * `publish` (store + any existing subscribers + the root diff), not a
   * direct apply. The chat title is re-derived (`Chat <n>`) — a
   * documented divergence from the pre-restart title. Returns undefined:
   * the backend gets no standalone AHP session (its session channel is
   * not registered — `sessions.get(peerID)` misses).
   */
  private reattachPeerChat(rec: SessionRecord, fs: FacadeSession, chatURI: string): undefined {
    const modifiedAt = new Date(fs.time.updated).toISOString();
    const chat = this.newChatRuntime(chatURI, fs.sessionID, `Chat ${rec.chats.size + 1}`, modifiedAt);
    this.bindChat(rec, chat);
    this.publish({
      channel: rec.channel,
      action: { type: ActionType.SessionChatAdded, summary: chatSummaryOf(chat.chatStore.state) },
    });
    if (this.opts.changesets) {
      this.publish({
        channel: chatURI,
        action: { type: ActionType.ChatChangesetsChanged, changesets: chatChangesetCatalog(chatURI, rec.channel) },
      });
    }
    this.log(`reattached peer chat ${chatURI} (backend ${fs.sessionID}) to session ${rec.channel} from its AHP marker`);
    return undefined;
  }

  /**
   * Queue a peer-chat binding whose owner is not registered yet (the
   * peer was listed before the owner, or the owner has not been listed
   * at all). `drainPendingChatBindings` resolves it when the owner
   * registers. The orphan fallback fires after the grace window: if the
   * owner is still unregistered and gone from opencode, the peer is
   * surfaced as its own AHP session instead (the data stays reachable).
   */
  private enqueueChatBinding(ownerID: string, fs: FacadeSession, chatURI: string): void {
    const queue = this.pendingChatBindings.get(ownerID) ?? [];
    queue.push({ fs, chatURI });
    this.pendingChatBindings.set(ownerID, queue);
    setTimeout(() => {
      void this.checkOrphanChatBindings(ownerID).catch((err) =>
        this.log(`orphan chat-binding check failed: ${errorMessage(err)}`),
      );
    }, EXTERNAL_REGISTER_GRACE_MS);
  }

  /**
   * Orphan fallback for queued peer-chat bindings (plan §14.13.1): the
   * owner never registered and is gone from opencode (e.g. deleted in
   * the TUI while the plugin was down). Drop the queue and register each
   * peer as a standalone AHP session. A failed owner lookup keeps the
   * queue — the next registration or timer re-checks.
   */
  private async checkOrphanChatBindings(ownerID: string): Promise<void> {
    const queue = this.pendingChatBindings.get(ownerID);
    if (queue === undefined || queue.length === 0) return; // the owner registered — drained
    let owner: FacadeSession | null;
    try {
      owner = await this.opts.facade.getSession(ownerID);
    } catch {
      return;
    }
    if (owner !== null) return; // the owner still exists in opencode — it registers when listed
    this.pendingChatBindings.delete(ownerID);
    for (const { fs, chatURI } of queue) {
      if (this.sessions.has(fs.sessionID) || this.byOpencode.has(fs.sessionID)) continue;
      this.log(
        `AHP marker owner ${ownerID} is gone from opencode — registering the orphaned peer ${fs.sessionID} (chat ${chatURI}) as a standalone session`,
      );
      this.registerExternalStandalone(fs);
    }
  }

  /**
   * Resolve queued peer-chat bindings once their owner registers (called
   * from the standalone registration's success path). A chat URI that is
   * already bound by then (e.g. the client created it again across the
   * restart) falls back to standalone registration.
   */
  private drainPendingChatBindings(ownerID: string): void {
    const queue = this.pendingChatBindings.get(ownerID);
    const owner = this.sessions.get(ownerID);
    if (queue === undefined || queue.length === 0 || owner === undefined) return;
    this.pendingChatBindings.delete(ownerID);
    for (const { fs, chatURI } of queue) {
      if (this.sessions.has(fs.sessionID) || this.byOpencode.has(fs.sessionID)) continue;
      if (this.byChannel.has(chatURI)) {
        this.log(
          `ignoring the AHP marker on ${fs.sessionID}: chat ${chatURI} is already bound (registering standalone)`,
        );
        this.registerExternalStandalone(fs);
      } else {
        this.reattachPeerChat(owner, fs, chatURI);
      }
    }
  }

  /**
   * Register an opencode session as a single-chat AHP session (its
   * default chat reuses the opencode id). The session channel defaults
   * to the opencode id; the channel-marker path (plan §14.13.1) passes
   * the ORIGINAL client-chosen channel instead — the registry then
   * resolves both suffixes (mirroring `handleCreateSession`). Applied
   * directly to the fresh stores (no seq, no actions) — the
   * registration is server-side bookkeeping, not a client-visible state
   * transition; the root announcement carries the lifecycle.
   */
  private registerExternalStandalone(fs: FacadeSession, channel?: string): SessionRecord {
    const recChannel = channel ?? sessionChannelURI(fs.sessionID);
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
    const rec: SessionRecord = {
      sessionID: fs.sessionID,
      channel: recChannel,
      provider: sessionStore.state.provider,
      createdAt: new Date(fs.time.created).toISOString(),
      modifiedAt,
      sessionStore,
      chats: new Map(),
      defaultChatURI: chatChannelURI(fs.sessionID),
      sessionChangesets: new Map(),
    };
    this.sessions.set(fs.sessionID, rec);
    this.byChannel.set(recChannel, rec);
    // The registry resolves the opencode id (event pump, chat channels)
    // and — for a channel-marker registration — the client-chosen
    // suffix too (mirroring `handleCreateSession`).
    const suffix = sessionIDOf(recChannel) as string;
    if (suffix !== fs.sessionID) this.channels.addSession(suffix);
    const defaultChat = this.newChatRuntime(rec.defaultChatURI, fs.sessionID, "Chat 1", modifiedAt);
    this.bindChat(rec, defaultChat);
    sessionStore.apply({ type: ActionType.SessionReady });
    sessionStore.apply({ type: ActionType.SessionChatAdded, summary: chatSummaryOf(defaultChat.chatStore.state) });
    sessionStore.apply({ type: ActionType.SessionDefaultChatChanged, defaultChat: rec.defaultChatURI });
    // Phase 2: advertise the changeset catalogues directly on the fresh
    // stores (registration is server-side bookkeeping — no seq, no actions).
    if (this.opts.changesets) {
      sessionStore.apply({ type: ActionType.SessionChangesetsChanged, changesets: sessionChangesetCatalog(recChannel) });
      defaultChat.chatStore.apply({
        type: ActionType.ChatChangesetsChanged,
        changesets: chatChangesetCatalog(rec.defaultChatURI, recChannel),
      });
    }
    // Durability (plan §14.13.1): peers whose marker points at this
    // session may have been listed earlier in the same `listSessions`
    // pass — re-attach them before the root announcement so the
    // sessionAdded summary carries the full chat catalog.
    this.drainPendingChatBindings(fs.sessionID);
    this.publish({
      channel: ROOT_CHANNEL,
      action: { type: ActionType.RootActiveSessionsChanged, activeSessions: this.sessions.size },
    });
    this.notifyRoot("root/sessionAdded", { channel: ROOT_CHANNEL, summary: this.sessionSummary(rec) });
    return rec;
  }

  /** Drop a session record and announce the removal on the root channel. */
  private removeRecord(rec: SessionRecord): void {
    const hadClients = rec.sessionStore.state.activeClients.length > 0;
    // Peer-chat backends are removed while their bindings are still live:
    // an unbound lingering backend would be re-registered by the next
    // listSessions scan as its own AHP session. R2: failures log — the
    // AHP side tears down either way (the ghost then shows in the TUI).
    for (const chat of rec.chats.values()) {
      if (chat.uri === rec.defaultChatURI) continue;
      void this.opts.facade
        .removeSession(chat.sessionID)
        .catch((err) => this.log(`failed to remove the peer chat's opencode session ${chat.sessionID}: ${errorMessage(err)}`));
    }
    // Phase 2: every live changeset URI is about to become un-subscribable
    // — dispatch `changeset/cleared` (protocol case 2) before the teardown
    // so subscribers release their references.
    for (const uri of rec.sessionChangesets.keys()) {
      this.publish({ channel: uri, action: { type: ActionType.ChangesetCleared } });
    }
    rec.sessionChangesets.clear();
    // Per-chat teardown (Phase 4 extension 2): live chat changesets
    // (`changeset/cleared`), in-flight client-tool executions failed
    // (the waiters must not leak), and every binding dropped.
    let failedTools = false;
    for (const chat of [...rec.chats.values()]) {
      failedTools = failedTools || [...chat.clientToolCalls.values()].some((inv) => inv.result === undefined);
      this.removeChat(rec, chat, "session removed before the client completed the tool call");
    }
    this.sessions.delete(rec.sessionID);
    this.byChannel.delete(rec.channel);
    const id = sessionIDOf(rec.channel);
    if (id !== null) this.channels.removeSession(id);
    this.channels.removeSession(rec.sessionID);
    this.publish({
      channel: ROOT_CHANNEL,
      action: { type: ActionType.RootActiveSessionsChanged, activeSessions: this.sessions.size },
    });
    this.notifyRoot("root/sessionRemoved", { channel: ROOT_CHANNEL, session: rec.channel });
    // Phase 4 extension 1: re-sync the opencode tool union when this
    // session's clients' tools leave the cross-session set (or any
    // in-flight call was failed — the facade union is unchanged, but the
    // session's execute gate must not linger).
    if (hadClients || failedTools) void this.syncClientToolsToOpencode();
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
      // The owner is the session/chat channel (owner-aware, plan §14.13).
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

  /** The denormalized `SessionSummary` view of a record. */
  private sessionSummary(rec: SessionRecord): SessionSummary {
    const s = rec.sessionStore.state;
    // Authoritative chat order: default first, then insertion order
    // (the default chat is bound first — plan §14.13).
    const chats = [...rec.chats.values()].map((c) => chatSummaryOf(c.chatStore.state));
    let modifiedAt = rec.modifiedAt;
    for (const c of rec.chats.values()) {
      if (c.chatStore.state.modifiedAt > modifiedAt) modifiedAt = c.chatStore.state.modifiedAt;
    }
    return buildSessionSummary({
      channel: rec.channel,
      provider: rec.provider,
      title: s.title,
      status: s.status,
      activity: s.activity,
      createdAt: rec.createdAt,
      modifiedAt,
      chats,
      defaultChat: rec.defaultChatURI,
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
        // Changeset stores are owner-keyed (session-kind on the record,
        // chat-kind on the chat — plan §14.13). Non-creating: a publish
        // targets a store someone created (subscribe/refresh); a missing
        // owner means the changeset is already torn down.
        const parsed = parseChangesetChannel(draft.channel);
        const rec = parsed !== null ? this.byChannel.get(parsed.ownerUri) : undefined;
        const store = rec !== undefined ? this.changesetStoreOf(rec, draft.channel) : undefined;
        if (store !== undefined) store.apply(draft.action as ChangesetAction);
      } else {
        // byChannel, not sessions.get(sessionIDOf(…)): the channel suffix
        // is not always the opencode session id (client-chosen suffixes).
        const rec = this.byChannel.get(draft.channel);
        if (rec !== undefined) {
          const before = this.sessionSummary(rec);
          if (kind === "session") {
            rec.sessionStore.apply(draft.action as SessionAction);
          } else {
            const chat = rec.chats.get(draft.channel);
            if (chat !== undefined) chat.chatStore.apply(draft.action as ChatAction);
          }
          if (kind === "chat") this.syncChatSummary(rec, draft.channel);
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
  private syncChatSummary(rec: SessionRecord, chatURI: string): void {
    const chat = rec.chats.get(chatURI)?.chatStore.state;
    if (chat === undefined) return;
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
