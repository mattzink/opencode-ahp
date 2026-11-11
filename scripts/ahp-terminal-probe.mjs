#!/usr/bin/env node
/**
 * opencode-ahp live pty terminal probe (testing.md §3.2).
 *
 * Exercises the interactive terminal surface end-to-end against the LAN
 * test server: initialize → createTerminal (spawn a real shell pty) →
 * root catalog row → subscribe snapshot → terminal/input (expect the
 * shell's echo/output back as terminal/data) → terminal/resized →
 * disposeTerminal (kill, final terminal/exited, catalog row drops).
 *
 * Dependency-free: Node ≥ 22 global WebSocket.
 *
 * Usage:
 *   node scripts/ahp-terminal-probe.mjs --token <token> \
 *     [--base http://127.0.0.1:8767] [--path /ahp] \
 *     [--project-dir /tmp/ahp-server/test-project] [--timeout-ms 10000]
 *
 * Exit codes: 0 all checks passed · 1 protocol failure · 2 connection failure
 */
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";

const TAG = "[ahp-terminal-probe]";
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
  projectDir: arg("--project-dir", null),
  timeoutMs: Number(arg("--timeout-ms", "10000")),
};
if (!opts.token) fail(2, "--token is required");
if (opts.projectDir && !isAbsolute(opts.projectDir)) fail(2, "--project-dir must be an absolute path");

const wsUrl = opts.base.replace(/^http/, "ws") + opts.path + "?token=" + encodeURIComponent(opts.token);

let failures = 0;
const check = (what, cond, detail = "") => {
  if (cond) {
    console.log(`${TAG} ok: ${what}`);
  } else {
    failures++;
    console.error(`${TAG} CHECK FAILED: ${what}${detail ? ` — ${detail}` : ""}`);
  }
};

// ── WebSocket AHP session (the ahp-client.mjs idiom) ──────────────────────

function rpcSession(timeoutMs) {
  let nextId = 1;
  const pending = new Map();
  const notifications = [];

  return {
    notifications,
    /** Attach the single message listener (call once after open). */
    attach(ws) {
      ws.addEventListener("message", (ev) => {
        let text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg);
        } else {
          notifications.push(msg);
        }
      });
    },
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
    /** Send a notification (no response — dispatchAction is a stream). */
    notify(ws, method, params) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    },
  };
}

/** Poll the collected notifications for one matching the predicate. */
async function waitForNotification(rpc, pred, what, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = rpc.notifications.find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) fail(1, `timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const actionNotifications = (rpc, channel) =>
  rpc.notifications.filter((m) => m.method === "action" && m.params?.channel === channel).map((m) => m.params);

const fileUri = (p) => "file://" + p;

// ── the probe ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`${TAG} connecting ${wsUrl}`);
  const ws = new WebSocket(wsUrl);
  const openPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket open timeout")), opts.timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket error"));
    });
    ws.addEventListener("close", (e) => {
      clearTimeout(timer);
      reject(new Error(`websocket closed before open (code ${e.code})`));
    });
  });
  try {
    await openPromise;
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

  const rpc = rpcSession(opts.timeoutMs);
  rpc.attach(ws);
  const clientId = "terminal-probe-" + randomBytes(4).toString("hex");

  // 1. initialize (subscribe to the root for the catalog stream).
  const init = await rpc.request(ws, "initialize", {
    channel: "ahp-root://",
    clientId,
    protocolVersions: ["1.0.0"],
    initialSubscriptions: ["ahp-root://"],
  });
  if (init.error) fail(1, `initialize failed: ${JSON.stringify(init.error)}`);
  console.log(`${TAG} initialize ok (server ${init.result.serverInfo.name} ${init.result.serverInfo.version})`);

  // 2. createTerminal — a client-chosen channel, client claim, the
  //    location's cwd, an explicit size.
  const terminalURI = "agenthost-terminal://probe-" + randomBytes(6).toString("hex");
  const create = await rpc.request(ws, "createTerminal", {
    channel: terminalURI,
    claim: { kind: "client", clientId },
    name: "probe shell",
    cwd: opts.projectDir ? fileUri(opts.projectDir) : undefined,
    cols: 100,
    rows: 30,
  });
  if (create.error) fail(1, `createTerminal failed: ${JSON.stringify(create.error)}`);
  check("createTerminal result is null", create.result === null, JSON.stringify(create.result));

  // 3. The root catalog gets a row for the new pty.
  const row = await waitForNotification(
    rpc,
    (m) => m.method === "action" && m.params?.channel === "ahp-root://" &&
      m.params.action.type === "root/terminalsChanged" &&
      (m.params.action.terminals ?? []).some((t) => t.resource === terminalURI),
    "root/terminalsChanged row for the pty",
    opts.timeoutMs,
  );
  check(
    "catalog row shape",
    row.params.action.terminals.find((t) => t.resource === terminalURI)?.title === "probe shell" &&
      row.params.action.terminals.find((t) => t.resource === terminalURI)?.lifecycle.status === "running",
    JSON.stringify(row.params.action.terminals),
  );

  // 4. Subscribe → snapshot: the pty state.
  const sub = await rpc.request(ws, "subscribe", { channel: terminalURI });
  if (sub.error) fail(1, `subscribe failed: ${JSON.stringify(sub.error)}`);
  const state = sub.result.snapshot.state;
  check("snapshot isPty", state.isPty === true, JSON.stringify(state));
  check("snapshot title", state.title === "probe shell", String(state.title));
  check("snapshot cols/rows", state.cols === 100 && state.rows === 30, `${state.cols}x${state.rows}`);
  check(
    "snapshot cwd is a directory URI",
    typeof state.cwd === "string" && state.cwd.startsWith("file://") && state.cwd.endsWith("/"),
    String(state.cwd),
  );
  check("snapshot lifecycle running", state.lifecycle.status === "running", JSON.stringify(state.lifecycle));

  // 5. terminal/input — the shell must echo the command and run it.
  const marker = "ahp-pty-probe-" + randomBytes(2).toString("hex");
  // dispatchAction is a notification (the action stream is the reply).
  rpc.notify(ws, "dispatchAction", {
    channel: terminalURI,
    clientSeq: 1,
    action: { type: "terminal/input", data: `echo ${marker}\r` },
  });
  const inputEcho = await waitForNotification(
    rpc,
    (m) => actionNotifications(rpc, terminalURI).some((a) => a.action.type === "terminal/input" && a.rejectionReason === undefined),
    "accepted terminal/input echo",
    opts.timeoutMs,
  );
  check("terminal/input accepted", inputEcho !== undefined);
  // The pty stream carries the shell's prompt machinery (ANSI colors,
  // bracketed-paste sequences, prompt redraws — they vary per shell/PS1),
  // so strip it before matching: OSC title sequences, CSI sequences, and
  // the pty's onlcr CRLF → LF. The finished exchange then reduces to the
  // typed command line (pty echo) and the shell's own output line
  // (marker alone on its line — proving the shell ran the command).
  const dataStream = () =>
    actionNotifications(rpc, terminalURI)
      .filter((a) => a.action.type === "terminal/data")
      .map((a) => a.action.data)
      .join("")
      .replace(/\u001b\][^\u0007]*\u0007/g, "") // OSC (e.g. xterm title)
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "") // CSI (colors, bracketed paste)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "");
  const expected = `\n${marker}\n`;
  const deadline = Date.now() + opts.timeoutMs;
  while (!dataStream().includes(expected) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  check("shell echoed the command and produced output", dataStream().includes(expected), "command output line never arrived");

  // 6. terminal/resized — the process resizes and the state tracks it.
  rpc.notify(ws, "dispatchAction", {
    channel: terminalURI,
    clientSeq: 2,
    action: { type: "terminal/resized", cols: 120, rows: 40 },
  });
  await waitForNotification(
    rpc,
    (m) => actionNotifications(rpc, terminalURI).some((a) => a.action.type === "terminal/resized" && a.rejectionReason === undefined),
    "accepted terminal/resized echo",
    opts.timeoutMs,
  );
  const sub2 = await rpc.request(ws, "subscribe", { channel: terminalURI });
  check("state tracks the resize", sub2.result.snapshot.state.cols === 120 && sub2.result.snapshot.state.rows === 40, `${sub2.result.snapshot.state.cols}x${sub2.result.snapshot.state.rows}`);

  // 7. disposeTerminal — kill, final terminal/exited, catalog row drops.
  const dispose = await rpc.request(ws, "disposeTerminal", { channel: terminalURI });
  if (dispose.error) fail(1, `disposeTerminal failed: ${JSON.stringify(dispose.error)}`);
  check("disposeTerminal result is null", dispose.result === null, JSON.stringify(dispose.result));
  await waitForNotification(
    rpc,
    (m) => actionNotifications(rpc, terminalURI).some((a) => a.action.type === "terminal/exited"),
    "final terminal/exited",
    opts.timeoutMs,
  );
  await waitForNotification(
    rpc,
    (m) => m.method === "action" && m.params?.channel === "ahp-root://" &&
      m.params.action.type === "root/terminalsChanged" &&
      !(m.params.action.terminals ?? []).some((t) => t.resource === terminalURI),
    "catalog row drop",
    opts.timeoutMs,
  );
  check("catalog row dropped", true);

  if (failures > 0) finish(1, `${failures} check(s) failed`);
  console.log(`${TAG} terminal probe: all checks passed`);
  finish(0);
}

main().catch((e) => fail(1, e.stack ?? e.message));
