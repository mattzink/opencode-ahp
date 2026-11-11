/**
 * Record types shared by the host section classes: the per-socket, per-client, per-session, per-chat and per-terminal state shapes, and the HostOptions the Host is constructed with.
 */

import { ActionType, ReconnectResultType, Implementation, SessionSummary } from "@microsoft/agent-host-protocol";
import { OpencodeFacade } from "./bridge.js";
import { ClientToolInvocation } from "./client-tools.js";
import { ChatStateStore, ChangesetStateStore, SessionStateStore, TerminalStateStore } from "./state.js";

// ActionType / ReconnectResultType are `declare const enum` in the package
// but are also real runtime objects (verified against the published dist),
// so the value imports are safe under both tsc (inlined) and Bun.
export interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface SocketState {
  initialized: boolean;
  /** Negotiated version (set by initialize, inherited on reconnect). */
  version: string | null;
  clientId: string | null;
}

/**
 * Per-clientId registry record — survives socket closes so `reconnect`
 * can replay for the same client (AHP lifecycle spec).
 */
export interface ClientRecord {
  version: string;
  socketId: number | null;
}

/**
 * Everything the host tracks for one AHP chat — the backing opencode
 * session, its chat-state store, and the per-turn tracking the event
 * pump needs to join opencode events to AHP turns. One AHP chat ↔ one
 * opencode session.
 */
export interface ChatRuntime {
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
   * toolCallId → client-executed tool call tracking (created at
   * `tool.input.started`, removed at the opencode-side terminal).
   */
  clientToolCalls: Map<string, ClientToolInvocation>;
  /** The most recent `session.inbox.enqueued` (external/TUI prompt tracking). */
  lastInbox: { text: string; delivery: string } | null;
  // ── changesets ────────────────────────────────────────────────
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
   * removed (content refs + discard-restore read them).
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
export interface SessionRecord {
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

/**
 * The host's handle to a spawned pty process (the injected `spawnPty`
 * seam's return): forward input to the process, resize its window, and
 * kill it (client dispose / location teardown).
 */
export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** Everything the host tells the `spawnPty` seam to start an interactive shell. */
export interface SpawnPtyInput {
  /** The spawn working directory (absolute path, inside the location directory). */
  cwd: string;
  cols: number;
  rows: number;
  /** pty output — the `terminal/data` source. */
  onOutput: (data: string) => void;
  /** Process exit; `code` undefined when killed without an exit code. */
  onExit: (code: number | undefined) => void;
}

/**
 * Spawns an interactive pty shell for `createTerminal`. Injected by the
 * plugin entry (the Bun runtime provides it — `Bun.spawn` with the
 * `terminal` option); unit tests inject a fake. Undefined when the
 * runtime cannot spawn ptys (the terminal commands then answer -32601).
 */
export type SpawnPty = (input: SpawnPtyInput) => PtyProcess;

/** Fields shared by every terminal record. */
interface TerminalRecordBase {
  /** The terminal channel URI (synthetic: `ahp-terminal:/<toolCallId>`; pty: client-chosen). */
  uri: string;
  /** The official-reducer store (the snapshot payload). */
  store: TerminalStateStore;
  /** Date.now() at creation (the synthetic kind uses it as the `durationMs` baseline). */
  startedAt: number;
}

/**
 * A read-only rendering of a
 * `shell`-tool command execution (`isPty: false`, command parts only).
 * Opened at the tool call's `tool.input.ended` (the command line is only
 * known there); the record outlives its turn — the root catalog drops it
 * at turn end (retention), and the channel state stays subscribable until
 * the owning chat/record is removed.
 */
export interface SyntheticTerminalRecord extends TerminalRecordBase {
  kind: "synthetic";
  /** The AHP session record that owns the channel (claim `session`). */
  rec: SessionRecord;
  /** The chat whose turn ran the command (claim `chat`). */
  chat: ChatRuntime;
  /** The opencode tool call id (also the `commandId`, scoped to the URI). */
  toolCallId: string;
  /** The AHP turnId the command executed in — the catalog membership key. */
  turnId: string;
  commandLine: string;
}

/**
 * An interactive pseudoterminal shell spawned for a client via
 * `createTerminal` (design §12.2): a client-chosen channel URI, a real
 * shell process in a resolved working directory, and a lifecycle of its
 * own (input/resize to the process, claim/title/clear through the
 * official reducer). Listed in the root catalog while the record is
 * alive (running or exited) until the client disposes it or the location
 * tears down.
 */
export interface PtyTerminalRecord extends TerminalRecordBase {
  kind: "pty";
  /** The spawned process handle (the `spawnPty` seam's return). */
  process: PtyProcess;
  /** The resolved spawn working directory (absolute path). */
  cwd: string;
}

export type TerminalRecord = SyntheticTerminalRecord | PtyTerminalRecord;

export interface HostOptions {
  serverInfo: Implementation;
  facade: OpencodeFacade;
  replayWindow: number;
  /** The opencode instance's working directory (InitializeResult.defaultDirectory). */
  defaultDirectory?: string;
  /** Advertise + serve the changeset channels (catalogues, snapshots, discard). */
  changesets: boolean;
  /**
   * Serve the terminal channels — the synthetic shell-command renderings
   * (one read-only `ahp-terminal:` channel per foreground `shell`-tool
   * call) and the interactive pty shells behind `createTerminal`. Off the
   * wire in 1.0.0 (no capability field) — the switch gates the
   * host-side behavior (off: the synthetic channels never open and the
   * terminal commands answer -32601).
   */
  terminals: boolean;
  /**
   * The pty spawn seam for `createTerminal` (undefined when the runtime
   * cannot spawn ptys — the command then answers -32601). The plugin
   * entry provides the Bun-backed factory; tests inject a fake.
   */
  spawnPty?: SpawnPty;
  /** Deliver a JSON-serializable frame to a connection. */
  send: (socketId: number, message: unknown) => void;
  /** Close one connection (a superseded duplicate clientId). */
  close?: (socketId: number, code?: number, reason?: string) => void;
  log?: (message: string) => void;
}
