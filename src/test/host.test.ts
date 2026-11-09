/**
 * Host tests (Phase 1): the JSON-RPC router over the fake facade —
 * createSession/listSessions, the session/chat snapshots (the dropdown-fix
 * invariant: session-state customizations carry the agent directory),
 * client-dispatchable actions (turns, steering/queue, permissions, cancel,
 * rename, echoes, rejections), and the opencode event pump (fixture replay,
 * external registration/removal, the createSession race remap).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CustomizationType,
  SessionStatus,
  ToolCallStatus,
  TurnState,
  type ActionEnvelope,
  type AgentCustomization,
  type ChatState,
  type DirectoryCustomization,
  type SessionState,
} from "@microsoft/agent-host-protocol";
import {
  DISCARD_OPERATION_ID,
  fileUri,
  headContentRef,
  mapV2Event,
  snapContentRef,
  type FacadeAgent,
  type FacadeClientTool,
  type FacadeDiffFile,
  type FacadeEvent,
  type FacadeProvider,
  type FacadeSession,
  type OpencodeFacade,
} from "../bridge.js";
import {
  ROOT_CHANNEL,
  sessionChannelURI,
  chatChannelURI,
  sessionChangesetURI,
  turnChangesetURI,
  uncommittedChangesetURI,
} from "../channels.js";
import { ERROR_INVALID_PARAMS } from "../handshake.js";
import { ERROR_NO_PROVIDER, ERROR_SESSION_EXISTS, Host } from "../host.js";

// ── fixtures / helpers ────────────────────────────────────────────────────

const provider: FacadeProvider = {
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

const agents: FacadeAgent[] = [
  { id: "build", name: "Build", description: "Default build agent", mode: "primary", hidden: false },
  { id: "plan", name: "Plan", description: "Read-only planning", mode: "primary", hidden: false },
  { id: "explore", name: "Explore", mode: "subagent", hidden: false },
  { id: "title", name: "Title", mode: "all", hidden: true },
];

/** The 38-event captured turn (plan §14.6), header + one event per line. */
function loadFixtureEvents(): { header: Record<string, unknown>; events: unknown[] } {
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
async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

interface Frame {
  socketId: number;
  message: Record<string, any>;
}

class FakeFacade implements OpencodeFacade {
  providers: FacadeProvider[] = [provider];
  agentList: FacadeAgent[] = agents;
  sessions = new Map<string, FacadeSession>();
  promptCalls: { sessionID: string; text: string; delivery?: "steer" | "queue" }[] = [];
  switchModelCalls: { sessionID: string; model: { providerID: string; modelID: string; variant?: string } }[] = [];
  switchAgentCalls: { sessionID: string; agent: string }[] = [];
  interruptCalls: string[] = [];
  renameCalls: { sessionID: string; title: string }[] = [];
  permissionReplies: { sessionID: string; requestID: string; decision: "once" | "reject" }[] = [];
  createCalls: ({ id?: string; model?: { providerID: string; modelID: string; variant?: string } } | undefined)[] = [];
  getSessionsCalls: string[] = [];
  // ── Phase 2: changesets ─────────────────────────────────────────────────
  /** The working-tree diff `vcsDiffWorking` serves (absolute paths). */
  diffFiles: FacadeDiffFile[] = [];
  /** File content on "disk" (absPath → content; absent = the file is gone). */
  disk = new Map<string, string>();
  /** File content in HEAD (absPath → content; absent = not in HEAD). */
  head = new Map<string, string>();
  discardCalls: string[] = [];
  writeCalls: { path: string; content: string }[] = [];
  deleteCalls: string[] = [];
  /** When set, vcsDiffWorking throws (the changeset errors out). */
  diffError: string | null = null;
  // ── Phase 4 extension 1: client tools ──────────────────────────────────
  /** Every `syncClientTools` call (the cross-session union each time). */
  syncClientToolsCalls: FacadeClientTool[][] = [];

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
  async createSession(input?: { id?: string; title?: string; agent?: string; model?: { providerID: string; modelID: string; variant?: string } }) {
    this.createCalls.push(input ?? undefined);
    const id = input?.id ?? `ses_fake_${this.sessions.size + 1}`;
    const now = Date.now();
    const fs: FacadeSession = {
      sessionID: id,
      title: "New Session",
      time: { created: now, updated: now },
      ...(input?.model !== undefined ? { model: input.model } : {}),
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
  // ── Phase 2: changesets ─────────────────────────────────────────────────
  async vcsDiffWorking(): Promise<readonly FacadeDiffFile[]> {
    if (this.diffError !== null) throw new Error(this.diffError);
    return this.diffFiles;
  }
  async gitHeadFile(absPath: string): Promise<string | null> {
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
  async discardFile(absPath: string): Promise<void> {
    this.discardCalls.push(absPath);
    this.diffFiles = this.diffFiles.filter((d) => d.path !== absPath);
    const headContent = this.head.get(absPath);
    if (headContent !== undefined) this.disk.set(absPath, headContent);
    else this.disk.delete(absPath);
  }
  async syncClientTools(tools: readonly FacadeClientTool[]): Promise<void> {
    this.syncClientToolsCalls.push([...tools]);
  }
}

interface Harness {
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
}

function makeHarness(opts?: { changesets?: boolean }): Harness {
  const facade = new FakeFacade();
  const frames: Frame[] = [];
  const host = new Host({
    serverInfo: { name: "opencode-ahp-test", version: "0.1.0" },
    facade,
    replayWindow: 100,
    defaultDirectory: "/tmp/opencode/ahp-scratch/project-lan",
    changesets: opts?.changesets ?? true,
    send: (socketId, message) => frames.push({ socketId, message: message as Record<string, any> }),
    log: () => {},
  });
  host.startEventPump();
  return {
    host,
    facade,
    frames,
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
            protocolVersions: ["1.0.0"],
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
async function waitInit(h: Harness, socketId: number): Promise<Record<string, any>> {
  await waitFor(() => h.frames.some((f) => f.socketId === socketId && f.message.id === 1 && f.message.result), `initialize result (${socketId})`);
  return h.frames.find((f) => f.socketId === socketId && f.message.id === 1 && f.message.result)!.message["result"];
}

async function createSession(h: Harness, socketId: number, channel: string, params: Record<string, unknown> = {}, id = 100): Promise<Record<string, any>> {
  h.send(socketId, "createSession", { channel, ...params }, id);
  await waitFor(
    () => h.frames.some((f) => f.socketId === socketId && f.message.id === id && (f.message.result !== undefined || f.message.error)),
    `createSession response (${channel})`,
  );
  return h.frames.find((f) => f.socketId === socketId && f.message.id === id)!.message;
}

async function subscribe(h: Harness, socketId: number, channel: string, id: number): Promise<Record<string, any>> {
  h.send(socketId, "subscribe", { channel }, id);
  await waitFor(() => h.frames.some((f) => f.socketId === socketId && f.message.id === id), `subscribe response (${channel})`);
  return h.frames.find((f) => f.socketId === socketId && f.message.id === id)!.message;
}

function sessionSnapshotState(h: Harness, socketId: number, channel: string, id: number): Promise<SessionState> {
  return subscribe(h, socketId, channel, id).then((res) => res["result"]["snapshot"]["state"] as SessionState);
}

function chatSnapshotState(h: Harness, socketId: number, channel: string, id: number): Promise<ChatState> {
  return subscribe(h, socketId, channel, id).then((res) => res["result"]["snapshot"]["state"] as ChatState);
}

/** The session-state customizations → the directory container with agent children. */
function agentDirectoryOf(state: SessionState): { container: DirectoryCustomization; children: AgentCustomization[] } {
  const container = state.customizations?.find((c) => c.type === CustomizationType.Directory) as DirectoryCustomization;
  return { container, children: container.children as AgentCustomization[] };
}

// ── handshake / catalog (Phase 0 regression through the host) ─────────────

describe("initialize", () => {
  it("negotiates 1.0.0, reports defaultDirectory, and snapshots the root catalog", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    const result = await waitInit(h, 1);
    expect(result.protocolVersion).toBe("1.0.0");
    expect(result.serverInfo).toEqual({ name: "opencode-ahp-test", version: "0.1.0" });
    expect(result.defaultDirectory).toBe("/tmp/opencode/ahp-scratch/project-lan");
    const root = result.snapshots.find((s: Record<string, any>) => s.resource === ROOT_CHANNEL);
    expect(root).toBeDefined();
    const gpuz = root.state.agents.find((a: Record<string, any>) => a.provider === "gpuz");
    expect(gpuz.models).toHaveLength(1);
    expect(gpuz.customizations).toHaveLength(1);
    const children = gpuz.customizations[0].children as AgentCustomization[];
    expect(children.map((c: AgentCustomization) => c.name)).toEqual(["Build", "Plan", "Explore"]);
    h.stop();
  });

  it("answers ping before initialize", async () => {
    const h = makeHarness();
    h.host.onOpen(1);
    h.send(1, "ping", {}, 7);
    await waitFor(() => h.frames.some((f) => f.message.id === 7), "ping response");
    expect(h.frames.find((f) => f.message.id === 7)!.message.result).toBeNull();
    h.stop();
  });
});

// ── createSession ─────────────────────────────────────────────────────────

describe("createSession", () => {
  it("creates a session, announces it on root, and seeds session/chat state with the agent picker", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);

    const res = await createSession(h, 1, sessionChannelURI("my-project-sess"), { provider: "gpuz" });
    expect(res.error).toBeUndefined();
    expect(res.result).toBeNull();

    // The facade got the first enabled model of the requested provider.
    expect(h.facade.createCalls).toHaveLength(1);
    expect(h.facade.createCalls[0]!.model).toEqual({ providerID: "gpuz", modelID: "qwen3.8-27b-q5xl" });

    // Root: count action + sessionAdded notification (to the root subscriber).
    const rootChannel = ROOT_CHANNEL;
    const rootActions = h.actionsOn(rootChannel);
    expect(rootActions.map((a) => a.action.type)).toContain("root/activeSessionsChanged");
    expect(rootActions.find((a) => a.action.type === "root/activeSessionsChanged")!.action.activeSessions).toBe(1);
    const added = h.notification("root/sessionAdded", 1);
    expect(added).toBeDefined();
    expect(added!.params.channel).toBe(ROOT_CHANNEL);
    expect(added!.params.summary.resource).toBe(sessionChannelURI("my-project-sess"));
    expect(added!.params.summary.provider).toBe("gpuz");
    expect(added!.params.summary.defaultChat).toBe(chatChannelURI("ses_fake_1"));

    // Session snapshot: lifecycle ready, the chat catalog, default chat, and —
    // the dropdown-fix invariant — session-state customizations carry the
    // agent directory (Build/Plan/Explore; hidden "Title" omitted).
    const sess = await sessionSnapshotState(h, 1, sessionChannelURI("my-project-sess"), 101);
    expect(sess.lifecycle).toBe("ready");
    expect(sess.provider).toBe("gpuz");
    expect(sess.defaultChat).toBe(chatChannelURI("ses_fake_1"));
    expect(sess.chats).toHaveLength(1);
    expect(sess.chats[0]!.title).toBe("Chat 1");
    const { container, children } = agentDirectoryOf(sess);
    expect(container.name).toBe("project-lan");
    expect(container.writable).toBe(false);
    expect(children.map((c) => c.name)).toEqual(["Build", "Plan", "Explore"]);
    expect(children.find((c) => c.name === "Explore")!.disableUserInvocation).toBe(true);

    // Chat snapshot: the same chat, idle + read.
    const chat = await chatSnapshotState(h, 1, chatChannelURI("ses_fake_1"), 102);
    expect(chat.resource).toBe(chatChannelURI("ses_fake_1"));
    expect(chat.status).toBe(SessionStatus.Idle | SessionStatus.IsRead);
    expect(chat.turns).toEqual([]);

    // The session.created the fake fired during create must not double-register.
    await waitFor(() => h.facade.getSessionsCalls.length >= 1 || true, "grace");
    await new Promise((r) => setTimeout(r, 320));
    expect(h.notification("root/sessionAdded", 1)).toBe(added); // still the first one
    const counts = h.actionsOn(rootChannel).filter((a) => a.action.type === "root/activeSessionsChanged");
    expect(counts[counts.length - 1]!.action.activeSessions).toBe(1);
    h.stop();
  });

  it("passes the channel suffix through as the opencode id when it starts with 'ses'", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI("ses_chosen_id"));
    expect(h.facade.createCalls[0]!.id).toBe("ses_chosen_id");
    h.stop();
  });

  it("rejects a duplicate channel with -32003", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI("dup"), {}, 100);
    const second = await createSession(h, 1, sessionChannelURI("dup"), {}, 101);
    expect(second.error?.code).toBe(ERROR_SESSION_EXISTS);
    h.stop();
  });

  it("rejects an unknown/disabled provider with -32002", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const unknown = await createSession(h, 1, sessionChannelURI("a"), { provider: "nope" }, 100);
    expect(unknown.error?.code).toBe(ERROR_NO_PROVIDER);
    h.facade.providers = [provider];
    h.facade.providers[0] = { ...provider, activation: "disabled" };
    const disabled = await createSession(h, 1, sessionChannelURI("b"), { provider: "gpuz" }, 101);
    expect(disabled.error?.code).toBe(ERROR_NO_PROVIDER);
    h.stop();
  });

  it("rejects an activeClient whose clientId does not match with -32602", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const res = await createSession(h, 1, sessionChannelURI("ac"), {
      activeClient: { clientId: "someone-else" },
    });
    expect(res.error?.code).toBe(ERROR_INVALID_PARAMS);
    h.stop();
  });

  it("normalizes a matching activeClient into the initial session state", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const res = await createSession(h, 1, sessionChannelURI("ac2"), {
      activeClient: { clientId: "c1", displayName: "VS Code", tools: [] },
    });
    expect(res.error).toBeUndefined();
    const sess = await sessionSnapshotState(h, 1, sessionChannelURI("ac2"), 101);
    expect(sess.activeClients).toEqual([
      { clientId: "c1", displayName: "VS Code", tools: [] },
    ]);
    h.stop();
  });
});

// ── listSessions ──────────────────────────────────────────────────────────

describe("listSessions", () => {
  it("lists opencode sessions newest-first with opaque cursor pagination and registers them", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const t0 = Date.now() - 3000;
    h.facade.sessions.set("ses_old", { sessionID: "ses_old", title: "Old", time: { created: t0, updated: t0 } });
    h.facade.sessions.set("ses_mid", { sessionID: "ses_mid", title: "Mid", time: { created: t0, updated: t0 + 1000 } });
    h.facade.sessions.set("ses_new", { sessionID: "ses_new", title: "New", time: { created: t0, updated: t0 + 2000 } });

    h.send(1, "listSessions", { limit: 2 }, 200);
    await waitFor(() => h.frames.some((f) => f.message.id === 200), "page 1");
    const page1 = h.frames.find((f) => f.message.id === 200)!.message.result;
    expect(page1.items.map((s: Record<string, any>) => s.resource)).toEqual([
      sessionChannelURI("ses_new"),
      sessionChannelURI("ses_mid"),
    ]);
    expect(page1.items[0].title).toBe("New");
    expect(page1.items[0].chats).toHaveLength(1);
    expect(page1.nextCursor).toBe("2");

    h.send(1, "listSessions", { limit: 2, cursor: page1.nextCursor }, 201);
    await waitFor(() => h.frames.some((f) => f.message.id === 201), "page 2");
    const page2 = h.frames.find((f) => f.message.id === 201)!.message.result;
    expect(page2.items.map((s: Record<string, any>) => s.resource)).toEqual([sessionChannelURI("ses_old")]);
    expect(page2.nextCursor).toBeUndefined();

    // Lazy registration: the channels are now subscribable.
    const sess = await sessionSnapshotState(h, 1, sessionChannelURI("ses_new"), 202);
    expect(sess.title).toBe("New");
    expect(sess.chats).toHaveLength(1);
    h.stop();
  });

  it("keeps a host-created session ahead of older opencode sessions", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const old = Date.now() - 60_000;
    h.facade.sessions.set("ses_old", { sessionID: "ses_old", time: { created: old, updated: old } });
    await createSession(h, 1, sessionChannelURI("mine"));

    h.send(1, "listSessions", {}, 210);
    await waitFor(() => h.frames.some((f) => f.message.id === 210), "list");
    const page = h.frames.find((f) => f.message.id === 210)!.message.result;
    expect(page.items[0].resource).toBe(sessionChannelURI("mine"));
    h.stop();
  });
});

// ── turn lifecycle (fixture replay) ───────────────────────────────────────

describe("turn lifecycle", () => {
  const FIX = loadFixtureEvents();
  const FIX_SES = FIX.header["sessionID"] as string;
  const FIX_PROMPT = FIX.header["prompt"] as string;

  it("replays the captured turn: reasoning, tool call, markdown, usage, completion", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(FIX_SES), { provider: "gpuz" });
    const chatURI = chatChannelURI(FIX_SES);
    await subscribe(h, 1, sessionChannelURI(FIX_SES), 110);
    await subscribe(h, 1, chatURI, 111);

    // The client dispatches chat/turnStarted (client-dispatchable) with the
    // model/agent selection; the host applies them and prompts.
    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 1,
      action: {
        type: "chat/turnStarted",
        turnId: "t1",
        startedAt: "2026-11-08T00:39:05.694Z",
        message: {
          text: FIX_PROMPT,
          origin: { kind: "user" },
          model: { id: "gpuz/qwen3.8-27b-q5xl" },
          agent: { uri: "opencode:agent/build" },
        },
      },
    });
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt");
    expect(h.facade.switchModelCalls).toEqual([{ sessionID: FIX_SES, model: { providerID: "gpuz", modelID: "qwen3.8-27b-q5xl" } }]);
    expect(h.facade.switchAgentCalls).toEqual([{ sessionID: FIX_SES, agent: "build" }]);
    expect(h.facade.promptCalls[0]).toEqual({ sessionID: FIX_SES, text: FIX_PROMPT });
    // Accepted echo on the chat channel (no rejectionReason).
    const echo = await waitForAction(h, chatURI, "chat/turnStarted");
    expect(echo.rejectionReason).toBeUndefined();
    expect(echo.origin).toEqual({ clientId: "c1", clientSeq: 1 });

    // Feed the captured turn through the pump.
    const n = h.facade.pushFixtureEvents(FIX.events);
    expect(n).toBeGreaterThanOrEqual(20);
    const complete = await waitForAction(h, chatURI, "chat/turnComplete");
    expect(complete.action.turnId).toBe("t1");
    expect(typeof complete.action.duration).toBe("number");

    // Final chat state.
    const chat = await chatSnapshotState(h, 1, chatURI, 112);
    expect(chat.activeTurn).toBeUndefined();
    expect(chat.status & (SessionStatus.InProgress | SessionStatus.InputNeeded)).toBe(0);
    expect(chat.turns).toHaveLength(1);
    const turn = chat.turns[0]!;
    expect(turn.id).toBe("t1");
    expect(turn.state).toBe(TurnState.Complete);
    expect(turn.message.text).toBe(FIX_PROMPT);
    expect(turn.usage).toMatchObject({
      inputTokens: 6482,
      outputTokens: 83,
      cacheReadTokens: 6516,
      model: "gpuz/qwen3.8-27b-q5xl",
    });

    const parts = turn.responseParts;
    const kinds = parts.map((p) => p.kind);
    expect(kinds).toEqual(["reasoning", "toolCall", "reasoning", "markdown"]);

    const reasoning1 = parts[0] as any;
    expect(reasoning1.content).toBe("The user wants me to execute a bash command and reply with the output. Let's run it.");

    const tool = (parts[1] as any).toolCall;
    expect(tool.toolCallId).toBe("kQyOlzLLY5Qv6hmXaEnuK1EA4CEvrlfv");
    expect(tool.toolName).toBe("shell");
    expect(tool.displayName).toBe("Shell");
    expect(tool.status).toBe(ToolCallStatus.Completed);
    expect(tool.invocationMessage).toBe("Run `echo hello-ahp`");
    expect(tool.toolInput).toBe('{"command":"echo hello-ahp"}');
    expect(tool.confirmed).toBe("not-needed");
    // The completed tool call inlines the result fields (AHP 1.0.0 state).
    expect(tool.success).toBe(true);
    expect(tool.pastTenseMessage).toBe("Ran `echo hello-ahp`");
    expect(tool.content).toEqual([{ type: "text", text: "hello-ahp\n" }]);

    const reasoning2 = parts[2] as any;
    expect(reasoning2.content).toBe('The command executed successfully, and the output is "hello-ahp". Let me reply with that output.');

    const markdown = parts[3] as any;
    expect(markdown.content).toBe("hello-ahp");

    // The session summary reflects the finished turn (chat synced up).
    const sess = await sessionSnapshotState(h, 1, sessionChannelURI(FIX_SES), 113);
    expect(sess.chats[0]!.status & SessionStatus.InProgress).toBe(0);
    h.stop();
  }, 15000);

  it("rejects a second turnStarted while a turn is active; accepts it after the turn ends", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const ses = "ses_t2";
    await createSession(h, 1, sessionChannelURI(ses), { provider: "gpuz" });
    const chatURI = chatChannelURI(ses);
    await subscribe(h, 1, chatURI, 101);

    const dispatch = (seq: number, turnId: string) =>
      h.send(1, "dispatchAction", {
        channel: chatURI,
        clientSeq: seq,
        action: { type: "chat/turnStarted", turnId, startedAt: new Date().toISOString(), message: { text: `hello ${seq}`, origin: { kind: "user" } } },
      });

    dispatch(1, "tA");
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt 1");
    dispatch(2, "tB");
    const rejected = await waitForAction(h, chatURI, "chat/turnStarted", (a) => a.rejectionReason !== undefined);
    expect(rejected.rejectionReason).toMatch(/already active/);
    expect(h.facade.promptCalls).toHaveLength(1);

    // Turn ends → the next turnStarted is accepted.
    h.facade.push({ type: "execution.succeeded", sessionID: ses });
    await waitForAction(h, chatURI, "chat/turnComplete");
    dispatch(3, "tC");
    const accepted = await waitForAction(h, chatURI, "chat/turnStarted", (a) => a.rejectionReason === undefined && a.action.turnId === "tC");
    expect(accepted.action.turnId).toBe("tC");
    expect(h.facade.promptCalls).toHaveLength(2);
    h.stop();
  });

  it("orphan execution.started (external TUI prompt) starts a host-minted turn", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const ses = "ses_t3";
    await createSession(h, 1, sessionChannelURI(ses), { provider: "gpuz" });
    const chatURI = chatChannelURI(ses);
    await subscribe(h, 1, chatURI, 101);

    h.facade.push({ type: "inbox.enqueued", sessionID: ses, inboxID: "m1", text: "from the TUI", delivery: "default" });
    h.facade.push({ type: "execution.started", sessionID: ses });
    const started = await waitForAction(h, chatURI, "chat/turnStarted");
    expect(started.origin).toBeUndefined();
    expect(started.action.message.text).toBe("from the TUI");
    h.stop();
  });
});

// ── permissions ───────────────────────────────────────────────────────────

describe("permissions", () => {
  const SES = "ses_perm";

  /** Start a turn and run the tool up to the permission prompt. */
  async function startTurnToPermission(h: Harness, socketId: number) {
    const chatURI = chatChannelURI(SES);
    await subscribe(h, socketId, chatURI, 901);
    await subscribe(h, socketId, sessionChannelURI(SES), 902);
    h.send(socketId, "dispatchAction", {
      channel: chatURI,
      clientSeq: 1,
      action: { type: "chat/turnStarted", turnId: "tP", startedAt: new Date().toISOString(), message: { text: "run it", origin: { kind: "user" } } },
    });
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt");
    const TOOL = "tool_1";
    h.facade.push({ type: "tool.input.started", sessionID: SES, assistantMessageID: "msg_1", id: TOOL, name: "shell" });
    h.facade.push({ type: "tool.input.ended", sessionID: SES, assistantMessageID: "msg_1", id: TOOL, text: '{"command":"ls -la"}' });
    h.facade.push({ type: "permission.asked", sessionID: SES, id: "perm_1", action: "shell", source: { type: "tool", messageID: "msg_1", id: TOOL } });
    const set = await waitForAction(h, sessionChannelURI(SES), "session/inputNeededSet");
    return { chatURI, TOOL, set };
  }

  it("surfaces a tool permission as pending-confirmation + inputNeededSet, and approves via toolCallConfirmed", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const { chatURI, TOOL, set } = await startTurnToPermission(h, 1);

    // toolCallReady was published without `confirmed` → pending-confirmation.
    const ready = await waitForAction(h, chatURI, "chat/toolCallReady");
    expect(ready.action.confirmed).toBeUndefined();
    const req = set.action.request;
    expect(req.id).toBe(TOOL);
    expect(req.kind).toBe("toolConfirmation");
    expect(req.turnId).toBe("tP");
    expect(req.toolCall.status).toBe("pending-confirmation");
    expect(req.toolCall.invocationMessage).toBe("Run `ls -la`");

    // Approve.
    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 2,
      action: { type: "chat/toolCallConfirmed", turnId: "tP", toolCallId: TOOL, approved: true, confirmed: "user-action" },
    });
    await waitFor(() => h.facade.permissionReplies.length === 1, "reply");
    expect(h.facade.permissionReplies[0]).toEqual({ sessionID: SES, requestID: "perm_1", decision: "once" });
    const confirmed = await waitForAction(h, chatURI, "chat/toolCallConfirmed");
    expect(confirmed.rejectionReason).toBeUndefined();
    const removed = await waitForAction(h, sessionChannelURI(SES), "session/inputNeededRemoved");
    expect(removed.action.id).toBe(TOOL);

    // The tool runs; the success completes it.
    h.facade.push({ type: "tool.progress", sessionID: SES, id: TOOL });
    h.facade.push({ type: "tool.success", sessionID: SES, id: TOOL, content: [{ type: "text", text: "ok\n" }] });
    const complete = await waitForAction(h, chatURI, "chat/toolCallComplete");
    expect(complete.action.result.success).toBe(true);
    h.stop();
  });

  it("denies via toolCallConfirmed (reject) and skips the tool result", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const { chatURI, TOOL } = await startTurnToPermission(h, 1);

    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 2,
      action: { type: "chat/toolCallConfirmed", turnId: "tP", toolCallId: TOOL, approved: false, reason: "user-declined" },
    });
    await waitFor(() => h.facade.permissionReplies.length === 1, "reply");
    expect(h.facade.permissionReplies[0]!.decision).toBe("reject");
    await waitForAction(h, sessionChannelURI(SES), "session/inputNeededRemoved");

    // opencode still reports the (skipped) tool outcome; the host must not
    // complete an already-cancelled tool call.
    h.facade.push({ type: "tool.failed", sessionID: SES, id: TOOL, error: { type: "cancelled", message: "denied" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.actionsOn(chatURI).some((a) => a.action.type === "chat/toolCallComplete")).toBe(false);

    const chat = await chatSnapshotState(h, 1, chatURI, 120);
    const tool = chat.activeTurn!.responseParts.find((p) => p.kind === "toolCall") as any;
    expect(tool.toolCall.status).toBe(ToolCallStatus.Cancelled);
    h.stop();
  });

  it("ignores non-tool permission.asked (logged, no inputNeeded)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    h.facade.push({ type: "permission.asked", sessionID: SES, id: "perm_x", action: "webfetch" });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.actionsOn(sessionChannelURI(SES)).some((a) => a.action.type === "session/inputNeededSet")).toBe(false);
    h.stop();
  });

  it("safety-net: permission.replied without a client confirmation still clears the input request", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const { TOOL } = await startTurnToPermission(h, 1);
    h.facade.push({ type: "permission.replied", sessionID: SES, requestID: "perm_1", reply: "once" });
    const removed = await waitForAction(h, sessionChannelURI(SES), "session/inputNeededRemoved");
    expect(removed.action.id).toBe(TOOL);
    h.stop();
  });
});

// ── steering / queue ──────────────────────────────────────────────────────

describe("steering and queue", () => {
  const SES = "ses_steer";

  it("steers an active turn (delivery:steer) and clears the steering message at turn end", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const chatURI = chatChannelURI(SES);
    await subscribe(h, 1, chatURI, 101);
    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 1,
      action: { type: "chat/turnStarted", turnId: "t1", startedAt: new Date().toISOString(), message: { text: "go", origin: { kind: "user" } } },
    });
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt");

    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 2,
      action: { type: "chat/pendingMessageSet", kind: "steering", id: "s1", message: { text: "steer me", origin: { kind: "user" } } },
    });
    await waitFor(() => h.facade.promptCalls.length === 2, "steer prompt");
    expect(h.facade.promptCalls[1]).toEqual({ sessionID: SES, text: "steer me", delivery: "steer" });
    const set = await waitForAction(h, chatURI, "chat/pendingMessageSet");
    expect(set.rejectionReason).toBeUndefined();

    // Turn ends → the steering message opencode consumed is cleared.
    h.facade.push({ type: "execution.succeeded", sessionID: SES });
    const removed = await waitForAction(h, chatURI, "chat/pendingMessageRemoved");
    expect(removed.action).toMatchObject({ type: "chat/pendingMessageRemoved", kind: "steering", id: "s1" });
    const chat = await chatSnapshotState(h, 1, chatURI, 130);
    expect(chat.steeringMessage).toBeUndefined();
    expect(chat.activeTurn).toBeUndefined();
    h.stop();
  });

  it("queues for the next turn (delivery:queue) and auto-starts it from the queue at turn end", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const chatURI = chatChannelURI(SES);
    await subscribe(h, 1, chatURI, 101);
    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 1,
      action: { type: "chat/turnStarted", turnId: "t1", startedAt: new Date().toISOString(), message: { text: "go", origin: { kind: "user" } } },
    });
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt");

    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 2,
      action: { type: "chat/pendingMessageSet", kind: "queued", id: "q1", message: { text: "next up", origin: { kind: "user" } } },
    });
    await waitFor(() => h.facade.promptCalls.length === 2, "queue prompt");
    expect(h.facade.promptCalls[1]).toEqual({ sessionID: SES, text: "next up", delivery: "queue" });

    // No new prompt call — the queued turn is state-only: at turn end the
    // host mints a turnStarted carrying queuedMessageId and the reducer dequeues.
    h.facade.push({ type: "execution.succeeded", sessionID: SES });
    const started = await waitForAction(h, chatURI, "chat/turnStarted", (a) => a.action.queuedMessageId === "q1");
    expect(started.origin).toBeUndefined();
    expect(started.action.message.text).toBe("next up");
    const chat = await chatSnapshotState(h, 1, chatURI, 131);
    expect(chat.activeTurn!.message.text).toBe("next up");
    expect(chat.queuedMessages).toBeUndefined();
    expect(h.facade.promptCalls).toHaveLength(2); // still no third prompt
    h.stop();
  });

  it("pendingMessageSet without an active turn prompts immediately and starts a host-minted turn", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const chatURI = chatChannelURI(SES);
    await subscribe(h, 1, chatURI, 101);

    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 1,
      action: { type: "chat/pendingMessageSet", kind: "queued", id: "q2", message: { text: "first message", origin: { kind: "user" } } },
    });
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt");
    expect(h.facade.promptCalls[0]).toEqual({ sessionID: SES, text: "first message" });
    const started = await waitForAction(h, chatURI, "chat/turnStarted", (a) => a.action.queuedMessageId === "q2");
    expect(started.action.message.text).toBe("first message");
    const chat = await chatSnapshotState(h, 1, chatURI, 132);
    expect(chat.activeTurn!.message.text).toBe("first message");
    h.stop();
  });

  it("rejects chat/pendingMessageRemoved (no inbox cancel in the plugin surface)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const chatURI = chatChannelURI(SES);
    await subscribe(h, 1, chatURI, 101);
    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 1,
      action: { type: "chat/pendingMessageRemoved", kind: "queued", id: "q9" },
    });
    const rejected = await waitForAction(h, chatURI, "chat/pendingMessageRemoved", (a) => a.rejectionReason !== undefined);
    expect(rejected.rejectionReason).toMatch(/no inbox cancel/);
    h.stop();
  });
});

// ── cancel / terminal events ──────────────────────────────────────────────

describe("cancel and terminal events", () => {
  const SES = "ses_cancel";

  it("chat/turnCancelled interrupts the session, finalizes the turn, and ignores the late interrupted event", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const chatURI = chatChannelURI(SES);
    await subscribe(h, 1, chatURI, 101);
    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 1,
      action: { type: "chat/turnStarted", turnId: "t1", startedAt: new Date().toISOString(), message: { text: "go", origin: { kind: "user" } } },
    });
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt");

    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 2,
      action: { type: "chat/turnCancelled", turnId: "t1" },
    });
    await waitFor(() => h.facade.interruptCalls.length === 1, "interrupt");
    expect(h.facade.interruptCalls).toEqual([SES]);
    const cancelled = await waitForAction(h, chatURI, "chat/turnCancelled");
    expect(cancelled.rejectionReason).toBeUndefined();

    // The opencode interrupted event finds no active turn → skipped.
    h.facade.push({ type: "execution.interrupted", sessionID: SES, reason: "user" });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.actionsOn(chatURI).filter((a) => a.action.type === "chat/turnCancelled")).toHaveLength(1);
    const chat = await chatSnapshotState(h, 1, chatURI, 140);
    expect(chat.activeTurn).toBeUndefined();
    expect(chat.turns).toHaveLength(1);
    expect(chat.turns[0]!.state).toBe(TurnState.Cancelled);
    h.stop();
  });

  it("rejects turnCancelled for a turn that is not active", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const chatURI = chatChannelURI(SES);
    await subscribe(h, 1, chatURI, 101);
    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 1,
      action: { type: "chat/turnCancelled", turnId: "nope" },
    });
    const rejected = await waitForAction(h, chatURI, "chat/turnCancelled", (a) => a.rejectionReason !== undefined);
    expect(rejected.rejectionReason).toMatch(/no active turn/);
    h.stop();
  });

  it("execution.failed produces chat/error with the error part", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const chatURI = chatChannelURI(SES);
    await subscribe(h, 1, chatURI, 101);
    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 1,
      action: { type: "chat/turnStarted", turnId: "t1", startedAt: new Date().toISOString(), message: { text: "boom", origin: { kind: "user" } } },
    });
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt");
    h.facade.push({ type: "execution.failed", sessionID: SES, error: { type: "provider_error", message: "rate limited" } });
    const error = await waitForAction(h, chatURI, "chat/error");
    expect(error.action.part).toMatchObject({ kind: "error", error: { errorType: "provider_error", message: "rate limited" } });
    const chat = await chatSnapshotState(h, 1, chatURI, 141);
    expect(chat.turns[0]!.state).toBe(TurnState.Error);
    const errPart = chat.turns[0]!.responseParts.find((p) => p.kind === "error") as any;
    expect(errPart.error.message).toBe("rate limited");
    h.stop();
  });
});

// ── session-level actions ─────────────────────────────────────────────────

describe("session-level actions", () => {
  const SES = "ses_title";

  it("session/titleChanged renames the opencode session and notifies root", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    await subscribe(h, 1, sessionChannelURI(SES), 140);
    const before = h.notification("root/sessionSummaryChanged", 1);
    expect(before === undefined || before.params.session !== sessionChannelURI(SES)).toBe(true);

    h.send(1, "dispatchAction", {
      channel: sessionChannelURI(SES),
      clientSeq: 1,
      action: { type: "session/titleChanged", title: "My renamed session" },
    });
    await waitFor(() => h.facade.renameCalls.length === 1, "rename");
    expect(h.facade.renameCalls[0]).toEqual({ sessionID: SES, title: "My renamed session" });
    const echo = await waitForAction(h, sessionChannelURI(SES), "session/titleChanged");
    expect(echo.rejectionReason).toBeUndefined();
    const changed = await waitFor(
      () => {
        const n = h.notification("root/sessionSummaryChanged", 1);
        return n !== undefined && n.params.session === sessionChannelURI(SES) && n.params.changes.title === "My renamed session";
      },
      "root/sessionSummaryChanged",
    );
    const sess = await sessionSnapshotState(h, 1, sessionChannelURI(SES), 150);
    expect(sess.title).toBe("My renamed session");
    void changed;
    h.stop();
  });

  it("echoes draft/read/archive actions without side effects", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const chatURI = chatChannelURI(SES);
    await subscribe(h, 1, chatURI, 141);
    await subscribe(h, 1, sessionChannelURI(SES), 142);
    const cases: Array<[string, { type: string } & Record<string, unknown>]> = [
      [chatURI, { type: "chat/draftChanged", draft: { text: "typing…", origin: { kind: "user" } } }],
      [chatURI, { type: "chat/isReadChanged", isRead: true }],
      [chatURI, { type: "chat/isArchivedChanged", isArchived: true }],
      [sessionChannelURI(SES), { type: "session/isReadChanged", isRead: true }],
      [sessionChannelURI(SES), { type: "session/isArchivedChanged", isArchived: true }],
    ];
    let seq = 1;
    for (const [channel, action] of cases) {
      h.send(1, "dispatchAction", { channel, clientSeq: seq++, action });
      const echoed = await waitForAction(h, channel, action.type);
      expect(echoed.rejectionReason).toBeUndefined();
    }
    const sess = await sessionSnapshotState(h, 1, sessionChannelURI(SES), 151);
    expect(sess.status & SessionStatus.IsRead).toBe(SessionStatus.IsRead);
    expect(sess.status & SessionStatus.IsArchived).toBe(SessionStatus.IsArchived);
    h.stop();
  });

  it("validates activeClient identity on session/activeClientSet", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    await subscribe(h, 1, sessionChannelURI(SES), 143);
    h.send(1, "dispatchAction", {
      channel: sessionChannelURI(SES),
      clientSeq: 1,
      action: { type: "session/activeClientSet", activeClient: { clientId: "c2" } },
    });
    const rejected = await waitForAction(h, sessionChannelURI(SES), "session/activeClientSet", (a) => a.rejectionReason !== undefined);
    expect(rejected.rejectionReason).toMatch(/must match/);
    h.send(1, "dispatchAction", {
      channel: sessionChannelURI(SES),
      clientSeq: 2,
      action: { type: "session/activeClientSet", activeClient: { clientId: "c1", displayName: "VS Code" } },
    });
    const set = await waitForAction(h, sessionChannelURI(SES), "session/activeClientSet", (a) => a.rejectionReason === undefined);
    expect(set.action.activeClient).toEqual({ clientId: "c1", displayName: "VS Code", tools: [] });
    h.stop();
  });

  it("rejects actions that are not client-dispatchable with a reason", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const chatURI = chatChannelURI(SES);
    await subscribe(h, 1, chatURI, 144);
    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 1,
      action: { type: "chat/turnComplete", turnId: "t1", duration: 10 },
    });
    const rejected = await waitForAction(h, chatURI, "chat/turnComplete", (a) => a.rejectionReason !== undefined);
    expect(rejected.rejectionReason).toMatch(/not client-dispatchable/);
    // The store must be untouched.
    const chat = await chatSnapshotState(h, 1, chatURI, 152);
    expect(chat.activeTurn).toBeUndefined();
    h.stop();
  });

  it("rejects dispatches for unknown channels and unknown sessions", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    h.send(1, "dispatchAction", { channel: "ahp-bogus:/x", clientSeq: 1, action: { type: "chat/draftChanged" } });
    const rejected = await waitForAction(h, "ahp-bogus:/x", "chat/draftChanged", (a) => a.rejectionReason !== undefined);
    expect(rejected.rejectionReason).toMatch(/unknown channel/);

    h.send(1, "dispatchAction", { channel: sessionChannelURI("ghost"), clientSeq: 2, action: { type: "session/titleChanged", title: "x" } });
    const rejected2 = await waitForAction(h, sessionChannelURI("ghost"), "session/titleChanged", (a) => a.rejectionReason !== undefined);
    expect(rejected2.rejectionReason).toMatch(/no such session/);
    h.stop();
  });

  it("accepts setClientManagedSettingsPermissions as a no-op notification", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    h.send(1, "setClientManagedSettingsPermissions", { permissions: ["chat"] });
    await new Promise((r) => setTimeout(r, 20));
    // No error frame on the connection (the socket stays usable).
    expect(h.frames.some((f) => f.message.error !== undefined)).toBe(false);
    h.send(1, "ping", {}, 9);
    await waitFor(() => h.frames.some((f) => f.message.id === 9), "ping after settings notification");
    h.stop();
  });
});

// ── external sessions (event pump registration) ───────────────────────────

describe("external sessions", () => {
  it("registers a TUI-created session after the grace period and announces it on root", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const t0 = Date.now() - 5000;
    h.facade.sessions.set("ses_tui_1", { sessionID: "ses_tui_1", title: "TUI session", time: { created: t0, updated: t0 } });

    h.facade.push({ type: "session.created", sessionID: "ses_tui_1", title: "TUI session" });
    // Before the grace: not registered yet.
    await new Promise((r) => setTimeout(r, 50));
    const early = await subscribe(h, 1, sessionChannelURI("ses_tui_1"), 160);
    expect(early.error?.code).toBe(-32001);

    await waitFor(
      () => h.notification("root/sessionAdded", 1) !== undefined,
      "root/sessionAdded for the external session",
      3000,
    );
    const added = h.notification("root/sessionAdded", 1)!;
    expect(added.params.summary.resource).toBe(sessionChannelURI("ses_tui_1"));
    expect(added.params.summary.title).toBe("TUI session");
    const counts = h.actionsOn(ROOT_CHANNEL).filter((a) => a.action.type === "root/activeSessionsChanged");
    expect(counts[counts.length - 1]!.action.activeSessions).toBe(1);

    const sess = await sessionSnapshotState(h, 1, sessionChannelURI("ses_tui_1"), 161);
    expect(sess.title).toBe("TUI session");
    h.stop();
  }, 10000);

  it("skips registration when the session is already gone by the grace deadline", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    h.facade.sessions.set("ses_gone", { sessionID: "ses_gone", time: { created: Date.now(), updated: Date.now() } });
    h.facade.push({ type: "session.created", sessionID: "ses_gone" });
    // The session is removed before the 250 ms deadline.
    h.facade.sessions.delete("ses_gone");
    await new Promise((r) => setTimeout(r, 320));
    expect(h.facade.getSessionsCalls).toContain("ses_gone");
    expect(h.notification("root/sessionAdded", 1)).toBeUndefined();
    h.stop();
  }, 10000);

  it("removes the session on session.deleted and announces it on root", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI("ses_del"), { provider: "gpuz" });
    expect(h.notification("root/sessionAdded", 1)).toBeDefined();

    h.facade.push({ type: "session.deleted", sessionID: "ses_del" });
    const removed = await waitFor(() => h.notification("root/sessionRemoved", 1) !== undefined, "root/sessionRemoved");
    const frame = h.notification("root/sessionRemoved", 1)!;
    expect(frame.params.session).toBe(sessionChannelURI("ses_del"));
    const counts = h.actionsOn(ROOT_CHANNEL).filter((a) => a.action.type === "root/activeSessionsChanged");
    expect(counts[counts.length - 1]!.action.activeSessions).toBe(0);
    const sub = await subscribe(h, 1, sessionChannelURI("ses_del"), 162);
    expect(sub.error?.code).toBe(-32001);
    void removed;
    h.stop();
  });

  it("survives the createSession race: the pump's session.created does not double-register", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    // The fake pushes session.created synchronously inside createSession.
    await createSession(h, 1, sessionChannelURI("ses_race_1"), { provider: "gpuz" });
    await new Promise((r) => setTimeout(r, 320));
    const added = h.frames.filter((f) => f.message.method === "root/sessionAdded");
    expect(added).toHaveLength(1);
    const counts = h.actionsOn(ROOT_CHANNEL).filter((a) => a.action.type === "root/activeSessionsChanged");
    expect(counts[counts.length - 1]!.action.activeSessions).toBe(1);
    h.stop();
  }, 10000);
});

// ── Phase 2: changesets ───────────────────────────────────────────────────

/** The harness location directory (HostOptions.defaultDirectory). */
const DIR = "/tmp/opencode/ahp-scratch/project-lan";

function startTurn(h: Harness, chatURI: string, turnId: string, seq = 1, text = "go"): void {
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

async function resourceRead(h: Harness, params: Record<string, unknown>, id: number): Promise<Record<string, any>> {
  h.send(1, "resourceRead", params, id);
  await waitFor(() => h.frames.some((f) => f.socketId === 1 && f.message.id === id), `resourceRead (${id})`);
  return h.frames.find((f) => f.socketId === 1 && f.message.id === id)!.message;
}

async function invokeOp(h: Harness, params: Record<string, unknown>, id: number): Promise<Record<string, any>> {
  h.send(1, "invokeChangesetOperation", params, id);
  await waitFor(() => h.frames.some((f) => f.socketId === 1 && f.message.id === id), `invokeChangesetOperation (${id})`);
  return h.frames.find((f) => f.socketId === 1 && f.message.id === id)!.message;
}

/** Subscribe to a changeset URI and return the snapshot state (null when absent). */
function changesetSnapshot(h: Harness, uri: string, id: number): Promise<Record<string, any> | null> {
  return subscribe(h, 1, uri, id).then((res) => {
    const snap = res["result"]?.["snapshot"] as Record<string, any> | undefined;
    return snap?.["state"] ?? null;
  });
}

describe("changeset catalogues", () => {
  const SES = "ses_cat";

  it("createSession seeds the session catalogue (1 entry) and the chat catalogue (3 entries)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });

    const session = await sessionSnapshotState(h, 1, sessionChannelURI(SES), 300);
    expect(session.changesets?.map((c) => [c.label, c.uriTemplate, c.changeKind])).toEqual([
      ["Session Changes", sessionChangesetURI(SES), "session"],
    ]);

    const chat = await chatSnapshotState(h, 1, chatChannelURI(SES), 301);
    expect(chat.changesets?.map((c) => [c.label, c.uriTemplate, c.changeKind])).toEqual([
      ["Uncommitted Changes", uncommittedChangesetURI(SES), "uncommitted"],
      ["Session Changes", sessionChangesetURI(SES), "session"],
      ["Turn Changes", turnChangesetURI(SES, "{turnId}"), "turn"],
    ]);
    for (const c of session.changesets ?? []) expect(c.capabilities).toEqual({ review: {} });
    h.stop();
  });

  it("externally registered sessions get catalogues too (applied directly to the fresh stores)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const t0 = Date.now() - 5000;
    h.facade.sessions.set("ses_ext", { sessionID: "ses_ext", title: "TUI session", time: { created: t0, updated: t0 } });
    h.facade.push({ type: "session.created", sessionID: "ses_ext", title: "TUI session" });
    await waitFor(
      () => h.notification("root/sessionAdded", 1) !== undefined,
      "root/sessionAdded for the external session",
      3000,
    );
    const session = await sessionSnapshotState(h, 1, sessionChannelURI("ses_ext"), 302);
    expect(session.changesets?.map((c) => c.changeKind)).toEqual(["session"]);
    const chat = await chatSnapshotState(h, 1, chatChannelURI("ses_ext"), 303);
    expect(chat.changesets?.map((c) => c.changeKind)).toEqual(["uncommitted", "session", "turn"]);
    h.stop();
  }, 10000);

  it("rejects a session suffix containing the changeset marker", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const res = await createSession(h, 1, "ahp-session:/x/changeset/session", { provider: "gpuz" });
    expect(res.error?.code).toBe(ERROR_INVALID_PARAMS);
    h.stop();
  });
});

describe("changeset subscribe and refresh", () => {
  const SES = "ses_sub";

  it("subscribe (uncommitted): computes to ready with the working diff and the discard operation", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const uri = uncommittedChangesetURI(SES);
    h.facade.diffFiles = [{ path: `${DIR}/mod.txt`, additions: 2, deletions: 1, status: "modified" }];
    h.facade.head.set(`${DIR}/mod.txt`, "a\nOLD\n");

    const state = await changesetSnapshot(h, uri, 310);
    expect(state!.status).toBe("ready");
    expect(state!.files).toEqual([
      {
        id: fileUri(`${DIR}/mod.txt`),
        edit: {
          before: { uri: fileUri(`${DIR}/mod.txt`), content: { uri: headContentRef(`${DIR}/mod.txt`) } },
          after: { uri: fileUri(`${DIR}/mod.txt`), content: { uri: fileUri(`${DIR}/mod.txt`) } },
          diff: { added: 2, removed: 1 },
        },
      },
    ]);
    expect(state!.operations?.map((o: any) => o.id)).toEqual([DISCARD_OPERATION_ID]);

    await waitForAction(h, uri, "changeset/contentChanged");
    const sc = await waitForAction(h, uri, "changeset/statusChanged");
    expect(sc.action.status).toBe("ready");
    h.stop();
  });

  it("subscribe with an empty diff: ready with no files and no operations", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const state = await changesetSnapshot(h, uncommittedChangesetURI(SES), 311);
    expect(state!.status).toBe("ready");
    expect(state!.files).toEqual([]);
    expect(state!.operations).toBeUndefined();
    h.stop();
  });

  it("subscribe when the diff fails: error status, then recovers on re-subscribe", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const uri = sessionChangesetURI(SES);
    h.facade.diffError = "git exploded";
    const failed = await changesetSnapshot(h, uri, 312);
    expect(failed!.status).toBe("error");
    expect(failed!.error).toMatchObject({ errorType: "changeset-computation", message: "git exploded" });

    h.facade.diffError = null;
    h.facade.diffFiles = [{ path: `${DIR}/new.txt`, additions: 3, deletions: 0, status: "added" }];
    const recovered = await changesetSnapshot(h, uri, 313);
    expect(recovered!.status).toBe("ready");
    expect(recovered!.files).toHaveLength(1);
    h.stop();
  });

  it("subscribe to a changeset of a dead session is rejected (-32001)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const res = await subscribe(h, 1, uncommittedChangesetURI("nope"), 314);
    expect(res.error?.code).toBe(-32001);
    h.stop();
  });
});

describe("turn changesets (before-capture)", () => {
  const SES = "ses_turn";
  const TARGET = `${DIR}/target.txt`;
  const BEFORE = "line1\nline2\n";
  const AFTER = "line1\nline2\nline3\n";

  /** Create a session, start turn t1, and drive a `write` tool targeting
   * `target.txt` (relative path — resolved against the location dir). */
  async function driveTurn(h: Harness): Promise<string> {
    const chatURI = chatChannelURI(SES);
    await subscribe(h, 1, chatURI, 320);
    h.facade.disk.set(TARGET, BEFORE);
    startTurn(h, chatURI, "t1");
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt");
    h.facade.push({ type: "tool.input.started", sessionID: SES, assistantMessageID: "m1", id: "tc1", name: "write" });
    h.facade.push({
      type: "tool.input.ended",
      sessionID: SES,
      assistantMessageID: "m1",
      id: "tc1",
      text: JSON.stringify({ path: "target.txt", content: AFTER }),
    });
    // Barrier: the awaited before-capture reads the disk when the pump
    // processes tool.input.ended — but this test's synchronous body runs
    // to completion before any pump microtask, so a disk mutation done
    // here would already be visible to the capture. The usage event's
    // chat/usage action is emitted only after the capture completes.
    h.facade.push({
      type: "usage.updated",
      sessionID: SES,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    await waitForAction(h, chatURI, "chat/usage");
    // Now the tool "executes" (disk gets the new content) and the turn
    // ends. The pump is sequential: execution.succeeded is processed
    // after the capture.
    h.facade.disk.set(TARGET, AFTER);
    h.facade.diffFiles = [{ path: TARGET, additions: 1, deletions: 0, status: "modified" }];
    h.facade.push({ type: "execution.succeeded", sessionID: SES });
    await waitForAction(h, chatURI, "chat/turnComplete");
    return chatURI;
  }

  it("captures the pre-edit content and serves the turn diff with snap refs", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    await driveTurn(h);

    const uri = turnChangesetURI(SES, "t1");
    const state = await changesetSnapshot(h, uri, 321);
    expect(state!.status).toBe("ready");
    expect(state!.files).toEqual([
      {
        id: fileUri(TARGET),
        edit: {
          before: { uri: fileUri(TARGET), content: { uri: snapContentRef(SES, "t1", TARGET, "before") } },
          after: { uri: fileUri(TARGET), content: { uri: snapContentRef(SES, "t1", TARGET, "after") } },
          diff: { added: 1, removed: 0 },
        },
      },
    ]);
    h.stop();
  });

  it("refreshes the subscribed uncommitted changeset at turn end", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const uncommittedURI = uncommittedChangesetURI(SES);
    // Subscribe with an empty working diff first…
    const first = await changesetSnapshot(h, uncommittedURI, 322);
    expect(first!.files).toEqual([]);
    // …then drive a turn whose tool "writes" the file (diff appears).
    await driveTurn(h);
    const cc = await waitForAction(h, uncommittedURI, "changeset/contentChanged");
    expect(cc.action.files).toHaveLength(1);
    expect(cc.action.files[0].id).toBe(fileUri(TARGET));
    h.stop();
  });

  it("serves the captured before/after content through resourceRead", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    await driveTurn(h);
    await changesetSnapshot(h, turnChangesetURI(SES, "t1"), 323);

    const before = await resourceRead(h, { uri: snapContentRef(SES, "t1", TARGET, "before"), encoding: "utf-8" }, 324);
    expect(before.result).toEqual({ data: BEFORE, encoding: "utf-8" });
    const after = await resourceRead(h, { uri: snapContentRef(SES, "t1", TARGET, "after"), encoding: "utf-8" }, 325);
    expect(after.result).toEqual({ data: AFTER, encoding: "utf-8" });
    h.stop();
  });

  it("discarding a turn file restores the pre-edit snapshot", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    await driveTurn(h);
    const uri = turnChangesetURI(SES, "t1");
    await changesetSnapshot(h, uri, 326);

    const res = await invokeOp(
      h,
      { channel: uri, operationId: DISCARD_OPERATION_ID, target: { kind: "resource", resource: fileUri(TARGET) } },
      327,
    );
    expect(res.error).toBeUndefined();
    expect(res.result.message).toBe(`Discarded changes to ${TARGET}`);
    expect(h.facade.writeCalls).toEqual([{ path: TARGET, content: BEFORE }]);
    expect(h.facade.disk.get(TARGET)).toBe(BEFORE);

    const running = await waitForAction(h, uri, "changeset/operationStatusChanged", (a) => a.action.status === "running");
    expect(running.action.operationId).toBe(DISCARD_OPERATION_ID);
    const idle = await waitForAction(h, uri, "changeset/operationStatusChanged", (a) => a.action.status === "idle");
    expect(idle.action.operationId).toBe(DISCARD_OPERATION_ID);
    // The turn changeset is the turn's record — it still shows the change.
    const state = await changesetSnapshot(h, uri, 328);
    expect(state!.files).toHaveLength(1);
    h.stop();
  });

  it("first capture per file wins (later edits in the same turn don't overwrite it)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const chatURI = chatChannelURI(SES);
    await subscribe(h, 1, chatURI, 329);
    h.facade.disk.set(TARGET, BEFORE);
    startTurn(h, chatURI, "t1");
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt");

    // Barrier: a usage event is processed (and its chat/usage emitted) only
    // AFTER the pump has fully processed the events pushed before it —
    // including the awaited before-capture of the preceding tool.input.ended.
    const usage = () =>
      h.facade.push({
        type: "usage.updated",
        sessionID: SES,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      });
    const usageCount = () => h.actionsOn(chatURI).filter((a) => a.action.type === "chat/usage").length;

    // Edit 1: capture 1 reads the disk (BEFORE) when the pump processes it.
    h.facade.push({ type: "tool.input.started", sessionID: SES, assistantMessageID: "m1", id: "tc1", name: "edit" });
    h.facade.push({
      type: "tool.input.ended",
      sessionID: SES,
      assistantMessageID: "m1",
      id: "tc1",
      text: JSON.stringify({ path: "target.txt", oldString: "line2", newString: "line2 a" }),
    });
    usage();
    await waitFor(() => usageCount() === 1, "capture 1 complete");
    // Edit 1 "executes": the disk changes to the post-edit content.
    h.facade.disk.set(TARGET, BEFORE + "edit1\n");
    // Edit 2: capture 2 must NOT overwrite the stored before-content.
    h.facade.push({ type: "tool.input.started", sessionID: SES, assistantMessageID: "m1", id: "tc2", name: "edit" });
    h.facade.push({
      type: "tool.input.ended",
      sessionID: SES,
      assistantMessageID: "m1",
      id: "tc2",
      text: JSON.stringify({ path: "target.txt", oldString: "line2 a", newString: "line2 b" }),
    });
    usage();
    await waitFor(() => usageCount() === 2, "capture 2 complete");
    h.facade.push({ type: "execution.succeeded", sessionID: SES });
    await waitForAction(h, chatURI, "chat/turnComplete");
    const before = await resourceRead(h, { uri: snapContentRef(SES, "t1", TARGET, "before"), encoding: "utf-8" }, 330);
    expect(before.result.data).toBe(BEFORE);
    h.stop();
  });

  it("does not capture tools outside the location directory or non-snapshot tools", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const chatURI = chatChannelURI(SES);
    await subscribe(h, 1, chatURI, 331);
    startTurn(h, chatURI, "t1");
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt");
    // Path escaping the location dir via ../
    h.facade.push({ type: "tool.input.started", sessionID: SES, assistantMessageID: "m1", id: "tc1", name: "write" });
    h.facade.push({
      type: "tool.input.ended",
      sessionID: SES,
      assistantMessageID: "m1",
      id: "tc1",
      text: JSON.stringify({ path: "../../etc/evil.txt", content: "x" }),
    });
    // A tool whose name is not file-mutating
    h.facade.push({ type: "tool.input.started", sessionID: SES, assistantMessageID: "m1", id: "tc2", name: "bash" });
    h.facade.push({ type: "tool.input.ended", sessionID: SES, assistantMessageID: "m1", id: "tc2", text: JSON.stringify({ command: "ls" }) });
    h.facade.push({ type: "execution.succeeded", sessionID: SES });
    await waitForAction(h, chatURI, "chat/turnComplete");
    const state = await changesetSnapshot(h, turnChangesetURI(SES, "t1"), 332);
    expect(state!.files).toEqual([]);
    h.stop();
  });
});

describe("resourceRead", () => {
  const SES = "ses_read";
  const FILE = `${DIR}/readme.txt`;

  async function ready(h: Harness): Promise<void> {
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
  }

  it("reads a file:// inside the location (utf-8 and base64)", async () => {
    const h = makeHarness();
    await ready(h);
    h.facade.disk.set(FILE, "hello\n");
    const utf8 = await resourceRead(h, { uri: fileUri(FILE), encoding: "utf-8" }, 340);
    expect(utf8.result).toEqual({ data: "hello\n", encoding: "utf-8" });
    const b64 = await resourceRead(h, { uri: fileUri(FILE) }, 341);
    expect(b64.result).toEqual({ data: Buffer.from("hello\n").toString("base64"), encoding: "base64" });
    h.stop();
  });

  it("rejects a file:// outside the location (-32009) and a missing file (-32008)", async () => {
    const h = makeHarness();
    await ready(h);
    const outside = await resourceRead(h, { uri: fileUri("/etc/passwd") }, 342);
    expect(outside.error?.code).toBe(-32009);
    const missing = await resourceRead(h, { uri: fileUri(`${DIR}/nope.txt`) }, 343);
    expect(missing.error?.code).toBe(-32008);
    const empty = await resourceRead(h, { uri: "" }, 344);
    expect(empty.error?.code).toBe(ERROR_INVALID_PARAMS);
    h.stop();
  });

  it("serves ahp-content://head from git HEAD and rejects untracked (-32008)", async () => {
    const h = makeHarness();
    await ready(h);
    h.facade.head.set(FILE, "HEAD version\n");
    const ok = await resourceRead(h, { uri: headContentRef(FILE), encoding: "utf-8" }, 345);
    expect(ok.result.data).toBe("HEAD version\n");
    const untracked = await resourceRead(h, { uri: headContentRef(`${DIR}/untracked.txt`), encoding: "utf-8" }, 346);
    expect(untracked.error?.code).toBe(-32008);
    h.stop();
  });

  it("rejects foreign and malformed content refs (-32008)", async () => {
    const h = makeHarness();
    await ready(h);
    for (const [uri, id] of [
      ["ahp-content://head/../../etc/passwd", 347],
      ["ahp-content://snap/abc/def/ghi", 348],
      ["https://example.com/x", 349],
    ] as const) {
      const res = await resourceRead(h, { uri, encoding: "utf-8" }, id);
      expect(res.error?.code).toBe(-32008);
    }
    h.stop();
  });
});

describe("invokeChangesetOperation", () => {
  const SES = "ses_op";
  const FILE = `${DIR}/mod.txt`;
  const URI = () => uncommittedChangesetURI(SES);

  async function readyWithFile(h: Harness): Promise<void> {
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    h.facade.diffFiles = [{ path: FILE, additions: 1, deletions: 1, status: "modified" }];
    h.facade.head.set(FILE, "a\nOLD\n");
    h.facade.disk.set(FILE, "a\nNEW\n");
    await changesetSnapshot(h, URI(), 350);
  }

  it("discards a file (running → idle) and refreshes the changeset to empty", async () => {
    const h = makeHarness();
    await readyWithFile(h);
    const res = await invokeOp(
      h,
      { channel: URI(), operationId: DISCARD_OPERATION_ID, target: { kind: "resource", resource: fileUri(FILE) } },
      351,
    );
    expect(res.error).toBeUndefined();
    expect(res.result.message).toBe(`Discarded changes to ${FILE}`);
    expect(h.facade.discardCalls).toEqual([FILE]);
    expect(h.facade.disk.get(FILE)).toBe("a\nOLD\n"); // restored from HEAD

    await waitForAction(h, URI(), "changeset/operationStatusChanged", (a) => a.action.status === "running");
    const cc = h.actionsOn(URI()).filter((a) => a.action.type === "changeset/contentChanged");
    expect(cc[cc.length - 1]!.action.files).toEqual([]);
    const oc = h.actionsOn(URI()).filter((a) => a.action.type === "changeset/operationsChanged");
    expect(oc[oc.length - 1]!.action.operations).toBeUndefined();
    await waitForAction(h, URI(), "changeset/operationStatusChanged", (a) => a.action.status === "idle");

    const state = await changesetSnapshot(h, URI(), 352);
    expect(state!.files).toEqual([]);
    expect(state!.operations).toBeUndefined();
    h.stop();
  });

  it("reports unknown operations (-32601), missing files and bad targets (-32602)", async () => {
    const h = makeHarness();
    await readyWithFile(h);
    const unknown = await invokeOp(h, { channel: URI(), operationId: "nope", target: { kind: "resource", resource: fileUri(FILE) } }, 353);
    expect(unknown.error?.code).toBe(-32601);
    const missing = await invokeOp(
      h,
      { channel: URI(), operationId: DISCARD_OPERATION_ID, target: { kind: "resource", resource: fileUri(`${DIR}/other.txt`) } },
      354,
    );
    expect(missing.error?.code).toBe(-32602);
    const range = await invokeOp(h, { channel: URI(), operationId: DISCARD_OPERATION_ID, target: { kind: "range" } }, 355);
    expect(range.error?.code).toBe(-32602);
    h.stop();
  });

  it("rejects paths outside the location (-32009)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    // Fresh session + store whose (repo-wide working-tree approximation)
    // diff contains a file outside the location directory.
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    h.facade.diffFiles = [{ path: "/outside/mod.txt", additions: 1, deletions: 0, status: "modified" }];
    await changesetSnapshot(h, URI(), 356);
    const res = await invokeOp(
      h,
      { channel: URI(), operationId: DISCARD_OPERATION_ID, target: { kind: "resource", resource: fileUri("/outside/mod.txt") } },
      357,
    );
    expect(res.error?.code).toBe(-32009);
    expect(h.facade.discardCalls).toEqual([]);
    h.stop();
  });

  it("reports no such changeset when the store was never created (-32001)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const res = await invokeOp(
      h,
      { channel: URI(), operationId: DISCARD_OPERATION_ID, target: { kind: "resource", resource: fileUri(FILE) } },
      358,
    );
    expect(res.error?.code).toBe(-32001);
    h.stop();
  });
});

describe("changeset/filesReviewChanged", () => {
  const SES = "ses_review";
  const FILE = `${DIR}/mod.txt`;

  it("echoes the toggle and the next refresh preserves the reviewed flag", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const uri = uncommittedChangesetURI(SES);
    const chatURI = chatChannelURI(SES);
    h.facade.diffFiles = [{ path: FILE, additions: 1, deletions: 1, status: "modified" }];
    await changesetSnapshot(h, uri, 360);
    await subscribe(h, 1, chatURI, 361);

    h.send(1, "dispatchAction", {
      channel: uri,
      clientSeq: 1,
      action: { type: "changeset/filesReviewChanged", files: [fileUri(FILE)], reviewed: true },
    });
    const echo = await waitForAction(h, uri, "changeset/filesReviewChanged");
    expect(echo.rejectionReason).toBeUndefined();
    expect(echo.origin).toEqual({ clientId: "c1", clientSeq: 1 });

    // A turn end refreshes the (subscribed) uncommitted changeset; the
    // rebuilt file list must keep the reviewed flag.
    startTurn(h, chatURI, "t1", 2);
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt");
    h.facade.diffFiles = [
      { path: FILE, additions: 1, deletions: 1, status: "modified" },
      { path: `${DIR}/other.txt`, additions: 1, deletions: 0, status: "added" },
    ];
    h.facade.push({ type: "execution.succeeded", sessionID: SES });
    const cc = await waitForAction(h, uri, "changeset/contentChanged", (a) => a.action.files.length === 2);
    expect(cc.action.files.find((f: any) => f.id === fileUri(FILE)).reviewed).toBe(true);
    expect(cc.action.files.find((f: any) => f.id === fileUri(`${DIR}/other.txt`)).reviewed).toBeUndefined();
    h.stop();
  });

  it("rejects the toggle on a changeset that was never subscribed", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const uri = sessionChangesetURI(SES); // never subscribed → no store
    h.send(1, "dispatchAction", {
      channel: uri,
      clientSeq: 1,
      action: { type: "changeset/filesReviewChanged", files: [fileUri(FILE)], reviewed: true },
    });
    const echo = await waitForAction(h, uri, "changeset/filesReviewChanged");
    expect(echo.rejectionReason).toMatch(/no such changeset/);
    h.stop();
  });
});

describe("changeset teardown and capability gate", () => {
  const SES = "ses_gate";

  it("session removal dispatches changeset/cleared for live changesets", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const uri = uncommittedChangesetURI(SES);
    await changesetSnapshot(h, uri, 370);
    h.facade.push({ type: "session.deleted", sessionID: SES });
    await waitFor(() => h.notification("root/sessionRemoved", 1) !== undefined, "root/sessionRemoved");
    const cleared = h.actionsOn(uri).filter((a) => a.action.type === "changeset/cleared");
    expect(cleared).toHaveLength(1);
    const sub = await subscribe(h, 1, uri, 371);
    expect(sub.error?.code).toBe(-32001);
    h.stop();
  });

  it("with the capability off: no catalogues, null snapshots, content refs not found, operations rejected", async () => {
    const h = makeHarness({ changesets: false });
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const session = await sessionSnapshotState(h, 1, sessionChannelURI(SES), 372);
    expect(session.changesets).toBeUndefined();
    const chat = await chatSnapshotState(h, 1, chatChannelURI(SES), 373);
    expect(chat.changesets).toBeUndefined();

    // The registry still knows the owner session is live, but the host
    // refuses to serve the channel → empty subscribe result.
    const res = await subscribe(h, 1, uncommittedChangesetURI(SES), 374);
    expect(res.result).toEqual({});

    const read = await resourceRead(h, { uri: headContentRef(`${DIR}/x.txt`), encoding: "utf-8" }, 375);
    expect(read.error?.code).toBe(-32008);

    const op = await invokeOp(
      h,
      {
        channel: uncommittedChangesetURI(SES),
        operationId: DISCARD_OPERATION_ID,
        target: { kind: "resource", resource: fileUri(`${DIR}/x.txt`) },
      },
      376,
    );
    expect(op.error?.code).toBe(-32001);
    h.stop();
  });
});

// ── client tools (Phase 4 extension 1, plan §14.12) ───────────────────────

describe("client tools (Phase 4 extension 1)", () => {
  const SES = "ses_ct";
  const CHAT = chatChannelURI(SES);
  const SC = sessionChannelURI(SES);

  /**
   * Common setup: c1 creates a session whose active client provides the
   * tool "ct", subscribes to both channels, and starts a turn.
   */
  async function setup(h: Harness): Promise<void> {
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, SC, {
      provider: "gpuz",
      activeClient: { clientId: "c1", tools: [{ name: "ct" }] },
    });
    await subscribe(h, 1, SC, 110);
    await subscribe(h, 1, CHAT, 111);
    h.send(1, "dispatchAction", {
      channel: CHAT,
      clientSeq: 1,
      action: {
        type: "chat/turnStarted",
        turnId: "t1",
        startedAt: new Date().toISOString(),
        message: { text: "call the ct tool", origin: { kind: "user" } },
      },
    });
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt");
  }

  /** Pump the client-tool input cycle (started + ended) for one call id. */
  function pushInputCycle(h: Harness, toolCallId: string, name = "ct"): void {
    h.facade.push({ type: "tool.input.started", sessionID: SES, assistantMessageID: "msg_ct", id: toolCallId, name });
    h.facade.push({ type: "tool.input.ended", sessionID: SES, assistantMessageID: "msg_ct", id: toolCallId, text: "{}" });
  }

  /** End the turn (after the opencode-side terminal for the call). */
  async function endTurn(h: Harness): Promise<void> {
    h.facade.push({ type: "execution.succeeded", sessionID: SES });
    await waitForAction(h, CHAT, "chat/turnComplete");
  }

  it("createSession with activeClient.tools registers the opencode tool union", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, SC, {
      provider: "gpuz",
      activeClient: {
        clientId: "c1",
        tools: [
          { name: "ct", description: "Client tool", inputSchema: { type: "object", properties: { n: { type: "string" } }, required: ["n"] } },
          { name: "bad" },
          { title: "no name" }, // dropped by wire validation
        ],
      },
    });
    await waitFor(() => h.facade.syncClientToolsCalls.length === 1, "syncClientTools");
    expect(h.facade.syncClientToolsCalls[0]).toEqual([
      { name: "ct", description: "Client tool", inputSchema: { type: "object", properties: { n: { type: "string" } }, required: ["n"] } },
      { name: "bad", description: "bad", inputSchema: { type: "object" } },
    ]);
    h.stop();
  });

  it("session/activeClientSet re-syncs the cross-session union (first-registered wins)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, SC, { provider: "gpuz" });
    const SES2 = "ses_ct2";
    await createSession(h, 1, sessionChannelURI(SES2), { provider: "gpuz" });
    h.send(1, "dispatchAction", {
      channel: SC,
      clientSeq: 1,
      action: {
        type: "session/activeClientSet",
        activeClient: { clientId: "c1", tools: [{ name: "a" }, { name: "dup", description: "first" }] },
      },
    });
    await waitFor(() => h.facade.syncClientToolsCalls.length === 1, "sync 1");
    h.send(1, "dispatchAction", {
      channel: sessionChannelURI(SES2),
      clientSeq: 2,
      action: {
        type: "session/activeClientSet",
        activeClient: { clientId: "c1", tools: [{ name: "b" }, { name: "dup", description: "second" }] },
      },
    });
    await waitFor(() => h.facade.syncClientToolsCalls.length === 2, "sync 2");
    expect(h.facade.syncClientToolsCalls[0]!.map((t) => t.name)).toEqual(["a", "dup"]);
    const union = h.facade.syncClientToolsCalls[1]!;
    expect(union.map((t) => t.name)).toEqual(["a", "dup", "b"]);
    expect(union.find((t) => t.name === "dup")?.description).toBe("first");
    h.stop();
  });

  it("client-executed tool: contributor at start, ready + execution request, client complete settles the execute", async () => {
    const h = makeHarness();
    await setup(h);
    pushInputCycle(h, "tool_1");

    const start = await waitForAction(h, CHAT, "chat/toolCallStart");
    expect(start.action.contributor).toEqual({ kind: "client", clientId: "c1" });

    const ready = await waitForAction(h, CHAT, "chat/toolCallReady");
    expect(ready.action.toolCallId).toBe("tool_1");
    expect(ready.action.confirmed).toBe("not-needed");

    const needed = await waitForAction(h, SC, "session/inputNeededSet");
    expect(needed.action.request).toMatchObject({
      id: "tool_1",
      chat: CHAT,
      kind: "toolClientExecution",
      turnId: "t1",
      clientId: "c1",
    });
    expect(needed.action.request.toolCall.status).toBe("running");

    // The execution request does not raise InputNeeded — the turn stays
    // in progress while the client runs (chat summary; the session-level
    // status only carries the input-queue activity bits).
    const sess = await sessionSnapshotState(h, 1, SC, 112);
    expect(sess.status & SessionStatus.InputNeeded).toBe(0);
    expect(sess.chats[0]!.status & SessionStatus.InProgress).toBe(SessionStatus.InProgress);

    // The opencode execute bridge blocks until the client completes.
    const exec = h.host.executeClientTool({ sessionID: SES, toolCallId: "tool_1", name: "ct", signal: new AbortController().signal });

    // The client may stream partial content while running (echo only).
    h.send(1, "dispatchAction", {
      channel: CHAT,
      clientSeq: 2,
      action: { type: "chat/toolCallContentChanged", turnId: "t1", toolCallId: "tool_1", content: [{ type: "text", text: "working…" }] },
    });
    const changed = await waitForAction(h, CHAT, "chat/toolCallContentChanged");
    expect(changed.rejectionReason).toBeUndefined();

    // The client completes.
    h.send(1, "dispatchAction", {
      channel: CHAT,
      clientSeq: 3,
      action: {
        type: "chat/toolCallComplete",
        turnId: "t1",
        toolCallId: "tool_1",
        result: { success: true, pastTenseMessage: "Pinged the service", content: [{ type: "text", text: "pong" }] },
      },
    });
    const complete = await waitForAction(h, CHAT, "chat/toolCallComplete");
    expect(complete.rejectionReason).toBeUndefined();
    await waitForAction(h, SC, "session/inputNeededRemoved");

    const execResult = await exec;
    expect(execResult).toEqual({ ok: true, pastTenseMessage: "Pinged the service", content: "pong" });

    // The opencode-side terminal arrives: no duplicate complete (queue
    // order — turnComplete is processed after tool.success).
    h.facade.push({ type: "tool.success", sessionID: SES, id: "tool_1", content: [{ type: "text", text: "pong" }] });
    await endTurn(h);
    expect(h.actionsOn(CHAT).filter((a) => a.action.type === "chat/toolCallComplete")).toHaveLength(1);

    // The tracking is gone: a second execute for the same call is refused.
    const exec2 = await h.host.executeClientTool({ sessionID: SES, toolCallId: "tool_1", name: "ct", signal: new AbortController().signal });
    expect(exec2.ok).toBe(false);

    // The completed tool call carries the client's result.
    const chat = await chatSnapshotState(h, 1, CHAT, 113);
    const part = (chat.turns[0]!.responseParts.find((p) => (p as any).kind === "toolCall") as any).toolCall;
    expect(part.status).toBe(ToolCallStatus.Completed);
    expect(part.contributor).toEqual({ kind: "client", clientId: "c1" });
    expect(part.success).toBe(true);
    expect(part.pastTenseMessage).toBe("Pinged the service");
    expect(part.content).toEqual([{ type: "text", text: "pong" }]);
    h.stop();
  }, 15000);

  it("rejects complete/contentChanged from a non-contributing client and for non-client calls", async () => {
    const h = makeHarness();
    await setup(h);
    h.init(2, "c2");
    await waitInit(h, 2);
    await subscribe(h, 2, CHAT, 121);
    pushInputCycle(h, "tool_1");
    await waitForAction(h, CHAT, "chat/toolCallStart");

    // c2 is not the contributor.
    h.send(2, "dispatchAction", {
      channel: CHAT,
      clientSeq: 1,
      action: { type: "chat/toolCallComplete", turnId: "t1", toolCallId: "tool_1", result: { success: true, pastTenseMessage: "x" } },
    });
    const rejected = await waitForAction(h, CHAT, "chat/toolCallComplete", (a) => a.rejectionReason !== undefined);
    expect(rejected.rejectionReason).toMatch(/contributing client/);

    // A server-executed call cannot be completed by the client at all.
    h.facade.push({ type: "tool.input.started", sessionID: SES, assistantMessageID: "msg_ct", id: "tool_2", name: "shell" });
    h.facade.push({ type: "tool.input.ended", sessionID: SES, assistantMessageID: "msg_ct", id: "tool_2", text: "{}" });
    h.send(1, "dispatchAction", {
      channel: CHAT,
      clientSeq: 4,
      action: { type: "chat/toolCallComplete", turnId: "t1", toolCallId: "tool_2", result: { success: true, pastTenseMessage: "x" } },
    });
    const rejected2 = await waitForAction(h, CHAT, "chat/toolCallComplete", (a) => a.action.toolCallId === "tool_2" && a.rejectionReason !== undefined);
    expect(rejected2.rejectionReason).toMatch(/not a client-executed call/);
    h.stop();
  });

  it("requiresResultConfirmation holds the result, raises InputNeeded, and settles on approval", async () => {
    const h = makeHarness();
    await setup(h);
    pushInputCycle(h, "tool_1");
    await waitForAction(h, SC, "session/inputNeededSet");

    const exec = h.host.executeClientTool({ sessionID: SES, toolCallId: "tool_1", name: "ct", signal: new AbortController().signal });
    h.send(1, "dispatchAction", {
      channel: CHAT,
      clientSeq: 2,
      action: {
        type: "chat/toolCallComplete",
        turnId: "t1",
        toolCallId: "tool_1",
        requiresResultConfirmation: true,
        result: { success: true, pastTenseMessage: "Did a thing", content: [{ type: "text", text: "thing" }] },
      },
    });
    await waitForAction(h, CHAT, "chat/toolCallComplete");

    // The confirmation request (same id — upserts over the execution
    // request) is user-facing: it raises InputNeeded.
    const confirm = await waitForAction(h, SC, "session/inputNeededSet", (a) => a.action.request.kind === "toolConfirmation");
    expect(confirm.action.request.toolCall.status).toBe("pending-result-confirmation");
    const sess = await sessionSnapshotState(h, 1, SC, 112);
    expect(sess.status & SessionStatus.InputNeeded).toBe(SessionStatus.InputNeeded);

    // The user approves → the held result settles the execute.
    h.send(1, "dispatchAction", {
      channel: CHAT,
      clientSeq: 3,
      action: { type: "chat/toolCallResultConfirmed", turnId: "t1", toolCallId: "tool_1", approved: true },
    });
    await waitForAction(h, CHAT, "chat/toolCallResultConfirmed");
    await waitForAction(h, SC, "session/inputNeededRemoved");
    const execResult = await exec;
    expect(execResult).toEqual({ ok: true, pastTenseMessage: "Did a thing", content: "thing" });

    // The queue drained: no longer blocked (the turn is still active, so
    // the status falls back to InProgress per the official reducer).
    const cleared = await sessionSnapshotState(h, 1, SC, 113);
    expect(cleared.status & SessionStatus.InputNeeded).not.toBe(SessionStatus.InputNeeded);
    expect(cleared.status & SessionStatus.InProgress).toBe(SessionStatus.InProgress);
    h.facade.push({ type: "tool.success", sessionID: SES, id: "tool_1", content: [{ type: "text", text: "thing" }] });
    await endTurn(h);
    expect(h.actionsOn(CHAT).filter((a) => a.action.type === "chat/toolCallComplete")).toHaveLength(1);
    h.stop();
  }, 15000);

  it("a denied result confirmation settles the execute with an error and cancels the call", async () => {
    const h = makeHarness();
    await setup(h);
    pushInputCycle(h, "tool_1");
    await waitForAction(h, SC, "session/inputNeededSet");

    const exec = h.host.executeClientTool({ sessionID: SES, toolCallId: "tool_1", name: "ct", signal: new AbortController().signal });
    h.send(1, "dispatchAction", {
      channel: CHAT,
      clientSeq: 2,
      action: {
        type: "chat/toolCallComplete",
        turnId: "t1",
        toolCallId: "tool_1",
        requiresResultConfirmation: true,
        result: { success: true, pastTenseMessage: "Did a thing" },
      },
    });
    await waitForAction(h, SC, "session/inputNeededSet", (a) => a.action.request.kind === "toolConfirmation");

    h.send(1, "dispatchAction", {
      channel: CHAT,
      clientSeq: 3,
      action: { type: "chat/toolCallResultConfirmed", turnId: "t1", toolCallId: "tool_1", approved: false },
    });
    await waitForAction(h, CHAT, "chat/toolCallResultConfirmed");
    const execResult = await exec;
    expect(execResult).toEqual({ ok: false, error: "the client denied the tool result" });

    h.facade.push({ type: "tool.failed", sessionID: SES, id: "tool_1", error: { type: "Error", message: "the client denied the tool result" } });
    await endTurn(h);
    const chat = await chatSnapshotState(h, 1, CHAT, 112);
    const part = (chat.turns[0]!.responseParts.find((p) => (p as any).kind === "toolCall") as any).toolCall;
    expect(part.status).toBe(ToolCallStatus.Cancelled);
    expect(part.reason).toBe("result-denied");
    h.stop();
  }, 15000);

  it("a failed client result settles the execute with the client's error", async () => {
    const h = makeHarness();
    await setup(h);
    pushInputCycle(h, "tool_1");
    await waitForAction(h, SC, "session/inputNeededSet");

    const exec = h.host.executeClientTool({ sessionID: SES, toolCallId: "tool_1", name: "ct", signal: new AbortController().signal });
    h.send(1, "dispatchAction", {
      channel: CHAT,
      clientSeq: 2,
      action: {
        type: "chat/toolCallComplete",
        turnId: "t1",
        toolCallId: "tool_1",
        result: { success: false, pastTenseMessage: "Tried the service", error: { message: "boom" } },
      },
    });
    await waitForAction(h, CHAT, "chat/toolCallComplete");
    const execResult = await exec;
    expect(execResult).toEqual({ ok: false, error: "boom" });

    h.facade.push({ type: "tool.failed", sessionID: SES, id: "tool_1", error: { type: "Error", message: "boom" } });
    await endTurn(h);
    expect(h.actionsOn(CHAT).filter((a) => a.action.type === "chat/toolCallComplete")).toHaveLength(1);
    h.stop();
  }, 15000);

  it("an aborted signal fails the in-flight execute (turn interrupt)", async () => {
    const h = makeHarness();
    await setup(h);
    pushInputCycle(h, "tool_1");
    await waitForAction(h, SC, "session/inputNeededSet");

    const ac = new AbortController();
    const exec = h.host.executeClientTool({ sessionID: SES, toolCallId: "tool_1", name: "ct", signal: ac.signal });
    ac.abort();
    const execResult = await exec;
    expect(execResult.ok).toBe(false);
    if (!execResult.ok) expect(execResult.error).toMatch(/cancelled/);
    h.stop();
  });

  it("executeClientTool refuses non-AHP sessions and unknown calls", async () => {
    const h = makeHarness();
    const r1 = await h.host.executeClientTool({ sessionID: "ses_nope", toolCallId: "x", name: "ct", signal: new AbortController().signal });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toMatch(/not an AHP session/);

    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, SC, { provider: "gpuz", activeClient: { clientId: "c1", tools: [{ name: "ct" }] } });
    const r2 = await h.host.executeClientTool({ sessionID: SES, toolCallId: "nope", name: "ct", signal: new AbortController().signal });
    expect(r2.ok).toBe(false);
    h.stop();
  });

  it("disconnect evicts the active client, fails the in-flight call, and re-syncs the union", async () => {
    const h = makeHarness();
    await setup(h);
    pushInputCycle(h, "tool_1");
    await waitForAction(h, SC, "session/inputNeededSet");

    const exec = h.host.executeClientTool({ sessionID: SES, toolCallId: "tool_1", name: "ct", signal: new AbortController().signal });
    const syncsBefore = h.facade.syncClientToolsCalls.length;
    h.host.onClose(1);

    // Server-side eviction on the session channel.
    expect(h.actionsOn(SC).some((a) => a.action.type === "session/activeClientRemoved" && a.action.clientId === "c1")).toBe(true);
    // The union shrank → re-synced.
    await waitFor(() => h.facade.syncClientToolsCalls.length > syncsBefore, "re-sync after eviction");
    expect(h.facade.syncClientToolsCalls[h.facade.syncClientToolsCalls.length - 1]).toEqual([]);
    // The in-flight execution request is cleared from the session state.
    const removed = h.actionsOn(SC).find((a) => a.action.type === "session/inputNeededRemoved");
    expect(removed?.action.id).toBe("tool_1");
    // The in-flight execution fails with a disconnect error.
    const execResult = await exec;
    expect(execResult).toEqual({ ok: false, error: "client c1 disconnected before completing the tool call" });
    h.stop();
  });

  it("disconnect evicts a held-result confirmation and clears the session input request", async () => {
    const h = makeHarness();
    await setup(h);
    pushInputCycle(h, "tool_1");
    await waitForAction(h, SC, "session/inputNeededSet");

    const exec = h.host.executeClientTool({ sessionID: SES, toolCallId: "tool_1", name: "ct", signal: new AbortController().signal });
    h.send(1, "dispatchAction", {
      channel: CHAT,
      clientSeq: 2,
      action: {
        type: "chat/toolCallComplete",
        turnId: "t1",
        toolCallId: "tool_1",
        requiresResultConfirmation: true,
        result: { success: true, pastTenseMessage: "Did a thing" },
      },
    });
    // The host upserts the same request id as a toolConfirmation → the
    // session is InputNeeded while the result awaits approval.
    await waitForAction(h, SC, "session/inputNeededSet", (a) => a.action.request.kind === "toolConfirmation");
    const blocked = await sessionSnapshotState(h, 1, SC, 120);
    expect(blocked.status & SessionStatus.InputNeeded).toBe(SessionStatus.InputNeeded);

    // The client disconnects while the result is held.
    h.host.onClose(1);

    // The stale confirmation request is removed and the session unblocks
    // (without this the session sits in InputNeeded forever). A second
    // client observes the cleared state (socket 1 is gone).
    await waitForAction(h, SC, "session/inputNeededRemoved", (a) => a.action.id === "tool_1");
    h.init(2, "c2");
    await waitInit(h, 2);
    const cleared = await sessionSnapshotState(h, 2, SC, 121);
    expect(cleared.status & SessionStatus.InputNeeded).not.toBe(SessionStatus.InputNeeded);
    expect(cleared.inputNeeded ?? []).toHaveLength(0);
    // The held execution fails with a disconnect error.
    const execResult = await exec;
    expect(execResult).toEqual({ ok: false, error: "client c1 disconnected before completing the tool call" });
    h.stop();
  }, 15000);
});

// ── action-stream helpers ─────────────────────────────────────────────────

async function waitForAction(
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
