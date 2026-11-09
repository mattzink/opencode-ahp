#!/usr/bin/env node
/**
 * opencode-ahp Phase 4 extension 1 live verification (client-provided
 * tools, plan §14.12).
 *
 * The probe registers a `ping` client tool via
 * `createSession.activeClient.tools`, then drives three turns through the
 * real opencode tool registry (the one-shot `ctx.tool.transform` +
 * `reload` registration and the `execute` bridge back into the host):
 *
 *   1. happy path — the model calls `ping`; the host marks the call
 *      client-executed (the `contributor` rides the `toolCallStart`),
 *      the probe completes it with a success result; the session never
 *      goes InputNeeded while the client executes; the turn completes
 *      with exactly one `toolCallComplete` (no duplicate from the
 *      opencode-side terminal); the snapshot carries the client's
 *      result + contributor.
 *   2. failed result — the probe completes with `success: false`; the
 *      model sees the error, the turn still completes, and the snapshot
 *      records the failure.
 *   3. `requiresResultConfirmation` — the probe's completion parks the
 *      call in `pending-result-confirmation` (the session goes
 *      InputNeeded); approving via `chat/toolCallResultConfirmed`
 *      releases the held result and the turn completes.
 *
 * Dependency-free: Node ≥ 22 global WebSocket.
 *
 * Usage:
 *   node scripts/ahp-client-tools.mjs --token <token> \
 *     [--base http://127.0.0.1:8767] [--path /ahp] \
 *     [--channel ahp-session:/lan-ct-<suffix>] [--provider opencode] \
 *     [--timeout-ms 180000]
 *
 * Exit codes: 0 success · 1 protocol/verification failure · 2 connection
 */
import { randomBytes } from "node:crypto";

const TAG = "[ahp-client-tools]";
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
  channel: arg("--channel", `ahp-session:/lan-ct-${Date.now().toString(36)}`),
  provider: arg("--provider", "opencode"),
  timeoutMs: Number(arg("--timeout-ms", "180000")),
};
if (!opts.token) fail(2, "--token is required");

// The client tool the probe registers. The model is instructed to call it
// exactly once per turn with a specific `note` argument.
const PING_TOOL = {
  name: "ping",
  title: "Ping",
  description: "Probe tool: receives a note and returns it. Used to verify client-provided tool execution.",
  inputSchema: {
    type: "object",
    properties: { note: { type: "string", description: "The note to ping" } },
    required: ["note"],
  },
};

const INPUT_NEEDED = 24; // SessionStatus.InputNeeded

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
const clientId = `ct-${randomBytes(4).toString("hex")}`;

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
      `${TAG}   action ${ch} ${a?.type}${a?.turnId ? ` (${a.turnId})` : ""}${a?.toolCallId ? ` [${a.toolCallId}]` : ""}${msg.params?.rejectionReason ? ` REJECTED: ${msg.params.rejectionReason}` : ""}`,
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

// ── turn-driven action consumption ─────────────────────────────────────────
// The cursor walks each channel's accumulator; relevant-but-unmatched
// envelopes park in an ordered buffer so an inner wait (e.g. for a
// completion echo) never swallows an interleaved tool call from a model
// retry.

let sessionURI = null;
let chatURI = null;
const cursors = new Map();
const buffer = [];

function isRelevant(env) {
  const a = env.action;
  if (!a) return false;
  if (env.channel === sessionURI) {
    return a.type === "session/inputNeededSet" || a.type === "session/inputNeededRemoved";
  }
  if (env.channel === chatURI) {
    return (
      a.type === "chat/turnStarted" ||
      a.type === "chat/toolCallStart" ||
      a.type === "chat/toolCallReady" ||
      a.type === "chat/toolCallComplete" ||
      a.type === "chat/toolCallContentChanged" ||
      a.type === "chat/toolCallResultConfirmed" ||
      a.type === "chat/turnComplete" ||
      a.type === "chat/turnError"
    );
  }
  return false;
}

async function nextRelevant(match, what, deadline) {
  for (;;) {
    for (let i = 0; i < buffer.length; i++) {
      if (match(buffer[i])) return buffer.splice(i, 1)[0];
    }
    for (const [ch, list] of actionsByChannel) {
      let i = cursors.get(ch) ?? 0;
      while (i < list.length) {
        const env = list[i++];
        if (isRelevant(env)) buffer.push(env);
      }
      cursors.set(ch, i);
    }
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await sleep(25);
  }
}

// ── client dispatches (fire-and-forget; the echo is an `action` frame) ────

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

function startTurn(turnId, text) {
  dispatch(chatURI, {
    type: "chat/turnStarted",
    turnId,
    startedAt: new Date().toISOString(),
    message: { text, origin: { kind: "user" } },
  });
}

function completeCall(turnId, toolCallId, decision) {
  dispatch(chatURI, {
    type: "chat/toolCallComplete",
    turnId,
    toolCallId,
    ...(decision.requiresResultConfirmation ? { requiresResultConfirmation: true } : {}),
    result: decision.result,
  });
}

function confirmResult(turnId, toolCallId, approved) {
  dispatch(chatURI, { type: "chat/toolCallResultConfirmed", turnId, toolCallId, approved });
}

// ── the turn driver ────────────────────────────────────────────────────────
/**
 * Runs one turn end-to-end. `respond(callId)` returns the client's
 * completion decision for each client-executed call it observes (the
 * model is instructed to call the tool once; a retry is answered the
 * same way). Returns per-call records + the terminal action.
 */
async function driveTurn(turnNo, turnId, prompt, respond) {
  const deadline = Date.now() + opts.timeoutMs;
  startTurn(turnId, prompt);
  console.log(`${TAG} dispatched chat/turnStarted ${turnId} (turn ${turnNo})`);

  const started = await nextRelevant(
    (en) => en.action?.type === "chat/turnStarted" && en.action.turnId === turnId,
    `turnStarted echo (${turnId})`,
    deadline,
  );
  check(`turn ${turnNo}: turnStarted echoed`, started.rejectionReason === undefined, String(started.rejectionReason));

  const calls = [];
  const byId = new Map();
  // Per-call record keyed by toolCallId. The execution request is the
  // source of truth for a client-executed call (it names the owning
  // client and the call, and the host keys the session request by the
  // same id), so it upserts the record even when the toolCallStart
  // envelope has not been consumed yet.
  const record = (id, name, contributor) => {
    let rec = byId.get(id);
    if (rec === undefined) {
      rec = { id, name: null, contributor: null, ready: null, exec: null, completeAccepted: false, confirmed: false };
      byId.set(id, rec);
      if (name === "ping") {
        calls.push(rec);
        check(
          `turn ${turnNo}: the ping call [${id}] carries the client contributor`,
          contributor?.kind === "client" && contributor?.clientId === clientId,
          `contributor=${JSON.stringify(contributor ?? null)}`,
        );
      } else if (name !== null) {
        console.log(`${TAG}   (turn ${turnNo}: model also called a server tool "${name}" — expected to have no contributor)`);
      }
    }
    if (name !== null) rec.name = name;
    if (contributor !== null) rec.contributor = contributor;
    return rec;
  };
  for (;;) {
    const env = await nextRelevant(isRelevant, `turn ${turnNo} progress`, deadline);
    const a = env.action;
    if (a.type === "chat/turnComplete" || a.type === "chat/turnError") {
      check(
        `turn ${turnNo}: completed`,
        a.type === "chat/turnComplete",
        a.type === "chat/turnError" ? `chat/turnError: ${JSON.stringify(a.part ?? null)}` : "chat/turnComplete",
      );
      return { calls, terminal: a };
    }
    if (a.type === "chat/toolCallStart") {
      record(a.toolCallId, a.toolName, a.contributor ?? null);
      continue;
    }
    if (a.type === "chat/toolCallReady") {
      const rec = byId.get(a.toolCallId);
      if (rec !== undefined) {
        rec.ready = a.confirmed;
        check(`turn ${turnNo}: toolCallReady [${rec.id}] confirms not-needed`, a.confirmed === "not-needed", String(a.confirmed));
      }
      continue;
    }
    if (a.type === "session/inputNeededSet" && a.request?.kind === "toolClientExecution") {
      const rec = record(a.request.id, a.request.toolCall?.toolName ?? null, a.request.toolCall?.contributor ?? null);
      rec.exec = a.request;
      check(
        `turn ${turnNo}: execution request [${rec.id}] names the owning client`,
        a.request.clientId === clientId && a.request.turnId === turnId && a.request.chat === chatURI && a.request.toolCall?.status === "running",
        JSON.stringify({ clientId: a.request.clientId, status: a.request.toolCall?.status }),
      );
      // The execution request does not raise InputNeeded — the turn
      // stays in progress while the client runs.
      const sessExec = (await sessionStatus());
      check(`turn ${turnNo}: session NOT InputNeeded while the client executes`, (sessExec & INPUT_NEEDED) === 0, `status=${sessExec}`);

      const decision = respond(rec.id);
      completeCall(turnId, rec.id, decision);
      const echo = await nextRelevant(
        (en) => en.action?.type === "chat/toolCallComplete" && en.action.toolCallId === rec.id,
        `toolCallComplete echo [${rec.id}]`,
        deadline,
      );
      rec.completeAccepted = echo.rejectionReason === undefined;
      check(`turn ${turnNo}: client toolCallComplete [${rec.id}] accepted`, rec.completeAccepted, String(echo.rejectionReason));
      if (decision.requiresResultConfirmation) {
        // The host upserts the same request id: the official session
        // reducer replaces by id, so the execution request becomes the
        // confirmation request with no inputNeededRemoved in between.
        const conf = await nextRelevant(
          (en) => en.action?.type === "session/inputNeededSet" && en.action.request?.kind === "toolConfirmation" && en.action.request.id === rec.id,
          `toolConfirmation [${rec.id}]`,
          deadline,
        );
        rec.confirmed = true;
        check(
          `turn ${turnNo}: confirmation request [${rec.id}] parks the call in pending-result-confirmation`,
          conf.action.request.toolCall?.status === "pending-result-confirmation",
          JSON.stringify(conf.action.request.toolCall?.status),
        );
        {
          const sess = await sessionSnapshot();
          const reqs = sess?.inputNeeded ?? [];
          check(
            `turn ${turnNo}: the execution request was replaced (single request, the confirmation)`,
            reqs.length === 1 && reqs[0].id === rec.id && reqs[0].kind === "toolConfirmation",
            JSON.stringify(reqs.map((r) => [r.id, r.kind])),
          );
        }
        const sessBlocked = (await sessionStatus());
        check(`turn ${turnNo}: session IS InputNeeded while the result awaits approval`, (sessBlocked & INPUT_NEEDED) === INPUT_NEEDED, `status=${sessBlocked}`);
        confirmResult(turnId, rec.id, true);
        const confEcho = await nextRelevant(
          (en) => en.action?.type === "chat/toolCallResultConfirmed" && en.action.toolCallId === rec.id,
          `toolCallResultConfirmed echo [${rec.id}]`,
          deadline,
        );
        check(`turn ${turnNo}: toolCallResultConfirmed [${rec.id}] accepted`, confEcho.rejectionReason === undefined, String(confEcho.rejectionReason));
        await nextRelevant(
          (en) => en.action?.type === "session/inputNeededRemoved" && en.action.id === rec.id,
          `inputNeededRemoved (confirmation) [${rec.id}]`,
          deadline,
        );
        const sessUnblocked = (await sessionStatus());
        check(`turn ${turnNo}: session unblocked after approval`, (sessUnblocked & INPUT_NEEDED) !== INPUT_NEEDED, `status=${sessUnblocked}`);
      } else {
        await nextRelevant(
          (en) => en.action?.type === "session/inputNeededRemoved" && en.action.id === rec.id,
          `inputNeededRemoved [${rec.id}]`,
          deadline,
        );
      }
      continue;
    }
    // Other relevant chatter (contentChanged, an unexpected request kind) — ignore.
  }
}

async function sessionSnapshot() {
  const sub = await request("subscribe", { channel: sessionURI });
  if (sub.error) throw new Error(`subscribe session: ${JSON.stringify(sub.error)}`);
  return sub.result?.snapshot?.state ?? null;
}

async function sessionStatus() {
  return (await sessionSnapshot())?.status ?? -1;
}

async function chatSnapshot() {
  const sub = await request("subscribe", { channel: chatURI });
  if (sub.error) throw new Error(`subscribe chat: ${JSON.stringify(sub.error)}`);
  return sub.result?.snapshot?.state;
}

function toolCallPart(state, turnId, callId) {
  const turn = (state?.turns ?? []).find((t) => t.id === turnId);
  const part = (turn?.responseParts ?? []).find((p) => p.kind === "toolCall" && p.toolCall?.toolCallId === callId);
  return part?.toolCall ?? null;
}

/** Number of toolCallComplete envelopes (any origin) for a call id. */
function completeCount(callId) {
  return (actionsByChannel.get(chatURI) ?? []).filter((a) => a.action?.type === "chat/toolCallComplete" && a.action.toolCallId === callId).length;
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

  const create = await request("createSession", {
    channel: opts.channel,
    provider: opts.provider,
    activeClient: { clientId, displayName: "client-tools probe", tools: [PING_TOOL] },
  });
  if (create.error) fail(1, `createSession: ${JSON.stringify(create.error)}`);
  check("createSession with the ping client tool", create.result === null, `channel ${opts.channel} provider ${opts.provider}`);

  const sessSub = await request("subscribe", { channel: opts.channel });
  if (sessSub.error) fail(1, `subscribe session: ${JSON.stringify(sessSub.error)}`);
  sessionURI = opts.channel;
  const activeClients = sessSub.result?.snapshot?.state?.activeClients ?? [];
  check(
    "session snapshot carries the active client with the tool",
    activeClients.some((c) => c.clientId === clientId && (c.tools ?? []).some((t) => t.name === "ping")),
    JSON.stringify(activeClients.map((c) => [c.clientId, (c.tools ?? []).map((t) => t.name)])),
  );
  chatURI = sessSub.result?.snapshot?.state?.defaultChat;
  if (typeof chatURI !== "string") fail(1, "session snapshot has no defaultChat");
  const chatSub = await request("subscribe", { channel: chatURI });
  if (chatSub.error) fail(1, `subscribe chat: ${JSON.stringify(chatSub.error)}`);

  // ── turn 1: happy path ──────────────────────────────────────────────────
  const turn1 = "turn-ct1-" + Date.now().toString(36);
  const r1 = await driveTurn(
    1,
    turn1,
    `Use the ping tool exactly once, with the argument {"note": "live-probe"}. Do not use any other tool, and do not read or write files. After the ping tool returns, reply with exactly: PONG-OK`,
    () => ({
      result: { success: true, pastTenseMessage: "Pinged the service", content: [{ type: "text", text: "pong: live-probe" }] },
    }),
  );
  check(
    "turn 1: the model called ping (direct) exactly once",
    r1.calls.length === 1 && r1.calls.every((c) => c.name === "ping"),
    `calls=${JSON.stringify(r1.calls.map((c) => c.name))}`,
  );
  for (const c of r1.calls) {
    check("turn 1: exactly one toolCallComplete (no opencode-side duplicate)", completeCount(c.id) === 1, `count=${completeCount(c.id)}`);
  }
  {
    const state = await chatSnapshot();
    const part = r1.calls.length > 0 ? toolCallPart(state, turn1, r1.calls[0].id) : null;
    check(
      "turn 1: snapshot tool call is completed with the client's result",
      part?.status === "completed" && part?.success === true && part?.pastTenseMessage === "Pinged the service",
      JSON.stringify({ status: part?.status, success: part?.success, past: part?.pastTenseMessage }),
    );
    check(
      "turn 1: snapshot tool call keeps the client contributor",
      part?.contributor?.kind === "client" && part?.contributor?.clientId === clientId,
      JSON.stringify(part?.contributor ?? null),
    );
    check(
      "turn 1: snapshot tool call carries the client's content",
      JSON.stringify(part?.content ?? null) === JSON.stringify([{ type: "text", text: "pong: live-probe" }]),
      JSON.stringify(part?.content ?? null),
    );
  }

  // ── turn 2: failed result ───────────────────────────────────────────────
  const turn2 = "turn-ct2-" + Date.now().toString(36);
  const r2 = await driveTurn(
    2,
    turn2,
    `Use the ping tool exactly once, with the argument {"note": "fail-probe"}. Do not use any other tool, and do not read or write files. The ping tool will fail — that is expected. After it returns, reply with exactly: DONE-FAIL`,
    () => ({
      result: { success: false, pastTenseMessage: "Pinged the service", error: { message: "probe failure: the service is down" } },
    }),
  );
  check("turn 2: the model called ping at least once", r2.calls.length >= 1, `calls=${r2.calls.length}`);
  for (const c of r2.calls) {
    check("turn 2: exactly one toolCallComplete", completeCount(c.id) === 1, `count=${completeCount(c.id)}`);
  }
  {
    const state = await chatSnapshot();
    const part = r2.calls.length > 0 ? toolCallPart(state, turn2, r2.calls[0].id) : null;
    check(
      "turn 2: snapshot tool call is completed with the client's failure",
      part?.status === "completed" && part?.success === false && typeof part?.error?.message === "string" && part.error.message.includes("probe failure"),
      JSON.stringify({ status: part?.status, success: part?.success, error: part?.error ?? null }),
    );
  }

  // ── turn 3: requiresResultConfirmation ──────────────────────────────────
  const turn3 = "turn-ct3-" + Date.now().toString(36);
  const r3 = await driveTurn(
    3,
    turn3,
    `Use the ping tool exactly once, with the argument {"note": "confirm-probe"}. Do not use any other tool, and do not read or write files. After the ping tool returns, reply with exactly: DONE-CONFIRM`,
    (id) => ({
      requiresResultConfirmation: true,
      result: { success: true, pastTenseMessage: "Pinged the service", content: [{ type: "text", text: "pong: confirm-probe" }] },
    }),
  );
  check("turn 3: the model called ping at least once", r3.calls.length >= 1, `calls=${r3.calls.length}`);
  for (const c of r3.calls) {
    check("turn 3: the completion went through result confirmation", c.confirmed === true, `confirmed=${c.confirmed}`);
    check("turn 3: exactly one toolCallComplete", completeCount(c.id) === 1, `count=${completeCount(c.id)}`);
  }
  {
    const state = await chatSnapshot();
    const part = r3.calls.length > 0 ? toolCallPart(state, turn3, r3.calls[0].id) : null;
    check(
      "turn 3: snapshot tool call is completed with the approved result",
      part?.status === "completed" && part?.success === true,
      JSON.stringify({ status: part?.status, success: part?.success }),
    );
    check(
      "turn 3: snapshot tool call carries the held client content",
      JSON.stringify(part?.content ?? null) === JSON.stringify([{ type: "text", text: "pong: confirm-probe" }]),
      JSON.stringify(part?.content ?? null),
    );
  }

  // ── final state ─────────────────────────────────────────────────────────
  {
    const state = await chatSnapshot();
    const turns = state?.turns ?? [];
    check(
      "chat snapshot has all three turns, all complete",
      turns.length === 3 && turns.every((t) => t.state === "complete"),
      `turns=${turns.map((t) => `${t.id}:${t.state}`).join(", ")}`,
    );
  }
} catch (e) {
  fail(1, e.message);
}

if (failures > 0) {
  console.error(`${TAG} ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`${TAG} OK: Phase 4 extension 1 (client tools) live verification passed`);
ws.close(1000);
process.exit(0);
