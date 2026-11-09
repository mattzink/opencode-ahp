/**
 * The opencode ⇄ AHP bridge (plan §6.1 bridge.ts) — the only opencode-
 * aware module, kept pure: it receives the narrow `OpencodeFacade` that
 * src/index.ts implements against the plugin `ctx`, and unit tests inject
 * a fake.
 *
 * Phase 0: the `ahp-root://` catalog (providers as AgentInfo, opencode
 * agents as AHP customizations — plan §14.7).
 *
 * Phase 1: the opencode session surface (create/list/get, prompt with
 * delivery, switchAgent/switchModel, interrupt, permission replies, the
 * mapped event stream) plus the initial-state builders and summary mappers
 * the host uses to seed session/chat stores.
 */
import { pathToFileURL } from "node:url";
import { sessionChangesetURI, turnChangesetURI, uncommittedChangesetURI } from "./channels.js";
import {
  ChangesetOperationScope,
  ChangesetOperationStatus,
  CustomizationLoadStatus,
  CustomizationType,
  MessageKind,
  SessionLifecycle,
  SessionStatus,
  type AgentCustomization,
  type AgentInfo,
  type Changeset,
  type ChangesetFile,
  type ChangesetOperation,
  type ChatSummary,
  type ChatState,
  type Customization,
  type DirectoryCustomization,
  type FileEdit,
  type Message,
  type SessionActiveClient,
  type SessionState,
  type SessionSummary,
  type SessionModelInfo,
} from "@microsoft/agent-host-protocol";

export type ProviderActivation = "auto" | "enabled" | "disabled";

export interface FacadeModel {
  providerID: string;
  modelID: string;
  name: string;
  enabled: boolean;
  limit: { context?: number; output?: number; input?: number };
  /** ModelInfo.capabilities.input (e.g. ["text", "image"]). */
  inputModalities: string[];
}

export interface FacadeProvider {
  providerID: string;
  name: string;
  description?: string;
  activation: ProviderActivation;
  models: FacadeModel[];
}

/** The opencode agent modes (Agent.Info.mode). */
export type FacadeAgentMode = "primary" | "subagent" | "all";

/**
 * Narrow opencode agent (plan §14.7 mapping table), from
 * `ctx.agent.list()` → `Agent.Info[]`.
 */
export interface FacadeAgent {
  id: string;
  name: string;
  description?: string;
  /** The `Model.Ref` the agent is pinned to; absent = inherit the session model. */
  model?: { providerID: string; modelID: string };
  mode: FacadeAgentMode;
  /** Internal agents (summary/title/compaction/…) — never surfaced. */
  hidden: boolean;
}

export interface FacadeModelRef {
  providerID: string;
  modelID: string;
  variant?: string;
}

/** A narrow opencode session (`ctx.session.*` → `SessionInfo`). */
export interface FacadeSession {
  sessionID: string;
  title?: string;
  agent?: string;
  model?: FacadeModelRef;
  archived?: boolean;
  time: { created: number; updated: number };
}

/** `SessionPromptInput.delivery` (steer | queue; absent = default). */
export type FacadeDelivery = "steer" | "queue";

/** The decision values the host uses (`always` is out of MVP scope). */
export type FacadePermissionDecision = "once" | "reject";

/**
 * A mapped opencode V2 event — the narrow, discriminated union the host's
 * event pump consumes. `mapV2Event` is the only place that knows the raw
 * wire shape; everything downstream works on this union.
 */
export type FacadeEvent =
  | { type: "session.created"; sessionID: string; title?: string; agent?: string; model?: FacadeModelRef }
  | { type: "session.deleted"; sessionID: string }
  | { type: "session.renamed"; sessionID: string; title: string }
  | { type: "inbox.enqueued"; sessionID: string; inboxID: string; text: string; delivery: FacadeDelivery | "default" }
  | { type: "inbox.delivered"; sessionID: string; inboxID: string }
  | { type: "execution.started"; sessionID: string }
  | { type: "execution.succeeded"; sessionID: string }
  | { type: "execution.failed"; sessionID: string; error: { type: string; message: string } }
  | { type: "execution.interrupted"; sessionID: string; reason: string }
  | { type: "step.started"; sessionID: string; assistantMessageID: string; agent: string; model: FacadeModelRef }
  | { type: "text.delta"; sessionID: string; assistantMessageID: string; ordinal: number; delta: string }
  | { type: "text.ended"; sessionID: string; assistantMessageID: string; ordinal: number; text: string }
  | { type: "reasoning.delta"; sessionID: string; assistantMessageID: string; ordinal: number; delta: string }
  | { type: "reasoning.ended"; sessionID: string; assistantMessageID: string; ordinal: number; text: string }
  | { type: "tool.input.started"; sessionID: string; assistantMessageID: string; id: string; name: string }
  | { type: "tool.input.ended"; sessionID: string; assistantMessageID: string; id: string; text: string }
  | { type: "tool.progress"; sessionID: string; id: string }
  | { type: "tool.success"; sessionID: string; id: string; content: FacadeToolContent[]; executed?: boolean }
  | { type: "tool.failed"; sessionID: string; id: string; error: { type: string; message: string }; executed?: boolean }
  | { type: "usage.updated"; sessionID: string; tokens: FacadeTokens }
  | {
      type: "permission.asked";
      sessionID: string;
      id: string;
      action: string;
      message?: string;
      /** Present when the permission was raised by a tool call (`id` = the tool call id). */
      source?: { type: "tool"; messageID: string; id: string };
    }
  | { type: "permission.replied"; sessionID: string; requestID: string; reply: string };

export interface FacadeToolContent {
  type: string;
  text?: string;
  data?: string;
  contentType?: string;
}

export interface FacadeTokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

/**
 * The narrow opencode surface the bridge needs. Implemented in
 * src/index.ts against the plugin `ctx` (the only ctx call sites, plan
 * §7 pure-module principle); a fake in unit tests.
 *
 * All methods are async: the catalog, agents, and sessions come from the
 * registry/session read APIs, which the docs guarantee reflect every
 * registration so far, including during plugin setup.
 */
export interface OpencodeFacade {
  /** Live provider/model catalog (plan §3.2: `ctx.provider` + `ctx.model`). */
  listCatalog(): Promise<readonly FacadeProvider[]>;
  /** Live opencode agents (plan §14.7: `ctx.agent.list()`). */
  listAgents(): Promise<readonly FacadeAgent[]>;
  // ── Phase 1: sessions ─────────────────────────────────────────────────
  /**
   * Create an opencode session. `id` is only passed through when it is a
   * valid opencode SessionID (must start with "ses"); the host decides.
   */
  createSession(input?: {
    id?: string;
    title?: string;
    agent?: string;
    model?: FacadeModelRef;
  }): Promise<FacadeSession>;
  /** All opencode sessions for this location. */
  listSessions(): Promise<readonly FacadeSession[]>;
  /** One opencode session, or null when it does not exist. */
  getSession(sessionID: string): Promise<FacadeSession | null>;
  /**
   * Send a prompt. `delivery` maps to `SessionPromptInput.delivery`
   * ("steer" | "queue"); absent = the default (start or continue a turn).
   * Resolves with the user message id opencode assigned.
   */
  prompt(input: { sessionID: string; text: string; delivery?: FacadeDelivery }): Promise<{ messageID: string }>;
  switchModel(input: { sessionID: string; model: FacadeModelRef }): Promise<void>;
  switchAgent(input: { sessionID: string; agent: string }): Promise<void>;
  interrupt(input: { sessionID: string }): Promise<void>;
  rename(input: { sessionID: string; title: string }): Promise<void>;
  replyPermission(input: {
    sessionID: string;
    requestID: string;
    decision: FacadePermissionDecision;
  }): Promise<void>;
  /**
   * The mapped event stream. The host passes its pump AbortSignal; the
   * iterator ends (without error) when the signal aborts.
   */
  events(signal: AbortSignal): AsyncIterable<FacadeEvent>;
  // ── Phase 2: changesets ───────────────────────────────────────────────
  /**
   * Working-tree diff vs HEAD (uncommitted changes, untracked files
   * included), with **absolute** file paths. `[]` when the location is
   * not a git repo, has no changes, or the diff fails (R2: degrade to
   * empty, never throw).
   */
  vcsDiffWorking(): Promise<readonly FacadeDiffFile[]>;
  /**
   * The file's content in HEAD (`git show HEAD:<rel>`), or null when the
   * location is not a repo, HEAD is missing, or the file is not tracked.
   */
  gitHeadFile(absPath: string): Promise<string | null>;
  /** Read a UTF-8 file from disk, or null when it does not exist. */
  readFile(absPath: string): Promise<string | null>;
  /** Write a UTF-8 file (creating parent directories as needed). */
  writeFile(absPath: string, content: string): Promise<void>;
  /** Delete a file; no-op when it does not exist. */
  deleteFile(absPath: string): Promise<void>;
  /**
   * Discard changes to one file: tracked → `git checkout HEAD -- <rel>`
   * (fallback delete), untracked → delete.
   */
  discardFile(absPath: string): Promise<void>;
}

/**
 * One entry of a VCS working-tree diff (the facade's shape — absolute
 * paths, unlike opencode's repo-root-relative `FileDiff.Info`).
 */
export interface FacadeDiffFile {
  path: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified";
}

// ── Phase 0: catalog mappers ─────────────────────────────────────────────

/**
 * Stable synthetic AHP URI for an opencode agent (plan §14.7: file URIs
 * are not available for config/built-in agents, and the URI only has to
 * match between the customization tree and `Message.agent`).
 */
export function agentUri(id: string): string {
  return `opencode:agent/${id}`;
}

/** The opencode agent id behind a synthetic `opencode:agent/<id>` URI, or null. */
export function agentIDFromUri(uri: string): string | null {
  return uri.startsWith("opencode:agent/") ? uri.slice("opencode:agent/".length) : null;
}

/**
 * Map opencode agents to AHP `AgentCustomization` children
 * (plan §14.7 mapping table):
 *  - `id` → `uri` (synthetic `opencode:agent/<id>`, stable per agent) and
 *    `id` (same value — the host is the minting publisher);
 *  - `hidden: true` agents are omitted (internal: summary/title/…);
 *  - pinned `model` → `<providerID>/<modelID>` — the same ref format as
 *    `SessionModelInfo.id`, so the pin resolves against the model picker;
 *  - `mode: "subagent"` → `disableUserInvocation: true` (delegatable, but
 *    not selectable in the user picker);
 *  - `permissions` have no AHP field — opencode enforces them itself.
 */
export function mapAgentCustomizations(agents: readonly FacadeAgent[]): AgentCustomization[] {
  const out: AgentCustomization[] = [];
  for (const agent of agents) {
    if (agent.hidden) continue;
    const uri = agentUri(agent.id);
    const child: AgentCustomization = {
      type: CustomizationType.Agent,
      id: uri,
      uri,
      name: agent.name,
    };
    if (agent.description !== undefined) child.description = agent.description;
    if (agent.model !== undefined) child.model = `${agent.model.providerID}/${agent.model.modelID}`;
    if (agent.mode === "subagent") child.disableUserInvocation = true;
    out.push(child);
  }
  return out;
}

/**
 * The workspace directory container that carries the agent children.
 * Attached to every `AgentInfo.customizations` (feeds the Agents
 * window's agent picker before any session exists) and to live
 * `SessionState.customizations` (the picker reads session-state
 * customizations — the root-cause fix for the empty dropdown, 2026-11-08).
 * `writable: false` — clients never write agents into the
 * workspace through this host.
 */
export function agentDirectoryCustomization(
  directory: string,
  agents: readonly FacadeAgent[],
): DirectoryCustomization {
  const name = directory.split(/[\\/]/).filter(Boolean).pop() ?? "workspace";
  return {
    type: CustomizationType.Directory,
    id: `opencode:directory:${directory}`,
    uri: pathToFileURL(directory).href,
    name,
    enabled: true,
    contents: CustomizationType.Agent,
    writable: false,
    load: { kind: CustomizationLoadStatus.Loaded },
    children: mapAgentCustomizations(agents),
  };
}

/**
 * Map the opencode catalog to the AHP root state's `agents` list.
 * Mapping locked 2026-11-07 (plan §14):
 *  - one AgentInfo per opencode provider;
 *  - providers with activation "disabled" are excluded;
 *  - models with enabled: false are excluded;
 *  - SessionModelInfo.id is a "<providerID>/<modelID>" ref;
 *  - maxContextWindow ← limit.context · maxOutputTokens ← limit.output
 *    · maxPromptTokens ← limit.input;
 *  - supportsVision ← capabilities.input contains "image".
 *
 * With opencode agents + a workspace directory (plan §14.7), every
 * AgentInfo also carries the same workspace directory container with the
 * agent children as `customizations` — omitted when there is no visible
 * (non-hidden) agent, so the picker shows the generic provider default
 * instead of an empty workspace entry.
 */
export function mapCatalog(
  providers: readonly FacadeProvider[],
  agents: readonly FacadeAgent[] = [],
  workspaceDirectory?: string,
): AgentInfo[] {
  const customizations =
    workspaceDirectory !== undefined && mapAgentCustomizations(agents).length > 0
      ? [agentDirectoryCustomization(workspaceDirectory, agents)]
      : undefined;
  const out: AgentInfo[] = [];
  for (const provider of providers) {
    if (provider.activation === "disabled") continue;
    const models: SessionModelInfo[] = [];
    for (const model of provider.models) {
      if (!model.enabled) continue;
      const info: SessionModelInfo = {
        id: `${provider.providerID}/${model.modelID}`,
        provider: provider.providerID,
        name: model.name,
        supportsVision: model.inputModalities.includes("image"),
      };
      if (model.limit.context !== undefined) info.maxContextWindow = model.limit.context;
      if (model.limit.output !== undefined) info.maxOutputTokens = model.limit.output;
      if (model.limit.input !== undefined) info.maxPromptTokens = model.limit.input;
      models.push(info);
    }
    out.push({
      provider: provider.providerID,
      displayName: provider.name,
      description: provider.description ?? provider.name,
      models,
      ...(customizations !== undefined ? { customizations } : {}),
    });
  }
  return out;
}

// ── Phase 1: event mapping ───────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Map a raw opencode V2 event (`{id, type, data}` — the fixture shape) to
 * the narrow `FacadeEvent` union, or null when the event carries nothing
 * the AHP host needs. Unknown types map to null (log-and-continue).
 */
export function mapV2Event(raw: unknown): FacadeEvent | null {
  if (!isObj(raw)) return null;
  const type = str(raw["type"]);
  const data = isObj(raw["data"]) ? raw["data"] : {};
  const sessionID = str(data["sessionID"]);
  if (type === undefined || sessionID === undefined) return null;

  switch (type) {
    case "session.created":
      return {
        type: "session.created",
        sessionID,
        title: str(data["title"]),
        agent: str(data["agent"]),
        model: mapModelRef(data["model"]),
      };
    case "session.deleted":
      return { type: "session.deleted", sessionID };
    case "session.renamed": {
      const title = str(data["title"]);
      return title !== undefined ? { type: "session.renamed", sessionID, title } : null;
    }
    case "session.inbox.enqueued": {
      const inboxID = str(data["inboxID"]);
      const item = isObj(data["item"]) ? data["item"] : undefined;
      const payload = item !== undefined && isObj(item["payload"]) ? item["payload"] : undefined;
      const text = payload !== undefined ? str(payload["text"]) : undefined;
      if (inboxID === undefined || text === undefined) return null;
      const delivery = str(data["delivery"]) ?? str(item?.["delivery"]);
      return {
        type: "inbox.enqueued",
        sessionID,
        inboxID,
        text,
        delivery: delivery === "steer" || delivery === "queue" ? delivery : "default",
      };
    }
    case "session.inbox.delivered": {
      const inboxID = str(data["inboxID"]);
      return inboxID !== undefined ? { type: "inbox.delivered", sessionID, inboxID } : null;
    }
    case "session.execution.started":
      return { type: "execution.started", sessionID };
    case "session.execution.succeeded":
      return { type: "execution.succeeded", sessionID };
    case "session.execution.failed": {
      const error = isObj(data["error"]) ? data["error"] : undefined;
      return {
        type: "execution.failed",
        sessionID,
        error: { type: error !== undefined ? (str(error["type"]) ?? "error") : "error", message: error !== undefined ? (str(error["message"]) ?? "") : "" },
      };
    }
    case "session.execution.interrupted":
      return { type: "execution.interrupted", sessionID, reason: str(data["reason"]) ?? "user" };
    case "session.step.started": {
      const assistantMessageID = str(data["assistantMessageID"]);
      const model = mapModelRef(data["model"]);
      if (assistantMessageID === undefined || model === undefined) return null;
      return {
        type: "step.started",
        sessionID,
        assistantMessageID,
        agent: str(data["agent"]) ?? "build",
        model,
      };
    }
    case "session.text.delta":
    case "session.reasoning.delta": {
      const assistantMessageID = str(data["assistantMessageID"]);
      const delta = str(data["delta"]);
      const ordinal = num(data["ordinal"]);
      if (assistantMessageID === undefined || delta === undefined || ordinal === undefined) return null;
      return {
        type: type === "session.text.delta" ? "text.delta" : "reasoning.delta",
        sessionID,
        assistantMessageID,
        ordinal,
        delta,
      };
    }
    case "session.text.ended":
    case "session.reasoning.ended": {
      const assistantMessageID = str(data["assistantMessageID"]);
      const text = str(data["text"]);
      const ordinal = num(data["ordinal"]);
      if (assistantMessageID === undefined || text === undefined || ordinal === undefined) return null;
      return {
        type: type === "session.text.ended" ? "text.ended" : "reasoning.ended",
        sessionID,
        assistantMessageID,
        ordinal,
        text,
      };
    }
    case "session.tool.input.started": {
      const id = str(data["id"]);
      const name = str(data["name"]);
      const assistantMessageID = str(data["assistantMessageID"]);
      if (id === undefined || name === undefined || assistantMessageID === undefined) return null;
      return { type: "tool.input.started", sessionID, assistantMessageID, id, name };
    }
    case "session.tool.input.ended": {
      const id = str(data["id"]);
      const text = str(data["text"]);
      const assistantMessageID = str(data["assistantMessageID"]);
      if (id === undefined || text === undefined || assistantMessageID === undefined) return null;
      return { type: "tool.input.ended", sessionID, assistantMessageID, id, text };
    }
    case "session.tool.progress": {
      const id = str(data["id"]);
      return id !== undefined ? { type: "tool.progress", sessionID, id } : null;
    }
    case "session.tool.success": {
      const id = str(data["id"]);
      if (id === undefined) return null;
      const content = Array.isArray(data["content"])
        ? (data["content"] as unknown[]).map((c) => (isObj(c) ? mapToolContent(c) : undefined)).filter((c): c is FacadeToolContent => c !== undefined)
        : [];
      return { type: "tool.success", sessionID, id, content, executed: data["executed"] === true };
    }
    case "session.tool.failed": {
      const id = str(data["id"]);
      const error = isObj(data["error"]) ? data["error"] : undefined;
      if (id === undefined) return null;
      return {
        type: "tool.failed",
        sessionID,
        id,
        error: { type: error !== undefined ? (str(error["type"]) ?? "error") : "error", message: error !== undefined ? (str(error["message"]) ?? "") : "" },
        executed: data["executed"] === true,
      };
    }
    case "session.usage.updated": {
      const tokens = isObj(data["tokens"]) ? data["tokens"] : undefined;
      if (tokens === undefined) return null;
      const cache = isObj(tokens["cache"]) ? tokens["cache"] : undefined;
      return {
        type: "usage.updated",
        sessionID,
        tokens: {
          input: num(tokens["input"]) ?? 0,
          output: num(tokens["output"]) ?? 0,
          reasoning: num(tokens["reasoning"]) ?? 0,
          cache: { read: cache !== undefined ? (num(cache["read"]) ?? 0) : 0, write: cache !== undefined ? (num(cache["write"]) ?? 0) : 0 },
        },
      };
    }
    case "permission.asked": {
      const id = str(data["id"]);
      if (id === undefined) return null;
      const source = isObj(data["source"]) && data["source"]["type"] === "tool" && str(data["source"]["id"]) !== undefined
        ? {
            type: "tool" as const,
            messageID: str(data["source"]["messageID"]) ?? "",
            id: str(data["source"]["id"]) as string,
          }
        : undefined;
      return {
        type: "permission.asked",
        sessionID,
        id,
        action: str(data["action"]) ?? "",
        message: str(data["message"]),
        source,
      };
    }
    case "permission.replied": {
      const requestID = str(data["requestID"]);
      const reply = str(data["reply"]);
      return requestID !== undefined && reply !== undefined
        ? { type: "permission.replied", sessionID, requestID, reply }
        : null;
    }
    default:
      return null;
  }
}

function mapModelRef(v: unknown): FacadeModelRef | undefined {
  if (!isObj(v)) return undefined;
  const id = str(v["id"]);
  const providerID = str(v["providerID"]);
  if (id === undefined || providerID === undefined) return undefined;
  const variant = str(v["variant"]);
  return variant !== undefined ? { providerID, modelID: id, variant } : { providerID, modelID: id };
}

function mapToolContent(c: Record<string, unknown>): FacadeToolContent | undefined {
  const t = str(c["type"]);
  if (t === undefined) return undefined;
  if (t === "text") {
    return { type: t, text: str(c["text"]) ?? "" };
  }
  if (t === "file" || t === "patch") {
    return { type: t, text: str(c["text"]) ?? str(c["patch"]) ?? "" };
  }
  return undefined;
}

// ── Phase 1: state builders & summary mappers ────────────────────────────

const STATUS_IDLE_READ = (SessionStatus.Idle | SessionStatus.IsRead) as SessionStatus;

/**
 * The `<providerID>/<modelID>` ref of a FacadeModelRef (the
 * `SessionModelInfo.id` format), or null when absent.
 */
export function modelRefString(model?: FacadeModelRef): string | null {
  return model !== undefined ? `${model.providerID}/${model.modelID}` : null;
}

/**
 * Initial `SessionState` for a new or lazily-registered opencode session.
 * `status` starts at `Idle | IsRead` (33) — the session reducer can only
 * move the read/archive/input-needed bits, so the *activity* source of
 * truth is the chat status (synced via `session/chatUpdated`, plan §14.9).
 * `customizations` carries the workspace agent directory container — the
 * same one the root catalog builds — because VS Code's agent dropdown reads
 * `SessionState.customizations` (root-state customizations are NOT read).
 */
export function initialSessionState(input: {
  sessionID: string;
  provider: string;
  title: string;
  activeClients?: SessionActiveClient[];
  customizations?: Customization[];
  status?: SessionStatus;
  changesets?: Changeset[];
}): SessionState {
  return {
    provider: input.provider,
    title: input.title,
    status: input.status ?? STATUS_IDLE_READ,
    lifecycle: SessionLifecycle.Creating,
    activeClients: input.activeClients ?? [],
    chats: [],
    defaultChat: undefined,
    ...(input.customizations !== undefined && input.customizations.length > 0
      ? { customizations: input.customizations }
      : {}),
    ...(input.changesets !== undefined ? { changesets: input.changesets } : {}),
  };
}

/** Initial `ChatState` for a session's single default chat. */
export function initialChatState(input: {
  resource: string;
  title: string;
  modifiedAt: string;
  changesets?: Changeset[];
}): ChatState {
  return {
    resource: input.resource,
    title: input.title,
    status: STATUS_IDLE_READ,
    modifiedAt: input.modifiedAt,
    turns: [],
    ...(input.changesets !== undefined ? { changesets: input.changesets } : {}),
  };
}

/** The denormalized `ChatSummary` view of a chat state. */
export function chatSummaryOf(chat: ChatState): ChatSummary {
  const summary: ChatSummary = {
    resource: chat.resource,
    title: chat.title,
    status: chat.status,
    modifiedAt: chat.modifiedAt,
  };
  if (chat.activity !== undefined) summary.activity = chat.activity;
  return summary;
}

/** The user-origin AHP `Message` for a plain text prompt. */
export function userMessage(text: string, model?: string, agentUri?: string): Message {
  const message: Message = { text, origin: { kind: MessageKind.User } };
  if (model !== undefined) message.model = { id: model };
  if (agentUri !== undefined) message.agent = { uri: agentUri };
  return message;
}

/**
 * Build the `SessionSummary` for root notifications / `listSessions` from
 * a live record's denormalized fields.
 */
export function buildSessionSummary(input: {
  channel: string;
  provider: string;
  title: string;
  status: SessionStatus;
  activity?: string;
  createdAt: string;
  modifiedAt: string;
  chat: ChatSummary;
  defaultChat: string;
}): SessionSummary {
  return {
    resource: input.channel,
    provider: input.provider,
    title: input.title,
    status: input.status,
    ...(input.activity !== undefined ? { activity: input.activity } : {}),
    createdAt: input.createdAt,
    modifiedAt: input.modifiedAt,
    chats: [input.chat],
    defaultChat: input.defaultChat,
  };
}

/**
 * Human-readable display name for an opencode tool (opencode ships no
 * display names; the names are lowercase identifiers like `shell`).
 */
export function displayNameFor(toolName: string): string {
  const known: Record<string, string> = {
    shell: "Shell",
    bash: "Shell",
    read: "Read file",
    write: "Write file",
    edit: "Edit file",
    apply: "Apply patch",
    glob: "Search files",
    grep: "Search content",
    webfetch: "Fetch URL",
    websearch: "Web search",
    task: "Task",
    todowrite: "Todo",
    todoread: "Todo",
  };
  return known[toolName] ?? toolName.charAt(0).toUpperCase() + toolName.slice(1);
}

function jsonValue(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/**
 * A present-tense, human-readable description of what a tool call will do
 * (the AHP `invocationMessage`), derived from the (JSON-string) input.
 * `shell`/`bash` → the command; file/url tools → the target; fallback →
 * the tool name.
 */
export function invocationMessageFor(toolName: string, inputText: string | undefined): string {
  let input: Record<string, unknown> | undefined;
  if (inputText !== undefined && inputText.length > 0) {
    try {
      const parsed: unknown = JSON.parse(inputText);
      if (isObj(parsed)) input = parsed;
    } catch {
      input = undefined;
    }
  }
  const first =
    (input !== undefined
      ? [
          jsonValue(input["command"]),
          jsonValue(input["cmd"]),
          jsonValue(input["path"]),
          jsonValue(input["file"]),
          jsonValue(input["filePath"]),
          jsonValue(input["url"]),
        ].find((v) => v !== null)
      : undefined) ?? null;
  if (first !== null) {
    return toolName === "shell" || toolName === "bash" ? `Run \`${first}\`` : first;
  }
  return displayNameFor(toolName);
}

/**
 * Past-tense variant for `ToolCallResult.pastTenseMessage`
 * ("Ran `cmd`", the file/url target, or the tool name).
 */
export function pastTenseMessageFor(toolName: string, inputText: string | undefined): string {
  const msg = invocationMessageFor(toolName, inputText);
  if (msg.startsWith("Run `")) return msg.replace(/^Run /, "Ran ");
  if (msg === displayNameFor(toolName)) {
    const known: Record<string, string> = { Shell: "Ran shell command" };
    return known[msg] ?? `Ran ${toolName}`;
  }
  return msg;
}

// ── Phase 2: changesets ───────────────────────────────────────────────────

/**
 * Content-ref URIs the host serves through `resourceRead` (plan §14.10):
 *  - `ahp-content://head/<b64url(absPath)>` — the file's content in HEAD
 *    (`git show HEAD:<rel>`), for the "before" side of uncommitted/session
 *    changes;
 *  - `ahp-content://snap/<b64url(session)>/<b64url(turn)>/<b64url(absPath)>/<part>`
 *    — a turn's captured pre-edit (`before`) or post-turn (`after`) content
 *    from the in-memory snapshot store. Opaque and unguessable (base64url
 *    segments, not path segments) so a client cannot point the host at
 *    arbitrary snapshots.
 *
 * The "after" side of uncommitted/session changes is the live disk path
 * itself (`file://`), read through `resourceRead` at view time.
 */
const CONTENT_REF_PREFIX = "ahp-content://";
const CONTENT_HEAD_MARKER = "ahp-content://head/";
const CONTENT_SNAP_MARKER = "ahp-content://snap/";

/** The `file://` URI of an absolute path (a `ChangesetFile.id`). */
export function fileUri(absPath: string): string {
  return pathToFileURL(absPath).href;
}

/** Content ref for a file's HEAD content (the "before" of a live diff). */
export function headContentRef(absPath: string): string {
  return CONTENT_HEAD_MARKER + b64url(absPath);
}

/** Content ref for one part of a turn's snapshot. */
export function snapContentRef(sessionID: string, turnId: string, absPath: string, part: "before" | "after"): string {
  return `${CONTENT_SNAP_MARKER}${b64url(sessionID)}/${b64url(turnId)}/${b64url(absPath)}/${part}`;
}

/** Parsed content-ref URI, or null when the URI is not one of ours. */
export type ParsedContentRef =
  | { kind: "head"; path: string }
  | { kind: "snap"; sessionID: string; turnId: string; path: string; part: "before" | "after" };

export function parseContentRef(uri: string): ParsedContentRef | null {
  if (uri.startsWith(CONTENT_HEAD_MARKER)) {
    const path = b64urlDecode(uri.slice(CONTENT_HEAD_MARKER.length));
    return path !== null ? { kind: "head", path } : null;
  }
  if (uri.startsWith(CONTENT_SNAP_MARKER)) {
    const segments = uri.slice(CONTENT_SNAP_MARKER.length).split("/");
    if (segments.length !== 4) return null;
    const [sessionID, turnId, path, part] = segments as [string, string, string, string];
    const dSession = b64urlDecode(sessionID);
    const dTurn = b64urlDecode(turnId);
    const dPath = b64urlDecode(path);
    if (dSession === null || dTurn === null || dPath === null) return null;
    if (part !== "before" && part !== "after") return null;
    return { kind: "snap", sessionID: dSession, turnId: dTurn, path: dPath, part };
  }
  return null;
}

function b64url(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64url");
}

function b64urlDecode(value: string): string | null {
  if (value.length === 0) return null;
  // base64url alphabet check — rejects path separators and junk, which is
  // what keeps a malformed ref from being mis-split into other segments.
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  const text = Buffer.from(value, "base64url").toString("utf-8");
  return text.length > 0 ? text : null;
}

/**
 * Line diff stats for two file contents (port of the ahp-acp-gateway
 * implementation, plan §14.10): CRLF-normalized, trailing newline ignored,
 * common prefix/suffix stripped, then an LCS DP over the middle with a
 * 40 000-cell cap (falls back to counting the whole middle when exceeded).
 */
export function computeLineDiffStats(
  oldText: string | null | undefined,
  newText: string | null | undefined,
): { added: number; removed: number } {
  const splitLines = (text: string | null | undefined): string[] => {
    if (!text) return [];
    const normalized = text.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines;
  };
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length === 0) {
    return { added: newLines.length, removed: 0 };
  }
  if (newLines.length === 0) {
    return { added: 0, removed: oldLines.length };
  }
  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);
  if (oldMid.length * newMid.length > 40_000) {
    return { added: newMid.length, removed: oldMid.length };
  }
  const dp = new Uint32Array((oldMid.length + 1) * (newMid.length + 1));
  const width = newMid.length + 1;
  for (let i = 1; i <= oldMid.length; i++) {
    const oldLine = oldMid[i - 1]!;
    for (let j = 1; j <= newMid.length; j++) {
      const idx = i * width + j;
      if (oldLine === newMid[j - 1]) {
        dp[idx] = dp[(i - 1) * width + (j - 1)]! + 1;
      } else {
        const up = dp[(i - 1) * width + j]!;
        const left = dp[i * width + (j - 1)]!;
        dp[idx] = up >= left ? up : left;
      }
    }
  }
  const lcs = dp[oldMid.length * width + newMid.length]!;
  return {
    added: Math.max(0, newMid.length - lcs),
    removed: Math.max(0, oldMid.length - lcs),
  };
}

/** The single operation this host advertises (plan §11 Phase 2). */
export const DISCARD_OPERATION_ID = "discard-changes";

/**
 * The `discard-changes` operation (gateway-identical shape): restores one
 * file from the changeset's "before" content — HEAD for uncommitted/session
 * changes, the turn's pre-edit snapshot for turn changes.
 */
export function discardOperation(): ChangesetOperation {
  return {
    id: DISCARD_OPERATION_ID,
    label: "Discard Changes",
    confirmation: "Are you sure you want to discard changes to this file?",
    icon: "discard",
    scopes: [ChangesetOperationScope.Resource],
    status: ChangesetOperationStatus.Idle,
  };
}

/**
 * The session channel's changeset catalogue: the session-wide changeset
 * only (the protocol's "session" changeKind — all changes the agent has
 * produced; approximated by the working tree vs HEAD, plan §14.10).
 */
export function sessionChangesetCatalog(sessionID: string): Changeset[] {
  return [
    {
      label: "Session Changes",
      uriTemplate: sessionChangesetURI(sessionID),
      changeKind: "session",
      capabilities: { review: {} },
    },
  ];
}

/**
 * The chat channel's changeset catalogue: uncommitted changes, the
 * session-wide changeset, and the per-turn template (`{turnId}` expands
 * against the chat's turns — the protocol's standard template shapes).
 */
export function chatChangesetCatalog(sessionID: string): Changeset[] {
  return [
    {
      label: "Uncommitted Changes",
      uriTemplate: uncommittedChangesetURI(sessionID),
      changeKind: "uncommitted",
      capabilities: { review: {} },
    },
    {
      label: "Session Changes",
      uriTemplate: sessionChangesetURI(sessionID),
      changeKind: "session",
      capabilities: { review: {} },
    },
    {
      label: "Turn Changes",
      uriTemplate: turnChangesetURI(sessionID, "{turnId}"),
      changeKind: "turn",
      capabilities: { review: {} },
    },
  ];
}

/** Carry a file's previous `reviewed` flag into a rebuilt entry (gateway behavior). */
function withReviewed(file: ChangesetFile, reviewed: boolean | undefined): ChangesetFile {
  return reviewed === undefined ? file : { ...file, reviewed };
}

/**
 * `ChangesetFile` entries for the working-tree diff (the `uncommitted` and
 * `session` changesets share this approximation, plan §14.10):
 *  - added → `after` only, live `file://` content ref;
 *  - deleted → `before` only, HEAD content ref;
 *  - modified → live `file://` after + HEAD before.
 * `id` is the `file://` URI (the target of `invokeChangesetOperation`).
 */
export function buildWorkingChangesetFiles(input: {
  diffs: readonly FacadeDiffFile[];
  reviewedById: ReadonlyMap<string, boolean>;
}): ChangesetFile[] {
  const out: ChangesetFile[] = [];
  for (const f of input.diffs) {
    if (f.path.length === 0) continue;
    const id = fileUri(f.path);
    const edit: FileEdit =
      f.status === "added"
        ? {
            after: { uri: id, content: { uri: id } },
            diff: { added: f.additions, removed: 0 },
          }
        : f.status === "deleted"
          ? {
              before: { uri: id, content: { uri: headContentRef(f.path) } },
              diff: { added: 0, removed: f.deletions },
            }
          : {
              before: { uri: id, content: { uri: headContentRef(f.path) } },
              after: { uri: id, content: { uri: id } },
              diff: { added: f.additions, removed: f.deletions },
            };
    out.push(withReviewed({ id, edit }, input.reviewedById.get(id)));
  }
  return out;
}

/**
 * `ChangesetFile` entries for one turn's captured file changes:
 *  - both sides use opaque snapshot content refs (the "after" is what the
 *    host read from disk at turn end — strictly correct even if a later
 *    turn edits the same file again);
 *  - `before === null` → the turn added the file; `after === null` → the
 *    turn deleted it; `before === after` → dropped (no net change).
 */
export function buildTurnChangesetFiles(input: {
  sessionID: string;
  turnId: string;
  /** absPath → captured {before, after} (null = file absent on that side). */
  files: ReadonlyMap<string, { before: string | null; after: string | null }>;
  reviewedById: ReadonlyMap<string, boolean>;
}): ChangesetFile[] {
  const out: ChangesetFile[] = [];
  for (const [absPath, snap] of input.files) {
    if (snap.before === snap.after) continue;
    const id = fileUri(absPath);
    const beforeRef = snapContentRef(input.sessionID, input.turnId, absPath, "before");
    const afterRef = snapContentRef(input.sessionID, input.turnId, absPath, "after");
    const edit: FileEdit =
      snap.before === null
        ? {
            after: { uri: id, content: { uri: afterRef } },
            diff: computeLineDiffStats(null, snap.after),
          }
        : snap.after === null
          ? {
              before: { uri: id, content: { uri: beforeRef } },
              diff: computeLineDiffStats(snap.before, null),
            }
          : {
              before: { uri: id, content: { uri: beforeRef } },
              after: { uri: id, content: { uri: afterRef } },
              diff: computeLineDiffStats(snap.before, snap.after),
            };
    out.push(withReviewed({ id, edit }, input.reviewedById.get(id)));
  }
  return out;
}
