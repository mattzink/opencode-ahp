#!/usr/bin/env node
/**
 * opencode-ahp Phase 4 extension 2 live verification (multi-chat per
 * session, plan §14.13).
 *
 * The probe exercises the 1 AHP chat ↔ 1 opencode session mapping against
 * the real server:
 *
 *   1. the root catalog advertises the plain multi-chat capability
 *      (`multipleChats: {}` — no fork/sideChat sub-caps).
 *   2. `createChat` mints a fresh opencode session bound to the
 *      client-chosen chat URI; the session catalog grows by
 *      `session/chatAdded` and the peer chat channel is subscribable.
 *   3. turns on both chats run against their own backends (default chat →
 *      the session's opencode id; peer chat → the minted id) and complete
 *      independently.
 *   4. `listSessions` gains exactly ONE AHP session after createChat (the
 *      one we created, now with two chats) — the peer backend is never
 *      re-surfaced as its own session (checked differentially, so the
 *      probe works on a server with pre-existing sessions).
 *   5. `source` is rejected with INVALID_PARAMS (no fork capability).
 *   6. `disposeChat` on the peer removes the chat + backend; the AHP
 *      session stays healthy with its default chat, and a further turn on
 *      the default chat still works.
 *
 * Durability (plan §14.13.1) — the chat-binding marker on the peer
 * backend's opencode session metadata must survive a location reload:
 *
 *   Run 1:  node scripts/ahp-multi-chat.mjs --token <t> --leave-peer
 *           (steps 1–5, then LEAVES the peer chat + backend alive and
 *           prints the recheck command)
 *   then:   POST /api/location/reload   (the "restart")
 *   Run 2:  node scripts/ahp-multi-chat.mjs --token <t> \
 *             --recheck <sessionChannel> <peerChatURI>
 *           (listSessions shows the peer chat re-attached at its ORIGINAL
 *           URI; a turn on it completes; disposeChat cleans up)
 *
 * Dependency-free: Node ≥ 22 global WebSocket.
 *
 * Usage:
 *   node scripts/ahp-multi-chat.mjs --token <token> \
 *     [--base http://127.0.0.1:8767] [--path /ahp] \
 *     [--channel ahp-session:/lan-mc-<suffix>] [--provider opencode] \
 *     [--timeout-ms 300000] [--leave-peer]
 *   node scripts/ahp-multi-chat.mjs --token <token> \
 *     --recheck <sessionChannel> <peerChatURI> [--base …] [--timeout-ms …]
 *
 * Exit codes: 0 success · 1 protocol/verification failure · 2 connection
 */
import { randomBytes } from "node:crypto";

const TAG = "[ahp-multi-chat]";
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
  channel: arg("--channel", `ahp-session:/lan-mc-${suffix}`),
  provider: arg("--provider", "opencode"),
  timeoutMs: Number(arg("--timeout-ms", "300000")),
  leavePeer: argv.includes("--leave-peer"),
};
if (!opts.token) fail(2, "--token is required");

// `--recheck <sessionChannel> <peerChatURI>`: the durability recheck
// (plan §14.13.1) — a separate connection after a location reload.
const recheckIdx = argv.indexOf("--recheck");
const recheck =
  recheckIdx >= 0 ? { channel: argv[recheckIdx + 1], chat: argv[recheckIdx + 2] } : null;
if (recheck !== null && (!recheck.channel || !recheck.chat)) {
  fail(2, "--recheck requires <sessionChannel> <peerChatURI>");
}

const peerChat = `ahp-chat:/lan-mc-peer-${suffix}`;

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${TAG} ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── AHP session ────────────────────────────────────────────────────────────

let ws = null;
let nextId = 1;
const pending = new Map();
const actionsByChannel = new Map(); // channel -> ActionEnvelope[]
const clientId = `mc-${randomBytes(4).toString("hex")}`;

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

let clientSeq = 0;
function dispatch(channel, action) {
  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "dispatchAction",
      params: { channel, clientSeq: ++clientSeq, action },
    }),
  );
}

async function chatSnapshot(channel) {
  const sub = await request("subscribe", { channel });
  if (sub.error) throw new Error(`subscribe ${channel}: ${JSON.stringify(sub.error)}`);
  return sub.result?.snapshot?.state ?? null;
}

/** Drive one turn on a chat channel end-to-end; returns the terminal action. */
async function driveTurn(chat, turnId, prompt, deadline) {
  dispatch(chat, {
    type: "chat/turnStarted",
    turnId,
    startedAt: new Date().toISOString(),
    message: { text: prompt, origin: { kind: "user" } },
  });
  console.log(`${TAG} dispatched chat/turnStarted ${turnId} on ${chat}`);
  const started = await waitForAction(
    chat,
    (en) => en.action?.type === "chat/turnStarted" && en.action.turnId === turnId,
    `turnStarted echo (${turnId})`,
    deadline,
  );
  check(`turn ${turnId}: turnStarted echoed`, started.rejectionReason === undefined, String(started.rejectionReason));
  const terminal = await waitForAction(
    chat,
    (en) => en.action?.type === "chat/turnComplete" || en.action?.type === "chat/turnError",
    `turn terminal (${turnId})`,
    deadline,
  );
  if (terminal.action.type !== "chat/turnComplete") {
    throw new Error(`turn ${turnId} ended in error: ${JSON.stringify(terminal.action.part ?? null)}`);
  }
  return terminal.action;
}

/**
 * Durability recheck (plan §14.13.1), run after a location reload: the
 * peer chat (created + marked by an earlier run) must be re-attached to
 * its owner session at its ORIGINAL chat URI via the metadata marker on
 * the peer backend's opencode session.
 */
async function runRecheck(sessionChannel, peerChatURI) {
  await connect();
  console.log(`${TAG} connected (clientId ${clientId}) — durability recheck`);

  const init = await request("initialize", {
    channel: "ahp-root://",
    clientId,
    protocolVersions: ["1.0.0"],
    initialSubscriptions: ["ahp-root://"],
  });
  if (init.error) fail(1, `initialize: ${JSON.stringify(init.error)}`);
  check("initialize", init.result?.protocolVersion === "1.0.0", `v${init.result?.protocolVersion}`);

  // listSessions is what surfaces the pre-existing opencode sessions after
  // a reload (there is no boot-time event replay) — and where the marked
  // peer is re-attached to its owner.
  const items = (await request("listSessions", { limit: 100 })).result.items;
  const ours = items.filter((i) => i.resource === sessionChannel);
  check("our session is listed after the reload", ours.length === 1);
  const chats = (ours[0]?.chats ?? []).map((c) => c.resource);
  const defaultChat = ours[0]?.defaultChat;
  check(
    "the peer chat is re-attached at its ORIGINAL URI (two chats, default first)",
    typeof defaultChat === "string" &&
      defaultChat !== peerChatURI &&
      JSON.stringify(chats) === JSON.stringify([defaultChat, peerChatURI]),
    JSON.stringify({ chats, defaultChat }),
  );
  // The peer's backend must not surface as its own AHP session: no other
  // session may carry the peer chat.
  const ghosts = items.filter(
    (i) => i.resource !== sessionChannel && (i.chats ?? []).some((c) => c.resource === peerChatURI),
  );
  check("no ghost session carries the peer chat", ghosts.length === 0, JSON.stringify(ghosts.map((g) => g.resource)));

  const deadline = Date.now() + opts.timeoutMs;
  const sessSub = await request("subscribe", { channel: sessionChannel });
  if (sessSub.error) fail(1, `subscribe session: ${JSON.stringify(sessSub.error)}`);
  const peerSub = await request("subscribe", { channel: peerChatURI });
  if (peerSub.error) fail(1, `subscribe peer chat: ${JSON.stringify(peerSub.error)}`);
  check(
    "peer chat channel is subscribable at its original URI",
    peerSub.result?.snapshot?.state?.resource === peerChatURI,
    JSON.stringify(peerSub.result?.snapshot?.state ?? null),
  );

  // A turn on the re-attached chat reaches the surviving backend.
  await driveTurn(peerChatURI, `turn-durable-${suffix}`, "Reply with exactly: MC-DURABLE-OK", deadline);
  check("peer chat turn after the reload completed", true);

  // Cleanup: dispose the peer (the owner session stays — cleanup backlog).
  const dispose = await request("disposeChat", { channel: peerChatURI });
  if (dispose.error) fail(1, `disposeChat: ${JSON.stringify(dispose.error)}`);
  check("disposeChat", dispose.result === null, `chat ${peerChatURI}`);
  const removed = await waitForAction(
    sessionChannel,
    (en) => en.action?.type === "session/chatRemoved" && en.action.chat === peerChatURI,
    "session/chatRemoved",
    deadline,
  );
  check("session/chatRemoved for the peer chat", removed.action.chat === peerChatURI);
  const state = (await request("subscribe", { channel: sessionChannel })).result?.snapshot?.state;
  check(
    "session survives with its default chat only",
    JSON.stringify((state?.chats ?? []).map((c) => c.resource)) === JSON.stringify([defaultChat]),
    JSON.stringify((state?.chats ?? []).map((c) => c.resource)),
  );
}

if (recheck !== null) {
  try {
    await runRecheck(recheck.channel, recheck.chat);
  } catch (e) {
    fail(1, e.message);
  }
  if (failures > 0) {
    console.error(`${TAG} ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log(`${TAG} OK: chat-binding durability recheck (plan §14.13.1) passed`);
  ws.close(1000);
  process.exit(0);
}

try {
  // ── setup ───────────────────────────────────────────────────────────────
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

  // 1. The capability is advertised on the catalog.
  {
    const root = (init.result?.snapshots ?? []).find((s) => s.resource === "ahp-root://");
    const caps = (root?.state?.agents ?? []).map((a) => a.capabilities);
    check(
      "root catalog advertises plain multi-chat (multipleChats {}, no fork/sideChat)",
      caps.length > 0 && caps.every((c) => JSON.stringify(c?.multipleChats) === "{}" && c?.multipleWorkingDirectories === undefined),
      JSON.stringify(caps),
    );
  }

  // Baseline for the differential listSessions check (step 4): the
  // server may carry pre-existing sessions from earlier probes. Captured
  // BEFORE our createSession so the diff is exactly {our session}.
  const listIds = async () =>
    (await request("listSessions", { limit: 100 })).result.items.map((i) => i.resource);
  const before = new Set(await listIds());

  const create = await request("createSession", {
    channel: opts.channel,
    provider: opts.provider,
  });
  if (create.error) fail(1, `createSession: ${JSON.stringify(create.error)}`);
  check("createSession", create.result === null, `channel ${opts.channel}`);

  const sessSub = await request("subscribe", { channel: opts.channel });
  if (sessSub.error) fail(1, `subscribe session: ${JSON.stringify(sessSub.error)}`);
  const defaultChat = sessSub.result?.snapshot?.state?.defaultChat;
  if (typeof defaultChat !== "string") fail(1, "session snapshot has no defaultChat");
  const chatSub = await request("subscribe", { channel: defaultChat });
  if (chatSub.error) fail(1, `subscribe default chat: ${JSON.stringify(chatSub.error)}`);

  // 2. createChat → session/chatAdded + a subscribable peer chat channel.
  const mkChat = await request("createChat", {
    channel: opts.channel,
    chat: peerChat,
  });
  if (mkChat.error) fail(1, `createChat: ${JSON.stringify(mkChat.error)}`);
  check("createChat", mkChat.result === null, `chat ${peerChat}`);

  const deadline = Date.now() + opts.timeoutMs;
  const added = await waitForAction(
    opts.channel,
    (en) => en.action?.type === "session/chatAdded" && en.action.summary?.resource === peerChat,
    "session/chatAdded",
    deadline,
  );
  check(
    "session/chatAdded carries the new chat summary",
    added.action.summary?.title === "Chat 2" && typeof added.action.summary?.resource === "string",
    JSON.stringify(added.action.summary ?? null),
  );

  const peerSub = await request("subscribe", { channel: peerChat });
  if (peerSub.error) fail(1, `subscribe peer chat: ${JSON.stringify(peerSub.error)}`);
  check(
    "peer chat channel is subscribable with fresh state",
    peerSub.result?.snapshot?.state?.resource === peerChat &&
      peerSub.result?.snapshot?.state?.title === "Chat 2" &&
      (peerSub.result?.snapshot?.state?.turns ?? []).length === 0,
    JSON.stringify({
      resource: peerSub.result?.snapshot?.state?.resource,
      title: peerSub.result?.snapshot?.state?.title,
      turns: (peerSub.result?.snapshot?.state?.turns ?? []).length,
    }),
  );

  // The session catalog now carries both chats, default first.
  {
    const state = (await request("subscribe", { channel: opts.channel })).result?.snapshot?.state;
    const resources = (state?.chats ?? []).map((c) => c.resource);
    check(
      "session snapshot: two chats, default first, defaultChat unchanged",
      JSON.stringify(resources) === JSON.stringify([defaultChat, peerChat]) && state?.defaultChat === defaultChat,
      JSON.stringify({ resources, defaultChat: state?.defaultChat }),
    );
  }

  // 3. Turns on both chats hit their own backends and complete.
  await driveTurn(
    defaultChat,
    "turn-mc-def-" + suffix,
    "Reply with exactly: MC-DEFAULT-OK",
    deadline,
  );
  check("default chat turn completed", true);
  await driveTurn(
    peerChat,
    "turn-mc-peer-" + suffix,
    "Reply with exactly: MC-PEER-OK",
    deadline,
  );
  check("peer chat turn completed", true);

  // 4. listSessions: the only NEW AHP session is ours (two chats) — the
  // peer backend is never re-surfaced as its own session.
  {
    const items = (await request("listSessions", { limit: 100 })).result.items;
    const after = new Set(items.map((i) => i.resource));
    const newOnes = [...after].filter((r) => !before.has(r));
    check(
      "listSessions gains exactly our session (no peer-backend ghost)",
      JSON.stringify(newOnes) === JSON.stringify([opts.channel]),
      JSON.stringify(newOnes),
    );
    const ours = items.filter((i) => i.resource === opts.channel);
    check(
      "our session summary carries both chats",
      ours.length === 1 &&
        (ours[0]?.chats ?? []).length === 2 &&
        ours[0]?.defaultChat === defaultChat,
      JSON.stringify({ chats: (ours[0]?.chats ?? []).map((c) => c.resource), defaultChat: ours[0]?.defaultChat }),
    );
  }

  // 5. `source` is rejected (no fork capability advertised).
  {
    const bad = await request("createChat", {
      channel: opts.channel,
      chat: `ahp-chat:/lan-mc-fork-${suffix}`,
      source: { kind: "fork", chat: defaultChat },
    });
    check(
      "createChat with source is rejected (INVALID_PARAMS)",
      bad.error?.code === -32602,
      JSON.stringify(bad.error ?? null),
    );
  }

  if (opts.leavePeer) {
    // Durability (plan §14.13.1): leave the peer chat + its backend
    // session (now carrying the AHP marker in its opencode metadata)
    // alive across a location reload; the recheck run verifies the
    // re-attachment and disposes the peer.
    console.log(
      `${TAG} --leave-peer: leaving the peer chat + backend alive for the durability recheck.\n` +
        `${TAG} Reload the location, then run:\n` +
        `${TAG}   node scripts/ahp-multi-chat.mjs --token <token> --recheck ${opts.channel} ${peerChat} --base ${opts.base}`,
    );
  } else {
    // 6. disposeChat on the peer; the session stays healthy.
    const dispose = await request("disposeChat", { channel: peerChat });
    if (dispose.error) fail(1, `disposeChat: ${JSON.stringify(dispose.error)}`);
    check("disposeChat", dispose.result === null, `chat ${peerChat}`);

    const removed = await waitForAction(
      opts.channel,
      (en) => en.action?.type === "session/chatRemoved" && en.action.chat === peerChat,
      "session/chatRemoved",
      deadline,
    );
    check("session/chatRemoved for the peer chat", removed.action.chat === peerChat);

    {
      const state = (await request("subscribe", { channel: opts.channel })).result?.snapshot?.state;
      const resources = (state?.chats ?? []).map((c) => c.resource);
      check(
        "session survives with its default chat only",
        JSON.stringify(resources) === JSON.stringify([defaultChat]) && state?.defaultChat === defaultChat,
        JSON.stringify({ resources, defaultChat: state?.defaultChat }),
      );
      const deadSub = await request("subscribe", { channel: peerChat });
      check(
        "peer chat channel is no longer subscribable",
        deadSub.error?.code === -32001,
        JSON.stringify(deadSub.error ?? deadSub.result ?? null),
      );
    }

    // And the session is still usable.
    await driveTurn(
      defaultChat,
      "turn-mc-after-" + suffix,
      "Reply with exactly: MC-AFTER-OK",
      deadline,
    );
    check("default chat turn after the dispose", true);
  }
} catch (e) {
  fail(1, e.message);
}

if (failures > 0) {
  console.error(`${TAG} ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`${TAG} OK: Phase 4 extension 2 (multi-chat) live verification passed`);
ws.close(1000);
process.exit(0);
