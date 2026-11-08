#!/usr/bin/env node
/**
 * opencode-ahp hello-world AHP client (Phase 0 spike, plan §11).
 *
 * Dependency-free: Node ≥ 22 global WebSocket + fetch.
 *
 * Default mode: open a WebSocket, run the AHP lifecycle
 * (initialize → subscribe → ping), print every response, exit 0 on
 * success.
 *
 * Probe mode (`--probe`): exercise the transport's HTTP matrix without a
 * WebSocket handshake — healthz, token auth (401), Origin policy (403),
 * routing (404), and the 101 upgrade.
 *
 * Usage:
 *   node scripts/ahp-client.mjs --token <token> \
 *     [--base http://127.0.0.1:8765] [--path /ahp] [--health-path /healthz] \
 *     [--versions 1.0.0] [--subscribe ahp-root://]... [--initial ahp-root://]... \
 *     [--origin <origin>] [--expect-error -32005] [--probe] [--timeout-ms 5000]
 *
 * Exit codes: 0 success · 1 protocol failure · 2 connection failure
 */
import { randomBytes } from "node:crypto";
import net from "node:net";

const TAG = "[ahp-client]";
const fail = (code, msg) => {
  console.error(`${TAG} FAIL: ${msg}`);
  process.exit(code);
};

// ── argv ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const all = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name) out.push(argv[i + 1]);
  return out;
};
const has = (name) => argv.includes(name);

const opts = {
  base: (arg("--base", "http://127.0.0.1:8765") ?? "").replace(/\/$/, ""),
  path: arg("--path", "/ahp"),
  healthPath: arg("--health-path", "/healthz"),
  token: arg("--token", null),
  versions: (arg("--versions", "1.0.0") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  subscribe: all("--subscribe"),
  initial: all("--initial"),
  origin: arg("--origin", null),
  expectError: arg("--expect-error", null),
  timeoutMs: Number(arg("--timeout-ms", "5000")),
  probe: has("--probe"),
};
if (opts.versions.length === 0) {
  fail(2, "--versions must be a non-empty comma-separated semver list");
}
if (opts.subscribe.length === 0) opts.subscribe.push("ahp-root://");

const httpUrl = (p, qs) => `${opts.base}${p}${qs ? `?${qs}` : ""}`;
const wsUrl = (p, qs) => opts.base.replace(/^http/, "ws") + p + (qs ? `?${qs}` : "");

// ── raw HTTP helpers (status-line level, for 101 and header checks) ─────

/** Send a raw request, return { statusLine, headers } once the headers end. */
function rawRequest(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const host = u.host;
    const key = randomBytes(16).toString("base64");
    const lines = [
      `GET ${u.pathname}${u.search} HTTP/1.1`,
      `host: ${host}`,
      "upgrade: websocket",
      "connection: Upgrade",
      `sec-websocket-key: ${key}`,
      "sec-websocket-version: 13",
    ];
    for (const [k, v] of Object.entries(extraHeaders)) lines.push(`${k}: ${v}`);
    const sock = net.connect({ host: u.hostname, port: Number(u.port) }, () => {
      sock.write(lines.join("\r\n") + "\r\n\r\n");
    });
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("raw request timed out"));
    }, opts.timeoutMs);
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      const i = buf.indexOf("\r\n\r\n");
      if (i >= 0) {
        clearTimeout(timer);
        sock.end();
        const head = buf.slice(0, i);
        const [statusLine, ...rest] = head.split("\r\n");
        const headers = {};
        for (const l of rest) {
          const j = l.indexOf(":");
          if (j > 0) headers[l.slice(0, j).trim().toLowerCase()] = l.slice(j + 1).trim();
        }
        resolve({ statusLine, headers });
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// ── probe mode ───────────────────────────────────────────────────────────

async function probe() {
  let failures = 0;
  const check = (label, got, want) => {
    const ok = want.includes(got);
    console.log(`${TAG} ${ok ? "ok  " : "FAIL"} ${label}: got ${got}, expected one of [${want.join(", ")}]`);
    if (!ok) failures++;
  };

  // 1. healthz — no auth required
  const health = await fetch(httpUrl(opts.healthPath)).catch((e) => fail(2, `healthz fetch: ${e.message}`));
  check("healthz", String(health.status), ["200"]);

  // 2. AHP path without a token — the server always has a token (auto-generated)
  const noTok = await fetch(httpUrl(opts.path)).catch((e) => fail(2, `no-token fetch: ${e.message}`));
  check("ahp path, no token", String(noTok.status), ["401"]);

  // 3. AHP path with a wrong token
  const badTok = await fetch(httpUrl(opts.path, "token=definitely-wrong-token")).catch((e) =>
    fail(2, `bad-token fetch: ${e.message}`),
  );
  check("ahp path, wrong token", String(badTok.status), ["401"]);

  // 4. Unknown path
  const other = await fetch(httpUrl("/nope-ahp-client")).catch((e) => fail(2, `404 fetch: ${e.message}`));
  check("unknown path", String(other.status), ["404"]);

  // 5. Good token, no Origin (non-browser client) — must upgrade
  const tokenQs = "token=" + encodeURIComponent(opts.token);
  const up = await rawRequest(wsUrl(opts.path, tokenQs)).catch((e) => fail(2, `upgrade: ${e.message}`));
  const upStatus = Number(up.statusLine.split(" ")[1]);
  check("ahp path, good token, no Origin", String(upStatus), ["101"]);

  // 6. Good token + an explicit Origin — 403 when the server's allowedOrigins
  //    does not list it, 101 when it does (e.g. allowedOrigins: "*").
  const origin = opts.origin ?? "https://evil.example";
  const upOrigin = await rawRequest(wsUrl(opts.path, tokenQs), { origin }).catch((e) =>
    fail(2, `origin upgrade: ${e.message}`),
  );
  const upOriginStatus = Number(upOrigin.statusLine.split(" ")[1]);
  check(`ahp path, good token, Origin: ${origin}`, String(upOriginStatus), ["403", "101"]);

  if (failures > 0) fail(1, `${failures} probe check(s) failed`);
  console.log(`${TAG} probe: all checks passed`);
  process.exit(0);
}

// ── WebSocket AHP session ────────────────────────────────────────────────

function rpcSession(timeoutMs) {
  let nextId = 1;
  const pending = new Map();
  const notifications = [];

  const open = (ws) => {
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
      const id = msg.id;
      if (id !== undefined && pending.has(id)) {
        const p = pending.get(id);
        pending.delete(id);
        clearTimeout(p.timer);
        p.resolve(msg);
      } else {
        notifications.push(msg);
        console.log(`${TAG} notification: ${JSON.stringify(msg)}`);
      }
    });
  };

  return {
    notifications,
    request(ws, method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout waiting for "${method}" response`));
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },
    attach: open,
  };
}

async function session() {
  const rpc = rpcSession(opts.timeoutMs);
  const tokenQs = opts.token ? "token=" + encodeURIComponent(opts.token) : null;
  const url = wsUrl(opts.path, tokenQs);

  console.log(`${TAG} connecting ${url}${opts.origin ? ` (Origin: ${opts.origin})` : " (no Origin)"}`);
  const ws = new WebSocket(url, opts.origin ? { headers: { origin: opts.origin } } : undefined);
  rpc.attach(ws);

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
      reject(new Error(`websocket closed before open (code ${e.code})`));
    });
  });

  try {
    await openPromise;
    console.log(`${TAG} connected`);
  } catch (e) {
    fail(2, e.message);
  }

  const finish = (code) => {
    try {
      ws.close(1000);
    } catch {
      // already closed
    }
    process.exit(code);
  };

  // 1. initialize
  const clientId = "client-" + randomBytes(6).toString("hex");
  const initParams = {
    channel: "ahp-root://",
    clientId,
    protocolVersions: opts.versions,
  };
  if (opts.initial.length > 0) initParams.initialSubscriptions = opts.initial;
  console.log(`${TAG} initialize (protocolVersions: ${JSON.stringify(opts.versions)})`);

  let init;
  try {
    init = await rpc.request(ws, "initialize", initParams);
  } catch (e) {
    fail(2, e.message);
  }

  if (init.error) {
    console.log(`${TAG} initialize error: ${JSON.stringify(init.error, null, 2)}`);
    if (opts.expectError !== null && Number(opts.expectError) === init.error.code) {
      console.log(`${TAG} PASS (expected error code ${init.error.code})`);
      finish(0);
    }
    finish(1, `initialize failed with code ${init.error.code}`);
  }

  console.log(`${TAG} initialize result: ${JSON.stringify(init.result, null, 2)}`);
  const version = init.result.protocolVersion;
  if (!version) finish(1, "initialize result has no protocolVersion");
  console.log(`${TAG} negotiated protocol version: ${version}`);

  // 2. subscribe (each URI; a root snapshot carries the catalog)
  let rootSnapshot = null;
  for (const uri of opts.subscribe) {
    let res;
    try {
      res = await rpc.request(ws, "subscribe", { channel: uri });
    } catch (e) {
      fail(2, e.message);
    }
    if (res.error) {
      console.log(`${TAG} subscribe ${uri} error: ${JSON.stringify(res.error)}`);
      finish(1, `subscribe ${uri} failed`);
    }
    const snap = res.result?.snapshot;
    console.log(`${TAG} subscribe ${uri}: ${snap ? "snapshot" : "no snapshot"}`);
    if (snap) console.log(`${TAG} snapshot: ${JSON.stringify(snap, null, 2)}`);
    if (uri === "ahp-root://" && snap) rootSnapshot = snap;
  }

  // 3. ping
  try {
    const ping = await rpc.request(ws, "ping", {});
    if (ping.error) {
      console.log(`${TAG} ping error: ${JSON.stringify(ping.error)}`);
      finish(1, "ping failed");
    }
    console.log(`${TAG} ping: ${JSON.stringify(ping.result ?? null)}`);
  } catch (e) {
    fail(2, e.message);
  }

  // 4. summary
  if (rootSnapshot) {
    const agents = rootSnapshot.state?.agents ?? [];
    const modelCount = agents.reduce((n, a) => n + (a.models?.length ?? 0), 0);
    console.log(
      `${TAG} OK: ${agents.length} agent(s), ${modelCount} model(s) in the root snapshot ` +
        `(fromSeq ${rootSnapshot.fromSeq})`,
    );
  }
  console.log(`${TAG} OK: session complete (${rpc.notifications.length} action notification(s) observed)`);
  finish(0);
}

// ── main ─────────────────────────────────────────────────────────────────

if (opts.probe) {
  if (!opts.token) fail(2, "--probe requires --token");
  await probe();
} else {
  await session();
}
