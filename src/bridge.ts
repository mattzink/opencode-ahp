/**
 * The opencode ⇄ AHP bridge — the only opencode-aware module, kept pure:
 * it receives the narrow `OpencodeFacade` that src/index.ts implements
 * against the plugin `ctx`, and unit tests inject a fake.
 *
 * Surfaces: the `ahp-root://` catalog (providers as AgentInfo, opencode
 * agents as AHP customizations); the opencode session surface (create/
 * list/get, prompt with delivery, switchAgent/switchModel, interrupt,
 * permission replies, the mapped event stream); and the initial-state
 * builders and summary mappers the host uses to seed session/chat stores.
 */
import { pathToFileURL } from "node:url";
import { sessionChangesetURI, turnChangesetURI, uncommittedChangesetURI } from "./channels.js";
import {
  ChangesetOperationScope,
  ChangesetOperationStatus,
  CustomizationEnablementKind,
  CustomizationLoadStatus,
  CustomizationType,
  McpServerStatus,
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
  type McpServerCustomization,
  type McpServerState,
  type Message,
  type SessionActiveClient,
  type SessionState,
  type SessionSummary,
  type SessionModelInfo,
  type SkillCustomization,
  type ToolDefinition,
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
 * Narrow opencode agent, from `ctx.agent.list()` → `Agent.Info[]`.
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

/**
 * An opencode MCP server's connection status (opencode `Mcp.Status`).
 * The status, not the config: `ctx.mcp.list()` reports what is
 * configured for the location as it stands right now.
 */
export type FacadeMcpStatus = "connected" | "pending" | "disabled" | "failed" | "needs_auth";

/**
 * Narrow opencode MCP server, from `ctx.mcp.list()`. `title` is the
 * configured display name; `error` carries detail text for
 * `failed` / `needs_auth` only.
 */
export interface FacadeMcpServer {
  name: string;
  title?: string;
  status: FacadeMcpStatus;
  error?: string;
}

/**
 * Narrow opencode skill, from `ctx.skill.list()`. `path` is an
 * absolute filesystem path for on-disk skills, or a virtual URI for
 * built-in ones (`skill://…`).
 */
export interface FacadeSkill {
  id: string;
  name: string;
  description?: string;
  /** Absent or `true` = the model may auto-invoke; `false` = user-selected only. */
  autoinvoke?: boolean;
  path: string;
}

/**
 * Narrow opencode tool, from `ctx.tool.list()`. `input` is the raw
 * `Tool.Info.input` — an Effect codec, a Standard Schema instance, or
 * a plain JSON-Schema object (the mapper is shape-detecting; the
 * bridge keeps no schema-library dependency).
 */
export interface FacadeTool {
  name: string;
  description?: string;
  input?: unknown;
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
  /**
   * The opencode session this one is a child of — set only for
   * subagent children (opencode core creates them with a `parentID`
   * pointing at the caller's session). Root sessions and forks carry
   * no parentID (a fork records its origin in `fork` instead). The
   * host never surfaces a parented session as an AHP session
   * (mirrors the TUI's session-list filter).
   */
  parentID?: string;
  /**
   * Durable, core-opaque session metadata. The host uses
   * one key — `opencode-ahp` — to make the peer-chat binding survive a
   * restart; everything else is passed through opaquely.
   */
  metadata?: Record<string, unknown>;
  /**
   * The location the session lives in (opencode `SessionInfo.location`):
   * the directory its agent has tool access to. A session created through
   * this host with `workingDirectories` (or created elsewhere in another
   * location) carries a directory other than the plugin's own location.
   */
  location?: { directory: string };
}

/** `SessionPromptInput.delivery` (steer | queue; absent = default). */
export type FacadeDelivery = "steer" | "queue";

/** The decision values the host uses (`always` is not implemented). */
export type FacadePermissionDecision = "once" | "reject";

/**
 * A mapped opencode V2 event — the narrow, discriminated union the host's
 * event pump consumes. `mapV2Event` is the only place that knows the raw
 * wire shape; everything downstream works on this union.
 */
export type FacadeEvent =
  | {
      type: "session.created";
      sessionID: string;
      title?: string;
      agent?: string;
      model?: FacadeModelRef;
      /** The parent session id (subagent children); absent for root sessions and forks. */
      parentID?: string;
    }
  | { type: "session.deleted"; sessionID: string }
  | { type: "session.renamed"; sessionID: string; title: string }
  | {
      type: "inbox.enqueued";
      sessionID: string;
      inboxID: string;
      text: string;
      delivery: FacadeDelivery | "default";
      /**
       * The enqueued item is a subagent completion report (a synthetic
       * item whose `payload.metadata.source` is `"subagent"` — opencode
       * core's report-back for an idle child). The host origins a
       * report-driven turn as a system notification, not user input.
       */
      subagent?: true;
    }
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
  | { type: "step.ended"; sessionID: string; tokens: FacadeTokens }
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
 * The classified result of one raw opencode V2 event (event capture,
 * design §8.1):
 *  - `ok` — mapped into the narrow `FacadeEvent` union;
 *  - `dropped` — a known type whose instance carries nothing usable
 *    (`reason` names the missing fields), or a malformed envelope
 *    (not an object, missing `type`/`sessionID`);
 *  - `unimplemented` — an event type the host has no handler for.
 *
 * `mapV2Event` is the thin `ok → event, else null` wrapper over this;
 * src/index.ts's events() generator uses the full outcome for the
 * timestamped capture lines.
 */
export type V2EventOutcome =
  | { status: "ok"; event: FacadeEvent }
  | { status: "dropped"; type: string; reason: string }
  | { status: "unimplemented"; type: string };

/**
 * The narrow opencode surface the bridge needs. Implemented in
 * src/index.ts against the plugin `ctx` (the only ctx call sites — this
 * module stays pure); a fake in unit tests.
 *
 * All methods are async: the catalog, agents, and sessions come from the
 * registry/session read APIs, which the docs guarantee reflect every
 * registration so far, including during plugin setup.
 */
export interface OpencodeFacade {
  /** Live provider/model catalog (`ctx.provider` + `ctx.model`). */
  listCatalog(): Promise<readonly FacadeProvider[]>;
  /** Live opencode agents (`ctx.agent.list()`). */
  listAgents(): Promise<readonly FacadeAgent[]>;
  // ── session customization catalog ────────────────────────────
  /**
   * The MCP servers configured for this location (`ctx.mcp.list()`) —
   * names with their current connection status.
   */
  listMcpServers(): Promise<readonly FacadeMcpServer[]>;
  /** The skills available in this location (`ctx.skill.list()`). */
  listSkills(): Promise<readonly FacadeSkill[]>;
  /** The tools registered in this location (`ctx.tool.list()`). */
  listTools(): Promise<readonly FacadeTool[]>;
  /**
   * Toggle the `disabled` flag of a configured MCP server and re-reconcile
   * the MCP registry (`ctx.mcp.transform` + `ctx.mcp.reload`). A disabled
   * server is disconnected and reports status `disabled`; a re-enabled one
   * connects again and the reload resolves only once the status is
   * settled. Runtime-only: the config file is untouched and the decision
   * is lost on location restart/reload.
   */
  setMcpDisabled(name: string, disabled: boolean): Promise<void>;
  // ── sessions ─────────────────────────────────────────────────
  /**
   * Create an opencode session. `id` is only passed through when it is a
   * valid opencode SessionID (must start with "ses"); the host decides.
   */
  createSession(input?: {
    id?: string;
    title?: string;
    agent?: string;
    model?: FacadeModelRef;
    /** Durable session metadata — the host's chat-binding marker rides here. */
    metadata?: Record<string, unknown>;
    /**
     * The location to create the session in (opencode v2: the target
     * location boots on first use). Absent = the plugin's own location.
     */
    location?: { directory: string };
  }): Promise<FacadeSession>;
  /** All opencode sessions for this location. */
  listSessions(): Promise<readonly FacadeSession[]>;
  /** One opencode session, or null when it does not exist. */
  getSession(sessionID: string): Promise<FacadeSession | null>;
  /**
   * Remove an opencode session (`ctx.session.remove`). `disposeChat`
   * removes a chat's backend session, and record removal disposes the
   * peer-chat backends (multi-chat: one AHP chat per opencode session).
   */
  removeSession(sessionID: string): Promise<void>;
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
  // ── changesets ───────────────────────────────────────────────
  /**
   * Working-tree diff vs HEAD (uncommitted changes, untracked files
   * included), with **absolute** file paths, for `directory` (absent →
   * the plugin's own location directory). `[]` when the directory is
   * not a git repo, has no changes, or the diff fails (R2: degrade to
   * empty, never throw).
   */
  vcsDiffWorking(directory?: string): Promise<readonly FacadeDiffFile[]>;
  /**
   * The file's content in HEAD (`git show HEAD:<rel>`), or null when the
   * repo is missing, HEAD is missing, or the file is not tracked.
   */
  gitHeadFile(absPath: string, directory?: string): Promise<string | null>;
  /** Read a UTF-8 file from disk, or null when it does not exist. */
  readFile(absPath: string): Promise<string | null>;
  /** Write a UTF-8 file (creating parent directories as needed). */
  writeFile(absPath: string, content: string): Promise<void>;
  /** Delete a file; no-op when it does not exist. */
  deleteFile(absPath: string): Promise<void>;
  /**
   * Discard changes to one file in `directory` (absent → the plugin's
   * own location): tracked → `git checkout HEAD -- <rel>` (fallback
   * delete), untracked → delete.
   */
  discardFile(absPath: string, directory?: string): Promise<void>;
  // ── resources ─────────────────────────────────────────────────
  /**
   * Resolve the metadata of an absolute filesystem path for
   * `resourceResolve`. With `followSymlinks` true (the default),
   * symlinks are followed and `path` in the result is the canonical
   * (realpath) path; with false the link itself is stat'd and `type` is
   * `symlink`. Throws a Node `ErrnoException` (ENOENT/EACCES/…) on
   * failure — the host maps the code.
   */
  resolveResource(absPath: string, followSymlinks?: boolean): Promise<FacadeResourceInfo>;
  /**
   * List one directory's entries (name + type only) for `resourceList`.
   * Throws a Node `ErrnoException` when the path is missing, not a
   * directory, or inaccessible.
   */
  listDirectory(absPath: string): Promise<readonly FacadeDirectoryEntry[]>;
  /**
   * Create a directory with all missing parents for `resourceMkdir`
   * (`mkdir -p`: an existing directory is a no-op success). Throws a
   * Node `ErrnoException` on failure.
   */
  mkdirResource(absPath: string): Promise<void>;
  // ── client-provided tools ─────────────────────────
  /**
   * Replace the location's registered client tools with `tools` (the
   * cross-session union of every AHP session's active-client tools;
   * `[]` when none). The implementation applies them to the opencode
   * tool registry (`ctx.tool.transform` + `ctx.tool.reload`) — the
   * registered tools' `execute` routes back to the host.
   */
  syncClientTools(tools: readonly FacadeClientTool[]): Promise<void>;
}

/**
 * A client-provided tool in its opencode-registration form (the host
 * derives it from the AHP `ToolDefinition`s — `inputSchema` already
 * normalized to an object JSON Schema, `description` already defaulted).
 */
export interface FacadeClientTool {
  name: string;
  description: string;
  /** Object JSON Schema for the tool input (raw — opencode passes it through). */
  inputSchema: Record<string, unknown>;
}

/**
 * The settled result of a client-executed tool call, as the opencode
 * `execute` bridge consumes it: `ok` → a `Tool.Result` (the client's
 * `toolCallComplete` content, text blocks joined), not-ok → a thrown
 * `Tool.Error`.
 */
export type FacadeClientToolResult =
  | {
      ok: true;
      /** The client's past-tense message (`ToolCallResult.pastTenseMessage`). */
      pastTenseMessage: string;
      /** The client's text content blocks, joined (absent when none). */
      content?: string;
      /** The client's structured content, verbatim. */
      structuredContent?: Record<string, unknown>;
    }
  | { ok: false; error: string };

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

/**
 * The facade's shape of `resourceResolve` metadata. `path` is the
 * canonical (realpath) path when `followSymlinks` was true; `mtime`/
 * `ctime` are epoch milliseconds (the host formats the ISO strings).
 */
export interface FacadeResourceInfo {
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  mtime: number;
  ctime: number;
}

/** One `resourceList` entry (name + type; no size/mtime — the spec's
 * list result does not carry them). */
export interface FacadeDirectoryEntry {
  name: string;
  type: "file" | "directory";
}

// ── catalog mappers ─────────────────────────────────────────────

/**
 * Stable synthetic AHP URI for an opencode agent (file URIs are not
 * available for config/built-in agents, and the URI only has to match
 * between the customization tree and `Message.agent`).
 */
export function agentUri(id: string): string {
  return `opencode:agent/${id}`;
}

/** The opencode agent id behind a synthetic `opencode:agent/<id>` URI, or null. */
export function agentIDFromUri(uri: string): string | null {
  return uri.startsWith("opencode:agent/") ? uri.slice("opencode:agent/".length) : null;
}

/**
 * Map opencode agents to AHP `AgentCustomization` children:
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
 * customizations — the root-cause fix for the empty dropdown).
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
 * A skill's `path` as a customization URI: an absolute filesystem
 * path becomes a `file://` URI; a virtual path (built-in skills use
 * `skill://…`) is already URI-shaped and passes through. Both are
 * stable per skill, and id = uri (the host is the minting publisher).
 */
export function skillUri(path: string): string {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(path) ? path : pathToFileURL(path).href;
}

/**
 * Map opencode skills to AHP `SkillCustomization` children:
 *  - `id` = `uri` = the skill's `path` (see {@link skillUri});
 *  - `autoinvoke === false` → `disableModelInvocation: true` (the
 *    model must not pick it; the user can still select it);
 *  - `description` passes through.
 */
export function mapSkillCustomizations(skills: readonly FacadeSkill[]): SkillCustomization[] {
  const out: SkillCustomization[] = [];
  for (const skill of skills) {
    const uri = skillUri(skill.path);
    const child: SkillCustomization = {
      type: CustomizationType.Skill,
      id: uri,
      uri,
      name: skill.name,
    };
    if (skill.description !== undefined) child.description = skill.description;
    if (skill.autoinvoke === false) child.disableModelInvocation = true;
    out.push(child);
  }
  return out;
}

/**
 * The skills directory container that carries the skill children —
 * the sibling of {@link agentDirectoryCustomization}. A
 * `DirectoryCustomization` holds a single child type
 * (`contents` is singular), so skills get their own container over
 * the same directory URI; the id is suffixed so both coexist in
 * `SessionState.customizations`.
 */
export function skillDirectoryCustomization(
  directory: string,
  skills: readonly FacadeSkill[],
): DirectoryCustomization {
  const name = directory.split(/[\\/]/).filter(Boolean).pop() ?? "workspace";
  return {
    type: CustomizationType.Directory,
    id: `opencode:directory:${directory}:skills`,
    uri: pathToFileURL(directory).href,
    name,
    enabled: true,
    contents: CustomizationType.Skill,
    writable: false,
    load: { kind: CustomizationLoadStatus.Loaded },
    children: mapSkillCustomizations(skills),
  };
}

/** The id prefix of the host's MCP-server customization entries. */
export const MCP_CUSTOMIZATION_ID_PREFIX = "opencode:mcp/";

/**
 * opencode's `Mcp.Status` → AHP `McpServerState`:
 *  - `connected` → ready, `pending` → starting, `disabled` → stopped;
 *  - `failed` → error (the status carries a message);
 *  - `needs_auth` → error too: AHP's `auth-required` state requires
 *    the RFC 9728 `ProtectedResourceMetadata` (an https `resource`
 *    URI), which opencode's status does not carry (message only) —
 *    the degradation keeps the panel honest without inventing a
 *    resource identifier.
 */
export function mcpServerState(server: FacadeMcpServer): McpServerState {
  switch (server.status) {
    case "connected":
      return { kind: McpServerStatus.Ready };
    case "pending":
      return { kind: McpServerStatus.Starting };
    case "disabled":
      return { kind: McpServerStatus.Stopped };
    case "needs_auth":
      return {
        kind: McpServerStatus.Error,
        error: {
          errorType: "mcp.auth-required",
          message: server.error ?? "MCP server requires authentication",
        },
      };
    case "failed":
      return {
        kind: McpServerStatus.Error,
        error: { errorType: "mcp.failed", message: server.error ?? "MCP server failed to start" },
      };
  }
}

/**
 * Map opencode MCP servers to **top-level** AHP
 * `McpServerCustomization` entries — the protocol's slot for a
 * "globally-configured MCP server that isn't bundled in a plugin or
 * directory":
 *  - `id` = `opencode:mcp/<name>` (stable per configured server);
 *  - `uri` = the session's directory URI (the server is configured
 *    for that directory's location — the closest provenance the
 *    status list carries);
 *  - `name` = the configured display title, falling back to the
 *    config name;
 *  - `enablement` = a single Workspace entry with `enabled: false`
 *    for a server whose status is `disabled` (file- or toggle-
 *    disabled — the status list does not distinguish). The panel's
 *    effective-enabled value is `enablement[0].enabled ?? true`, so
 *    an enabled server omits the field; without it the client would
 *    render the toggle as on while the state says `stopped`.
 *
 * Snapshot semantics: the state is whatever opencode reports when the
 * session registers (or when the host re-snapshots after an MCP
 * toggle — the re-push replaces the full customization list).
 * opencode's `mcp.status.changed` event carries only the server name
 * (no state payload) and is not otherwise acted on, so the host
 * re-snapshots per registration rather than live-pushing (futures.md).
 */
export function mapMcpServerCustomizations(
  servers: readonly FacadeMcpServer[],
  directory: string,
): McpServerCustomization[] {
  const uri = pathToFileURL(directory).href;
  return servers.map((server) => ({
    type: CustomizationType.McpServer,
    id: `${MCP_CUSTOMIZATION_ID_PREFIX}${server.name}`,
    uri,
    name: server.title ?? server.name,
    state: mcpServerState(server),
    ...(server.status === "disabled"
      ? { enablement: [{ kind: CustomizationEnablementKind.Workspace, uri, enabled: false }] }
      : {}),
  }));
}

/**
 * A facade tool's raw `input` as an AHP `inputSchema`, or null when
 * there is no input at all. The AHP shape is fixed
 * (`{ type: "object", properties?, required? }`); opencode's
 * `Tool.Info.input` is a union of three value-schema forms, and the
 * bridge stays dependency-free, so the mapping is shape-detecting:
 *  - a plain JSON-Schema object literal → keep `type` / `properties`
 *    / `required` (the fields AHP accepts), validated in shape;
 *  - a Standard Schema v1 instance (branded
 *    `Symbol.for("standard-schema")`), an Effect codec, or any other
 *    opaque object → degrade to `{ type: "object" }` — the input is
 *    always an object, but no JSON-Schema shape is extractable
 *    without a schema compiler;
 *  - anything that is not an object (no input) → null (no
 *    `inputSchema` at all).
 */
export function inputSchemaOf(input: unknown): ToolDefinition["inputSchema"] | null {
  if (input === null || typeof input !== "object") return null;
  const candidate = input as Record<string, unknown>;
  if (
    candidate["type"] === "object" &&
    (candidate["properties"] === undefined ||
      (typeof candidate["properties"] === "object" && candidate["properties"] !== null)) &&
    (candidate["required"] === undefined ||
      (Array.isArray(candidate["required"]) &&
        candidate["required"].every((r) => typeof r === "string")))
  ) {
    const schema: NonNullable<ToolDefinition["inputSchema"]> = { type: "object" };
    if (candidate["properties"] !== undefined) {
      schema.properties = candidate["properties"] as Record<string, object>;
    }
    if (Array.isArray(candidate["required"])) {
      schema.required = candidate["required"] as string[];
    }
    return schema;
  }
  // Opaque schema forms (Standard Schema brand, Effect codec, …).
  return { type: "object" };
}

/**
 * Map the opencode tool registry to AHP `ToolDefinition[]` (the
 * session's `serverTools`):
 *  - `input` → `inputSchema` via {@link inputSchemaOf} (absent input
 *    omits the field);
 *  - `excluded` — names the cross-session union of every live
 *    session's active-client tools registers in the same location
 *    registry — are dropped: those tools already reach the model
 *    (and the client) through the client itself and must not echo
 *    back as server tools.
 */
export function mapServerTools(
  tools: readonly FacadeTool[],
  excluded: ReadonlySet<string> = new Set(),
): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const tool of tools) {
    if (excluded.has(tool.name)) continue;
    const def: ToolDefinition = { name: tool.name };
    if (tool.description !== undefined && tool.description.length > 0) {
      def.description = tool.description;
    }
    const inputSchema = inputSchemaOf(tool.input);
    if (inputSchema !== null) def.inputSchema = inputSchema;
    out.push(def);
  }
  return out;
}

/**
 * Map the opencode catalog to the AHP root state's `agents` list.
 * Mapping locked:
 *  - one AgentInfo per opencode provider;
 *  - providers with activation "disabled" are excluded;
 *  - models with enabled: false are excluded;
 *  - SessionModelInfo.id is a "<providerID>/<modelID>" ref;
 *  - maxContextWindow ← limit.context · maxOutputTokens ← limit.output
 *    · maxPromptTokens ← limit.input;
 *  - supportsVision ← capabilities.input contains "image".
 *
 * With opencode agents + a workspace directory, every
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
      // Multi-chat: advertise plain multipleChats.
      // No `fork`/`sideChat` sub-caps — the opencode plugin surface has
      // no fork API in 2.2.6, so conformant clients (VS Code gates its
      // UI on these) will never attempt the unsupported source forms.
      // No `multipleWorkingDirectories` either (a location is one dir).
      capabilities: { multipleChats: {} },
      ...(customizations !== undefined ? { customizations } : {}),
    });
  }
  return out;
}

// ── event mapping ───────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** "a, b" — the names of the undefined values (drop reasons). */
function missingOf(vals: Record<string, unknown>): string {
  return Object.keys(vals).filter((k) => vals[k] === undefined).join(", ");
}

/**
 * Classify a raw opencode V2 event (`{id, type, data}` — the fixture
 * shape) — `mapV2Event` is the thin `ok → event, else null` wrapper
 * over this, and the timestamped capture lines (design §8.1) are
 * formatted from the full outcome. Unknown types classify as
 * `unimplemented` (log-and-continue, as before).
 */
export function mapV2EventRaw(raw: unknown): V2EventOutcome {
  if (!isObj(raw)) return { status: "dropped", type: "?", reason: "not an event envelope" };
  const type = str(raw["type"]);
  if (type === undefined) return { status: "dropped", type: "?", reason: "missing: type" };
  const data = isObj(raw["data"]) ? raw["data"] : {};
  const sessionID = str(data["sessionID"]);
  if (sessionID === undefined) return { status: "dropped", type, reason: "missing: sessionID" };

  /** The `dropped` outcome for missing fields inside a known type. */
  const drop = (fields: string): V2EventOutcome => ({ status: "dropped", type, reason: `missing: ${fields}` });

  switch (type) {
    case "session.created":
      return {
        status: "ok",
        event: {
          type: "session.created",
          sessionID,
          title: str(data["title"]),
          agent: str(data["agent"]),
          model: mapModelRef(data["model"]),
          parentID: str(data["parentID"]),
        },
      };
    case "session.deleted":
      return { status: "ok", event: { type: "session.deleted", sessionID } };
    case "session.renamed": {
      const title = str(data["title"]);
      if (title === undefined) return drop("title");
      return { status: "ok", event: { type: "session.renamed", sessionID, title } };
    }
    case "session.inbox.enqueued": {
      const inboxID = str(data["inboxID"]);
      const item = isObj(data["item"]) ? data["item"] : undefined;
      const payload = item !== undefined && isObj(item["payload"]) ? item["payload"] : undefined;
      const text = payload !== undefined ? str(payload["text"]) : undefined;
      if (inboxID === undefined || text === undefined)
        return drop(missingOf({ inboxID, text }));
      const delivery = str(data["delivery"]) ?? str(item?.["delivery"]);
      // Subagent completion report: a SYNTHETIC item tagged
      // `metadata.source: "subagent"` (opencode core's report-back for an
      // idle child). The item type is part of the detection key — user
      // items may carry arbitrary metadata too.
      const metadata = payload !== undefined && isObj(payload["metadata"]) ? payload["metadata"] : undefined;
      const subagent = item?.["type"] === "synthetic" && metadata !== undefined && metadata["source"] === "subagent";
      return {
        status: "ok",
        event: {
          type: "inbox.enqueued",
          sessionID,
          inboxID,
          text,
          delivery: delivery === "steer" || delivery === "queue" ? delivery : "default",
          ...(subagent ? { subagent: true as const } : {}),
        },
      };
    }
    case "session.inbox.delivered": {
      const inboxID = str(data["inboxID"]);
      if (inboxID === undefined) return drop("inboxID");
      return { status: "ok", event: { type: "inbox.delivered", sessionID, inboxID } };
    }
    case "session.execution.started":
      return { status: "ok", event: { type: "execution.started", sessionID } };
    case "session.execution.succeeded":
      return { status: "ok", event: { type: "execution.succeeded", sessionID } };
    case "session.execution.failed": {
      const error = isObj(data["error"]) ? data["error"] : undefined;
      return {
        status: "ok",
        event: {
          type: "execution.failed",
          sessionID,
          error: { type: error !== undefined ? (str(error["type"]) ?? "error") : "error", message: error !== undefined ? (str(error["message"]) ?? "") : "" },
        },
      };
    }
    case "session.execution.interrupted":
      return { status: "ok", event: { type: "execution.interrupted", sessionID, reason: str(data["reason"]) ?? "user" } };
    case "session.step.started": {
      const assistantMessageID = str(data["assistantMessageID"]);
      const model = mapModelRef(data["model"]);
      if (assistantMessageID === undefined || model === undefined)
        return drop(missingOf({ assistantMessageID, model }));
      return {
        status: "ok",
        event: {
          type: "step.started",
          sessionID,
          assistantMessageID,
          agent: str(data["agent"]) ?? "build",
          model,
        },
      };
    }
    case "session.text.delta":
    case "session.reasoning.delta": {
      const assistantMessageID = str(data["assistantMessageID"]);
      const delta = str(data["delta"]);
      const ordinal = num(data["ordinal"]);
      if (assistantMessageID === undefined || delta === undefined || ordinal === undefined)
        return drop(missingOf({ assistantMessageID, delta, ordinal }));
      return {
        status: "ok",
        event: {
          type: type === "session.text.delta" ? "text.delta" : "reasoning.delta",
          sessionID,
          assistantMessageID,
          ordinal,
          delta,
        },
      };
    }
    case "session.text.ended":
    case "session.reasoning.ended": {
      const assistantMessageID = str(data["assistantMessageID"]);
      const text = str(data["text"]);
      const ordinal = num(data["ordinal"]);
      if (assistantMessageID === undefined || text === undefined || ordinal === undefined)
        return drop(missingOf({ assistantMessageID, text, ordinal }));
      return {
        status: "ok",
        event: {
          type: type === "session.text.ended" ? "text.ended" : "reasoning.ended",
          sessionID,
          assistantMessageID,
          ordinal,
          text,
        },
      };
    }
    case "session.tool.input.started": {
      const id = str(data["id"]);
      const name = str(data["name"]);
      const assistantMessageID = str(data["assistantMessageID"]);
      if (id === undefined || name === undefined || assistantMessageID === undefined)
        return drop(missingOf({ id, name, assistantMessageID }));
      return { status: "ok", event: { type: "tool.input.started", sessionID, assistantMessageID, id, name } };
    }
    case "session.tool.input.ended": {
      const id = str(data["id"]);
      const text = str(data["text"]);
      const assistantMessageID = str(data["assistantMessageID"]);
      if (id === undefined || text === undefined || assistantMessageID === undefined)
        return drop(missingOf({ id, text, assistantMessageID }));
      return { status: "ok", event: { type: "tool.input.ended", sessionID, assistantMessageID, id, text } };
    }
    case "session.tool.progress": {
      const id = str(data["id"]);
      if (id === undefined) return drop("id");
      return { status: "ok", event: { type: "tool.progress", sessionID, id } };
    }
    case "session.tool.success": {
      const id = str(data["id"]);
      if (id === undefined) return drop("id");
      const content = Array.isArray(data["content"])
        ? (data["content"] as unknown[]).map((c) => (isObj(c) ? mapToolContent(c) : undefined)).filter((c): c is FacadeToolContent => c !== undefined)
        : [];
      return { status: "ok", event: { type: "tool.success", sessionID, id, content, executed: data["executed"] === true } };
    }
    case "session.tool.failed": {
      const id = str(data["id"]);
      const error = isObj(data["error"]) ? data["error"] : undefined;
      if (id === undefined) return drop("id");
      return {
        status: "ok",
        event: {
          type: "tool.failed",
          sessionID,
          id,
          error: { type: error !== undefined ? (str(error["type"]) ?? "error") : "error", message: error !== undefined ? (str(error["message"]) ?? "") : "" },
          executed: data["executed"] === true,
        },
      };
    }
    case "session.step.ended": {
      const tokens = isObj(data["tokens"]) ? data["tokens"] : undefined;
      if (tokens === undefined) return drop("tokens");
      const cache = isObj(tokens["cache"]) ? tokens["cache"] : undefined;
      return {
        status: "ok",
        event: {
          type: "step.ended",
          sessionID,
          tokens: {
            input: num(tokens["input"]) ?? 0,
            output: num(tokens["output"]) ?? 0,
            reasoning: num(tokens["reasoning"]) ?? 0,
            cache: { read: cache !== undefined ? (num(cache["read"]) ?? 0) : 0, write: cache !== undefined ? (num(cache["write"]) ?? 0) : 0 },
          },
        },
      };
    }
    case "permission.asked": {
      const id = str(data["id"]);
      if (id === undefined) return drop("id");
      const source = isObj(data["source"]) && data["source"]["type"] === "tool" && str(data["source"]["id"]) !== undefined
        ? {
            type: "tool" as const,
            messageID: str(data["source"]["messageID"]) ?? "",
            id: str(data["source"]["id"]) as string,
          }
        : undefined;
      return {
        status: "ok",
        event: {
          type: "permission.asked",
          sessionID,
          id,
          action: str(data["action"]) ?? "",
          message: str(data["message"]),
          source,
        },
      };
    }
    case "permission.replied": {
      const requestID = str(data["requestID"]);
      const reply = str(data["reply"]);
      if (requestID === undefined || reply === undefined)
        return drop(missingOf({ requestID, reply }));
      return { status: "ok", event: { type: "permission.replied", sessionID, requestID, reply } };
    }
    default:
      return { status: "unimplemented", type };
  }
}

/**
 * Map a raw opencode V2 event to the narrow `FacadeEvent` union, or
 * null when the event carries nothing the AHP host needs — the `ok`
 * view of `mapV2EventRaw` (`dropped`/`unimplemented` outcomes are
 * log-and-continue; the capture lines see the full outcome).
 */
export function mapV2Event(raw: unknown): FacadeEvent | null {
  const outcome = mapV2EventRaw(raw);
  return outcome.status === "ok" ? outcome.event : null;
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

// ── event capture lines ───────────────────────────────────────────

/** The house log tag (shared with src/index.ts's console lines). */
export const EVENT_LOG_TAG = "[opencode-ahp]";

/** Max characters of the raw `data` JSON on a capture line. */
const EVENT_LOG_PAYLOAD_MAX = 300;

/**
 * Local `HH:MM:SS.mmm` (zero-padded) for capture lines. The `Date` is
 * passed in (not read here) so the formatter stays pure and unit-testable
 * with a fixed instant.
 */
export function timeStamp(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/**
 * One capture line per raw opencode event (design §8.1):
 *
 *   [opencode-ahp] 19:04:41.520 event ok: session.tool.input.started {"…"}
 *   [opencode-ahp] 19:04:41.525 event dropped (missing: text): session.tool.input.ended {"…"}
 *   [opencode-ahp] 19:04:41.530 event unimplemented: shell.created {"…"}
 *
 * The type is the **raw** opencode type (what the plugin received), and
 * the payload is the raw `data` JSON — truncated to
 * `EVENT_LOG_PAYLOAD_MAX` with an ellipsis — or the whole raw value when
 * the envelope is malformed. `stamp` is precomputed (`timeStamp`) so this
 * stays pure.
 */
export function eventLogLine(outcome: V2EventOutcome, raw: unknown, stamp: string): string {
  const type = isObj(raw) ? (str(raw["type"]) ?? "?") : "?";
  const payloadSource = isObj(raw) && isObj(raw["data"]) ? raw["data"] : raw;
  let payload: string;
  try {
    payload = JSON.stringify(payloadSource) ?? "null";
  } catch {
    payload = "(unserializable)";
  }
  if (payload.length > EVENT_LOG_PAYLOAD_MAX) payload = `${payload.slice(0, EVENT_LOG_PAYLOAD_MAX)}…`;
  const kind =
    outcome.status === "ok"
      ? "ok"
      : outcome.status === "dropped"
        ? `dropped (${outcome.reason})`
        : "unimplemented";
  return `${EVENT_LOG_TAG} ${stamp} event ${kind}: ${type} ${payload}`;
}

// ── state builders & summary mappers ────────────────────────────

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
 * truth is the chat status (synced via `session/chatUpdated`).
 * `customizations` carries the session customization catalog (design
 * §7.5) — the workspace agent directory container, the sibling skills
 * directory container, and the top-level MCP server entries — because
 * VS Code's agent dropdown and Customizations panel read
 * `SessionState.customizations` (root-state customizations are NOT
 * read). `serverTools` carries the host-side tool list (opencode's
 * registry minus client-contributed tools).
 */
export function initialSessionState(input: {
  sessionID: string;
  provider: string;
  title: string;
  activeClients?: SessionActiveClient[];
  customizations?: Customization[];
  /** The session's `serverTools` (AHP `SessionState.serverTools`). */
  serverTools?: ToolDefinition[];
  status?: SessionStatus;
  changesets?: Changeset[];
  /**
   * The session's working directories (AHP `SessionMetadata.workingDirectories`):
   * the location directory the session's agent has tool access to. VS Code's
   * session list groups sessions by this workspace (label = the folder name,
   * host-suffixed for remote hosts); a session without it lands in the
   * "Unknown" bucket. Single entry — the host advertises no
   * `multipleWorkingDirectories` capability, so clients may not mutate it.
   */
  workingDirectories?: string[];
}): SessionState {
  return {
    provider: input.provider,
    title: input.title,
    status: input.status ?? STATUS_IDLE_READ,
    lifecycle: SessionLifecycle.Creating,
    activeClients: input.activeClients ?? [],
    chats: [],
    defaultChat: undefined,
    ...(input.workingDirectories !== undefined && input.workingDirectories.length > 0
      ? { workingDirectories: input.workingDirectories }
      : {}),
    ...(input.customizations !== undefined && input.customizations.length > 0
      ? { customizations: input.customizations }
      : {}),
    ...(input.serverTools !== undefined && input.serverTools.length > 0
      ? { serverTools: input.serverTools }
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
 * The system-notification-origin AHP `Message` for a machine-generated
 * turn input — a subagent completion report waking an idle parent
 * (design §8): the turn carries the report text verbatim, but its origin
 * is `systemNotification`, not user input.
 */
export function systemNotificationMessage(text: string): Message {
  return { text, origin: { kind: MessageKind.SystemNotification } };
}

/** Bitmask covering the mutually-exclusive activity bits (bits 0–4). */
const STATUS_ACTIVITY_MASK = (1 << 5) - 1;

/**
 * The bit that uniquely marks an input-needed status: `InputNeeded` (24)
 * *includes* the `InProgress` bit (8), so `status & InputNeeded` also
 * matches plain in-progress — bit 16 (`InputNeeded & ~InProgress`) is the
 * discriminator (the same bit the official reducer's
 * `withInputNeededStatus` clears on drain).
 */
const INPUT_NEEDED_MARKER = (SessionStatus.InputNeeded & ~SessionStatus.InProgress) as SessionStatus;

/**
 * Derive `SessionSummary.status` per the AHP aggregation rules: the
 * activity bits (0–4) come from the default chat, else the most recently
 * modified chat; they are **promoted** to `InputNeeded` whenever any chat
 * is blocked on input, else to `Error` whenever any chat is in an error
 * state. The orthogonal flags (`IsRead` / `IsArchived`) are session-scoped
 * and are preserved from `sessionStatus`.
 *
 * The activity bits are deliberately NOT taken from `sessionStatus`: the
 * session reducer only reaches them through the input-queue path, and that
 * path cannot lower them back to `Idle` once a turn ends (draining the
 * queue leaves `InProgress` behind — the official reducer's "unblocked
 * turn falls back to `InProgress`" assumes the session was promoted to
 * `InProgress` when the turn started, which it is not; only the chat is).
 * The chat summaries are the activity source of truth.
 */
export function sessionSummaryStatus(
  sessionStatus: SessionStatus,
  chats: readonly ChatSummary[],
  defaultChat: string | undefined,
): SessionStatus {
  const flags = sessionStatus & ~STATUS_ACTIVITY_MASK;
  let source = defaultChat !== undefined ? chats.find((c) => c.resource === defaultChat) : undefined;
  if (source === undefined) {
    for (const c of chats) {
      if (source === undefined || c.modifiedAt > source.modifiedAt) source = c;
    }
  }
  let promoted: SessionStatus | undefined;
  for (const c of chats) {
    if (c.status & INPUT_NEEDED_MARKER) {
      promoted = SessionStatus.InputNeeded;
      break;
    }
    if (c.status & SessionStatus.Error) promoted = SessionStatus.Error;
  }
  const activity =
    promoted !== undefined
      ? promoted
      : source !== undefined
        ? ((source.status & STATUS_ACTIVITY_MASK) as SessionStatus)
        : SessionStatus.Idle;
  return (flags | activity) as SessionStatus;
}

/**
 * Build the `SessionSummary` for root notifications / `listSessions` from
 * a live record's denormalized fields. `chats` is the full catalog in
 * authoritative order (default first, then insertion order).
 */
export function buildSessionSummary(input: {
  channel: string;
  provider: string;
  title: string;
  status: SessionStatus;
  activity?: string;
  createdAt: string;
  modifiedAt: string;
  chats: ChatSummary[];
  defaultChat: string;
  /** The session's working directories (see `initialSessionState`) — the root
   * channel's session catalog carries the same `SessionMetadata` the session
   * channel does, so the list must show the same workspace. */
  workingDirectories?: string[];
}): SessionSummary {
  return {
    resource: input.channel,
    provider: input.provider,
    title: input.title,
    status: input.status,
    ...(input.activity !== undefined ? { activity: input.activity } : {}),
    ...(input.workingDirectories !== undefined && input.workingDirectories.length > 0
      ? { workingDirectories: input.workingDirectories }
      : {}),
    createdAt: input.createdAt,
    modifiedAt: input.modifiedAt,
    chats: input.chats,
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

// ── changesets ───────────────────────────────────────────────────

/**
 * Content-ref URIs the host serves through `resourceRead`:
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
const CONTENT_HEAD_MARKER = "ahp-content://head/";
const CONTENT_SNAP_MARKER = "ahp-content://snap/";

/** The `file://` URI of an absolute path (a `ChangesetFile.id`). */
export function fileUri(absPath: string): string {
  return pathToFileURL(absPath).href;
}

/** File URI of a directory — directory paths end with `/` (RFC 8089). */
export function directoryUri(absPath: string): string {
  return fileUri(absPath.endsWith("/") ? absPath : absPath + "/");
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
 * Line diff stats for two file contents (ported from the ahp-acp-gateway
 * implementation): CRLF-normalized, trailing newline ignored,
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

/** The single changeset operation this host advertises. */
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
 * produced; approximated by the working tree vs HEAD). Takes the session
 * channel URI as the changeset owner.
 */
export function sessionChangesetCatalog(sessionChannel: string): Changeset[] {
  return [
    {
      label: "Session Changes",
      uriTemplate: sessionChangesetURI(sessionChannel),
      changeKind: "session",
      capabilities: { review: {} },
    },
  ];
}

/**
 * The chat channel's changeset catalogue: the chat's own uncommitted
 * changes, the session-wide changeset, and the per-turn template
 * (`{turnId}` expands against the chat's turns — the protocol's standard
 * template shapes). Multi-chat: every chat has its own catalogue keyed
 * off its own channel URI.
 */
export function chatChangesetCatalog(chatChannel: string, sessionChannel: string): Changeset[] {
  return [
    {
      label: "Uncommitted Changes",
      uriTemplate: uncommittedChangesetURI(chatChannel),
      changeKind: "uncommitted",
      capabilities: { review: {} },
    },
    {
      label: "Session Changes",
      uriTemplate: sessionChangesetURI(sessionChannel),
      changeKind: "session",
      capabilities: { review: {} },
    },
    {
      label: "Turn Changes",
      uriTemplate: turnChangesetURI(chatChannel, "{turnId}"),
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
 * `ChangesetFile` entries for the working-tree diff (the `uncommitted`
 * and `session` changesets share this approximation):
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
