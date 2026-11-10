#!/usr/bin/env node
/**
 * opencode-ahp event fixture capture.
 *
 * Boots a scratch location, opens the server's SSE event stream, runs one
 * small tool-using prompt, and records every V2Event envelope to a JSONL
 * fixture (one event per line, in arrival order) for the event→AHP
 * mapping tests (src/test/fixtures/).
 *
 * Uses the HTTP API with Basic auth (same mechanism `opencode api` uses;
 * the password comes from --password or $OPENCODE_SERVER_PASSWORD).
 *
 * Usage:
 *   node scripts/capture-events.mjs --server http://127.0.0.1:4097 \
 *     [--project /tmp/opencode/ahp-scratch/project] \
 *     [--model gpuz/qwen3.8-27b-q5xl] [--prompt "…"] \
 *     [--out src/test/fixtures/events.jsonl] [--timeout-ms 120000]
 *
 * Exit codes: 0 captured a terminal execution event · 1 setup failure ·
 * 2 timeout without a terminal event (the fixture is still written)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const TAG = "[capture]";
const fail = (code, msg) => {
  console.error(`${TAG} FAIL: ${msg}`);
  process.exit(code);
};

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};

const server = (arg("--server", "http://127.0.0.1:4097") ?? "").replace(/\/$/, "");
const project = arg("--project", "/tmp/opencode/ahp-scratch/project");
const modelRef = arg("--model", null); // "providerID/modelID"
const promptText = arg(
  "--prompt",
  "Use your bash tool to run exactly: echo hello-ahp — then reply with the command output.",
);
const out = arg("--out", "src/test/fixtures/events.jsonl");
const timeoutMs = Number(arg("--timeout-ms", "120000"));
const password = arg("--password", null) ?? process.env["OPENCODE_SERVER_PASSWORD"];
if (!password) fail(1, "no password (pass --password or set OPENCODE_SERVER_PASSWORD)");

const auth = { authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") };

async function api(method, path, body) {
  const res = await fetch(server + path, {
    method,
    headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) fail(1, `${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── 1. boot the location (loads config + plugins) ────────────────────────
const loc = await api("GET", `/api/location?location[directory]=${encodeURIComponent(project)}`);
if (!loc?.directory) fail(1, `location boot failed: ${JSON.stringify(loc).slice(0, 200)}`);
console.log(`${TAG} location: ${loc.directory} (project ${loc.project?.id})`);

// ── 2. create a session ──────────────────────────────────────────────────
const created = await api("POST", "/api/session", {
  title: "ahp-event-capture",
  location: { directory: loc.directory },
});
const sessionID = created?.data?.id;
if (!sessionID) fail(1, `session create failed: ${JSON.stringify(created).slice(0, 300)}`);
console.log(`${TAG} session: ${sessionID}`);

// ── 3. select the model ──────────────────────────────────────────────────
if (modelRef) {
  const [providerID, ...rest] = modelRef.split("/");
  const modelID = rest.join("/");
  // Model.Ref = { id, providerID, variant? } — `id` is the bare model ID.
  const sw = await api("POST", `/api/session/${sessionID}/model`, {
    model: { id: modelID, providerID },
  });
  console.log(`${TAG} model: ${modelRef} → ${JSON.stringify(sw).slice(0, 160)}`);
}

// ── 4. open the SSE event stream ─────────────────────────────────────────
const events = [];
const counts = new Map();
const terminalTypes = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);
const isTerminalForSession = (evt) => {
  if (!terminalTypes.has(evt.type)) return false;
  const d = evt.data ?? {};
  return d.sessionID === sessionID || evt.location?.directory === loc.directory;
};
let terminalSeen = false;
const record = (evt) => {
  events.push(evt);
  counts.set(evt.type, (counts.get(evt.type) ?? 0) + 1);
  if (!terminalSeen && isTerminalForSession(evt)) terminalSeen = true;
};

const sseRes = await fetch(server + "/api/event", { headers: auth });
if (!sseRes.ok || !sseRes.body) fail(1, `event stream failed: ${sseRes.status}`);
const reader = sseRes.body.getReader();
const decoder = new TextDecoder();
let sseBuf = "";

const streamDone = (async () => {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });
      let i;
      while ((i = sseBuf.indexOf("\n")) >= 0) {
        const line = sseBuf.slice(0, i).replace(/\r$/, "");
        sseBuf = sseBuf.slice(i + 1);
        if (!line.startsWith("data:")) continue; // skip heartbeats/comments
        try {
          record(JSON.parse(line.slice(5).trim()));
        } catch {
          console.error(`${TAG} bad SSE line: ${line.slice(0, 120)}`);
        }
      }
    }
  } catch {
    // stream closed
  }
})();

// ── 5. prompt + wait for a terminal execution event ──────────────────────
await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(), timeoutMs);
  const check = setInterval(() => {
    if (terminalSeen) {
      clearInterval(check);
      clearTimeout(timer);
      resolve();
    }
  }, 50);
  // Give the stream a moment to connect before prompting.
  setTimeout(async () => {
    console.log(`${TAG} prompt: ${promptText.slice(0, 80)}…`);
    try {
      await api("POST", `/api/session/${sessionID}/prompt`, { text: promptText });
    } catch (e) {
      console.error(`${TAG} prompt failed: ${e.message}`);
    }
  }, 1500);
});
// Stop reading the SSE stream (the server holds it open indefinitely).
try {
  await reader.cancel();
} catch {
  // already closed
}
await streamDone.catch(() => {});

// ── 6. write the fixture ─────────────────────────────────────────────────
mkdirSync(dirname(out), { recursive: true });
const header = {
  capturedAt: new Date().toISOString(),
  server,
  project: loc.directory,
  sessionID,
  model: modelRef,
  prompt: promptText,
  eventCount: events.length,
  terminalEvent: terminalSeen,
};
writeFileSync(
  out,
  JSON.stringify(header, null, 2) + "\n" + events.map((e) => JSON.stringify(e)).join("\n") + "\n",
);
console.log(`${TAG} wrote ${events.length} event(s) to ${out} (terminal: ${terminalSeen})`);

// ── 7. summary ───────────────────────────────────────────────────────────
console.log(`${TAG} event types:`);
for (const [type, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${TAG}   ${String(n).padStart(4)}  ${type}`);
}
process.exit(terminalSeen ? 0 : 2);
