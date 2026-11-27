#!/usr/bin/env node
/**
 * opencode-ahp live verification: `disposeSession` (AHP
 * session-channel command — design.md §6/§7).
 *
 * The probe disposes AHP sessions through the real server and checks the
 * full teardown, differential (the server may carry sessions from
 * earlier probes):
 *
 *   1. `initialize` (root subscription) against v1.1.0.
 *   2. Baselines: `listSessions` (AHP channels) and `GET /api/session`
 *      (opencode session ids — the cross-check ground truth for the
 *      backend removals).
 *   3. `createSession` (standard channel) → `null` + `root/sessionAdded`;
 *      the session is listed with its one default chat; the default
 *      chat's channel suffix is the opencode backend id.
 *   4. Rejections without side effects: a chat channel and the root
 *      channel are -32602, an unknown session channel is -32001, and no
 *      `root/sessionRemoved` has fired.
 *   5. `createChat` mints a peer backend (`session/chatAdded`);
 *      `GET /api/session` gains exactly ONE new id — the peer backend.
 *   6. `disposeSession` → `null`; a single `root/sessionRemoved`
 *      (carrying the session channel) and the
 *      `root/activeSessionsChanged` count back to the baseline.
 *   7. After the response: the session AND the peer chat channel are no
 *      longer subscribable (-32001), `listSessions` is back to the
 *      baseline, and BOTH backend ids are gone from `GET /api/session`
 *      (default + peer — the multi-chat case).
 *   8. A second `disposeSession` → -32001 (already gone).
 *   9. The legacy channel form: `createSession` on
 *      `<provider>:/<suffix>` (the form clients echo back) →
 *      `disposeSession` on that same channel → `null` + a second
 *      `root/sessionRemoved`, the backend id gone from `GET
 *      /api/session`, the channel no longer subscribable.
 *
 * Dependency-free: Node ≥ 22 global WebSocket + fetch.
 *
 * Usage:
 *   node scripts/ahp-dispose-session.mjs --token <ahp token> --pw <server pw> \
 *     [--base http://127.0.0.1:8767] [--path /ahp] \
 *     [--http-base http://127.0.0.1:4098] \
 *     [--channel ahp-session:/lan-ds-<rand>] [--provider opencode] \
 *     [--timeout-ms 300000]
 *
 * Exit codes: 0 success · 1 protocol/verification failure · 2 connection
 */
import { randomBytes } from "node:crypto";

const TAG = "[ahp-dispose-session]";
const fail = (code, msg) => {
  console.error(`${TAG} FAIL: ${msg}`);
  process.exit(code);
};

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};

const suffix = Date.now().toString(36);
const opts = {
  base: (arg("--base", "http://127.0.0.1:8767") ?? "").replace(/\/$/, ""),
  path: arg("--path", "/ahp"),
  token: arg("--token", null),
  httpBase: (arg("--http-base", "http://127.0.0.1:4098") ?? "").replace(/\/$/, ""),
  pw: arg("--pw", null),
  channel: arg("--channel", `ahp-session:/lan-ds-${suffix}`),
  provider: arg("--provider", "opencode"),
  timeoutMs: Number(arg("--timeout-ms", "300000")),
};
if (!opts.token) fail(2, "--token is required");
if (!opts.pw) fail(2, "--pw (the opencode server Basic auth password) is required");

const legacyChannel = `${opts.provider}:/lan-ds-legacy-${suffix}`;
const peerChat = `ahp-chat:/lan-ds-peer-${suffix}`;

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${TAG} ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── the test server's own HTTP surface (the cross-check ground truth) ──

const basic = "Basic " + Buffer.from(`opencode:${opts.pw}`).toString("base64");
// The server's session list is a cursor-paginated envelope:
// { data: Session[], cursor: { previous, next } } — walk `next` pages
// (a handful of probes never approaches the page cap).
const opencodeSessionIds = async () => {
  const ids = new Set();
  let cursor;
  for (let page = 0; page < 100; page++) {
    const url =
      opts.httpBase + "/api/session" + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : "");
    const res = await fetch(url, { headers: { authorization: basic } });
    if (!res.ok) throw new Error(`GET /api/session → ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body.data)) throw new Error("GET /api/session: envelope has no data array");
    for (const s of body.data) if (typeof s?.id === "string") ids.add(s.id);
    cursor = body.cursor?.next ?? null;
    if (!cursor) break;
  }
  return ids;
};

// ── AHP session ────────────────────────────────────────────────────────────

let ws = null;
let nextId = 1;
const pending = new Map();
const actionsByChannel = new Map(); // channel -> ActionEnvelope[]
const rootNotifications = []; // root/sessionAdded, root/sessionRemoved
const clientId = `ds-${randomBytes(4).toString("hex")}`;

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
    console.log(
      `${TAG}   action ${ch} ${a?.type}${a?.turnId ? ` (${a.turnId})` : ""}${msg.params?.rejectionReason ? ` REJECTED: ${msg.params.rejectionReason}` : ""}`,
    );
    return;
  }
  if (msg.method === "root/sessionAdded" || msg.method === "root/sessionRemoved") {
    rootNotifications.push(msg);
  }
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sessionRemovedCount = () =>
  rootNotifications.filter((n) => n.method === "root/sessionRemoved").length;

// ── action consumption (per-channel cursor) ────────────────────────────────

const cursors = new Map();

/** Wait until a channel's action stream (from `since`, in envelopes) has an
 * envelope matching `match`. */
async function waitForAction(channel, match, what, deadline, since = 0) {
  for (;;) {
    const list = actionsByChannel.get(channel) ?? [];
    for (let i = Math.max(since, cursors.get(channel) ?? 0); i < list.length; i++) {
      if (match(list[i])) {
        cursors.set(channel, i + 1);
        return list[i];
      }
    }
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await sleep(25);
  }
}

/** Wait until a root notification matching `match` arrives. */
async function waitForRootNotification(match, what, deadline, since = 0) {
  for (;;) {
    for (let i = Math.max(since, cursors.get("__root__") ?? 0); i < rootNotifications.length; i++) {
      if (match(rootNotifications[i])) {
        cursors.set("__root__", i + 1);
        return rootNotifications[i];
      }
    }
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await sleep(25);
  }
}

async function listChannelResources() {
  const items = (await request("listSessions", { limit: 100 })).result.items;
  return items.map((i) => i.resource);
}

try {
  // ── 1. setup ─────────────────────────────────────────────────────────────
  await connect();
  console.log(`${TAG} connected (clientId ${clientId})`);

  const init = await request("initialize", {
    channel: "ahp-root://",
    clientId,
    protocolVersions: ["1.1.0", "1.0.0"],
    initialSubscriptions: ["ahp-root://"],
  });
  if (init.error) fail(1, `initialize: ${JSON.stringify(init.error)}`);
  check("initialize", init.result?.protocolVersion === "1.1.0", `v${init.result?.protocolVersion}`);

  const deadline = Date.now() + opts.timeoutMs;

  // ── 2. baselines (differential — pre-existing sessions are fine) ────────
  const baselineChannels = new Set(await listChannelResources());
  const baselineIds = await opencodeSessionIds();
  console.log(
    `${TAG} baseline: ${baselineChannels.size} AHP session(s), ${baselineIds.size} opencode session(s)`,
  );

  // ── 3. createSession (standard channel) ─────────────────────────────────
  const create = await request("createSession", {
    channel: opts.channel,
    provider: opts.provider,
  });
  if (create.error) fail(1, `createSession: ${JSON.stringify(create.error)}`);
  check("createSession", create.result === null, `channel ${opts.channel}`);
  await waitForRootNotification(
    (n) => n.method === "root/sessionAdded" && n.params?.summary?.resource === opts.channel,
    "root/sessionAdded",
    deadline,
  );
  check("root/sessionAdded for the new session", true);

  const sessSub = await request("subscribe", { channel: opts.channel });
  if (sessSub.error) fail(1, `subscribe session: ${JSON.stringify(sessSub.error)}`);
  const defaultChat = sessSub.result?.snapshot?.state?.defaultChat;
  if (typeof defaultChat !== "string") fail(1, "session snapshot has no defaultChat");
  const defaultBackend = defaultChat.slice("ahp-chat:/".length);
  const afterCreate = await opencodeSessionIds();
  check(
    "the default chat's channel suffix is the (fresh) opencode backend id",
    !baselineIds.has(defaultBackend) && afterCreate.has(defaultBackend),
    `defaultChat ${defaultChat} → backend ${defaultBackend}`,
  );

  {
    const items = (await request("listSessions", { limit: 100 })).result.items;
    const ours = items.filter((i) => i.resource === opts.channel);
    check(
      "listSessions lists the new session with its one default chat",
      ours.length === 1 &&
        (ours[0]?.chats ?? []).length === 1 &&
        ours[0]?.defaultChat === defaultChat,
      JSON.stringify({ chats: (ours[0]?.chats ?? []).map((c) => c.resource), defaultChat: ours[0]?.defaultChat }),
    );
  }

  // ── 4. rejections without side effects ──────────────────────────────────
  {
    const chat = await request("disposeSession", { channel: defaultChat });
    check(
      "disposeSession on a chat channel is rejected (INVALID_PARAMS)",
      chat.error?.code === -32602,
      JSON.stringify(chat.error ?? null),
    );
    const root = await request("disposeSession", { channel: "ahp-root://" });
    check(
      "disposeSession on the root channel is rejected (INVALID_PARAMS)",
      root.error?.code === -32602,
      JSON.stringify(root.error ?? null),
    );
    const ghost = await request("disposeSession", { channel: `ahp-session:/lan-ds-ghost-${suffix}` });
    check(
      "disposeSession on an unknown session channel is rejected (SESSION_NOT_FOUND)",
      ghost.error?.code === -32001,
      JSON.stringify(ghost.error ?? null),
    );
    check("no root/sessionRemoved yet (rejections had no side effects)", sessionRemovedCount() === 0);
    const alive = await request("subscribe", { channel: opts.channel });
    const aliveState = alive.result?.snapshot?.state;
    check(
      "the session is untouched after the rejections",
      alive.error === undefined &&
        aliveState?.defaultChat === defaultChat &&
        (aliveState?.chats ?? []).length === 1,
      JSON.stringify({ error: alive.error ?? null, defaultChat: aliveState?.defaultChat }),
    );
  }

  // ── 5. multi-chat: a peer backend joins the record ──────────────────────
  const mkChat = await request("createChat", { channel: opts.channel, chat: peerChat });
  if (mkChat.error) fail(1, `createChat: ${JSON.stringify(mkChat.error)}`);
  check("createChat", mkChat.result === null, `chat ${peerChat}`);
  await waitForAction(
    opts.channel,
    (en) => en.action?.type === "session/chatAdded" && en.action.summary?.resource === peerChat,
    "session/chatAdded",
    deadline,
  );
  check("session/chatAdded for the peer chat", true);

  const afterPeer = await opencodeSessionIds();
  const newBackends = [...afterPeer].filter((id) => !baselineIds.has(id) && id !== defaultBackend);
  check(
    "GET /api/session gains exactly ONE new id (the peer backend)",
    newBackends.length === 1,
    JSON.stringify(newBackends),
  );
  const peerBackend = newBackends[0];
  if (peerBackend === undefined) fail(1, "no peer backend id found to track");

  // ── 6. disposeSession (multi-chat session) ──────────────────────────────
  const dispose = await request("disposeSession", { channel: opts.channel });
  if (dispose.error) fail(1, `disposeSession: ${JSON.stringify(dispose.error)}`);
  check("disposeSession", dispose.result === null, `channel ${opts.channel}`);

  const removed = await waitForRootNotification(
    (n) => n.method === "root/sessionRemoved" && n.params?.session === opts.channel,
    "root/sessionRemoved",
    deadline,
  );
  check(
    "root/sessionRemoved carries the session channel (exactly once)",
    removed.params.session === opts.channel && sessionRemovedCount() === 1,
    JSON.stringify(removed.params ?? null),
  );
  await waitForAction(
    "ahp-root://",
    (en) => en.action?.type === "root/activeSessionsChanged" && en.action.activeSessions === baselineChannels.size,
    "root/activeSessionsChanged back to the baseline count",
    deadline,
  );
  check(
    "root/activeSessionsChanged count is back to the baseline",
    true,
    `activeSessions ${baselineChannels.size}`,
  );

  // ── 7. after the response: channels dead, catalog + backends gone ───────
  {
    const dead = await request("subscribe", { channel: opts.channel });
    check(
      "the session channel is no longer subscribable (-32001)",
      dead.error?.code === -32001,
      JSON.stringify(dead.error ?? dead.result ?? null),
    );
    const deadChat = await request("subscribe", { channel: peerChat });
    check(
      "the peer chat channel is no longer subscribable (-32001)",
      deadChat.error?.code === -32001,
      JSON.stringify(deadChat.error ?? deadChat.result ?? null),
    );
    const channels = await listChannelResources();
    check(
      "listSessions is back to the baseline (no resurfacing)",
      JSON.stringify([...channels].sort()) === JSON.stringify([...baselineChannels].sort()),
      JSON.stringify([...channels].filter((c) => !baselineChannels.has(c))),
    );
    const ids = await opencodeSessionIds();
    check(
      "BOTH opencode backends are gone (default + peer — the multi-chat case)",
      !ids.has(defaultBackend) && !ids.has(peerBackend),
      JSON.stringify({ defaultBackend, peerBackend, remaining: [...ids].filter((i) => !baselineIds.has(i)) }),
    );
  }

  // ── 8. a second dispose is an error ─────────────────────────────────────
  {
    const again = await request("disposeSession", { channel: opts.channel });
    check(
      "a second disposeSession is rejected (SESSION_NOT_FOUND)",
      again.error?.code === -32001,
      JSON.stringify(again.error ?? null),
    );
  }

  // ── 9. the legacy channel form (the one clients echo back) ──────────────
  const legacyCreate = await request("createSession", {
    channel: legacyChannel,
    provider: opts.provider,
  });
  if (legacyCreate.error) fail(1, `createSession (legacy): ${JSON.stringify(legacyCreate.error)}`);
  check("createSession (legacy channel)", legacyCreate.result === null, `channel ${legacyChannel}`);
  await waitForRootNotification(
    (n) => n.method === "root/sessionAdded" && n.params?.summary?.resource === legacyChannel,
    "root/sessionAdded (legacy)",
    deadline,
  );

  const legacySub = await request("subscribe", { channel: legacyChannel });
  if (legacySub.error) fail(1, `subscribe legacy session: ${JSON.stringify(legacySub.error)}`);
  const legacyDefaultChat = legacySub.result?.snapshot?.state?.defaultChat;
  const legacyBackend = typeof legacyDefaultChat === "string" ? legacyDefaultChat.slice("ahp-chat:/".length) : "";
  check(
    "the legacy session's default chat suffix is its opencode backend id",
    (await opencodeSessionIds()).has(legacyBackend),
    `backend ${legacyBackend}`,
  );

  const legacyDispose = await request("disposeSession", { channel: legacyChannel });
  if (legacyDispose.error) fail(1, `disposeSession (legacy): ${JSON.stringify(legacyDispose.error)}`);
  check("disposeSession (legacy channel)", legacyDispose.result === null, `channel ${legacyChannel}`);
  const legacyRemoved = await waitForRootNotification(
    (n) => n.method === "root/sessionRemoved" && n.params?.session === legacyChannel,
    "root/sessionRemoved (legacy)",
    deadline,
  );
  check(
    "root/sessionRemoved carries the legacy channel (still exactly one per dispose)",
    legacyRemoved.params.session === legacyChannel && sessionRemovedCount() === 2,
    JSON.stringify(legacyRemoved.params ?? null),
  );
  {
    // A legacy channel classifies "unknown" by prefix; once its record is
    // gone it is no longer in the live session-channel set, so the
    // honest error is -32602 (unknown URI) — only the standard form of
    // a dead session answers -32001.
    const dead = await request("subscribe", { channel: legacyChannel });
    check(
      "the legacy channel is no longer subscribable (-32602 unknown URI)",
      dead.error?.code === -32602,
      JSON.stringify(dead.error ?? dead.result ?? null),
    );
    const ids = await opencodeSessionIds();
    check(
      "the legacy backend id is gone from GET /api/session",
      !ids.has(legacyBackend),
      `backend ${legacyBackend}`,
    );
    const channels = await listChannelResources();
    check(
      "listSessions is back to the baseline again",
      JSON.stringify([...channels].sort()) === JSON.stringify([...baselineChannels].sort()),
      JSON.stringify([...channels].filter((c) => !baselineChannels.has(c))),
    );
  }
} catch (e) {
  fail(1, e.message);
}

if (failures > 0) {
  console.error(`${TAG} ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`${TAG} OK: disposeSession live verification passed`);
ws.close(1000);
process.exit(0);
