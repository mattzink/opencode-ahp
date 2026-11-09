#!/usr/bin/env node
/**
 * opencode-ahp Phase 2 live verification (plan §11, §9.4 items 12 + 7).
 *
 * E2E item 12 — changesets:
 *   1. initialize (root subscription)
 *   2. createSession (provider selection)
 *   3. subscribe session + chat → assert the changeset catalogues
 *      (session: 1 entry; chat: uncommitted + session + turn template)
 *   4. subscribe the uncommitted changeset (initial state)
 *   5. dispatchAction chat/turnStarted with a prompt that edits
 *      notes.txt → observe turnComplete
 *   6. the turn-end refresh must surface notes.txt in the uncommitted
 *      changeset (contentChanged); subscribe the turn changeset → snap
 *      content refs
 *   7. resourceRead: file:// (live disk), ahp-content://head (git HEAD),
 *      ahp-content://snap before/after (the pre-edit capture); error
 *      cases (-32009 outside location, -32008 bad refs)
 *   8. changeset/filesReviewChanged toggle → echo accepted
 *   9. invokeChangesetOperation discard-changes → operationStatusChanged
 *      running→idle, the file restored from HEAD (verified on disk —
 *      the location directory is local to this machine), changeset
 *      refreshed to empty; the turn changeset keeps its record
 *
 * E2E item 7 — reconnect:
 *  10. start a second turn, drop the link right after the turnStarted
 *      echo (mid-turn), reconnect with the same clientId +
 *      lastSeenServerSeq → replay (or snapshot) with no duplicate turn
 *
 * The location directory must be a git repository with notes.txt
 * committed at "line1\nline2\n".
 *
 * Dependency-free: Node ≥ 22 global WebSocket.
 *
 * Usage:
 *   node scripts/ahp-phase2.mjs --token <token> \
 *     [--base http://127.0.0.1:8767] [--path /ahp] \
 *     [--channel ahp-session:/lan-phase2] [--provider opencode] \
 *     [--location-dir /tmp/opencode/ahp-scratch/project-lan] \
 *     [--timeout-ms 120000]
 *
 * Exit codes: 0 success · 1 protocol/verification failure · 2 connection
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const TAG = "[ahp-phase2]";
const fail = (code, msg) => {
  console.error(`${TAG} FAIL: ${msg}`);
  process.exit(code);
};

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};

const opts = {
  base: (arg("--base", "http://127.0.0.1:8767") ?? "").replace(/\/$/, ""),
  path: arg("--path", "/ahp"),
  token: arg("--token", null),
  channel: arg("--channel", "ahp-session:/lan-phase2"),
  provider: arg("--provider", "opencode"),
  locationDir: arg("--location-dir", "/tmp/opencode/ahp-scratch/project-lan"),
  timeoutMs: Number(arg("--timeout-ms", "120000")),
};
if (!opts.token) fail(2, "--token is required");

const FILE = join(opts.locationDir, "notes.txt");
const FILE_BEFORE = "line1\nline2\n";
const b64 = (s) => Buffer.from(s, "utf-8").toString("base64");
const b64url = (s) =>
  Buffer.from(s, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const headRef = `ahp-content://head/${b64url(FILE)}`;
const fileRef = `file://${FILE}`;
const sessionURI = opts.channel;
// The changeset URIs are read from the catalogues (a faithful client
// follows the server's uriTemplates — the owner suffix is the opencode
// session id, which differs from a client-chosen session suffix).
let uncommittedURI = null;
let turnTemplate = null;

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${TAG} ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── AHP session (reconnectable) ───────────────────────────────────────────

let ws = null;
let nextId = 1;
const pending = new Map();
const actionsByChannel = new Map(); // channel -> ActionEnvelope[]
const rootNotifications = [];
let lastSeenSeq = -1;
const clientId = "phase2-" + randomBytes(4).toString("hex");

/** The (not yet started) turn-2 id; set before it is dispatched. */
let TURN_ID_2 = null;
/** seq of the turn-2 turnStarted echo (set by dispatchFrame). */
let turn2StartSeq = -1;
/** serverSeqs of every action envelope already merged (live or replay). */
const seenSeqs = new Set();

function dispatchFrame(msg) {
  const id = msg.id;
  if (id !== undefined && pending.has(id)) {
    const p = pending.get(id);
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(msg);
    return;
  }
  if (msg.method === "action") {
    const ch = msg.params?.channel;
    if (!actionsByChannel.has(ch)) actionsByChannel.set(ch, []);
    actionsByChannel.get(ch).push(msg.params);
    if (typeof msg.params?.serverSeq === "number" && msg.params.serverSeq > lastSeenSeq)
      lastSeenSeq = msg.params.serverSeq;
    const a = msg.params?.action;
    if (typeof msg.params?.serverSeq === "number") seenSeqs.add(msg.params.serverSeq);
    if (a?.type === "chat/turnStarted" && a.turnId === TURN_ID_2) turn2StartSeq = msg.params.serverSeq;
    console.log(
      `${TAG}   action ${ch} seq=${msg.params?.serverSeq} ${a?.type}${a?.turnId ? ` (${a.turnId})` : ""}${msg.params?.rejectionReason ? ` REJECTED: ${msg.params.rejectionReason}` : ""}`,
    );
    return;
  }
  rootNotifications.push(msg);
  console.log(`${TAG}   notification ${msg.method}: ${JSON.stringify(msg.params ?? null).slice(0, 200)}`);
}

function connect() {
  const wsUrl =
    opts.base.replace(/^http/, "ws") +
    opts.path +
    "?token=" +
    encodeURIComponent(opts.token);
  ws = new WebSocket(wsUrl);
  ws.addEventListener("message", (ev) => {
    let text;
    const data = ev.data;
    if (typeof data === "string") text = data;
    else text = new TextDecoder().decode(data instanceof ArrayBuffer ? data : Buffer.from(data));
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      console.error(`${TAG} non-JSON frame: ${text.slice(0, 200)}`);
      return;
    }
    dispatchFrame(msg);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket open timeout")), opts.timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`websocket error: ${e?.message ?? "unknown"}`));
    });
    ws.addEventListener("close", (e) => {
      clearTimeout(timer);
      reject(new Error(`websocket closed (code ${e.code})`));
    });
  });
}

const request = (method, params) => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for "${method}" response`));
    }, opts.timeoutMs);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
};

const waitFor = async (cond, label, timeoutMs = opts.timeoutMs) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** Dispatch a chat/turnStarted and return the (client-minted) turnId. */
let clientSeq = 0;
function startTurn(chatChannel, turnId, text) {
  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "dispatchAction",
      params: {
        channel: chatChannel,
        clientSeq: ++clientSeq,
        action: {
          type: "chat/turnStarted",
          turnId,
          startedAt: new Date().toISOString(),
          message: { text, origin: { kind: "user" } },
        },
      },
    }),
  );
  return turnId;
}

try {
  // ── Phase A: catalogues ────────────────────────────────────────────────
  await connect();
  console.log(`${TAG} connected (clientId ${clientId})`);

  const init = await request("initialize", {
    channel: "ahp-root://",
    clientId,
    protocolVersions: ["1.0.0"],
    initialSubscriptions: ["ahp-root://"],
  });
  if (init.error) fail(1, `initialize: ${JSON.stringify(init.error)}`);
  check("initialize", init.result?.protocolVersion === "1.0.0", `v${init.result?.protocolVersion}`);
  lastSeenSeq = Math.max(lastSeenSeq, init.result?.serverSeq ?? -1);

  const create = await request("createSession", { channel: opts.channel, provider: opts.provider });
  if (create.error) fail(1, `createSession: ${JSON.stringify(create.error)}`);
  check("createSession", create.result === null, `channel ${opts.channel} provider ${opts.provider}`);

  const sessSub = await request("subscribe", { channel: sessionURI });
  if (sessSub.error) fail(1, `subscribe session: ${JSON.stringify(sessSub.error)}`);
  const sessCatalog = sessSub.result?.snapshot?.state?.changesets ?? [];
  check(
    "session snapshot carries the 1-entry changeset catalogue",
    sessCatalog.length === 1 && sessCatalog[0]?.changeKind === "session" && sessCatalog[0]?.label === "Session Changes",
    JSON.stringify(sessCatalog.map((c) => [c.label, c.changeKind])),
  );
  for (const c of sessCatalog) check(`capability review (${c.label})`, JSON.stringify(c.capabilities) === JSON.stringify({ review: {} }));

  const chatURI = sessSub.result?.snapshot?.state?.defaultChat;
  const chatSub = await request("subscribe", { channel: chatURI });
  if (chatSub.error) fail(1, `subscribe chat: ${JSON.stringify(chatSub.error)}`);
  const chatCatalog = chatSub.result?.snapshot?.state?.changesets ?? [];
  check(
    "chat snapshot carries the 3-entry changeset catalogue",
    JSON.stringify(chatCatalog.map((c) => c.changeKind)) === JSON.stringify(["uncommitted", "session", "turn"]),
    JSON.stringify(chatCatalog.map((c) => [c.label, c.uriTemplate, c.changeKind])),
  );
  uncommittedURI = chatCatalog.find((c) => c.changeKind === "uncommitted")?.uriTemplate;
  turnTemplate = chatCatalog.find((c) => c.changeKind === "turn")?.uriTemplate;
  if (uncommittedURI === undefined || turnTemplate === undefined) fail(1, "catalogue missing uncommitted/turn entries");

  // ── Phase B: the editing turn ──────────────────────────────────────────
  const unsubSub = await request("subscribe", { channel: uncommittedURI });
  if (unsubSub.error) fail(1, `subscribe uncommitted: ${JSON.stringify(unsubSub.error)}`);
  const initialState = unsubSub.result?.snapshot?.state;
  check(
    "uncommitted changeset starts ready",
    initialState?.status === "ready",
    `status=${initialState?.status} files=${initialState?.files?.length ?? "?"} error=${JSON.stringify(initialState?.error ?? null)}`,
  );

  const turnId = "turn-live2-" + Date.now().toString(36);
  startTurn(
    chatURI,
    turnId,
    `Use the write tool to overwrite the file notes.txt (in the project root) with exactly this content:\nline1\nline2\nline3\nDo not create or modify any other file, and do not reply with anything but a short confirmation.`,
  );
  console.log(`${TAG} dispatched chat/turnStarted ${turnId} (file-editing prompt)`);

  await waitFor(
    () => (actionsByChannel.get(chatURI) ?? []).some((a) => a.action?.type === "chat/turnStarted" && !a.rejectionReason),
    "turnStarted echo",
  );
  await waitFor(
    () => (actionsByChannel.get(chatURI) ?? []).some((a) => a.action?.type === "chat/turnComplete" || a.action?.type === "chat/turnError"),
    "turn end",
  );
  const endAction = (actionsByChannel.get(chatURI) ?? []).find((a) => a.action?.type === "chat/turnComplete" || a.action?.type === "chat/turnError");
  check("turn completed", endAction?.action?.type === "chat/turnComplete", endAction?.action?.type);

  // The disk really changed (the model used a file tool). The exact
  // content is the model's business (trailing-newline habits vary); the
  // point is that it differs from the committed baseline.
  const diskAfterTurn = readFileSync(FILE, "utf-8");
  check("notes.txt was edited on disk", diskAfterTurn !== FILE_BEFORE, JSON.stringify(diskAfterTurn));

  // Turn-end refresh of the (subscribed) uncommitted changeset.
  await waitFor(
    () =>
      (actionsByChannel.get(uncommittedURI) ?? []).some(
        (a) => a.action?.type === "changeset/contentChanged" && (a.action.files ?? []).some((f) => f.id === fileRef),
      ),
    "uncommitted contentChanged with notes.txt",
  );
  const ccAction = (actionsByChannel.get(uncommittedURI) ?? []).find(
    (a) => a.action?.type === "changeset/contentChanged" && (a.action.files ?? []).some((f) => f.id === fileRef),
  );
  const ccFile = ccAction.action.files.find((f) => f.id === fileRef);
  check(
    "uncommitted diff entry has live after + HEAD before",
    ccFile?.edit?.after?.content?.uri === fileRef && ccFile?.edit?.before?.content?.uri === headRef,
    JSON.stringify({ after: ccFile?.edit?.after, before: ccFile?.edit?.before }),
  );
  check(
    "contentChanged attaches the discard operation",
    (ccAction.action.operations ?? []).some((o) => o?.id === "discard-changes"),
    JSON.stringify((ccAction.action.operations ?? []).map((o) => o.id)),
  );

  // Subscribe the turn changeset → snap content refs (template from the
  // catalogue, {turnId} substituted).
  const turnURI = turnTemplate.replace("{turnId}", turnId);
  const turnSub = await request("subscribe", { channel: turnURI });
  if (turnSub.error) fail(1, `subscribe turn changeset: ${JSON.stringify(turnSub.error)}`);
  const turnState = turnSub.result?.snapshot?.state;
  const turnFile = turnState?.files?.find((f) => f.id === fileRef);
  check(
    "turn changeset shows notes.txt with snap refs",
    turnState?.status === "ready" && turnFile !== undefined,
    `status=${turnState?.status} files=${turnState?.files?.length ?? "?"}`,
  );
  check(
    "turn before/after are opaque snap refs",
    /^ahp-content:\/\/snap\//.test(turnFile?.edit?.before?.content?.uri ?? "") &&
      /^ahp-content:\/\/snap\//.test(turnFile?.edit?.after?.content?.uri ?? ""),
    JSON.stringify({ b: turnFile?.edit?.before?.content?.uri, a: turnFile?.edit?.after?.content?.uri }),
  );

  // ── Phase C: resourceRead + review + discard ───────────────────────────
  const rr = (uri, encoding) => request("resourceRead", encoding ? { uri, encoding } : { uri });

  const live = await rr(fileRef, "utf-8");
  check(
    "resourceRead file:// serves the live disk",
    live.result?.data === diskAfterTurn && live.result?.encoding === "utf-8",
    JSON.stringify(live.result ?? live.error),
  );
  const liveB64 = await rr(fileRef);
  check(
    "resourceRead file:// defaults to base64",
    liveB64.result?.data === b64(diskAfterTurn) && liveB64.result?.encoding === "base64",
    liveB64.result?.encoding,
  );
  const head = await rr(headRef, "utf-8");
  check(
    "resourceRead ahp-content://head serves git HEAD",
    head.result?.data === FILE_BEFORE,
    JSON.stringify(head.result ?? head.error),
  );

  // Snap refs: extract the session id from the turn ref segments (the
  // probe minted no session id; the host did — decode from the ref itself
  // is opaque, so read the before/after via the turn state's own refs).
  const beforeRef = turnFile?.edit?.before?.content?.uri;
  const afterRef = turnFile?.edit?.after?.content?.uri;
  const before = await rr(beforeRef, "utf-8");
  const after = await rr(afterRef, "utf-8");
  check(
    "resourceRead snap before = pre-edit content",
    before.result?.data === FILE_BEFORE,
    JSON.stringify(before.result ?? before.error),
  );
  check(
    "resourceRead snap after = post-edit content",
    after.result?.data === diskAfterTurn,
    JSON.stringify(after.result ?? after.error),
  );
  const outside = await rr("file:///etc/passwd");
  check("resourceRead rejects outside the location (-32009)", outside.error?.code === -32009, JSON.stringify(outside.error ?? null));
  const junk = await rr("ahp-content://head/not@base64url", "utf-8");
  check("resourceRead rejects malformed refs (-32008)", junk.error?.code === -32008, JSON.stringify(junk.error ?? null));

  // Review toggle (client-dispatchable) → accepted echo.
  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "dispatchAction",
      params: {
        channel: uncommittedURI,
        clientSeq: ++clientSeq,
        action: { type: "changeset/filesReviewChanged", files: [fileRef], reviewed: true },
      },
    }),
  );
  await waitFor(
    () => (actionsByChannel.get(uncommittedURI) ?? []).some((a) => a.action?.type === "changeset/filesReviewChanged"),
    "filesReviewChanged echo",
  );
  const revEcho = (actionsByChannel.get(uncommittedURI) ?? []).find((a) => a.action?.type === "changeset/filesReviewChanged");
  check(
    "filesReviewChanged echoed without rejection",
    revEcho.rejectionReason === undefined,
    String(revEcho.rejectionReason),
  );

  // Discard (invokeChangesetOperation) → running → idle, file restored.
  const discard = await request("invokeChangesetOperation", {
    channel: uncommittedURI,
    operationId: "discard-changes",
    target: { kind: "resource", resource: fileRef },
  });
  check(
    "invokeChangesetOperation discard succeeds",
    discard.error === undefined && typeof discard.result?.message === "string",
    JSON.stringify(discard.result ?? discard.error),
  );
  await waitFor(
    () =>
      (actionsByChannel.get(uncommittedURI) ?? []).some(
        (a) => a.action?.type === "changeset/operationStatusChanged" && a.action.operationId === "discard-changes" && a.action.status === "idle",
      ),
    "operationStatusChanged idle",
  );
  const statuses = (actionsByChannel.get(uncommittedURI) ?? [])
    .filter((a) => a.action?.type === "changeset/operationStatusChanged" && a.action.operationId === "discard-changes")
    .map((a) => a.action.status);
  check("discard ran running → idle", statuses.includes("running") && statuses[statuses.length - 1] === "idle", statuses.join(","));
  await waitFor(
    () =>
      (actionsByChannel.get(uncommittedURI) ?? []).filter((a) => a.action?.type === "changeset/contentChanged").at(-1)?.action.files
        ?.length === 0,
    "uncommitted changeset empty after discard",
  );
  const diskAfterDiscard = readFileSync(FILE, "utf-8");
  check("notes.txt restored to HEAD on disk", diskAfterDiscard === FILE_BEFORE, JSON.stringify(diskAfterDiscard));
  check("resourceRead file:// now serves the restored content", (await rr(fileRef, "utf-8")).result?.data === FILE_BEFORE);

  // The turn changeset is the turn's record: it keeps showing the change.
  const turnResub = await request("subscribe", { channel: turnURI });
  check(
    "turn changeset keeps its record after discard",
    (turnResub.result?.snapshot?.state?.files ?? []).length === 1,
    `files=${turnResub.result?.snapshot?.state?.files?.length}`,
  );

  // ── Phase D: reconnect (E2E item 7) ────────────────────────────────────
  // The reconnect boundary is the turn-2 turnStarted echo's seq: by the
  // time we drop the link, at least one further turn-2 action has been
  // published, so the replay is guaranteed to carry something (the rest,
  // if any, arrives live). An empty replay would only be correct if
  // nothing were ever published after the boundary.
  const turnId2 = "turn-live2b-" + Date.now().toString(36);
  TURN_ID_2 = turnId2;
  startTurn(chatURI, turnId2, "Reply with exactly: ok");
  await waitFor(
    () => (actionsByChannel.get(chatURI) ?? []).some((a) => a.action?.type === "chat/turnStarted" && !a.rejectionReason && a.action.turnId === turnId2),
    "turn 2 turnStarted echo",
  );
  await waitFor(
    () => (actionsByChannel.get(chatURI) ?? []).some((a) => a.action?.turnId === turnId2 && a.action?.type !== "chat/turnStarted"),
    "a turn-2 progress action",
  );
  console.log(`${TAG} dropping the link mid-turn (boundary seq ${turn2StartSeq})`);
  ws.close(1000);
  await new Promise((r) => setTimeout(r, 300));

  await connect();
  console.log(`${TAG} reconnected`);
  const re = await request("reconnect", {
    channel: "ahp-root://",
    clientId,
    lastSeenServerSeq: turn2StartSeq,
    subscriptions: [sessionURI, chatURI, uncommittedURI, turnURI],
  });
  if (re.error) fail(1, `reconnect: ${JSON.stringify(re.error)}`);
  const reType = re.result?.type;
  check("reconnect returns replay or snapshot", reType === "replay" || reType === "snapshot", `type=${reType}`);
  if (reType === "replay") {
    // Merge the replayed envelopes into the accumulator (de-duped by
    // serverSeq) exactly as a real client would apply them to state — the
    // turn-2 turnComplete may have been delivered here, not live.
    for (const env of re.result?.actions ?? []) {
      if (seenSeqs.has(env.serverSeq)) continue;
      seenSeqs.add(env.serverSeq);
      if (!actionsByChannel.has(env.channel)) actionsByChannel.set(env.channel, []);
      actionsByChannel.get(env.channel).push(env);
      console.log(`${TAG}   replay ${env.channel} seq=${env.serverSeq} ${env.action?.type}${env.action?.turnId ? ` (${env.action.turnId})` : ""}`);
    }
    const replayed = (re.result?.actions ?? []).map((a) => a.action?.type);
    check(
      "replay carries the turn-2 actions published since the boundary",
      (re.result?.actions ?? []).some((a) => a.action?.turnId === turnId2),
      `[${[...new Set(replayed)].join(", ")}]`,
    );
  }

  // The in-flight turn must complete exactly once (no duplicate turn).
  await waitFor(
    () =>
      (actionsByChannel.get(chatURI) ?? []).filter((a) => a.action?.type === "chat/turnComplete" && a.action.turnId === turnId2).length >= 1,
    "turn 2 turnComplete",
  );
  const completions = (actionsByChannel.get(chatURI) ?? []).filter(
    (a) => a.action?.type === "chat/turnComplete" && a.action.turnId === turnId2,
  );
  check("no duplicate turn after reconnect", completions.length === 1, `turnComplete count=${completions.length}`);

  // Chat state is consistent: both completed turns are in the snapshot.
  const chatFinal = await request("subscribe", { channel: chatURI });
  const chatState = chatFinal.result?.snapshot?.state;
  const turns = chatState?.turns ?? [];
  check(
    "chat snapshot has both turns after reconnect",
    turns.length === 2 && turns.every((t) => t.message?.origin?.kind === "user"),
    `turns=${turns.map((t) => t.id).join(", ")}`,
  );
} catch (e) {
  fail(1, e.message);
}

if (failures > 0) {
  console.error(`${TAG} ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`${TAG} OK: Phase 2 live verification passed (E2E items 12 + 7)`);
ws.close(1000);
process.exit(0);
