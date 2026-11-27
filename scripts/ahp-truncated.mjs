#!/usr/bin/env node
/**
 * opencode-ahp live verification: chat/truncated (state-only truncation,
 * design.md §9).
 *
 * Drives the client-dispatchable `chat/truncated` end to end against a
 * fresh session (a unique channel per run — the assertions are on the
 * absolute turn contents, so no prior-run turns may be present):
 *   1. initialize (root subscription)
 *   2. createSession + session/chat subscribe
 *   3. two completed turns → `chat/truncated` with `turnId` keeps turns
 *      up to and including it
 *   4. `chat/truncated` without `turnId` clears all turns (status idle)
 *   5. the documented use case: truncate, then `chat/turnStarted` with
 *      the edited message — the chat holds exactly the new turn
 *   6. an invalid `turnId` shape is rejected with a reason
 *   7. a chat action on a session channel is rejected with a reason
 *
 * opencode's message history is untouched by any of this (no counterpart
 * on the plugin surface) — the assertions are on the AHP chat state.
 *
 * Dependency-free: Node ≥ 22 global WebSocket.
 *
 * Usage:
 *   node scripts/ahp-truncated.mjs --token <token> \
 *     [--base http://127.0.0.1:8767] [--path /ahp] \
 *     [--channel ahp-session:/lan-truncated-<rand>] [--provider opencode] \
 *     [--timeout-ms 90000]
 *
 * Exit codes: 0 success · 1 protocol/verification failure · 2 connection
 */
import { randomBytes } from "node:crypto";

const TAG = "[ahp-truncated]";
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
  channel: arg("--channel", "ahp-session:/lan-truncated-" + randomBytes(3).toString("hex")),
  provider: arg("--provider", "opencode"),
  timeoutMs: Number(arg("--timeout-ms", "90000")),
};
if (!opts.token) fail(2, "--token is required");

const wsUrl =
  opts.base.replace(/^http/, "ws") +
  opts.path +
  "?token=" +
  encodeURIComponent(opts.token);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${TAG} ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── minimal AHP session ───────────────────────────────────────────────────

let nextId = 1;
const pending = new Map();
const actionsByChannel = new Map(); // channel -> ActionEnvelope[]

const ws = new WebSocket(wsUrl);
ws.addEventListener("message", (ev) => {
  const data = ev.data;
  const text =
    typeof data === "string"
      ? data
      : new TextDecoder().decode(data instanceof ArrayBuffer ? data : Buffer.from(data));
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    console.error(`${TAG} non-JSON frame: ${text.slice(0, 200)}`);
    return;
  }
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
    const a = msg.params?.action;
    console.log(
      `${TAG}   action ${ch} seq=${msg.params?.serverSeq} ${a?.type}${a?.turnId ? ` (${a.turnId})` : ""}${msg.params?.rejectionReason ? ` REJECTED: ${msg.params.rejectionReason}` : ""}`,
    );
    return;
  }
  console.log(`${TAG}   notification ${msg.method}: ${JSON.stringify(msg.params ?? null).slice(0, 200)}`);
});

const openPromise = new Promise((resolve, reject) => {
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

const dispatch = (channel, clientSeq, action) =>
  ws.send(JSON.stringify({ jsonrpc: "2.0", method: "dispatchAction", params: { channel, clientSeq, action } }));

const chatState = async (chatChannel) => {
  const sub = await request("subscribe", { channel: chatChannel });
  if (sub.error) throw new Error(`subscribe chat: ${JSON.stringify(sub.error)}`);
  return sub.result?.snapshot?.state;
};

/** Dispatch chat/turnStarted and wait for its accepted echo + turnComplete. */
const runTurn = async (chatChannel, clientSeq, turnId, text) => {
  dispatch(chatChannel, clientSeq, {
    type: "chat/turnStarted",
    turnId,
    startedAt: new Date().toISOString(),
    message: { text, origin: { kind: "user" } },
  });
  console.log(`${TAG} dispatched chat/turnStarted ${turnId} (${JSON.stringify(text)})`);
  await waitFor(
    () =>
      (actionsByChannel.get(chatChannel) ?? []).some(
        (a) => a.action?.type === "chat/turnStarted" && a.action?.turnId === turnId && !a.rejectionReason,
      ),
    `turnStarted echo ${turnId}`,
  );
  await waitFor(
    () => (actionsByChannel.get(chatChannel) ?? []).some((a) => a.action?.type === "chat/turnComplete" && a.action?.turnId === turnId),
    `turnComplete ${turnId}`,
  );
};

/** Wait for a `chat/truncated` action (accepted or rejected, whichever matches). */
const waitTruncated = (channel, predicate) =>
  waitFor(
    () => (actionsByChannel.get(channel) ?? []).some((a) => a.action?.type === "chat/truncated" && predicate(a)),
    `chat/truncated on ${channel}`,
  );

try {
  await openPromise;
  console.log(`${TAG} connected ${wsUrl.replace(opts.token, "***")}`);

  // 1. initialize
  const clientId = "trunc-" + randomBytes(4).toString("hex");
  const init = await request("initialize", {
    channel: "ahp-root://",
    clientId,
    protocolVersions: ["1.1.0", "1.0.0"],
    initialSubscriptions: ["ahp-root://"],
  });
  if (init.error) fail(1, `initialize: ${JSON.stringify(init.error)}`);
  check("initialize", init.result?.protocolVersion === "1.1.0", `v${init.result?.protocolVersion}`);

  // 2. createSession + subscribe session/chat
  const create = await request("createSession", {
    channel: opts.channel,
    provider: opts.provider,
  });
  if (create.error) fail(1, `createSession: ${JSON.stringify(create.error)}`);
  check("createSession", create.result === null, `channel ${opts.channel} provider ${opts.provider}`);
  const sessSub = await request("subscribe", { channel: opts.channel });
  if (sessSub.error) fail(1, `subscribe session: ${JSON.stringify(sessSub.error)}`);
  const chatChannel = sessSub.result?.snapshot?.state?.defaultChat;
  if (typeof chatChannel !== "string") fail(1, "no default chat in the session snapshot");
  const chatSub = await request("subscribe", { channel: chatChannel });
  if (chatSub.error) fail(1, `subscribe chat: ${JSON.stringify(chatSub.error)}`);
  check("fresh chat state", (chatSub.result?.snapshot?.state?.turns ?? []).length === 0, chatChannel);

  // 3. two completed turns → truncate to the first.
  const t1 = "t1-" + Date.now().toString(36);
  const t2 = "t2-" + Date.now().toString(36);
  await runTurn(chatChannel, 1, t1, "Reply with exactly: one");
  await runTurn(chatChannel, 2, t2, "Reply with exactly: two");
  let state = await chatState(chatChannel);
  check("two turns stored", state.turns.map((t) => t.id).join(",") === `${t1},${t2}`, state.turns.map((t) => t.id).join(","));

  dispatch(chatChannel, 3, { type: "chat/truncated", turnId: t1 });
  await waitTruncated(chatChannel, (a) => !a.rejectionReason);
  state = await chatState(chatChannel);
  check(
    "truncate to turnId keeps turns up to and including it",
    state.turns.map((t) => t.id).join(",") === t1,
    state.turns.map((t) => t.id).join(","),
  );

  // 4. truncate without turnId → no turns, status idle (the activity bits
  //    InProgress=8 / InputNeeded=24 are clear).
  dispatch(chatChannel, 4, { type: "chat/truncated" });
  await waitTruncated(chatChannel, (a) => !a.rejectionReason && a.action?.turnId === undefined);
  state = await chatState(chatChannel);
  check(
    "truncated without turnId clears all turns (idle)",
    state.turns.length === 0 && state.activeTurn === undefined && (state.status & (8 | 24)) === 0,
    `turns ${state.turns.length} status ${state.status}`,
  );

  // 5. the documented use case: truncate, then turnStarted with the edited
  //    message — the chat holds exactly the new turn.
  const t3 = "t3-" + Date.now().toString(36);
  await runTurn(chatChannel, 5, t3, "Reply with exactly: three");
  state = await chatState(chatChannel);
  check(
    "truncate-then-resend holds exactly the new turn",
    state.turns.map((t) => t.id).join(",") === t3,
    state.turns.map((t) => t.id).join(","),
  );

  // 6. invalid turnId shape → rejected with a reason.
  dispatch(chatChannel, 6, { type: "chat/truncated", turnId: 42 });
  await waitTruncated(chatChannel, (a) => a.rejectionReason !== undefined);
  const bad = (actionsByChannel.get(chatChannel) ?? []).find((a) => a.action?.type === "chat/truncated" && a.rejectionReason !== undefined);
  check("invalid turnId shape rejected", /invalid chat\/truncated params/.test(bad.rejectionReason), bad.rejectionReason);

  // 7. chat action on a session channel → rejected with a reason.
  dispatch(opts.channel, 7, { type: "chat/truncated" });
  await waitTruncated(opts.channel, (a) => a.rejectionReason !== undefined);
  const wrongChannel = (actionsByChannel.get(opts.channel) ?? []).find((a) => a.action?.type === "chat/truncated" && a.rejectionReason !== undefined);
  check("session channel rejected", /chat actions require a chat channel/.test(wrongChannel.rejectionReason), wrongChannel.rejectionReason);
} catch (e) {
  fail(1, e.message);
}

if (failures > 0) {
  console.error(`${TAG} ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`${TAG} OK: chat/truncated verification passed`);
ws.close(1000);
process.exit(0);
