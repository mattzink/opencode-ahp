/**
 * Host tests — client-dispatchable actions: the session-level echoes and
 * rejections, and the MCP toggle (`session/customizationToggled` /
 * `mcpServerStartRequested` / `mcpServerStopRequested` → the
 * `disabled`-flag dispatch and the catalog re-push).
 */
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { McpServerStatus, SessionStatus } from "@microsoft/agent-host-protocol";
import { sessionChannelURI, chatChannelURI } from "../channels.js";
import {
  waitFor,
  makeHarness,
  waitInit,
  createSession,
  subscribe,
  sessionSnapshotState,
  chatSnapshotState,
  DIR,
  waitForAction,
  createChat,
} from "./host-fakes.js";

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
    expect(sess.chats[0]?.title).toBe("My renamed session");
    void changed;
    h.stop();
  });

  it("renames the peer backend when VS Code dispatches titleChanged on a chat channel", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const session = sessionChannelURI(SES);
    const chat = "ahp-chat:/peer-rename";
    await createSession(h, 1, session, { provider: "gpuz" });
    await createChat(h, 1, { channel: session, chat }, 151);
    await subscribe(h, 1, chat, 152);
    h.send(1, "dispatchAction", {
      channel: chat,
      clientSeq: 1,
      action: { type: "session/titleChanged", title: "Follow-up" },
    });
    const echo = await waitForAction(h, chat, "session/titleChanged");
    expect(echo.rejectionReason).toBeUndefined();
    expect(echo.origin).toEqual({ clientId: "c1", clientSeq: 1 });
    expect(h.facade.renameCalls).toEqual([{ sessionID: h.facade.createdIds[1], title: "Follow-up" }]);
    const state = await sessionSnapshotState(h, 1, session, 153);
    expect(state.title).toBe("New Session");
    expect(state.chats.find((entry) => entry.resource === chat)?.title).toBe("Follow-up");
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

// ── MCP toggle ────────────────────────────────────────────────────────────
// The panel's enable toggle (`session/customizationToggled` on an
// `opencode:mcp/<name>` id) and the dedicated start/stop control actions
// map to the facade's `setMcpDisabled` (opencode's `disabled` flag + MCP
// re-reconcile). The accepted echo is followed by a full catalog re-push
// so the entry's `state` and the `enablement` the panel reads converge.

describe("MCP toggle", () => {
  const SES = "ses_mcp_toggle";
  const mcpEntry = (customizations: any[], name: string) =>
    customizations.find((c: any) => c.id === `opencode:mcp/${name}`);

  it("session/customizationToggled disables a configured MCP server", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    h.facade.mcpServers = [{ name: "context7", title: "Context7", status: "connected" }];
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const sessURI = sessionChannelURI(SES);
    await subscribe(h, 1, sessURI, 140);

    h.send(1, "dispatchAction", {
      channel: sessURI,
      clientSeq: 1,
      action: {
        type: "session/customizationToggled",
        id: "opencode:mcp/context7",
        enablement: [{ kind: "session", enabled: false }],
      },
    });
    await waitFor(() => h.facade.setMcpDisabledCalls.length === 1, "setMcpDisabled");
    expect(h.facade.setMcpDisabledCalls[0]).toEqual({ name: "context7", disabled: true });
    const echo = await waitForAction(h, sessURI, "session/customizationToggled");
    expect(echo.rejectionReason).toBeUndefined();

    // The per-location catalog re-pushes: the entry is stopped and carries
    // the host's workspace disable decision (the panel's effective-enabled
    // value); without it the toggle would render on while stopped.
    const changed = await waitForAction(h, sessURI, "session/customizationsChanged");
    const entry = mcpEntry(changed.action.customizations, "context7");
    expect(entry.state).toEqual({ kind: McpServerStatus.Stopped });
    expect(entry.enablement).toEqual([{ kind: "workspace", uri: pathToFileURL(DIR).href, enabled: false }]);

    const sess = await sessionSnapshotState(h, 1, sessURI, 150);
    const stored = mcpEntry(sess.customizations!, "context7");
    expect(stored.state).toEqual({ kind: McpServerStatus.Stopped });
    expect(stored.enablement).toEqual(entry.enablement);
    h.stop();
  });

  it("session/customizationToggled re-enables (absent decision → enabled, no enablement)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    // File-disabled (or previously toggled off): stopped with no tools.
    h.facade.mcpServers = [{ name: "context7", status: "disabled" }];
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const sessURI = sessionChannelURI(SES);
    await subscribe(h, 1, sessURI, 141);
    const seeded = await sessionSnapshotState(h, 1, sessURI, 142);
    expect(mcpEntry(seeded.customizations!, "context7").state).toEqual({ kind: McpServerStatus.Stopped });
    expect(mcpEntry(seeded.customizations!, "context7").enablement).toHaveLength(1);

    // The client strips the decision when turning the server back on
    // (empty enablement array = no explicit decision = enabled).
    h.send(1, "dispatchAction", {
      channel: sessURI,
      clientSeq: 1,
      action: { type: "session/customizationToggled", id: "opencode:mcp/context7", enablement: [] },
    });
    await waitFor(() => h.facade.setMcpDisabledCalls.length === 1, "setMcpDisabled");
    expect(h.facade.setMcpDisabledCalls[0]).toEqual({ name: "context7", disabled: false });
    const echo = await waitForAction(h, sessURI, "session/customizationToggled");
    expect(echo.rejectionReason).toBeUndefined();
    const changed = await waitForAction(h, sessURI, "session/customizationsChanged");
    const entry = mcpEntry(changed.action.customizations, "context7");
    expect(entry.state).toEqual({ kind: McpServerStatus.Ready });
    expect(entry.enablement).toBeUndefined();
    h.stop();
  });

  it("mcpServerStopRequested / mcpServerStartRequested drive the same path", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    h.facade.mcpServers = [{ name: "context7", title: "Context7", status: "connected" }];
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const sessURI = sessionChannelURI(SES);
    await subscribe(h, 1, sessURI, 143);

    h.send(1, "dispatchAction", {
      channel: sessURI,
      clientSeq: 1,
      action: { type: "session/mcpServerStopRequested", id: "opencode:mcp/context7" },
    });
    await waitFor(() => h.facade.setMcpDisabledCalls.length === 1, "setMcpDisabled");
    expect(h.facade.setMcpDisabledCalls[0]).toEqual({ name: "context7", disabled: true });
    const stop = await waitForAction(h, sessURI, "session/mcpServerStopRequested");
    expect(stop.rejectionReason).toBeUndefined();

    h.send(1, "dispatchAction", {
      channel: sessURI,
      clientSeq: 2,
      action: { type: "session/mcpServerStartRequested", id: "opencode:mcp/context7" },
    });
    await waitFor(() => h.facade.setMcpDisabledCalls.length === 2, "setMcpDisabled");
    expect(h.facade.setMcpDisabledCalls[1]).toEqual({ name: "context7", disabled: false });
    const start = await waitForAction(h, sessURI, "session/mcpServerStartRequested");
    expect(start.rejectionReason).toBeUndefined();

    // Both re-pushes landed; the final state is the re-enabled one.
    const sess = await sessionSnapshotState(h, 1, sessURI, 153);
    expect(mcpEntry(sess.customizations!, "context7").state).toEqual({ kind: McpServerStatus.Ready });
    h.stop();
  });

  it("rejects toggles and start/stop for non-MCP customizations", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    h.facade.mcpServers = [{ name: "context7", status: "connected" }];
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const sessURI = sessionChannelURI(SES);
    await subscribe(h, 1, sessURI, 144);

    // The agent directory container (and its agent children) are static
    // file/config definitions — no enable/disable mechanism exists.
    h.send(1, "dispatchAction", {
      channel: sessURI,
      clientSeq: 1,
      action: {
        type: "session/customizationToggled",
        id: `opencode:directory:${DIR}`,
        enablement: [{ kind: "session", enabled: false }],
      },
    });
    const toggle = await waitForAction(h, sessURI, "session/customizationToggled", (a) => a.rejectionReason !== undefined);
    expect(toggle.rejectionReason).toMatch(/static file\/config definitions/);

    h.send(1, "dispatchAction", {
      channel: sessURI,
      clientSeq: 2,
      action: { type: "session/mcpServerStopRequested", id: `opencode:directory:${DIR}` },
    });
    const stop = await waitForAction(h, sessURI, "session/mcpServerStopRequested", (a) => a.rejectionReason !== undefined);
    expect(stop.rejectionReason).toMatch(/only MCP servers accept start\/stop/);
    expect(h.facade.setMcpDisabledCalls).toHaveLength(0);
    h.stop();
  });

  it("rejects the toggle with a reason when the facade fails", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    h.facade.mcpServers = [{ name: "context7", status: "connected" }];
    h.facade.mcpDisabledError = "reconcile blew up";
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const sessURI = sessionChannelURI(SES);
    await subscribe(h, 1, sessURI, 145);
    h.send(1, "dispatchAction", {
      channel: sessURI,
      clientSeq: 1,
      action: { type: "session/mcpServerStopRequested", id: "opencode:mcp/context7" },
    });
    const rejected = await waitForAction(h, sessURI, "session/mcpServerStopRequested", (a) => a.rejectionReason !== undefined);
    expect(rejected.rejectionReason).toMatch(/mcp toggle failed: reconcile blew up/);
    h.stop();
  });

  it("re-pushes the catalog to every live session (shared per-location state)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    h.facade.mcpServers = [{ name: "context7", status: "connected" }];
    await createSession(h, 1, sessionChannelURI("ses_mcp_a"), { provider: "gpuz" });
    await createSession(h, 1, sessionChannelURI("ses_mcp_b"), { provider: "gpuz" });
    const [uriA, uriB] = [sessionChannelURI("ses_mcp_a"), sessionChannelURI("ses_mcp_b")];
    await subscribe(h, 1, uriA, 146);
    await subscribe(h, 1, uriB, 147);

    h.send(1, "dispatchAction", {
      channel: uriA,
      clientSeq: 1,
      action: {
        type: "session/customizationToggled",
        id: "opencode:mcp/context7",
        enablement: [{ kind: "session", enabled: false }],
      },
    });
    const changedA = await waitForAction(h, uriA, "session/customizationsChanged");
    const changedB = await waitForAction(h, uriB, "session/customizationsChanged");
    for (const changed of [changedA, changedB]) {
      const entry = mcpEntry(changed.action.customizations, "context7");
      expect(entry.state).toEqual({ kind: McpServerStatus.Stopped });
      expect(entry.enablement).toEqual([{ kind: "workspace", uri: pathToFileURL(DIR).href, enabled: false }]);
    }
    h.stop();
  });
});
