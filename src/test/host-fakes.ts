/**
 * Shared doubles and harness for the host test suites (the test-side
 * counterpart to the host's section split — cf. host.ts): the fake facade
 * (sessions, the customization catalog, multi-chat, changesets, resources,
 * client tools, the MCP toggle), the fake pty, the JSON-RPC frame harness
 * over `Host`, and the request/action helpers every suite drives through it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CustomizationType,
  PathStyle,
  type AgentCustomization,
  type ChatState,
  type DirectoryCustomization,
  type SessionState,
} from "@microsoft/agent-host-protocol";
import {
  mapV2Event,
  type FacadeAgent,
  type FacadeClientTool,
  type FacadeDirectoryEntry,
  type FacadeDiffFile,
  type FacadeEvent,
  type FacadeMcpServer,
  type FacadeProvider,
  type FacadeResourceInfo,
  type FacadeSession,
  type FacadeSkill,
  type FacadeTool,
  type OpencodeFacade,
} from "../bridge.js";
import { ROOT_CHANNEL, sessionChannelURI } from "../channels.js";
import { Host } from "../host.js";
import { PathPolicy } from "../path-policy.js";
import { type SpawnPty, type SpawnPtyInput } from "../host-types.js";

export const provider: FacadeProvider = {
  providerID: "gpuz",
  name: "gpuz",
  activation: "auto",
  models: [
    {
      providerID: "gpuz",
      modelID: "qwen3.8-27b-q5xl",
      name: "Qwen 3.8",
      enabled: true,
      limit: { context: 262144, output: 32768, input: 229376 },
      inputModalities: ["text", "image"],
    },
  ],
};

export const agents: FacadeAgent[] = [
  { id: "build", name: "Build", description: "Default build agent", mode: "primary", hidden: false },
  { id: "plan", name: "Plan", description: "Read-only planning", mode: "primary", hidden: false },
  { id: "explore", name: "Explore", mode: "subagent", hidden: false },
  { id: "title", name: "Title", mode: "all", hidden: true },
];

/** The 38-event captured turn, header + one event per line. */
export function loadFixtureEvents(): { header: Record<string, unknown>; events: unknown[] } {
  const raw = readFileSync(fileURLToPath(new URL("./fixtures/events.jsonl", import.meta.url)), "utf8");
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && start >= 0) {
        parts.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  const parsed = parts.map((p) => JSON.parse(p));
  return { header: parsed[0] as Record<string, unknown>, events: parsed.slice(1) };
}

/** Polls until cond() is true (host handlers are async; frames land on later ticks). */
export async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

export interface Frame {
  socketId: number;
  message: Record<string, any>;
}

export class FakeFacade implements OpencodeFacade {
  providers: FacadeProvider[] = [provider];
  agentList: FacadeAgent[] = agents;
  // ── session customization catalog ──────────────────
  /** Default empty: existing snapshot assertions stay valid; tests opt in. */
  mcpServers: FacadeMcpServer[] = [];
  skills: FacadeSkill[] = [];
  tools: FacadeTool[] = [];
  /**
   * When > 0 the catalog lists resolve after this delay — widens the
   * external-registration window (announcement before the catalog
   * change actions) so a test can subscribe in between.
   */
  catalogDelayMs = 0;
  sessions = new Map<string, FacadeSession>();
  promptCalls: { sessionID: string; text: string; delivery?: "steer" | "queue" }[] = [];
  switchModelCalls: { sessionID: string; model: { providerID: string; modelID: string; variant?: string } }[] = [];
  switchAgentCalls: { sessionID: string; agent: string }[] = [];
  interruptCalls: string[] = [];
  renameCalls: { sessionID: string; title: string }[] = [];
  permissionReplies: { sessionID: string; requestID: string; decision: "once" | "reject" }[] = [];
  createCalls: ({
    id?: string;
    model?: { providerID: string; modelID: string; variant?: string };
    metadata?: Record<string, unknown>;
    location?: { directory: string };
  } | undefined)[] = [];
  getSessionsCalls: string[] = [];
  // ── multi-chat ─────────────────────────────────────
  /** Every `removeSession` call (disposeChat / peer-chat teardown). */
  removeCalls: string[] = [];
  /** The opencode ids minted by `createSession` (call order). */
  createdIds: string[] = [];
  /** When non-null, `prompt` throws (initialMessage rollback path). */
  promptError: string | null = null;
  // ── changesets ─────────────────────────────────────────────────
  /** The working-tree diff `vcsDiffWorking` serves (absolute paths). */
  diffFiles: FacadeDiffFile[] = [];
  /** File content on "disk" (absPath → content; absent = the file is gone). */
  disk = new Map<string, string>();
  /** File content in HEAD (absPath → content; absent = not in HEAD). */
  head = new Map<string, string>();
  discardCalls: { path: string; directory?: string }[] = [];
  writeCalls: { path: string; content: string }[] = [];
  deleteCalls: string[] = [];
  /** When set, vcsDiffWorking throws (the changeset errors out). */
  diffError: string | null = null;
  /** Every `vcsDiffWorking` call (undefined = the plugin's own location). */
  diffCalls: (string | undefined)[] = [];
  /** Every `gitHeadFile` call (directory = the resolving session's dir). */
  headCalls: { path: string; directory?: string }[] = [];
  // ── resources ──────────────────────────────────────
  /** Directories on the fake resource FS (absolute paths; files live in `disk`). */
  dirs = new Set<string>();
  /** Symlinks on the fake resource FS (link path → target path). */
  symlinks = new Map<string, string>();
  /** Paths the fake resource FS refuses with EACCES (the -32009 mapping). */
  restricted = new Set<string>();
  /** The fake resource FS's mtime/ctime (epoch ms) for metadata results. */
  resourceTime = 1_700_000_000_000;
  // ── client tools ──────────────────────────────────
  /** Every `syncClientTools` call (the cross-session union each time). */
  syncClientToolsCalls: FacadeClientTool[][] = [];
  // ── MCP toggle ────────────────────────────────────
  /** Every `setMcpDisabled` call, in order. */
  setMcpDisabledCalls: { name: string; disabled: boolean }[] = [];
  /** When set, `setMcpDisabled` throws (the dispatch rejects the toggle). */
  mcpDisabledError: string | null = null;

  private queue: FacadeEvent[] = [];
  private waiters: Array<() => void> = [];

  /** Push a mapped event into the pump's stream. */
  push(ev: FacadeEvent): void {
    this.queue.push(ev);
    const w = this.waiters.shift();
    if (w) w();
  }

  /** Push every fixture event that maps to a FacadeEvent, in order. */
  pushFixtureEvents(events: unknown[]): number {
    let n = 0;
    for (const raw of events) {
      const mapped = mapV2Event(raw);
      if (mapped !== null) {
        this.push(mapped);
        n++;
      }
    }
    return n;
  }

  async listCatalog(): Promise<readonly FacadeProvider[]> {
    return this.providers;
  }
  async listAgents(): Promise<readonly FacadeAgent[]> {
    return this.agentList;
  }
  private async catalogDelay(): Promise<void> {
    if (this.catalogDelayMs > 0) await new Promise((r) => setTimeout(r, this.catalogDelayMs));
  }
  async listMcpServers(): Promise<readonly FacadeMcpServer[]> {
    await this.catalogDelay();
    return this.mcpServers;
  }
  async listSkills(): Promise<readonly FacadeSkill[]> {
    await this.catalogDelay();
    return this.skills;
  }
  async listTools(): Promise<readonly FacadeTool[]> {
    await this.catalogDelay();
    return this.tools;
  }
  async createSession(input?: {
    id?: string;
    title?: string;
    agent?: string;
    model?: { providerID: string; modelID: string; variant?: string };
    metadata?: Record<string, unknown>;
    location?: { directory: string };
  }) {
    this.createCalls.push(input ?? undefined);
    const id = input?.id ?? `ses_fake_${this.sessions.size + 1}`;
    this.createdIds.push(id);
    const now = Date.now();
    const fs: FacadeSession = {
      sessionID: id,
      title: "New Session",
      time: { created: now, updated: now },
      ...(input?.model !== undefined ? { model: input.model } : {}),
      // Durable metadata: the host's chat-binding marker
      // is written at create and must survive a "restart" (fresh host over
      // the same facade sessions).
      ...(input?.metadata !== undefined ? { metadata: input.metadata } : {}),
      // opencode reports the session's location (absent → the plugin's
      // own location, which the fake does not model).
      ...(input?.location !== undefined ? { location: input.location } : {}),
    };
    this.sessions.set(id, fs);
    // opencode fires session.created synchronously during create — the
    // host's grace + remap must survive this.
    this.push({ type: "session.created", sessionID: id });
    return fs;
  }
  async listSessions(): Promise<readonly FacadeSession[]> {
    return [...this.sessions.values()];
  }
  async getSession(sessionID: string): Promise<FacadeSession | null> {
    this.getSessionsCalls.push(sessionID);
    return this.sessions.get(sessionID) ?? null;
  }
  async prompt(input: { sessionID: string; text: string; delivery?: "steer" | "queue" }) {
    if (this.promptError !== null) throw new Error(this.promptError);
    this.promptCalls.push(input);
    return { messageID: `msg_${this.promptCalls.length}` };
  }
  async switchModel(input: { sessionID: string; model: { providerID: string; modelID: string; variant?: string } }) {
    this.switchModelCalls.push(input);
  }
  async switchAgent(input: { sessionID: string; agent: string }) {
    this.switchAgentCalls.push(input);
  }
  async interrupt(input: { sessionID: string }) {
    this.interruptCalls.push(input.sessionID);
  }
  async rename(input: { sessionID: string; title: string }) {
    this.renameCalls.push(input);
  }
  async replyPermission(input: { sessionID: string; requestID: string; decision: "once" | "reject" }) {
    this.permissionReplies.push(input);
  }
  async removeSession(sessionID: string): Promise<void> {
    this.removeCalls.push(sessionID);
    // opencode fires session.deleted after a successful remove — mirror
    // createSession's synchronous session.created (the host's byOpencode
    // join must skip events for already-unbound backends).
    if (this.sessions.delete(sessionID)) {
      this.push({ type: "session.deleted", sessionID });
    }
  }
  async *events(signal: AbortSignal): AsyncIterable<FacadeEvent> {
    const onAbort = () => {
      const ws = this.waiters.splice(0);
      for (const w of ws) w();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        while (this.queue.length === 0 && !signal.aborted) {
          await new Promise<void>((resolve) => this.waiters.push(resolve));
        }
        if (signal.aborted) return;
        yield this.queue.shift()!;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  // ── changesets ─────────────────────────────────────────────────
  async vcsDiffWorking(directory?: string): Promise<readonly FacadeDiffFile[]> {
    this.diffCalls.push(directory);
    if (this.diffError !== null) throw new Error(this.diffError);
    return this.diffFiles;
  }
  async gitHeadFile(absPath: string, directory?: string): Promise<string | null> {
    this.headCalls.push({ path: absPath, directory });
    return this.head.get(absPath) ?? null;
  }
  async readFile(absPath: string): Promise<string | null> {
    return this.disk.get(absPath) ?? null;
  }
  async writeFile(absPath: string, content: string): Promise<void> {
    this.writeCalls.push({ path: absPath, content });
    this.disk.set(absPath, content);
  }
  async deleteFile(absPath: string): Promise<void> {
    this.deleteCalls.push(absPath);
    this.disk.delete(absPath);
  }
  /** Discard one file: drop it from the working diff and restore the disk
   * content from HEAD (deleted when the file is untracked, like the real
   * facade). */
  async discardFile(absPath: string, directory?: string): Promise<void> {
    this.discardCalls.push({ path: absPath, directory });
    this.diffFiles = this.diffFiles.filter((d) => d.path !== absPath);
    const headContent = this.head.get(absPath);
    if (headContent !== undefined) this.disk.set(absPath, headContent);
    else this.disk.delete(absPath);
  }
  // ── resources ─────────────────────────────────────────────────
  private errno(code: string, path: string, syscall: string): NodeJS.ErrnoException {
    const err = new Error(`${syscall} ${code} ${path}`) as NodeJS.ErrnoException;
    err.code = code;
    return err;
  }

  /**
   * Stat a fake resource-FS path: with `follow` false, lstat semantics
   * (a symlink reports itself); with true, the link chain is followed and
   * the target's canonical path is returned. Throws a Node ErrnoException
   * (ENOENT/EACCES) on failure, like the real facade.
   */
  private fsStat(absPath: string, follow: boolean): { path: string; type: "file" | "directory" | "symlink" } {
    if (!follow) {
      if (this.restricted.has(absPath)) throw this.errno("EACCES", absPath, "stat");
      if (this.symlinks.has(absPath)) return { path: absPath, type: "symlink" };
      if (this.dirs.has(absPath)) return { path: absPath, type: "directory" };
      if (this.disk.has(absPath)) return { path: absPath, type: "file" };
      throw this.errno("ENOENT", absPath, "stat");
    }
    let current = absPath;
    if (this.restricted.has(current)) throw this.errno("EACCES", current, "stat");
    for (let i = 0; i < 10; i++) {
      const target = this.symlinks.get(current);
      if (target === undefined) break;
      current = target;
    }
    if (this.restricted.has(current)) throw this.errno("EACCES", current, "stat");
    if (this.dirs.has(current)) return { path: current, type: "directory" };
    if (this.disk.has(current)) return { path: current, type: "file" };
    throw this.errno("ENOENT", current, "stat");
  }

  async resolveResource(absPath: string, followSymlinks?: boolean): Promise<FacadeResourceInfo> {
    const s = this.fsStat(absPath, followSymlinks !== false);
    const size = s.type === "file" ? Buffer.byteLength(this.disk.get(s.path) ?? "", "utf8") : 0;
    return { path: s.path, type: s.type, size, mtime: this.resourceTime, ctime: this.resourceTime };
  }

  async listDirectory(absPath: string): Promise<readonly FacadeDirectoryEntry[]> {
    const s = this.fsStat(absPath, true);
    if (s.type !== "directory") throw this.errno("ENOTDIR", absPath, "readdir");
    const prefix = `${s.path}/`;
    const entries: FacadeDirectoryEntry[] = [];
    const seen = new Map<string, "file" | "directory">();
    for (const path of [...this.disk.keys(), ...this.dirs, ...this.symlinks.keys()]) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const name = rest.split("/")[0];
      if (rest.includes("/") || name === undefined || name.length === 0) continue;
      let type: "file" | "directory";
      if (this.disk.has(path)) type = "file";
      else if (this.dirs.has(path)) type = "directory";
      else {
        // A symlink: follow it — a link to a directory lists as a
        // directory, a dangling link as a file (the real facade's stat).
        try {
          type = this.fsStat(path, true).type === "directory" ? "directory" : "file";
        } catch {
          type = "file";
        }
      }
      if (!seen.has(name)) {
        seen.set(name, type);
        entries.push({ name, type });
      }
    }
    // Directories first, then by name (the real facade's sort).
    entries.sort((a, b) =>
      a.type !== b.type ? (a.type === "directory" ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    return entries;
  }

  async mkdirResource(absPath: string): Promise<void> {
    // `mkdir -p` semantics: an existing directory is a no-op; a path
    // component occupied by a non-directory fails (final component →
    // EEXIST, an intermediate one → ENOTDIR, like the real mkdir).
    if (this.restricted.has(absPath)) throw this.errno("EACCES", absPath, "mkdir");
    const parts = absPath.split("/").filter((p) => p.length > 0);
    let current = "";
    for (let i = 0; i < parts.length; i++) {
      current = `${current}/${parts[i]}`;
      if (this.restricted.has(current)) throw this.errno("EACCES", current, "mkdir");
      if (this.dirs.has(current)) continue;
      if (this.disk.has(current) || this.symlinks.has(current)) {
        if (i === parts.length - 1) throw this.errno("EEXIST", current, "mkdir");
        throw this.errno("ENOTDIR", current, "mkdir");
      }
      this.dirs.add(current);
    }
  }
  async syncClientTools(tools: readonly FacadeClientTool[]): Promise<void> {
    this.syncClientToolsCalls.push([...tools]);
  }
  async setMcpDisabled(name: string, disabled: boolean): Promise<void> {
    if (this.mcpDisabledError !== null) throw new Error(this.mcpDisabledError);
    this.setMcpDisabledCalls.push({ name, disabled });
    // Mirror the re-reconcile: the status follows the flag (a re-enabled
    // server comes back `connected`; other statuses are left alone).
    for (const server of this.mcpServers) {
      if (server.name !== name) continue;
      if (disabled) {
        server.status = "disabled";
        delete server.error;
      } else if (server.status === "disabled") {
        server.status = "connected";
      }
    }
  }
}

/**
 * The test double for the host's `spawnPty` seam: records what the host
 * writes to it (input) and the resize calls, and exposes the host-facing
 * callbacks so tests can drive pty output and process exit (the instances
 * are captured in the harness `ptys` list, ordered by spawn).
 */
export class FakePty {
  readonly written: string[] = [];
  /** Every size the host applied: the spawn size, then one per resize. */
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;
  private _onOutput: ((data: string) => void) | null = null;
  private _onExit: ((code: number | undefined) => void) | null = null;

  /** The host's spawn entry point (the `SpawnPty` seam shape). */
  static spawn(input: SpawnPtyInput): FakePty {
    const pty = new FakePty();
    pty._onOutput = input.onOutput;
    pty._onExit = input.onExit;
    pty.resizes.push({ cols: input.cols, rows: input.rows });
    return pty;
  }

  /** Test driver: the pty produces output (the `terminal/data` source). */
  emit(data: string): void {
    this._onOutput?.(data);
  }

  /** Test driver: the pty process exits (code undefined when killed). */
  exit(code?: number): void {
    this._onExit?.(code);
  }

  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  kill(): void {
    this.killed = true;
  }
}

export interface Harness {
  host: Host;
  facade: FakeFacade;
  frames: Frame[];
  send: (socketId: number, method: string, params: unknown, id?: unknown) => void;
  init: (socketId: number, clientId: string, subs?: string[]) => void;
  /** Published action envelopes on a channel (action typed as any — the AHP
   * StateAction union needs no narrowing for test assertions). */
  actionsOn: (channel: string) => any[];
  notification: (method: string, socketId?: number) => Record<string, any> | undefined;
  stop: () => void;
  /** The FakePty instances spawned so far, in spawn order. */
  ptys: FakePty[];
  /** Host log lines, in order. */
  logs: string[];
}

export function makeHarness(opts?: {
  changesets?: boolean;
  terminals?: boolean;
  /** The spawnPty seam; null omits the option entirely (the -32601 path),
   * undefined uses the default fake that captures into `ptys`. */
  spawnPty?: SpawnPty | null;
  /** The directory allowlist; undefined omits the option (unrestricted). */
  pathPolicy?: PathPolicy;
}): Harness {
  const facade = new FakeFacade();
  const frames: Frame[] = [];
  const ptys: FakePty[] = [];
  const logs: string[] = [];
  const host = new Host({
    serverInfo: { name: "opencode-ahp-test", version: "0.1.0" },
    facade,
    replayWindow: 100,
    defaultDirectory: "/tmp/opencode/ahp-scratch/project-lan",
    pathStyle: PathStyle.Posix,
    changesets: opts?.changesets ?? true,
    terminals: opts?.terminals ?? true,
    ...(opts?.pathPolicy !== undefined ? { pathPolicy: opts.pathPolicy } : {}),
    ...(opts?.spawnPty === null
      ? {}
      : {
          spawnPty:
            opts?.spawnPty ??
            ((input: SpawnPtyInput) => {
              const pty = FakePty.spawn(input);
              ptys.push(pty);
              return pty;
            }),
        }),
    send: (socketId, message) => frames.push({ socketId, message: message as Record<string, any> }),
    log: (message) => logs.push(message),
  });
  host.startEventPump();
  return {
    host,
    facade,
    frames,
    ptys,
    logs,
    send: (socketId, method, params, id) => {
      host.onMessage(socketId, JSON.stringify(id === undefined ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method, params, id }));
    },
    init: (socketId, clientId, subs = [ROOT_CHANNEL]) => {
      host.onOpen(socketId);
      host.onMessage(
        socketId,
        JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          id: 1,
          params: {
            channel: ROOT_CHANNEL,
            clientId,
            protocolVersions: ["1.1.0", "1.0.0"],
            initialSubscriptions: subs,
          },
        }),
      );
    },
    actionsOn: (channel) =>
      frames
        .filter((f) => f.message.method === "action" && f.message.params?.channel === channel)
        .map((f) => f.message.params as any),
    notification: (method, socketId) =>
      frames.find((f) => f.message.method === method && (socketId === undefined || f.socketId === socketId))
        ?.message as Record<string, any> | undefined,
    stop: () => host.stopEventPump(),
  };
}

/** Wait for the initialize result and return it. */
export async function waitInit(h: Harness, socketId: number): Promise<Record<string, any>> {
  await waitFor(() => h.frames.some((f) => f.socketId === socketId && f.message.id === 1 && f.message.result), `initialize result (${socketId})`);
  return h.frames.find((f) => f.socketId === socketId && f.message.id === 1 && f.message.result)!.message["result"];
}

export async function createSession(h: Harness, socketId: number, channel: string, params: Record<string, unknown> = {}, id = 100): Promise<Record<string, any>> {
  h.send(socketId, "createSession", { channel, ...params }, id);
  await waitFor(
    () => h.frames.some((f) => f.socketId === socketId && f.message.id === id && (f.message.result !== undefined || f.message.error)),
    `createSession response (${channel})`,
  );
  return h.frames.find((f) => f.socketId === socketId && f.message.id === id)!.message;
}

export async function subscribe(h: Harness, socketId: number, channel: string, id: number): Promise<Record<string, any>> {
  h.send(socketId, "subscribe", { channel }, id);
  await waitFor(() => h.frames.some((f) => f.socketId === socketId && f.message.id === id), `subscribe response (${channel})`);
  return h.frames.find((f) => f.socketId === socketId && f.message.id === id)!.message;
}

export function sessionSnapshotState(h: Harness, socketId: number, channel: string, id: number): Promise<SessionState> {
  return subscribe(h, socketId, channel, id).then((res) => res["result"]["snapshot"]["state"] as SessionState);
}

export function chatSnapshotState(h: Harness, socketId: number, channel: string, id: number): Promise<ChatState> {
  return subscribe(h, socketId, channel, id).then((res) => res["result"]["snapshot"]["state"] as ChatState);
}

/** The session-state customizations → the directory container with agent children. */
export function agentDirectoryOf(state: SessionState): { container: DirectoryCustomization; children: AgentCustomization[] } {
  const container = state.customizations?.find((c) => c.type === CustomizationType.Directory) as DirectoryCustomization;
  return { container, children: container.children as AgentCustomization[] };
}

/** The harness location directory (HostOptions.defaultDirectory). */
export const DIR = "/tmp/opencode/ahp-scratch/project-lan";
/** A working directory outside the location (cross-location sessions). */
export const OTHER = "/tmp/opencode/other-project";

export function startTurn(h: Harness, chatURI: string, turnId: string, seq = 1, text = "go"): void {
  h.send(1, "dispatchAction", {
    channel: chatURI,
    clientSeq: seq,
    action: {
      type: "chat/turnStarted",
      turnId,
      startedAt: new Date().toISOString(),
      message: { text, origin: { kind: "user" } },
    },
  });
}

/** Send one JSON-RPC request on socket 1 and return the response message. */
export async function rpc(h: Harness, method: string, params: Record<string, unknown>, id: number): Promise<Record<string, any>> {
  h.send(1, method, params, id);
  await waitFor(() => h.frames.some((f) => f.socketId === 1 && f.message.id === id), `${method} (${id})`);
  return h.frames.find((f) => f.socketId === 1 && f.message.id === id)!.message;
}

export async function resourceRead(h: Harness, params: Record<string, unknown>, id: number): Promise<Record<string, any>> {
  return rpc(h, "resourceRead", params, id);
}

export async function invokeOp(h: Harness, params: Record<string, unknown>, id: number): Promise<Record<string, any>> {
  h.send(1, "invokeChangesetOperation", params, id);
  await waitFor(() => h.frames.some((f) => f.socketId === 1 && f.message.id === id), `invokeChangesetOperation (${id})`);
  return h.frames.find((f) => f.socketId === 1 && f.message.id === id)!.message;
}

/** Subscribe to a changeset URI and return the snapshot state (null when absent). */
export function changesetSnapshot(h: Harness, uri: string, id: number): Promise<Record<string, any> | null> {
  return subscribe(h, 1, uri, id).then((res) => {
    const snap = res["result"]?.["snapshot"] as Record<string, any> | undefined;
    return snap?.["state"] ?? null;
  });
}

export async function waitForAction(
  h: Harness,
  channel: string,
  type: string,
  match?: (a: any) => boolean,
): Promise<any> {
  await waitFor(() => {
    const actions = h.actionsOn(channel);
    return actions.some((a) => a.action.type === type && (match === undefined || match(a)));
  }, `action ${type} on ${channel}`);
  const actions = h.actionsOn(channel);
  return actions.find((a) => a.action.type === type && (match === undefined || match(a)))!;
}

export async function createChat(
  h: Harness,
  socketId: number,
  params: Record<string, unknown>,
  id: number,
): Promise<Record<string, any>> {
  h.send(socketId, "createChat", params, id);
  await waitFor(
    () => h.frames.some((f) => f.socketId === socketId && f.message.id === id && (f.message.result !== undefined || f.message.error)),
    `createChat response (${id})`,
  );
  return h.frames.find((f) => f.socketId === socketId && f.message.id === id)!.message;
}

export async function disposeChat(h: Harness, socketId: number, chatChannel: string, id: number): Promise<Record<string, any>> {
  h.send(socketId, "disposeChat", { channel: chatChannel }, id);
  await waitFor(
    () => h.frames.some((f) => f.socketId === socketId && f.message.id === id && (f.message.result !== undefined || f.message.error)),
    `disposeChat response (${id})`,
  );
  return h.frames.find((f) => f.socketId === socketId && f.message.id === id)!.message;
}

export async function disposeSession(h: Harness, socketId: number, sessionChannel: string, id: number): Promise<Record<string, any>> {
  h.send(socketId, "disposeSession", { channel: sessionChannel }, id);
  await waitFor(
    () => h.frames.some((f) => f.socketId === socketId && f.message.id === id && (f.message.result !== undefined || f.message.error)),
    `disposeSession response (${id})`,
  );
  return h.frames.find((f) => f.socketId === socketId && f.message.id === id)!.message;
}

/** Create a session on channel suffix `ses`; returns the default chat's
 * opencode session id (suffixes starting with "ses" pass through as the
 * opencode id — the existing createSession behavior). */
export async function setupSession(h: Harness, ses: string): Promise<string> {
  await createSession(h, 1, sessionChannelURI(ses), { provider: "gpuz" });
  return h.facade.createdIds[0]!;
}

export async function listSessionsPage(h: Harness, id: number): Promise<Record<string, any>> {
  h.send(1, "listSessions", {}, id);
  await waitFor(() => h.frames.some((f) => f.message.id === id), `listSessions (${id})`);
  return h.frames.find((f) => f.message.id === id)!.message.result;
}
