/**
 * Host tests — changesets: the catalogues (session + chat), subscribe and
 * refresh, turn before-capture (including the cross-location cases: the
 * session's own directory diffed, relative tool paths resolved against it),
 * `invokeChangesetOperation`, `filesReviewChanged`, and teardown +
 * capability gating.
 */
import { describe, expect, it } from "vitest";
import {
  DISCARD_OPERATION_ID,
  directoryUri,
  fileUri,
  headContentRef,
  snapContentRef,
} from "../bridge.js";
import {
  sessionChannelURI,
  chatChannelURI,
  sessionChangesetURI,
  turnChangesetURI,
  uncommittedChangesetURI,
} from "../channels.js";
import { ERROR_INVALID_PARAMS } from "../handshake.js";
import {
  waitFor,
  Harness,
  makeHarness,
  waitInit,
  createSession,
  subscribe,
  sessionSnapshotState,
  chatSnapshotState,
  DIR,
  OTHER,
  startTurn,
  resourceRead,
  invokeOp,
  changesetSnapshot,
  waitForAction,
} from "./host-fakes.js";

describe("changeset catalogues", () => {
  const SES = "ses_cat";

  it("createSession seeds the session catalogue (1 entry) and the chat catalogue (3 entries)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });

    const session = await sessionSnapshotState(h, 1, sessionChannelURI(SES), 300);
    expect(session.changesets?.map((c) => [c.label, c.uriTemplate, c.changeKind])).toEqual([
      ["Session Changes", sessionChangesetURI(sessionChannelURI(SES)), "session"],
    ]);

    const chat = await chatSnapshotState(h, 1, chatChannelURI(SES), 301);
    expect(chat.changesets?.map((c) => [c.label, c.uriTemplate, c.changeKind])).toEqual([
      ["Uncommitted Changes", uncommittedChangesetURI(chatChannelURI(SES)), "uncommitted"],
      ["Session Changes", sessionChangesetURI(sessionChannelURI(SES)), "session"],
      ["Turn Changes", turnChangesetURI(chatChannelURI(SES), "{turnId}"), "turn"],
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
    const uri = uncommittedChangesetURI(chatChannelURI(SES));
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
    const state = await changesetSnapshot(h, uncommittedChangesetURI(chatChannelURI(SES)), 311);
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
    const uri = sessionChangesetURI(sessionChannelURI(SES));
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
    const res = await subscribe(h, 1, uncommittedChangesetURI("ahp-chat:/nope"), 314);
    expect(res.error?.code).toBe(-32001);
    h.stop();
  });

  it("subscribe for a cross-location session diffs the session's own directory", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI("ses_wdsub"), {
      provider: "gpuz",
      workingDirectories: [directoryUri(OTHER)],
    }, 315);
    const uri = uncommittedChangesetURI(chatChannelURI("ses_wdsub"));
    const file = `${OTHER}/mod.txt`;
    h.facade.diffFiles = [{ path: file, additions: 2, deletions: 1, status: "modified" }];
    h.facade.head.set(file, "a\nOLD\n");

    const state = await changesetSnapshot(h, uri, 316);
    expect(state!.status).toBe("ready");
    expect(state!.files).toEqual([
      {
        id: fileUri(file),
        edit: {
          before: { uri: fileUri(file), content: { uri: headContentRef(file) } },
          after: { uri: fileUri(file), content: { uri: fileUri(file) } },
          diff: { added: 2, removed: 1 },
        },
      },
    ]);
    // The diff was computed for the session's own directory, not the
    // location's (the facade's last call carries it).
    expect(h.facade.diffCalls[h.facade.diffCalls.length - 1]).toBe(OTHER);
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
      type: "step.ended",
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

    const uri = turnChangesetURI(chatChannelURI(SES), "t1");
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
    const uncommittedURI = uncommittedChangesetURI(chatChannelURI(SES));
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
    await changesetSnapshot(h, turnChangesetURI(chatChannelURI(SES), "t1"), 323);

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
    const uri = turnChangesetURI(chatChannelURI(SES), "t1");
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
        type: "step.ended",
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
    const state = await changesetSnapshot(h, turnChangesetURI(chatChannelURI(SES), "t1"), 332);
    expect(state!.files).toEqual([]);
    h.stop();
  });

  it("resolves a relative tool path against the session's own directory (cross-location)", async () => {
    const WD_SES = "ses_wdturn";
    const WD_TARGET = `${OTHER}/target.txt`;
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(WD_SES), {
      provider: "gpuz",
      workingDirectories: [directoryUri(OTHER)],
    }, 333);
    const chatURI = chatChannelURI(WD_SES);
    await subscribe(h, 1, chatURI, 334);
    h.facade.disk.set(WD_TARGET, BEFORE);
    startTurn(h, chatURI, "t1");
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt");
    // The relative path resolves against the session's own directory,
    // not the location's.
    h.facade.push({ type: "tool.input.started", sessionID: WD_SES, assistantMessageID: "m1", id: "tc1", name: "write" });
    h.facade.push({
      type: "tool.input.ended",
      sessionID: WD_SES,
      assistantMessageID: "m1",
      id: "tc1",
      text: JSON.stringify({ path: "target.txt", content: AFTER }),
    });
    h.facade.push({
      type: "step.ended",
      sessionID: WD_SES,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    await waitForAction(h, chatURI, "chat/usage");
    h.facade.disk.set(WD_TARGET, AFTER);
    h.facade.push({ type: "execution.succeeded", sessionID: WD_SES });
    await waitForAction(h, chatURI, "chat/turnComplete");

    const state = await changesetSnapshot(h, turnChangesetURI(chatURI, "t1"), 335);
    expect(state!.status).toBe("ready");
    expect(state!.files).toHaveLength(1);
    expect(state!.files[0].id).toBe(fileUri(WD_TARGET));
    // The snapshot refs carry the foreign absolute path.
    const before = await resourceRead(h, { uri: snapContentRef(WD_SES, "t1", WD_TARGET, "before"), encoding: "utf-8" }, 336);
    expect(before.result.data).toBe(BEFORE);
    h.stop();
  });
});

describe("invokeChangesetOperation", () => {
  const SES = "ses_op";
  const FILE = `${DIR}/mod.txt`;
  const URI = () => uncommittedChangesetURI(chatChannelURI(SES));

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
    // A location session passes no session directory (the facade defaults
    // to the plugin's own location).
    expect(h.facade.discardCalls).toEqual([{ path: FILE, directory: undefined }]);
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
    const uri = uncommittedChangesetURI(chatChannelURI(SES));
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
    const uri = sessionChangesetURI(sessionChannelURI(SES)); // never subscribed → no store
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
    const uri = uncommittedChangesetURI(chatChannelURI(SES));
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
    const res = await subscribe(h, 1, uncommittedChangesetURI(chatChannelURI(SES)), 374);
    expect(res.result).toEqual({});

    const read = await resourceRead(h, { uri: headContentRef(`${DIR}/x.txt`), encoding: "utf-8" }, 375);
    expect(read.error?.code).toBe(-32008);

    const op = await invokeOp(
      h,
      {
        channel: uncommittedChangesetURI(chatChannelURI(SES)),
        operationId: DISCARD_OPERATION_ID,
        target: { kind: "resource", resource: fileUri(`${DIR}/x.txt`) },
      },
      376,
    );
    expect(op.error?.code).toBe(-32001);
    h.stop();
  });
});
