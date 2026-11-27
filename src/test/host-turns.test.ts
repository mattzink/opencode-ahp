/**
 * Host tests — the turn pump: the fixture-replayed turn lifecycle (streaming
 * text/reasoning, tool-call events, usage, turn terminals), permission round
 * trips, steering/queue delivery, and cancel + terminal events.
 */
import { describe, expect, it } from "vitest";
import { SessionStatus, ToolCallStatus, TurnState } from "@microsoft/agent-host-protocol";
import { sessionChannelURI, chatChannelURI } from "../channels.js";
import {
  loadFixtureEvents,
  waitFor,
  Harness,
  makeHarness,
  waitInit,
  createSession,
  subscribe,
  sessionSnapshotState,
  chatSnapshotState,
  waitForAction,
} from "./host-fakes.js";

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
          model: { id: "gpuz/qwen3.8-27b-q5xl", config: { reasoningEffort: "high" } },
          agent: { uri: "opencode:agent/build" },
        },
      },
    });
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt");
    expect(h.facade.switchModelCalls).toEqual([
      { sessionID: FIX_SES, model: { providerID: "gpuz", modelID: "qwen3.8-27b-q5xl", variant: "high" } },
    ]);
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
      inputTokens: 6535,
      outputTokens: 30,
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
    // The completed tool call inlines the result fields (AHP state).
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

  it("an idle subagent report starts a host-minted turn with a system-notification origin", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const ses = "ses_t4";
    await createSession(h, 1, sessionChannelURI(ses), { provider: "gpuz" });
    const chatURI = chatChannelURI(ses);
    await subscribe(h, 1, chatURI, 102);

    const report =
      '<subagent sessionID="ses_child" state="completed" description="Explore">\nresult text\n</subagent>';
    h.facade.push({
      type: "inbox.enqueued",
      sessionID: ses,
      inboxID: "m2",
      text: report,
      delivery: "steer",
      subagent: true,
    });
    h.facade.push({ type: "execution.started", sessionID: ses });
    const started = await waitForAction(h, chatURI, "chat/turnStarted");
    // The report text is carried verbatim (it is the turn's actual input),
    // but its origin is a system notification, not user input.
    expect(started.action.message.text).toBe(report);
    expect(started.action.message.origin).toEqual({ kind: "systemNotification" });

    // The turn finalizes normally (the model's response is not dropped).
    h.facade.push({ type: "execution.succeeded", sessionID: ses });
    await waitForAction(h, chatURI, "chat/turnComplete");
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

  it("summary status: InputNeeded while blocked, back to Idle after a denied, interrupted turn (no stuck Working…)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const { chatURI, TOOL } = await startTurnToPermission(h, 1);

    // The session summary (the session-list view) of this session.
    const summaryStatus = async (id: number): Promise<SessionStatus> => {
      h.send(1, "listSessions", {}, id);
      await waitFor(() => h.frames.some((f) => f.message.id === id && f.message.result !== undefined), `listSessions ${id}`);
      const item = (h.frames.find((f) => f.message.id === id)!.message.result as { items: Array<Record<string, any>> }).items.find(
        (s) => s.resource === sessionChannelURI(SES),
      );
      if (item === undefined) throw new Error("session not in listSessions");
      return item.status as SessionStatus;
    };

    // While the turn awaits the user's confirmation, the summary is
    // promoted to InputNeeded.
    expect(await summaryStatus(300)).toBe((SessionStatus.InputNeeded | SessionStatus.IsRead) as SessionStatus);

    // Deny (VS Code's "Skip" sends toolCallConfirmed approved:false) and let
    // opencode finish the interrupted execution.
    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 2,
      action: { type: "chat/toolCallConfirmed", turnId: "tP", toolCallId: TOOL, approved: false, reason: "user-declined" },
    });
    await waitFor(() => h.facade.permissionReplies.length === 1, "reply");
    h.facade.push({ type: "tool.failed", sessionID: SES, id: TOOL, error: { type: "cancelled", message: "denied" } });
    h.facade.push({ type: "execution.interrupted", sessionID: SES, reason: "shutdown" });
    await waitForAction(h, chatURI, "chat/turnCancelled");

    // The session store's own status still carries the reducer's
    // InProgress residue (draining the input queue only clears bit 16)…
    const store = await sessionSnapshotState(h, 1, sessionChannelURI(SES), 310);
    expect(store.status & SessionStatus.InProgress).toBe(SessionStatus.InProgress);
    // …but the summary aggregates from the chat, which is idle again —
    // the session list must no longer show "Working…".
    expect(await summaryStatus(311)).toBe((SessionStatus.Idle | SessionStatus.IsRead) as SessionStatus);
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

// ── truncation ────────────────────────────────────────────────────────────
// `chat/truncated` is state-only: the official reducer trims the stored
// turns and drops the active turn (status → idle). opencode's message
// history is untouched (no counterpart on the plugin surface) and an
// in-flight execution is not interrupted — its late events land on a
// store that no longer carries the turn (reducer no-ops).

describe("truncation", () => {
  const SES = "ses_trunc";
  const dispatchTurn = (h: Harness, chatURI: string, seq: number, turnId: string, text: string) =>
    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: seq,
      action: { type: "chat/turnStarted", turnId, startedAt: new Date().toISOString(), message: { text, origin: { kind: "user" } } },
    });
  /** Dispatch turnStarted and drive it to completion (one prompt + one succeeded event). */
  async function completeTurn(h: Harness, chatURI: string, seq: number, turnId: string, text: string): Promise<void> {
    dispatchTurn(h, chatURI, seq, turnId, text);
    await waitFor(() => h.facade.promptCalls.length === seq, `prompt ${turnId}`);
    h.facade.push({ type: "execution.succeeded", sessionID: SES });
    await waitForAction(h, chatURI, "chat/turnComplete", (a) => a.action.turnId === turnId);
  }

  it("keeps turns up to and including the named turn", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const chatURI = chatChannelURI(SES);
    await subscribe(h, 1, chatURI, 101);
    await completeTurn(h, chatURI, 1, "t1", "first");
    await completeTurn(h, chatURI, 2, "t2", "second");
    let chat = await chatSnapshotState(h, 1, chatURI, 110);
    expect(chat.turns.map((t) => t.id)).toEqual(["t1", "t2"]);

    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 3,
      action: { type: "chat/truncated", turnId: "t1" },
    });
    const echo = await waitForAction(h, chatURI, "chat/truncated");
    expect(echo.rejectionReason).toBeUndefined();
    chat = await chatSnapshotState(h, 1, chatURI, 111);
    expect(chat.turns.map((t) => t.id)).toEqual(["t1"]);
    expect(chat.activeTurn).toBeUndefined();
    expect(chat.status & (SessionStatus.InProgress | SessionStatus.InputNeeded)).toBe(0);
    h.stop();
  });

  it("clears all turns when turnId is omitted", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const chatURI = chatChannelURI(SES);
    await subscribe(h, 1, chatURI, 101);
    await completeTurn(h, chatURI, 1, "t1", "first");

    h.send(1, "dispatchAction", { channel: chatURI, clientSeq: 2, action: { type: "chat/truncated" } });
    const echo = await waitForAction(h, chatURI, "chat/truncated");
    expect(echo.rejectionReason).toBeUndefined();
    const chat = await chatSnapshotState(h, 1, chatURI, 112);
    expect(chat.turns).toHaveLength(0);
    expect(chat.activeTurn).toBeUndefined();
    expect(chat.status & (SessionStatus.InProgress | SessionStatus.InputNeeded)).toBe(0);
    h.stop();
  });

  it("drops an active turn (status → idle) without interrupting opencode", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const chatURI = chatChannelURI(SES);
    await subscribe(h, 1, chatURI, 101);
    dispatchTurn(h, chatURI, 1, "t1", "go");
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt");
    let chat = await chatSnapshotState(h, 1, chatURI, 113);
    expect(chat.activeTurn!.id).toBe("t1");

    h.send(1, "dispatchAction", { channel: chatURI, clientSeq: 2, action: { type: "chat/truncated" } });
    const echo = await waitForAction(h, chatURI, "chat/truncated");
    expect(echo.rejectionReason).toBeUndefined();
    chat = await chatSnapshotState(h, 1, chatURI, 114);
    expect(chat.turns).toHaveLength(0);
    expect(chat.activeTurn).toBeUndefined();
    expect(chat.status & (SessionStatus.InProgress | SessionStatus.InputNeeded)).toBe(0);
    expect(h.facade.interruptCalls).toHaveLength(0); // state-only: no interrupt

    // The in-flight execution ends on the opencode side; its terminal
    // event finds a store without the turn (reducer no-op) and the
    // handoff runs against the post-truncation state.
    h.facade.push({ type: "execution.succeeded", sessionID: SES });
    await new Promise((r) => setTimeout(r, 30));
    chat = await chatSnapshotState(h, 1, chatURI, 115);
    expect(chat.turns).toHaveLength(0);
    expect(chat.activeTurn).toBeUndefined();
    h.stop();
  });

  it("supports the documented use case: truncate, then turnStarted with the edited message", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const chatURI = chatChannelURI(SES);
    await subscribe(h, 1, chatURI, 101);
    await completeTurn(h, chatURI, 1, "t1", "first");
    await completeTurn(h, chatURI, 2, "t2", "second (to edit)");

    // Truncate to t1, then resend the edited second message.
    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 3,
      action: { type: "chat/truncated", turnId: "t1" },
    });
    const echo = await waitForAction(h, chatURI, "chat/truncated");
    expect(echo.rejectionReason).toBeUndefined();
    dispatchTurn(h, chatURI, 4, "t3", "second (edited)");
    await waitFor(() => h.facade.promptCalls.length === 3, "prompt t3");
    expect(h.facade.promptCalls[2]).toEqual({ sessionID: SES, text: "second (edited)" });
    h.facade.push({ type: "execution.succeeded", sessionID: SES });
    await waitForAction(h, chatURI, "chat/turnComplete", (a) => a.action.turnId === "t3");
    const chat = await chatSnapshotState(h, 1, chatURI, 116);
    expect(chat.turns.map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(chat.activeTurn).toBeUndefined();
    h.stop();
  });

  it("accepts an unknown turnId (official reducer no-op, state unchanged)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const chatURI = chatChannelURI(SES);
    await subscribe(h, 1, chatURI, 101);
    await completeTurn(h, chatURI, 1, "t1", "first");

    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 2,
      action: { type: "chat/truncated", turnId: "ghost" },
    });
    const echo = await waitForAction(h, chatURI, "chat/truncated");
    expect(echo.rejectionReason).toBeUndefined();
    const chat = await chatSnapshotState(h, 1, chatURI, 117);
    expect(chat.turns.map((t) => t.id)).toEqual(["t1"]);
    h.stop();
  });

  it("rejects an invalid turnId shape (non-string and empty)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const chatURI = chatChannelURI(SES);
    await subscribe(h, 1, chatURI, 101);
    h.send(1, "dispatchAction", { channel: chatURI, clientSeq: 1, action: { type: "chat/truncated", turnId: 42 } });
    const rejected = await waitForAction(h, chatURI, "chat/truncated", (a) => a.rejectionReason !== undefined && a.origin?.clientSeq === 1);
    expect(rejected.rejectionReason).toMatch(/invalid chat\/truncated params/);
    h.send(1, "dispatchAction", { channel: chatURI, clientSeq: 2, action: { type: "chat/truncated", turnId: "" } });
    const rejected2 = await waitForAction(h, chatURI, "chat/truncated", (a) => a.rejectionReason !== undefined && a.origin?.clientSeq === 2);
    expect(rejected2.rejectionReason).toMatch(/non-empty string/);
    h.stop();
  });

  it("rejects a chat action on a session channel", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const sessURI = sessionChannelURI(SES);
    await subscribe(h, 1, sessURI, 101);
    h.send(1, "dispatchAction", { channel: sessURI, clientSeq: 1, action: { type: "chat/truncated" } });
    const rejected = await waitForAction(h, sessURI, "chat/truncated", (a) => a.rejectionReason !== undefined);
    expect(rejected.rejectionReason).toMatch(/chat actions require a chat channel/);
    h.stop();
  });
});
