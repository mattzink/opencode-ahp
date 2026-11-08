import { describe, expect, it } from "vitest";
import {
  ChannelRegistry,
  ROOT_CHANNEL,
  channelKind,
  chatChannelURI,
  sessionChannelURI,
  sessionIDOf,
} from "../channels.js";

describe("channelKind", () => {
  it("classifies URIs", () => {
    expect(channelKind("ahp-root://")).toBe("root");
    expect(channelKind("ahp-session:/s-1")).toBe("session");
    expect(channelKind("ahp-chat:/s-1")).toBe("chat");
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
