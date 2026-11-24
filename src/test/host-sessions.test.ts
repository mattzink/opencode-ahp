/**
 * Host tests — session lifecycle: `createSession` (including the
 * session customization snapshot — the dropdown-fix invariant: session-state
 * customizations carry the agent directory), the non-standard (legacy)
 * session channel form, `listSessions`, `disposeSession` (record + peer
 * backends, the removal announcement, rejections), and
 * `resolveSessionConfig` (the AHP 1.0.0 root command).
 */
import { describe, expect, it } from "vitest";
import {
  CustomizationType,
  McpServerStatus,
  SessionStatus,
  type DirectoryCustomization,
  type SkillCustomization,
} from "@microsoft/agent-host-protocol";
import { directoryUri } from "../bridge.js";
import { ROOT_CHANNEL, sessionChannelURI, chatChannelURI } from "../channels.js";
import { ERROR_INVALID_PARAMS } from "../handshake.js";
import {
  ERROR_INVALID_REQUEST,
  ERROR_NO_PROVIDER,
  ERROR_SESSION_EXISTS,
  ERROR_SESSION_NOT_FOUND,
} from "../host.js";
import {
  provider,
  waitFor,
  makeHarness,
  waitInit,
  createSession,
  subscribe,
  sessionSnapshotState,
  chatSnapshotState,
  agentDirectoryOf,
  DIR,
  OTHER,
  startTurn,
  createChat,
  disposeSession,
  setupSession,
  listSessionsPage,
} from "./host-fakes.js";

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
    // The session's workspace is the location directory (the agent's tool
    // access root) — VS Code groups its session list by this; without it the
    // session lands in the "Unknown" bucket.
    expect(added!.params.summary.workingDirectories).toEqual(["file:///tmp/opencode/ahp-scratch/project-lan/"]);

    // Session snapshot: lifecycle ready, the chat catalog, default chat, and —
    // the dropdown-fix invariant — session-state customizations carry the
    // agent directory (Build/Plan/Explore; hidden "Title" omitted).
    const sess = await sessionSnapshotState(h, 1, sessionChannelURI("my-project-sess"), 101);
    expect(sess.lifecycle).toBe("ready");
    expect(sess.provider).toBe("gpuz");
    expect(sess.defaultChat).toBe(chatChannelURI("ses_fake_1"));
    expect(sess.workingDirectories).toEqual(["file:///tmp/opencode/ahp-scratch/project-lan/"]);
    expect(sess.chats).toHaveLength(1);
    expect(sess.chats[0]!.title).toBe(sess.title);
    const { container, children } = agentDirectoryOf(sess);
    expect(container.name).toBe("project-lan");
    expect(container.writable).toBe(false);
    expect(children.map((c) => c.name)).toEqual(["Build", "Plan", "Explore"]);
    expect(children.find((c) => c.name === "Explore")!.disableUserInvocation).toBe(true);

    // Chat snapshot: the same chat, idle + read.
    const chat = await chatSnapshotState(h, 1, chatChannelURI("ses_fake_1"), 102);
    expect(chat.resource).toBe(chatChannelURI("ses_fake_1"));
    expect(chat.title).toBe(sess.title);
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

  it("honors workingDirectories[0] as the session's working directory (cross-location)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);

    const res = await createSession(h, 1, sessionChannelURI("wd-sess"), {
      provider: "gpuz",
      workingDirectories: [`${directoryUri(OTHER)}`],
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toBeNull();
    // The backend session is created in the target directory's location —
    // trailing slash stripped (the record's directory is a plain path).
    expect(h.facade.createCalls[0]!.location).toEqual({ directory: OTHER });

    const added = h.notification("root/sessionAdded", 1);
    expect(added!.params.summary.resource).toBe(sessionChannelURI("wd-sess"));
    expect(added!.params.summary.workingDirectories).toEqual([directoryUri(OTHER)]);

    const sess = await sessionSnapshotState(h, 1, sessionChannelURI("wd-sess"), 101);
    expect(sess.workingDirectories).toEqual([directoryUri(OTHER)]);
    // The directory customization advertises the session's own directory,
    // not the location's.
    const { container } = agentDirectoryOf(sess);
    expect(container.name).toBe("other-project");
    h.stop();
  });

  it("ignores extra workingDirectories (no multipleWorkingDirectories capability)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const res = await createSession(h, 1, sessionChannelURI("wd-extra"), {
      provider: "gpuz",
      workingDirectories: [directoryUri(OTHER), "file:///tmp/opencode/elsewhere/"],
    });
    expect(res.error).toBeUndefined();
    expect(h.facade.createCalls[0]!.location).toEqual({ directory: OTHER });
    expect(h.notification("root/sessionAdded", 1)!.params.summary.workingDirectories).toEqual([directoryUri(OTHER)]);
    h.stop();
  });

  it("rejects malformed workingDirectories with -32602", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const bad = ["nope", [], [""], ["not-a-uri"], ["http://example.com/x"], [123]];
    for (let i = 0; i < bad.length; i++) {
      const res = await createSession(h, 1, sessionChannelURI(`wd-bad-${i}`), {
        provider: "gpuz",
        workingDirectories: bad[i] as unknown[],
      }, 100 + i);
      expect(res.error?.code).toBe(ERROR_INVALID_PARAMS);
    }
    expect(h.facade.createCalls).toHaveLength(0);
    h.stop();
  });

  it("seeds the snapshot with the customization catalog and server tools (client tools excluded)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    h.facade.skills = [
      { id: "opencode", name: "OpenCode", path: "skill://opencode/SKILL.md" },
      { id: "demo", name: "Demo", description: "A demo skill", autoinvoke: false, path: "/home/u/.config/opencode/skills/demo/SKILL.md" },
    ];
    h.facade.mcpServers = [
      { name: "context7", title: "Context7", status: "connected" },
      { name: "broken", status: "failed", error: "boom" },
    ];
    h.facade.tools = [
      { name: "bash", description: "Run a shell command", input: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "ct_a" },
    ];

    // Session A's own `activeClient` provides `ct_a`: the record does not
    // exist while the snapshot runs, so its exclusion is pre-seeded.
    await createSession(
      h,
      1,
      sessionChannelURI("ses_cat_a"),
      { provider: "gpuz", activeClient: { clientId: "c1", tools: [{ name: "ct_a" }] } },
      100,
    );
    const sessA = await sessionSnapshotState(h, 1, sessionChannelURI("ses_cat_a"), 101);
    // Session B (no active client): `ct_a` is excluded through the
    // cross-session union (A's active client).
    await createSession(h, 1, sessionChannelURI("ses_cat_b"), { provider: "gpuz" }, 102);
    const sessB = await sessionSnapshotState(h, 1, sessionChannelURI("ses_cat_b"), 103);

    for (const sess of [sessA, sessB]) {
      // The agent directory container (the existing dropdown-fix invariant).
      const { container, children } = agentDirectoryOf(sess);
      expect(container.id).toBe(`opencode:directory:${DIR}`);
      expect(children.map((c) => c.name)).toEqual(["Build", "Plan", "Explore"]);
      // The skills directory container: a sibling over the same URI, with
      // the virtual built-in path and the on-disk skill.
      const skillDir = sess.customizations!.find(
        (c) => c.type === CustomizationType.Directory && c.id === `opencode:directory:${DIR}:skills`,
      ) as DirectoryCustomization;
      expect(skillDir.contents).toBe("skill");
      expect(skillDir.uri).toBe(container.uri);
      const skillChildren = (skillDir.children ?? []) as SkillCustomization[];
      expect(skillChildren.map((c) => c.name)).toEqual(["OpenCode", "Demo"]);
      expect(skillChildren.find((c) => c.name === "Demo")!.disableModelInvocation).toBe(true);
      // Top-level MCP entries: the connected server is ready (title over
      // name); the failed server carries its error.
      expect(sess.customizations!.find((c) => c.id === "opencode:mcp/context7")).toEqual({
        type: CustomizationType.McpServer,
        id: "opencode:mcp/context7",
        uri: container.uri,
        name: "Context7",
        state: { kind: McpServerStatus.Ready },
      });
      expect(sess.customizations!.find((c) => c.id === "opencode:mcp/broken")).toEqual({
        type: CustomizationType.McpServer,
        id: "opencode:mcp/broken",
        uri: container.uri,
        name: "broken",
        state: { kind: McpServerStatus.Error, error: { errorType: "mcp.failed", message: "boom" } },
      });
      // Server tools: the registry's `bash` with its JSON-Schema input —
      // and `ct_a` is NOT echoed back (it reaches the model through the
      // client).
      expect(sess.serverTools).toEqual([
        {
          name: "bash",
          description: "Run a shell command",
          inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        },
      ]);
    }
    h.stop();
  });
});

// ── non-standard (legacy) session channels ────────────────────────────
// VS Code's legacy addressing (hosts predating the vscode.ahpSessionUris
// capability) and the AHP reference client create sessions under
// <provider>:/<uuid> instead of ahp-session:/<uuid>. The host accepts
// the form and echoes the channel back verbatim (design §6).

describe("non-standard (legacy) session channels", () => {
  it("createSession accepts a <provider>:/<uuid> channel and serves it end-to-end", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const legacy = "copilot:/d6df6b12-1111-4111-8111-111111111111";
    const res = await createSession(h, 1, legacy, { provider: "gpuz" });
    expect(res.error).toBeUndefined();
    expect(res.result).toBeNull();

    // The root announcement carries the client's channel verbatim.
    const added = h.notification("root/sessionAdded", 1);
    expect(added!.params.summary.resource).toBe(legacy);

    // The legacy channel is subscribable — it classifies "unknown" by
    // prefix and resolves through the registry's session-channel set.
    const sess = await sessionSnapshotState(h, 1, legacy, 101);
    expect(sess.lifecycle).toBe("ready");
    expect(sess.chats).toHaveLength(1);
    expect(sess.defaultChat).toBe(chatChannelURI(h.facade.createdIds[0]!));

    // createChat accepts the legacy session channel as the owner.
    const chat = await createChat(h, 1, { channel: legacy, chat: "ahp-chat:/legacy-peer" }, 102);
    expect(chat.error).toBeUndefined();

    // A duplicate uses the exact channel string.
    const dup = await createSession(h, 1, legacy, {}, 103);
    expect(dup.error?.code).toBe(ERROR_SESSION_EXISTS);
    h.stop();
  });

  it("rejects non-session channels with -32602 and logs the offending channel", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const bad: (string | undefined)[] = [
      "ahp-chat:/x",
      ROOT_CHANNEL,
      "file:///tmp/opencode/ahp-scratch",
      "copilot://x", // authority — not the legacy form
      "copilot:/", // empty suffix
      undefined, // missing channel
    ];
    for (let i = 0; i < bad.length; i++) {
      const id = 100 + i;
      h.send(1, "createSession", bad[i] === undefined ? {} : { channel: bad[i] }, id);
      await waitFor(
        () => h.frames.some((f) => f.socketId === 1 && f.message.id === id && (f.message.result !== undefined || f.message.error)),
        `createSession response (${id})`,
      );
      const msg = h.frames.find((f) => f.socketId === 1 && f.message.id === id)!.message;
      expect(msg.error?.code).toBe(ERROR_INVALID_PARAMS);
    }
    expect(h.facade.createCalls).toHaveLength(0);
    // The rejection is logged with the offending channel — this path used
    // to go out silently, making a client's channel error unattributable.
    const logged = h.logs.filter((l) => l.startsWith("createSession rejected: channel is not a session URI"));
    expect(logged).toHaveLength(bad.length);
    expect(logged[0]!.includes('"ahp-chat:/x"')).toBe(true);
    h.stop();
  });

  it("keeps the session-channel and terminal-channel sets disjoint", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    // A pty terminal on the same URI form as a legacy session channel
    // (VS Code mints agenthost-terminal:/<uuid> for pty terminals).
    const uri = "agenthost-terminal:/term-1";
    h.send(1, "createTerminal", { channel: uri, claim: { kind: "client", clientId: "c1" } }, 900);
    await waitFor(() => h.frames.some((f) => f.message.id === 900 && (f.message.result !== undefined || f.message.error)), "createTerminal response");
    expect(h.frames.find((f) => f.message.id === 900)!.message.error).toBeUndefined();

    // A session cannot take a live terminal channel.
    const clash = await createSession(h, 1, uri, {}, 901);
    expect(clash.error?.code).toBe(ERROR_INVALID_PARAMS);
    expect(h.logs.some((l) => l.includes("live terminal channel"))).toBe(true);

    // A terminal cannot take a live (legacy) session channel.
    const legacy = "copilot:/sess-clash";
    const created = await createSession(h, 1, legacy, {}, 902);
    expect(created.error).toBeUndefined();
    h.send(1, "createTerminal", { channel: legacy, claim: { kind: "client", clientId: "c1" } }, 903);
    await waitFor(() => h.frames.some((f) => f.message.id === 903 && (f.message.result !== undefined || f.message.error)), "createTerminal response");
    expect(h.frames.find((f) => f.message.id === 903)!.message.error?.code).toBe(ERROR_INVALID_REQUEST);
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
    expect(page1.items[0].workingDirectories).toEqual(["file:///tmp/opencode/ahp-scratch/project-lan/"]);
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

  it("does not surface subagent child sessions (a parentID) and keeps their channel unregistered", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const t0 = Date.now() - 5000;
    h.facade.sessions.set("ses_parent", { sessionID: "ses_parent", title: "Parent", time: { created: t0, updated: t0 } });
    h.facade.sessions.set("ses_child", {
      sessionID: "ses_child",
      title: "Subagent child",
      parentID: "ses_parent",
      time: { created: t0, updated: t0 + 1000 },
    });

    h.send(1, "listSessions", {}, 211);
    await waitFor(() => h.frames.some((f) => f.message.id === 211), "list");
    const page = h.frames.find((f) => f.message.id === 211)!.message.result;
    expect(page.items.map((s: Record<string, any>) => s.resource)).toEqual([sessionChannelURI("ses_parent")]);

    // The child's channel was never registered — no lazy registration either.
    const sub = await subscribe(h, 1, sessionChannelURI("ses_child"), 212);
    expect(sub.error?.code).toBe(-32001);
    h.stop();
  });
});

// ── disposeSession ───────────────────────────────────────

describe("disposeSession", () => {
  it("disposes the session and its backend, announces the removal on root, and answers null", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI("ses_disp"), { provider: "gpuz" });
    expect(h.notification("root/sessionAdded", 1)).toBeDefined();

    const res = await disposeSession(h, 1, sessionChannelURI("ses_disp"), 400);
    expect(res.error).toBeUndefined();
    expect(res.result).toBeNull();
    expect(h.facade.removeCalls).toEqual(["ses_disp"]);

    // root/sessionRemoved (exactly once) and the active-session count at 0.
    expect(h.frames.filter((f) => f.message.method === "root/sessionRemoved")).toHaveLength(1);
    const removed = h.notification("root/sessionRemoved", 1)!;
    expect(removed.params.session).toBe(sessionChannelURI("ses_disp"));
    const counts = h.actionsOn(ROOT_CHANNEL).filter((a) => a.action.type === "root/activeSessionsChanged");
    expect(counts[counts.length - 1]!.action.activeSessions).toBe(0);

    // The session channel is no longer subscribable; listSessions is empty.
    const sub = await subscribe(h, 1, sessionChannelURI("ses_disp"), 401);
    expect(sub.error?.code).toBe(ERROR_SESSION_NOT_FOUND);
    const page = await listSessionsPage(h, 402);
    expect(page.items).toHaveLength(0);

    // The backend's session.deleted (pushed by the fake during the remove,
    // possibly pumped before or after the unbind) must not re-run the
    // teardown: no duplicate root/sessionRemoved, no resurfacing.
    await new Promise((r) => setTimeout(r, 320));
    expect(h.frames.filter((f) => f.message.method === "root/sessionRemoved")).toHaveLength(1);
    expect(h.frames.filter((f) => f.message.method === "root/sessionAdded")).toHaveLength(1);

    // A second dispose (or one that raced a TUI deletion) is an error.
    const again = await disposeSession(h, 1, sessionChannelURI("ses_disp"), 403);
    expect(again.error?.code).toBe(ERROR_SESSION_NOT_FOUND);
    h.stop();
  }, 10000);

  it("disposes a multi-chat session: every peer backend goes with the record", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const defaultSession = await setupSession(h, "dm-sess");
    const peer = "ahp-chat:/peer-dm";
    await createChat(h, 1, { channel: sessionChannelURI("dm-sess"), chat: peer }, 410);
    const peerSession = h.facade.createdIds[1]!;

    const res = await disposeSession(h, 1, sessionChannelURI("dm-sess"), 411);
    expect(res.error).toBeUndefined();
    expect(res.result).toBeNull();
    // Every opencode backend behind the record is removed (default + peer).
    expect(h.facade.removeCalls).toHaveLength(2);
    expect(h.facade.removeCalls).toContain(defaultSession);
    expect(h.facade.removeCalls).toContain(peerSession);

    expect(h.notification("root/sessionRemoved", 1)).toBeDefined();
    const counts = h.actionsOn(ROOT_CHANNEL).filter((a) => a.action.type === "root/activeSessionsChanged");
    expect(counts[counts.length - 1]!.action.activeSessions).toBe(0);

    // Neither the session channel nor the peer chat channel is subscribable.
    const sub = await subscribe(h, 1, sessionChannelURI("dm-sess"), 412);
    expect(sub.error?.code).toBe(ERROR_SESSION_NOT_FOUND);
    const chatSub = await subscribe(h, 1, peer, 413);
    expect(chatSub.error?.code).toBe(ERROR_SESSION_NOT_FOUND);

    // No disposed backend resurfaces as its own AHP session past the
    // grace window (the peer's session.deleted must not re-attach or
    // re-register anything).
    await new Promise((r) => setTimeout(r, 320));
    expect(h.frames.filter((f) => f.message.method === "root/sessionAdded")).toHaveLength(1);
    h.stop();
  }, 10000);

  it("accepts the legacy <scheme>:/<suffix> channel form (the one clients echo back)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const legacy = "gpuz:/legacy-disp";
    const created = await createSession(h, 1, legacy, { provider: "gpuz" });
    expect(created.error).toBeUndefined();
    const backend = h.facade.createdIds[0]!;

    const res = await disposeSession(h, 1, legacy, 420);
    expect(res.error).toBeUndefined();
    expect(res.result).toBeNull();
    expect(h.facade.removeCalls).toEqual([backend]);
    const removed = h.notification("root/sessionRemoved", 1)!;
    expect(removed.params.session).toBe(legacy);
    h.stop();
  });

  it("rejects non-session channels and unknown sessions without side effects", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await setupSession(h, "ej-sess");

    const chat = await disposeSession(h, 1, chatChannelURI("ej-sess"), 430);
    expect(chat.error?.code).toBe(ERROR_INVALID_PARAMS);
    const root = await disposeSession(h, 1, ROOT_CHANNEL, 431);
    expect(root.error?.code).toBe(ERROR_INVALID_PARAMS);
    const unknown = await disposeSession(h, 1, sessionChannelURI("ghost"), 432);
    expect(unknown.error?.code).toBe(ERROR_SESSION_NOT_FOUND);

    // The session is untouched.
    expect(h.notification("root/sessionRemoved", 1)).toBeUndefined();
    expect(h.facade.removeCalls).toHaveLength(0);
    const sess = await sessionSnapshotState(h, 1, sessionChannelURI("ej-sess"), 433);
    expect(sess.chats).toHaveLength(1);
    h.stop();
  });
});

describe("resolveSessionConfig (AHP 1.0.0 root command)", () => {
  const SES = "ses_cfg";

  it("answers the empty schema with empty values — the client's strict pre-send resolve succeeds", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    // The VS Code shape: provider + workingDirectory + (later) config.
    h.send(
      1,
      "resolveSessionConfig",
      {
        channel: ROOT_CHANNEL,
        provider: "gpuz",
        workingDirectory: "file:///tmp/opencode/ahp-scratch/project-lan",
        config: {},
      },
      920,
    );
    await waitFor(() => h.frames.some((f) => f.message.id === 920), "resolveSessionConfig response");
    const res = h.frames.find((f) => f.message.id === 920)!.message.result;
    expect(res).toEqual({ schema: { type: "object", properties: {} }, values: {} });
    h.stop();
  });

  it("accepts a missing channel as a client error (-32602), not a protocol error", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    h.send(1, "resolveSessionConfig", { channel: "ahp-session:/x" }, 921);
    await waitFor(() => h.frames.some((f) => f.message.id === 921), "resolveSessionConfig response");
    expect(h.frames.find((f) => f.message.id === 921)!.message.error.code).toBe(-32602);
    h.send(1, "resolveSessionConfig", {}, 922);
    await waitFor(() => h.frames.some((f) => f.message.id === 922), "resolveSessionConfig response");
    expect(h.frames.find((f) => f.message.id === 922)!.message.error.code).toBe(-32602);
    h.stop();
  });

  it("the full VS Code new-session flow: resolve → createSession → first send works", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    // Strict resolve right before the send (what _sendNewSessionRequest does).
    h.send(1, "resolveSessionConfig", { channel: ROOT_CHANNEL, provider: "gpuz" }, 923);
    await waitFor(() => h.frames.some((f) => f.message.id === 923), "resolveSessionConfig response");
    expect(h.frames.find((f) => f.message.id === 923)!.message.error).toBeUndefined();
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const chatURI = chatChannelURI(SES);
    await subscribe(h, 1, chatURI, 924);
    startTurn(h, chatURI, "tCfg", 1, "hello");
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt delivered");
    h.stop();
  });
});
