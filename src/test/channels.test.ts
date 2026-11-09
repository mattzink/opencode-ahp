import { describe, expect, it } from "vitest";
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
} from "../channels.js";

describe("channelKind", () => {
  it("classifies URIs", () => {
    expect(channelKind("ahp-root://")).toBe("root");
    expect(channelKind("ahp-session:/s-1")).toBe("session");
    expect(channelKind("ahp-chat:/s-1")).toBe("chat");
  });

  it("classifies changeset URIs — the marker wins over the owner prefixes", () => {
    expect(channelKind("ahp-chat:/s-1/changeset/uncommitted")).toBe("changeset");
    expect(channelKind("ahp-session:/s-1/changeset/session")).toBe("changeset");
    expect(channelKind("ahp-chat:/s-1/changeset/turn/turn-1")).toBe("changeset");
    // The marker check runs BEFORE the session/chat prefix checks, so a
    // changeset URI is never misread as the session channel before the
    // marker (createSession rejects such session suffixes).
    expect(channelKind("ahp-session:/s-1/changeset/session")).not.toBe("session");
  });

  it("rejects empty ids and foreign schemes", () => {
    expect(channelKind("ahp-root:/")).toBe("unknown");
    expect(channelKind("ahp-root:///extra")).toBe("unknown");
    expect(channelKind("ahp-session:/")).toBe("unknown");
    expect(channelKind("ahp-chat:/")).toBe("unknown");
    expect(channelKind("bogus://x")).toBe("unknown");
    expect(channelKind("")).toBe("unknown");
  });
});

describe("session URI helpers", () => {
  it("builds and round-trips session and chat URIs (one chat per session)", () => {
    expect(sessionChannelURI("s-1")).toBe("ahp-session:/s-1");
    expect(chatChannelURI("s-1")).toBe("ahp-chat:/s-1");
    expect(sessionIDOf("ahp-session:/s-1")).toBe("s-1");
    expect(sessionIDOf("ahp-chat:/s-1")).toBe("s-1");
    expect(sessionIDOf(ROOT_CHANNEL)).toBeNull();
    expect(sessionIDOf("bogus://x")).toBeNull();
  });
});

describe("changeset URI parsing and builders", () => {
  it("parses the three kinds (owner must be a valid session/chat URI)", () => {
    expect(parseChangesetChannel(uncommittedChangesetURI(chatChannelURI("s-1")))).toEqual({
      ownerUri: chatChannelURI("s-1"),
      sessionID: "s-1",
      kind: "uncommitted",
    });
    expect(parseChangesetChannel(sessionChangesetURI(sessionChannelURI("s-1")))).toEqual({
      ownerUri: sessionChannelURI("s-1"),
      sessionID: "s-1",
      kind: "session",
    });
    expect(parseChangesetChannel(turnChangesetURI(chatChannelURI("s-1"), "turn-7"))).toEqual({
      ownerUri: chatChannelURI("s-1"),
      sessionID: "s-1",
      kind: "turn",
      turnId: "turn-7",
    });
  });

  it("round-trips the builders", () => {
    expect(uncommittedChangesetURI(chatChannelURI("s-1"))).toBe("ahp-chat:/s-1/changeset/uncommitted");
    expect(sessionChangesetURI(sessionChannelURI("s-1"))).toBe("ahp-session:/s-1/changeset/session");
    expect(turnChangesetURI(chatChannelURI("s-1"), "turn-7")).toBe("ahp-chat:/s-1/changeset/turn/turn-7");
  });

  it("rejects malformed URIs", () => {
    // no marker / marker at the start / non-changeset URIs
    expect(parseChangesetChannel("ahp-session:/s-1")).toBeNull();
    expect(parseChangesetChannel("ahp-chat:/s-1/changeset")).toBeNull();
    expect(parseChangesetChannel("/changeset/uncommitted")).toBeNull();
    expect(parseChangesetChannel(ROOT_CHANNEL)).toBeNull();
    // unknown kind
    expect(parseChangesetChannel("ahp-chat:/s-1/changeset/staged")).toBeNull();
    // turn with empty or slashed id
    expect(parseChangesetChannel("ahp-chat:/s-1/changeset/turn/")).toBeNull();
    expect(parseChangesetChannel("ahp-chat:/s-1/changeset/turn/a/b")).toBeNull();
    // owner that is not a session/chat channel
    expect(parseChangesetChannel("bogus://x/changeset/session")).toBeNull();
    expect(parseChangesetChannel("ahp-root:///changeset/session")).toBeNull();
  });

  it("rejects owners that themselves contain the marker (no live session channel ever does)", () => {
    // lastIndexOf isolates the owner "ahp-session:/a/changeset/x", but the
    // marker-priority rule classifies that owner as a changeset URI, so it
    // is not a valid session/chat channel and the whole parse fails. Live
    // owners can never contain the marker (createSession rejects such
    // suffixes; opencode session ids never do).
    expect(parseChangesetChannel("ahp-session:/a/changeset/x/changeset/session")).toBeNull();
  });
});

describe("ChannelRegistry: subscribe", () => {
  it("subscribes the root channel without a session lookup", () => {
    const reg = new ChannelRegistry();
    expect(reg.subscribe(1, ROOT_CHANNEL)).toEqual({ ok: true });
    expect(reg.subscriptionsOf(1)).toEqual([ROOT_CHANNEL]);
  });

  it("rejects unknown URIs", () => {
    const reg = new ChannelRegistry();
    expect(reg.subscribe(1, "bogus://x")).toEqual({ ok: false, reason: "unknown-uri" });
    expect(reg.subscriptionsOf(1)).toEqual([]);
  });

  it("rejects session channels for sessions that do not exist", () => {
    const reg = new ChannelRegistry();
    expect(reg.subscribe(1, "ahp-session:/nope")).toEqual({ ok: false, reason: "no-such-session" });
    expect(reg.subscribe(1, "ahp-chat:/nope")).toEqual({ ok: false, reason: "no-such-session" });
  });

  it("accepts session channels once the session is live", () => {
    const reg = new ChannelRegistry();
    reg.addSession("s-1");
    expect(reg.subscribe(1, sessionChannelURI("s-1"))).toEqual({ ok: true });
    expect(reg.subscribe(1, chatChannelURI("s-1"))).toEqual({ ok: true });
    expect(reg.subscriptionsOf(1)).toEqual(["ahp-session:/s-1", "ahp-chat:/s-1"]);
  });

  it("subscribes changeset channels when the owner session is live", () => {
    const reg = new ChannelRegistry();
    reg.addSession("s-1");
    expect(reg.subscribe(1, uncommittedChangesetURI(chatChannelURI("s-1")))).toEqual({ ok: true });
    expect(reg.subscribe(1, sessionChangesetURI(sessionChannelURI("s-1")))).toEqual({ ok: true });
    expect(reg.subscribe(1, turnChangesetURI(chatChannelURI("s-1"), "turn-1"))).toEqual({ ok: true });
  });

  it("rejects changeset channels for dead sessions", () => {
    const reg = new ChannelRegistry();
    expect(reg.subscribe(1, uncommittedChangesetURI("ahp-chat:/nope"))).toEqual({ ok: false, reason: "no-such-session" });
    reg.addSession("s-1");
    reg.removeSession("s-1");
    expect(reg.subscribe(1, sessionChangesetURI(sessionChannelURI("s-1")))).toEqual({ ok: false, reason: "no-such-session" });
  });

  it("rejects unparseable changeset URIs as unknown", () => {
    const reg = new ChannelRegistry();
    reg.addSession("s-1");
    // marker present but the owner is not a session/chat channel
    expect(reg.subscribe(1, "bogus://x/changeset/session")).toEqual({ ok: false, reason: "unknown-uri" });
  });

  it("re-subscribing the same URI is idempotent", () => {
    const reg = new ChannelRegistry();
    reg.subscribe(1, ROOT_CHANNEL);
    reg.subscribe(1, ROOT_CHANNEL);
    expect(reg.subscriptionsOf(1)).toEqual([ROOT_CHANNEL]);
  });

  it("unsubscribe removes a single URI", () => {
    const reg = new ChannelRegistry();
    reg.addSession("s-1");
    reg.subscribe(1, ROOT_CHANNEL);
    reg.subscribe(1, sessionChannelURI("s-1"));
    reg.unsubscribe(1, ROOT_CHANNEL);
    expect(reg.subscriptionsOf(1)).toEqual(["ahp-session:/s-1"]);
    reg.unsubscribe(1, "never-subscribed"); // no-op
    expect(reg.subscriptionsOf(1)).toEqual(["ahp-session:/s-1"]);
  });
});

describe("ChannelRegistry: broadcast targets and sockets", () => {
  it("lists the sockets subscribed to a URI", () => {
    const reg = new ChannelRegistry();
    reg.subscribe(1, ROOT_CHANNEL);
    reg.addSession("s-1");
    reg.subscribe(2, sessionChannelURI("s-1"));
    reg.subscribe(3, sessionChannelURI("s-1"));
    expect([...reg.socketsSubscribedTo(ROOT_CHANNEL)]).toEqual([1]);
    expect([...reg.socketsSubscribedTo(sessionChannelURI("s-1"))].sort()).toEqual([2, 3]);
    expect(reg.socketsSubscribedTo("bogus://x")).toEqual([]);
  });

  it("removeSocket drops a socket's subscriptions", () => {
    const reg = new ChannelRegistry();
    reg.subscribe(1, ROOT_CHANNEL);
    reg.removeSocket(1);
    expect(reg.subscriptionsOf(1)).toEqual([]);
    expect(reg.socketsSubscribedTo(ROOT_CHANNEL)).toEqual([]);
  });
});

describe("ChannelRegistry: live sessions", () => {
  it("tracks session add/remove", () => {
    const reg = new ChannelRegistry();
    reg.addSession("s-1");
    expect(reg.hasSession("s-1")).toBe(true);
    reg.removeSession("s-1");
    expect(reg.hasSession("s-1")).toBe(false);
    reg.removeSession("never-added"); // no-op
  });

  it("removing a session revokes subscribability", () => {
    const reg = new ChannelRegistry();
    reg.addSession("s-1");
    reg.subscribe(1, sessionChannelURI("s-1"));
    reg.removeSession("s-1");
    expect(reg.subscribe(2, sessionChannelURI("s-1"))).toEqual({ ok: false, reason: "no-such-session" });
    // socket 1's existing subscription record stays (Phase 1 prunes on session events)
    expect(reg.subscriptionsOf(1)).toEqual([sessionChannelURI("s-1")]);
  });
});
