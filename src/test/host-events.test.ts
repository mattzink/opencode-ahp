/**
 * Host tests — the opencode event pump's registration surface: external
 * (TUI/restart) session registration, the catalog converging on the
 * registered session, and removal.
 */
import { describe, expect, it } from "vitest";
import { directoryUri } from "../bridge.js";
import { ROOT_CHANNEL, chatChannelURI, sessionChannelURI } from "../channels.js";
import {
  waitFor,
  makeHarness,
  waitInit,
  createSession,
  subscribe,
  sessionSnapshotState,
  chatSnapshotState,
  DIR,
  OTHER,
  waitForAction,
} from "./host-fakes.js";

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
    expect(added.params.summary.chats[0].title).toBe("TUI session");
    expect(added.params.summary.workingDirectories).toEqual(["file:///tmp/opencode/ahp-scratch/project-lan/"]);
    const counts = h.actionsOn(ROOT_CHANNEL).filter((a) => a.action.type === "root/activeSessionsChanged");
    expect(counts[counts.length - 1]!.action.activeSessions).toBe(1);

    const sess = await sessionSnapshotState(h, 1, sessionChannelURI("ses_tui_1"), 161);
    expect(sess.title).toBe("TUI session");
    expect(sess.chats[0]?.title).toBe("TUI session");
    expect(sess.workingDirectories).toEqual(["file:///tmp/opencode/ahp-scratch/project-lan/"]);
    h.stop();
  }, 10000);

  it("updates the default chat's visible title when OpenCode names the session", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const id = "ses_autotitle";
    const session = sessionChannelURI(id);
    const chat = chatChannelURI(id);
    await createSession(h, 1, session, { provider: "gpuz" });
    await subscribe(h, 1, session, 160);
    h.facade.push({ type: "session.renamed", sessionID: id, title: "Fix workspace selection" });
    await waitForAction(h, session, "session/chatUpdated", (a) => a.action.changes.title === "Fix workspace selection");
    const state = await sessionSnapshotState(h, 1, session, 161);
    expect(state.title).toBe("Fix workspace selection");
    expect(state.chats[0]?.title).toBe("Fix workspace selection");
    expect((await chatSnapshotState(h, 1, chat, 162)).title).toBe("Fix workspace selection");
    expect(h.frames.some(({ message }) => message.method === "root/sessionSummaryChanged"
      && message.params.changes.chats?.[0]?.title === "Fix workspace selection")).toBe(true);
    h.stop();
  });

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

  it("never registers a subagent child (session.created with a parentID) — not even deferred", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    h.facade.sessions.set("ses_child3", {
      sessionID: "ses_child3",
      title: "Subagent child",
      parentID: "ses_parent3",
      time: { created: Date.now(), updated: Date.now() },
    });
    h.facade.push({ type: "session.created", sessionID: "ses_child3", parentID: "ses_parent3", title: "Subagent child" });
    // Past the 250 ms external-register grace: no registration ran, and
    // the early skip means no existence fetch either.
    await new Promise((r) => setTimeout(r, 320));
    expect(h.facade.getSessionsCalls).not.toContain("ses_child3");
    expect(h.notification("root/sessionAdded", 1)).toBeUndefined();
    const sub = await subscribe(h, 1, sessionChannelURI("ses_child3"), 165);
    expect(sub.error?.code).toBe(-32001);
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

  it("registers a cross-location session with its own working directory", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const t0 = Date.now() - 5000;
    h.facade.sessions.set("ses_foreign", {
      sessionID: "ses_foreign",
      title: "Foreign session",
      location: { directory: OTHER },
      time: { created: t0, updated: t0 },
    });

    h.facade.push({ type: "session.created", sessionID: "ses_foreign", title: "Foreign session" });
    await waitFor(
      () => h.notification("root/sessionAdded", 1) !== undefined,
      "root/sessionAdded for the external session",
      3000,
    );
    const added = h.notification("root/sessionAdded", 1)!;
    expect(added.params.summary.resource).toBe(sessionChannelURI("ses_foreign"));
    // The session's own location — not the plugin's location directory.
    expect(added.params.summary.workingDirectories).toEqual([directoryUri(OTHER)]);

    const sess = await sessionSnapshotState(h, 1, sessionChannelURI("ses_foreign"), 163);
    expect(sess.title).toBe("Foreign session");
    expect(sess.workingDirectories).toEqual([directoryUri(OTHER)]);
    h.stop();
  }, 10000);

  it("an externally-registered session converges on the catalog via change actions", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    h.facade.skills = [{ id: "opencode", name: "OpenCode", path: "skill://opencode/SKILL.md" }];
    h.facade.tools = [{ name: "bash", description: "Run a shell command" }];
    // Widen the window: the announcement lands first, the catalog
    // change actions follow (the synchronous path cannot await).
    h.facade.catalogDelayMs = 50;
    const t0 = Date.now() - 5000;
    h.facade.sessions.set("ses_tui_cat", {
      sessionID: "ses_tui_cat",
      title: "TUI session",
      time: { created: t0, updated: t0 },
    });
    h.facade.push({ type: "session.created", sessionID: "ses_tui_cat", title: "TUI session" });

    await waitFor(
      () => h.notification("root/sessionAdded", 1) !== undefined,
      "root/sessionAdded for the external session",
      3000,
    );
    // Subscribe in the window: the snapshot does not carry the catalog
    // yet — the change actions follow.
    const ch = sessionChannelURI("ses_tui_cat");
    const early = await subscribe(h, 1, ch, 200);
    expect(early.result?.snapshot?.state?.customizations).toBeUndefined();
    expect(early.result?.snapshot?.state?.serverTools).toBeUndefined();

    const customizationsChanged = await waitForAction(h, ch, "session/customizationsChanged");
    const skillDir = (customizationsChanged.action.customizations as Record<string, any>[]).find(
      (c) => c.id === `opencode:directory:${DIR}:skills`,
    );
    expect(((skillDir?.children ?? []) as { name: string }[]).map((c) => c.name)).toEqual(["OpenCode"]);
    const serverToolsChanged = await waitForAction(h, ch, "session/serverToolsChanged");
    expect(serverToolsChanged.action.tools).toEqual([{ name: "bash", description: "Run a shell command" }]);

    // The store has converged: a fresh subscribe carries the catalog.
    const sess = await sessionSnapshotState(h, 1, ch, 201);
    expect(sess.customizations!.some((c) => c.id === `opencode:directory:${DIR}:skills`)).toBe(true);
    expect(sess.serverTools).toEqual([{ name: "bash", description: "Run a shell command" }]);
    h.stop();
  }, 10000);
});
