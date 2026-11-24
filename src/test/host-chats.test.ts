/**
 * Host tests — multi-chat: `createChat`/`disposeChat` (peer backends on
 * client-chosen URIs, the capability advertisement, independent turns) and
 * chat-binding durability (the AHP marker surviving a "restart", resurfacing
 * under the original channel — standard and legacy form).
 */
import { describe, expect, it } from "vitest";
import { directoryUri, type FacadeSession } from "../bridge.js";
import { ROOT_CHANNEL, sessionChannelURI, chatChannelURI } from "../channels.js";
import { ERROR_INVALID_PARAMS } from "../handshake.js";
import { ERROR_INTERNAL, ERROR_SESSION_EXISTS, ERROR_SESSION_NOT_FOUND } from "../host.js";
import {
  waitFor,
  Harness,
  makeHarness,
  waitInit,
  createSession,
  subscribe,
  sessionSnapshotState,
  chatSnapshotState,
  OTHER,
  startTurn,
  waitForAction,
  createChat,
  disposeChat,
  setupSession,
  listSessionsPage,
} from "./host-fakes.js";

// ── multi-chat ─────────────────────────

describe("multi-chat", () => {
  it("advertises the plain multi-chat capability in the root catalog", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    const result = await waitInit(h, 1);
    const root = result.snapshots.find((s: Record<string, any>) => s.resource === ROOT_CHANNEL)!;
    expect(root.state.agents).toHaveLength(1);
    // Empty object = multi-chat without source-based creation (no fork/
    // sideChat sub-caps; conformant clients gate on their absence).
    expect(root.state.agents[0].capabilities).toEqual({ multipleChats: {} });
    h.stop();
  });

  it("createChat mints a backend session, adds the chat to the catalog, and routes turns to it", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const defaultSession = await setupSession(h, "mc-sess");
    // Subscribe before the create: action frames go to subscribers only.
    await subscribe(h, 1, sessionChannelURI("mc-sess"), 400);
    const peer = "ahp-chat:/peer-mc";
    const res = await createChat(h, 1, { channel: sessionChannelURI("mc-sess"), chat: peer }, 401);
    expect(res.error).toBeUndefined();
    expect(res.result).toBeNull();

    // A fresh backend session (the 2nd opencode session) is bound to the
    // client-chosen chat URI.
    expect(h.facade.createdIds).toHaveLength(2);
    const peerSession = h.facade.createdIds[1]!;

    // Session channel: session/chatAdded with the new chat's summary.
    const added = await waitForAction(h, sessionChannelURI("mc-sess"), "session/chatAdded");
    expect(added.action.summary.resource).toBe(peer);
    expect(added.action.summary.title).toBe("Chat 2");

    // Session snapshot: two chats, default first, defaultChat unchanged.
    const sess = await sessionSnapshotState(h, 1, sessionChannelURI("mc-sess"), 402);
    expect(sess.chats?.map((c: any) => c.resource)).toEqual([chatChannelURI(defaultSession), peer]);
    expect(sess.defaultChat).toBe(chatChannelURI(defaultSession));

    // The peer chat channel is subscribable with its own fresh state.
    const chat = await chatSnapshotState(h, 1, peer, 403);
    expect(chat.resource).toBe(peer);
    expect(chat.title).toBe("Chat 2");
    expect(chat.turns).toEqual([]);

    // A turn dispatched on the peer chat prompts the peer's backend.
    startTurn(h, peer, "t-peer", 1, "hello peer");
    await waitFor(() => h.facade.promptCalls.length === 1, "peer prompt");
    expect(h.facade.promptCalls[0]!.sessionID).toBe(peerSession);

    // The peer's own session.created (pushed by the fake during create)
    // must not resurface as a separate AHP session after the grace window.
    await new Promise((r) => setTimeout(r, 320));
    expect(h.frames.filter((f) => f.message.method === "root/sessionAdded")).toHaveLength(1);
    h.stop();
  }, 10000);

  it("createChat on a working-directories session mints the peer backend in the same location", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI("mc-wd"), {
      provider: "gpuz",
      workingDirectories: [directoryUri(OTHER)],
    }, 410);
    await subscribe(h, 1, sessionChannelURI("mc-wd"), 411);
    const peer = "ahp-chat:/peer-wd";
    const res = await createChat(h, 1, { channel: sessionChannelURI("mc-wd"), chat: peer }, 412);
    expect(res.error).toBeUndefined();
    expect(res.result).toBeNull();
    // The peer backend runs in the owner's location — not the plugin's.
    expect(h.facade.createCalls).toHaveLength(2);
    expect(h.facade.createCalls[1]!.location).toEqual({ directory: OTHER });
    h.stop();
  });

  it("createChat with initialMessage starts the chat's first turn on the peer backend", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await setupSession(h, "im-sess");
    const peer = "ahp-chat:/peer-im";
    const res = await createChat(
      h,
      1,
      {
        channel: sessionChannelURI("im-sess"),
        chat: peer,
        initialMessage: {
          text: "first message",
          origin: { kind: "user" },
          model: { id: "gpuz/qwen3.8-27b-q5xl", config: { reasoningEffort: "low" } },
        },
      },
      410,
    );
    expect(res.error).toBeUndefined();
    expect(res.result).toBeNull();

    // The host-minted turnStarted is visible in the chat state (the socket
    // could not have subscribed to the chat channel before it existed).
    const chat = await chatSnapshotState(h, 1, peer, 411);
    expect(chat.activeTurn).toBeDefined();
    expect(chat.activeTurn?.message?.text).toBe("first message");
    expect(h.facade.promptCalls).toHaveLength(1);
    expect(h.facade.promptCalls[0]!.sessionID).toBe(h.facade.createdIds[1]!);
    expect(h.facade.promptCalls[0]!.text).toBe("first message");
    expect(h.facade.switchModelCalls).toEqual([
      { sessionID: h.facade.createdIds[1], model: { providerID: "gpuz", modelID: "qwen3.8-27b-q5xl", variant: "low" } },
    ]);
    h.stop();
  });

  it("rolls the chat back when the initial message prompt fails", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const defaultSession = await setupSession(h, "im2-sess");
    const peer = "ahp-chat:/peer-im2";
    h.facade.promptError = "model exploded";
    const res = await createChat(
      h,
      1,
      { channel: sessionChannelURI("im2-sess"), chat: peer, initialMessage: { text: "x" } },
      420,
    );
    expect(res.error?.code).toBe(ERROR_INTERNAL);
    // The chat is rolled back: the backend session is removed, no turn
    // ever started, and the catalog is clean.
    expect(h.facade.removeCalls).toEqual([h.facade.createdIds[1]!]);
    expect(h.actionsOn(peer).some((a: any) => a.action.type === "chat/turnStarted")).toBe(false);
    const sess = await sessionSnapshotState(h, 1, sessionChannelURI("im2-sess"), 421);
    expect(sess.chats?.map((c: any) => c.resource)).toEqual([chatChannelURI(defaultSession)]);
    h.stop();
  });

  it("rejects source and workingDirectories (no fork/sideChat capability)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await setupSession(h, "src-sess");
    const src = await createChat(
      h,
      1,
      { channel: sessionChannelURI("src-sess"), chat: "ahp-chat:/p1", source: { kind: "fork", chat: "x" } },
      430,
    );
    expect(src.error?.code).toBe(ERROR_INVALID_PARAMS);
    const wd = await createChat(
      h,
      1,
      { channel: sessionChannelURI("src-sess"), chat: "ahp-chat:/p2", workingDirectories: ["/x"] },
      431,
    );
    expect(wd.error?.code).toBe(ERROR_INVALID_PARAMS);
    // No backend session was minted for either rejected request.
    expect(h.facade.createdIds).toHaveLength(1);
    h.stop();
  });

  it("rejects the default chat URI, a duplicate chat URI, and unknown channels", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const defaultSession = await setupSession(h, "dup-sess");
    // The default chat URI is not a new chat.
    const def = await createChat(h, 1, { channel: sessionChannelURI("dup-sess"), chat: chatChannelURI(defaultSession) }, 440);
    expect(def.error?.code).toBe(ERROR_SESSION_EXISTS);
    // A second createChat for the same peer URI.
    await createChat(h, 1, { channel: sessionChannelURI("dup-sess"), chat: "ahp-chat:/twin" }, 441);
    const dup = await createChat(h, 1, { channel: sessionChannelURI("dup-sess"), chat: "ahp-chat:/twin" }, 442);
    expect(dup.error?.code).toBe(ERROR_SESSION_EXISTS);
    // Unknown session channel → -32001; a non-session channel → -32602.
    const unknown = await createChat(h, 1, { channel: sessionChannelURI("ghost"), chat: "ahp-chat:/g" }, 443);
    expect(unknown.error?.code).toBe(ERROR_SESSION_NOT_FOUND);
    const badChannel = await createChat(h, 1, { channel: "ahp-chat:/x", chat: "ahp-chat:/g" }, 444);
    expect(badChannel.error?.code).toBe(ERROR_INVALID_PARAMS);
    h.stop();
  });

  it("refuses to dispose the default chat and unknown chats", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const defaultSession = await setupSession(h, "disp-sess");
    const def = await disposeChat(h, 1, chatChannelURI(defaultSession), 450);
    expect(def.error?.code).toBe(ERROR_INVALID_PARAMS);
    const unknown = await disposeChat(h, 1, "ahp-chat:/ghost", 451);
    expect(unknown.error?.code).toBe(ERROR_SESSION_NOT_FOUND);
    // The session is untouched.
    const sess = await sessionSnapshotState(h, 1, sessionChannelURI("disp-sess"), 452);
    expect(sess.chats).toHaveLength(1);
    h.stop();
  });

  it("disposeChat removes the peer chat and its backend, keeping the session healthy", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const defaultSession = await setupSession(h, "dis-sess");
    await subscribe(h, 1, sessionChannelURI("dis-sess"), 460);
    const peer = "ahp-chat:/peer-dis";
    await createChat(h, 1, { channel: sessionChannelURI("dis-sess"), chat: peer }, 461);
    const peerSession = h.facade.createdIds[1]!;

    const res = await disposeChat(h, 1, peer, 462);
    expect(res.error).toBeUndefined();
    expect(res.result).toBeNull();
    expect(h.facade.removeCalls).toEqual([peerSession]);

    const removed = await waitForAction(h, sessionChannelURI("dis-sess"), "session/chatRemoved");
    expect(removed.action.chat).toBe(peer);

    // The AHP session survives with its single (default) chat.
    const sess = await sessionSnapshotState(h, 1, sessionChannelURI("dis-sess"), 463);
    expect(sess.chats?.map((c: any) => c.resource)).toEqual([chatChannelURI(defaultSession)]);

    // The backend's session.deleted (pushed by the fake during remove,
    // possibly pumped before or after the unbind) must not resurface as
    // its own AHP session past the grace window.
    await new Promise((r) => setTimeout(r, 320));
    expect(h.frames.filter((f) => f.message.method === "root/sessionAdded")).toHaveLength(1);

    // The peer chat channel is no longer subscribable.
    const sub = await subscribe(h, 1, peer, 464);
    expect(sub.error?.code).toBe(ERROR_SESSION_NOT_FOUND);
    h.stop();
  }, 10000);

  it("session.deleted on a peer backend drops only the AHP chat", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const defaultSession = await setupSession(h, "pd-sess");
    await subscribe(h, 1, sessionChannelURI("pd-sess"), 470);
    const peer = "ahp-chat:/peer-pd";
    await createChat(h, 1, { channel: sessionChannelURI("pd-sess"), chat: peer }, 471);
    const peerSession = h.facade.createdIds[1]!;

    // Simulate the peer's opencode session being deleted outside AHP
    // (TUI, another client).
    h.facade.sessions.delete(peerSession);
    h.facade.push({ type: "session.deleted", sessionID: peerSession });
    const removed = await waitForAction(h, sessionChannelURI("pd-sess"), "session/chatRemoved");
    expect(removed.action.chat).toBe(peer);

    // The AHP session itself is untouched.
    expect(h.notification("root/sessionRemoved", 1)).toBeUndefined();
    const sess = await sessionSnapshotState(h, 1, sessionChannelURI("pd-sess"), 472);
    expect(sess.chats?.map((c: any) => c.resource)).toEqual([chatChannelURI(defaultSession)]);
    h.stop();
  });

  it("session.renamed on a peer backend publishes session/chatUpdated (the chat store keeps its title)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await setupSession(h, "rn-sess");
    await subscribe(h, 1, sessionChannelURI("rn-sess"), 480);
    const peer = "ahp-chat:/peer-rn";
    await createChat(h, 1, { channel: sessionChannelURI("rn-sess"), chat: peer }, 481);
    const peerSession = h.facade.createdIds[1]!;

    h.facade.push({ type: "session.renamed", sessionID: peerSession, title: "Peer title" });
    const updated = await waitForAction(h, sessionChannelURI("rn-sess"), "session/chatUpdated");
    expect(updated.action.chat).toBe(peer);
    expect(updated.action.changes.title).toBe("Peer title");

    // The catalog (session state) carries the new title; the chat store
    // keeps the original (same behavior as the default chat's titleChanged).
    const sess = await sessionSnapshotState(h, 1, sessionChannelURI("rn-sess"), 482);
    expect(sess.chats?.find((c: any) => c.resource === peer)?.title).toBe("Peer title");
    const chat = await chatSnapshotState(h, 1, peer, 483);
    expect(chat.title).toBe("Chat 2");
    // No session-level title change.
    expect(h.actionsOn(sessionChannelURI("rn-sess")).some((a: any) => a.action.type === "session/titleChanged")).toBe(false);
    h.stop();
  });

  it("listSessions does not surface peer-chat backends as their own sessions", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const defaultSession = await setupSession(h, "ls-sess");
    const peer = "ahp-chat:/peer-ls";
    await createChat(h, 1, { channel: sessionChannelURI("ls-sess"), chat: peer }, 490);

    // The facade lists both backends; only the default's AHP session may
    // be registered/surfaced (the peer is already bound to a chat).
    h.send(1, "listSessions", {}, 491);
    await waitFor(() => h.frames.some((f) => f.message.id === 491), "list");
    const page = h.frames.find((f) => f.message.id === 491)!.message.result;
    expect(page.items.map((s: any) => s.resource)).toEqual([sessionChannelURI("ls-sess")]);
    expect(page.items[0].chats).toHaveLength(2);
    expect(page.items[0].defaultChat).toBe(chatChannelURI(defaultSession));

    // The peer backend's session channel was never registered.
    const sub = await subscribe(h, 1, sessionChannelURI(h.facade.createdIds[1]!), 492);
    expect(sub.error?.code).toBe(ERROR_SESSION_NOT_FOUND);
    h.stop();
  });

  it("runs concurrent turns on two chats with per-chat isolation", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const defaultSession = await setupSession(h, "cc-sess");
    const peer = "ahp-chat:/peer-cc";
    await createChat(h, 1, { channel: sessionChannelURI("cc-sess"), chat: peer }, 500);
    const peerSession = h.facade.createdIds[1]!;
    const def = chatChannelURI(defaultSession);

    await subscribe(h, 1, def, 501);
    await subscribe(h, 1, peer, 502);

    startTurn(h, def, "t-d", 1, "default turn");
    await waitFor(() => h.facade.promptCalls.length === 1, "default prompt");
    startTurn(h, peer, "t-p", 2, "peer turn");
    await waitFor(() => h.facade.promptCalls.length === 2, "peer prompt");
    expect(h.facade.promptCalls[0]!.sessionID).toBe(defaultSession);
    expect(h.facade.promptCalls[1]!.sessionID).toBe(peerSession);

    // Deltas for each backend land on their own chat channel only.
    h.facade.push({ type: "text.delta", sessionID: defaultSession, assistantMessageID: "m-d", ordinal: 0, delta: "D" });
    h.facade.push({ type: "text.delta", sessionID: peerSession, assistantMessageID: "m-p", ordinal: 0, delta: "P" });
    const defPart = await waitForAction(h, def, "chat/responsePart", (a) => a.action.part.content === "D");
    expect(defPart.action.turnId).toBe("t-d");
    const peerPart = await waitForAction(h, peer, "chat/responsePart", (a) => a.action.part.content === "P");
    expect(peerPart.action.turnId).toBe("t-p");

    // Completing the default turn leaves the peer turn active.
    h.facade.push({ type: "execution.succeeded", sessionID: defaultSession });
    const defComplete = await waitForAction(h, def, "chat/turnComplete");
    expect(defComplete.action.turnId).toBe("t-d");
    const peerState = await chatSnapshotState(h, 1, peer, 503);
    expect(peerState.activeTurn?.id).toBe("t-p");

    h.facade.push({ type: "execution.succeeded", sessionID: peerSession });
    const peerComplete = await waitForAction(h, peer, "chat/turnComplete");
    expect(peerComplete.action.turnId).toBe("t-p");
    h.stop();
  });
});

// ── chat-binding durability ─────────

/**
 * Seed the facade the way a post-restart opencode store looks:
 * pre-existing sessions with no live `session.created` events (there is
 * no boot-time event replay — they surface on the first listSessions).
 */
function seedSession(
  h: Harness,
  sessionID: string,
  opts: { title?: string; metadata?: Record<string, unknown> } = {},
): FacadeSession {
  const now = Date.now();
  const fs: FacadeSession = {
    sessionID,
    title: opts.title ?? "Seeded Session",
    time: { created: now, updated: now },
    ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
  };
  h.facade.sessions.set(sessionID, fs);
  return fs;
}

describe("chat-binding durability", () => {
  it("createChat stamps the AHP marker on the peer backend's opencode metadata", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const defaultSession = await setupSession(h, "dm-sess");
    const peer = "ahp-chat:/peer-dm";
    await createChat(h, 1, { channel: sessionChannelURI("dm-sess"), chat: peer }, 700);
    const peerSession = h.facade.createdIds[1]!;
    // The marker carries the chat URI + the OWNER's opencode session id
    // (the default chat's suffix is minted, so it is not the channel
    // suffix).
    expect(h.facade.sessions.get(peerSession)!.metadata).toEqual({
      "opencode-ahp": { chat: peer, owner: defaultSession },
    });
    h.stop();
  });

  it("re-attaches a marked peer to its owner session after a restart", async () => {
    const h = makeHarness();
    const owner = "ses_own_dur";
    const peer = "ses_peer_dur";
    const chatURI = "ahp-chat:/peer-dur";
    seedSession(h, owner, { title: "Owner" });
    seedSession(h, peer, { metadata: { "opencode-ahp": { chat: chatURI, owner } } });
    h.init(1, "c1");
    await waitInit(h, 1);

    const page = await listSessionsPage(h, 710);
    // One AHP session — the peer's backend does not surface as its own.
    expect(page.items).toHaveLength(1);
    expect(page.items[0].resource).toBe(sessionChannelURI(owner));
    expect(page.items[0].chats.map((c: any) => c.resource)).toEqual([chatChannelURI(owner), chatURI]);
    expect(page.items[0].defaultChat).toBe(chatChannelURI(owner));
    expect(h.frames.filter((f) => f.message.method === "root/sessionAdded")).toHaveLength(1);

    // The peer's session channel was never registered; the peer chat
    // channel is subscribable at its ORIGINAL URI.
    const sessSub = await subscribe(h, 1, sessionChannelURI(peer), 711);
    expect(sessSub.error?.code).toBe(ERROR_SESSION_NOT_FOUND);
    const chat = await chatSnapshotState(h, 1, chatURI, 712);
    expect(chat.resource).toBe(chatURI);
    expect(chat.turns).toEqual([]);

    // A turn on the re-attached chat prompts the peer backend.
    startTurn(h, chatURI, "t-dur", 1, "hello again");
    await waitFor(() => h.facade.promptCalls.length === 1, "peer prompt");
    expect(h.facade.promptCalls[0]!.sessionID).toBe(peer);
    h.stop();
  });

  it("drains a peer queued ahead of its owner in the same listSessions pass", async () => {
    const h = makeHarness();
    const owner = "ses_own_or";
    const peer = "ses_peer_or";
    const chatURI = "ahp-chat:/peer-or";
    // The peer is listed BEFORE its owner (Map insertion order) — the
    // marker's owner is not registered when the peer is reached, so the
    // binding is queued and must drain when the owner registers.
    seedSession(h, peer, { metadata: { "opencode-ahp": { chat: chatURI, owner } } });
    seedSession(h, owner, { title: "Owner" });
    h.init(1, "c1");
    await waitInit(h, 1);

    const page = await listSessionsPage(h, 720);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].resource).toBe(sessionChannelURI(owner));
    expect(page.items[0].chats.map((c: any) => c.resource)).toEqual([chatChannelURI(owner), chatURI]);
    expect(h.frames.filter((f) => f.message.method === "root/sessionAdded")).toHaveLength(1);

    // The re-attached chat is live: a turn prompts the peer backend.
    startTurn(h, chatURI, "t-or", 1, "queued peer");
    await waitFor(() => h.facade.promptCalls.length === 1, "peer prompt");
    expect(h.facade.promptCalls[0]!.sessionID).toBe(peer);
    h.stop();
  }, 10000);

  it("registers a marked peer standalone after the grace window when its owner is gone from opencode", async () => {
    const h = makeHarness();
    const owner = "ses_own_gh"; // deleted in the TUI while the plugin was down
    const peer = "ses_peer_gh";
    seedSession(h, peer, { metadata: { "opencode-ahp": { chat: "ahp-chat:/peer-gh", owner } } });
    h.init(1, "c1");
    await waitInit(h, 1);

    // First list: the peer is queued (the owner is not registered) and
    // not surfaced.
    const first = await listSessionsPage(h, 730);
    expect(first.items).toHaveLength(0);

    // After the grace window the orphan check finds the owner gone from
    // opencode and registers the peer as its own AHP session (the data
    // stays reachable).
    await new Promise((r) => setTimeout(r, 320));
    const second = await listSessionsPage(h, 731);
    expect(second.items).toHaveLength(1);
    expect(second.items[0].resource).toBe(sessionChannelURI(peer));
    expect(second.items[0].chats).toHaveLength(1);
    expect(second.items[0].defaultChat).toBe(chatChannelURI(peer));
    expect(h.frames.filter((f) => f.message.method === "root/sessionAdded")).toHaveLength(1);
    h.stop();
  }, 10000);

  it("falls back to standalone for a fork that inherited its parent's marker", async () => {
    const h = makeHarness();
    const owner = "ses_own_du";
    const peer = "ses_peer_du";
    const fork = "ses_fork_du";
    const chatURI = "ahp-chat:/peer-du";
    seedSession(h, owner, { title: "Owner" });
    seedSession(h, peer, { metadata: { "opencode-ahp": { chat: chatURI, owner } } });
    // The fork inherited the parent's metadata (core documents the
    // inheritance) — the same marker, so the chat URI collides.
    seedSession(h, fork, { metadata: { "opencode-ahp": { chat: chatURI, owner } } });
    h.init(1, "c1");
    await waitInit(h, 1);

    const page = await listSessionsPage(h, 740);
    expect(page.items).toHaveLength(2);
    const ownerItem = page.items.find((s: any) => s.resource === sessionChannelURI(owner));
    const forkItem = page.items.find((s: any) => s.resource === sessionChannelURI(fork));
    // The original peer re-attached to the owner...
    expect(ownerItem.chats.map((c: any) => c.resource)).toEqual([chatChannelURI(owner), chatURI]);
    // ...and the fork is its own AHP session (default chat reuses its id).
    expect(forkItem.chats).toHaveLength(1);
    expect(forkItem.defaultChat).toBe(chatChannelURI(fork));
    // No ghost for the original peer's session channel.
    const peerSub = await subscribe(h, 1, sessionChannelURI(peer), 741);
    expect(peerSub.error?.code).toBe(ERROR_SESSION_NOT_FOUND);
    h.stop();
  });

  it("createSession stamps the channel marker on a minted-id default backend (not on a ses-suffix one)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    // Minted id: the client-chosen suffix is not an opencode id — the
    // default backend carries the channel marker so a restart resurfaces
    // the session under the ORIGINAL channel.
    const minted = await createSession(h, 1, sessionChannelURI("cn-mint"), { provider: "gpuz" }, 100);
    expect(minted.error).toBeUndefined();
    const mintedID = h.facade.createdIds[0]!;
    expect(mintedID.startsWith("ses_fake_")).toBe(true);
    expect(h.facade.sessions.get(mintedID)!.metadata).toEqual({
      "opencode-ahp": { channel: sessionChannelURI("cn-mint") },
    });
    // A "ses" suffix passes through as the opencode id — the channel
    // already reuses the id, so no marker is stamped.
    const passed = await createSession(h, 1, sessionChannelURI("ses_cn_pass"), { provider: "gpuz" }, 101);
    expect(passed.error).toBeUndefined();
    expect(h.facade.sessions.get("ses_cn_pass")!.metadata).toBeUndefined();
    h.stop();
  });

  it("resurfaces a minted-id session under its original client channel after a restart", async () => {
    const h = makeHarness();
    const owner = "ses_own_cn";
    const peer = "ses_peer_cn";
    const chatURI = "ahp-chat:/peer-cn";
    const original = "ahp-session:/cn-dur";
    // The post-restart store: the default backend (minted id) carries the
    // channel marker; the peer backend carries the chat-binding marker.
    seedSession(h, owner, { title: "Owner", metadata: { "opencode-ahp": { channel: original } } });
    seedSession(h, peer, { metadata: { "opencode-ahp": { chat: chatURI, owner } } });
    h.init(1, "c1");
    await waitInit(h, 1);

    const page = await listSessionsPage(h, 760);
    // ONE AHP session, under the ORIGINAL client-chosen channel — the
    // minted opencode id is only the backend's identity.
    expect(page.items).toHaveLength(1);
    expect(page.items[0].resource).toBe(original);
    expect(page.items[0].chats.map((c: any) => c.resource)).toEqual([chatChannelURI(owner), chatURI]);
    expect(page.items[0].defaultChat).toBe(chatChannelURI(owner));
    expect(h.frames.filter((f) => f.message.method === "root/sessionAdded")).toHaveLength(1);

    // The original session channel is subscribable with a full snapshot.
    const sub = await subscribe(h, 1, original, 761);
    expect(sub.error).toBeUndefined();
    expect(sub.result.snapshot.resource).toBe(original);
    expect(sub.result.snapshot.state.chats).toHaveLength(2);

    // A turn on the re-attached peer chat reaches the surviving backend.
    startTurn(h, chatURI, "t-cn", 1, "channel check");
    await waitFor(() => h.facade.promptCalls.length === 1, "peer prompt");
    expect(h.facade.promptCalls[0]!.sessionID).toBe(peer);
    h.stop();
  });

  it("resurfaces a legacy-channel session under its original channel after a restart", async () => {
    const h = makeHarness();
    const original = "copilot:/legacy-dur";
    seedSession(h, "ses_own_ld", { title: "Legacy", metadata: { "opencode-ahp": { channel: original } } });
    h.init(1, "c1");
    await waitInit(h, 1);

    const page = await listSessionsPage(h, 770);
    // The marker's channel is a non-standard form — it must still be
    // accepted (a prefix-only check would fall back to the opencode id).
    expect(page.items).toHaveLength(1);
    expect(page.items[0].resource).toBe(original);

    // The legacy channel is subscribable with a full snapshot.
    const sub = await subscribe(h, 1, original, 771);
    expect(sub.error).toBeUndefined();
    expect(sub.result.snapshot.resource).toBe(original);
    expect(sub.result.snapshot.state.chats).toHaveLength(1);
    h.stop();
  });
});
