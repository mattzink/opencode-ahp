#!/usr/bin/env node
/**
 * opencode-ahp live verification: full session + turn lifecycle.
 *
 * Drives the full AHP 1.0.0 surface that the VS Code Agents window needs:
 *   1. initialize (root subscription)
 *   2. createSession (session-channel command; provider selection)
 *   3. subscribe the session channel → assert the agent picker is present
 *      in the snapshot (SessionState.customizations — the fix for the
 *      empty dropdown)
 *   4. subscribe the chat channel (URI from the session state)
 *   5. dispatchAction chat/turnStarted → observe the turn lifecycle
 *      (echo → responsePart/delta → turnComplete)
 *
 * Dependency-free: Node ≥ 22 global WebSocket.
 *
 * Usage:
 *   node scripts/ahp-turn-lifecycle.mjs --token <token> \
 *     [--base http://127.0.0.1:8767] [--path /ahp] \
 *     [--channel ahp-session:/lan-turn] [--provider opencode] \
 *     [--prompt "Reply with exactly: ok"] [--timeout-ms 90000]
 *
 * Exit codes: 0 success · 1 protocol/verification failure · 2 connection
 */
import { randomBytes } from "node:crypto";

const TAG = "[ahp-turn-lifecycle]";
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
  channel: arg("--channel", "ahp-session:/lan-turn"),
  provider: arg("--provider", "opencode"),
  prompt: arg("--prompt", "Reply with exactly: ok"),
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
const rootNotifications = [];

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
    const a = msg.params?.action;
    console.log(`${TAG}   action ${msg.params?.channel} seq=${msg.params?.serverSeq} ${a?.type}${a?.turnId ? ` (${a.turnId})` : ""}${msg.params?.rejectionReason ? ` REJECTED: ${msg.params.rejectionReason}` : ""}`);
    return;
  }
  rootNotifications.push(msg);
  console.log(`${TAG}   notification ${msg.method}: ${JSON.stringify(msg.params ?? null).slice(0, 200)}`);
}

const ws = new WebSocket(wsUrl);
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

try {
  await openPromise;
  console.log(`${TAG} connected ${wsUrl.replace(opts.token, "***")}`);

  // 1. initialize
  const clientId = "turn-" + randomBytes(4).toString("hex");
  const init = await request("initialize", {
    channel: "ahp-root://",
    clientId,
    protocolVersions: ["1.0.0"],
    initialSubscriptions: ["ahp-root://"],
  });
  if (init.error) fail(1, `initialize: ${JSON.stringify(init.error)}`);
  check("initialize", init.result?.protocolVersion === "1.0.0", `v${init.result?.protocolVersion}`);

  // 2. createSession
  const create = await request("createSession", {
    channel: opts.channel,
    provider: opts.provider,
  });
  if (create.error) fail(1, `createSession: ${JSON.stringify(create.error)}`);
  check("createSession", create.result === null, `channel ${opts.channel} provider ${opts.provider}`);

  // 3. subscribe the session channel → the agent picker must be in the
  //    snapshot's SessionState.customizations.
  const sessSub = await request("subscribe", { channel: opts.channel });
  if (sessSub.error) fail(1, `subscribe session: ${JSON.stringify(sessSub.error)}`);
  const sessState = sessSub.result?.snapshot?.state;
  const customizations = sessState?.customizations ?? [];
  const dir = customizations.find((c) => c.type === "directory");
  const agentNames = dir?.children?.map((c) => c.name) ?? [];
  check(
    "session snapshot carries the agent picker",
    dir !== undefined && agentNames.length > 0,
    dir ? `directory ${dir.name} → agents: ${agentNames.join(", ")}` : "no directory customization",
  );
  check(
    "session snapshot has the default chat",
    typeof sessState?.defaultChat === "string" && sessState.defaultChat.startsWith("ahp-chat:/"),
    String(sessState?.defaultChat),
  );
  const chatChannel = sessState?.defaultChat;

  // The root announcement must have arrived (notification, ephemeral).
  check(
    "root/sessionAdded notification observed",
    rootNotifications.some((n) => n.method === "root/sessionAdded" && n.params?.summary?.resource === opts.channel),
  );

  // 4. subscribe the chat channel
  const chatSub = await request("subscribe", { channel: chatChannel });
  if (chatSub.error) fail(1, `subscribe chat: ${JSON.stringify(chatSub.error)}`);
  check(
    "chat snapshot is the seeded 'Chat 1'",
    chatSub.result?.snapshot?.state?.title === "Chat 1",
    `fromSeq ${chatSub.result?.snapshot?.fromSeq}`,
  );

  // 5. dispatch the turn and watch the lifecycle
  const turnId = "turn-live-" + Date.now().toString(36);
  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "dispatchAction",
      params: {
        channel: chatChannel,
        clientSeq: 1,
        action: {
          type: "chat/turnStarted",
          turnId,
          startedAt: new Date().toISOString(),
          message: { text: opts.prompt, origin: { kind: "user" } },
        },
      },
    }),
  );
  console.log(`${TAG} dispatched chat/turnStarted ${turnId} (${JSON.stringify(opts.prompt)})`);

  await waitFor(
    () => (actionsByChannel.get(chatChannel) ?? []).some((a) => a.action?.type === "chat/turnStarted" && !a.rejectionReason),
    "turnStarted echo",
  );
  check("turnStarted echo received", true);

  await waitFor(
    () => (actionsByChannel.get(chatChannel) ?? []).some((a) => a.action?.type === "chat/turnComplete"),
    "turnComplete",
  );
  const types = (actionsByChannel.get(chatChannel) ?? []).map((a) => a.action?.type);
  check("responsePart observed", types.includes("chat/responsePart"));
  check("turnComplete observed", true, `actions: ${[...new Set(types)].join(", ")}`);
} catch (e) {
  fail(1, e.message);
}

if (failures > 0) {
  console.error(`${TAG} ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`${TAG} OK: session + turn lifecycle verification passed`);
ws.close(1000);
process.exit(0);
