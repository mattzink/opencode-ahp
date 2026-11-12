#!/usr/bin/env node
/**
 * opencode-ahp LAN test server lifecycle (testing.md §3.1).
 *
 * Brings up the isolated test server that the live-verification scripts
 * (and the two-machine walkthrough) run against: an `opencode serve` on
 * :4098 with isolated XDG homes under /tmp/ahp-server/{data,state,cache},
 * serving the location /tmp/ahp-server/test-project. On a fresh scratch
 * dir it scaffolds that project itself (nothing is ever copied over):
 * .opencode/opencode.jsonc pinning this repo as a dev plugin with the AHP
 * host on 0.0.0.0:8767, an AHP token (random per fresh tree, or pinned
 * with --token), a 1-minute keep-alive touch interval, and event
 * capture on (logEvents), a .gitignore, `git init`, and an initial commit
 * of the scaffold so the working tree starts clean. By default it
 * also boots
 * the location — the one-time cold-boot step that starts the AHP listener
 * — and waits for healthz.
 *
 * Idempotent: an already-running test server is reused (its Basic-auth
 * password is recovered from the process environment), the project
 * scaffolding is only created when the location config is missing, and the
 * location boot (GET /api/location) is idempotent. The script generates
 * the Basic-auth password itself (OPENCODE_SERVER_PASSWORD) and prints it
 * — no stdout parsing, no lost boot-time lines.
 *
 * Dependency-free: Node ≥ 22 (fetch + child_process + fs + git only).
 *
 * Usage:
 *   node scripts/ahp-server.mjs [--port 4098] [--hostname 0.0.0.0]
 *     [--location-dir /tmp/ahp-server/test-project]
 *     [--scratch /tmp/ahp-server] [--token <value>]
 *     [--foreground] [--restart] [--stop] [--no-boot]
 *
 *   --location-dir defaults to <scratch>/test-project (pass --scratch to
 *   move the whole tree; the project follows unless --location-dir is set).
 *
 *   --token pins the AHP token written into the scaffolded project config
 *   (a stable PC B URL across re-scaffolds); without it a random token is
 *   generated per fresh tree.
 *
 *   (default)     ensure the server is up, boot the location, wait for the
 *                 AHP healthz, print a summary (Basic-auth password, AHP
 *                 URL with token, TUI command line, log path), and exit 0
 *                 with the server
 *                 left running detached.
 *   --foreground  same, but stays attached and tees the server log to this
 *                 console; Ctrl-C stops the server (the §3.1 flow).
 *   --restart     stop the running test server first, then start fresh.
 *   --stop        stop the running test server (refuses non-test processes;
 *                 isolated state is kept), exit 0.
 *   --no-boot     start/reuse the server but skip the location boot request
 *                 (and the healthz wait); the AHP host state is then
 *                 reported informationally only.
 *
 * Exit codes: 0 up/stopped · 1 location boot (or AHP healthz) failure ·
 * 2 setup failure (port conflict, spawn, ready timeout, config missing)
 */
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TAG = "[ahp-server]";
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
const has = (name) => argv.includes(name);

const opts = {
  port: Number(arg("--port", "4098")),
  hostname: arg("--hostname", "0.0.0.0"),
  scratch: arg("--scratch", "/tmp/ahp-server"),
  locationDir: null, // resolved below: <scratch>/test-project unless --location-dir
  token: null, // resolved below: --token value, or random per fresh scaffold
  foreground: has("--foreground"),
  restart: has("--restart"),
  stop: has("--stop"),
  noBoot: has("--no-boot"),
};
if (!Number.isInteger(opts.port) || opts.port <= 0) {
  fail(2, "--port must be a positive integer");
}
opts.locationDir = arg("--location-dir", path.join(opts.scratch, "test-project"));
if (has("--token")) {
  const t = arg("--token");
  if (typeof t !== "string" || t.length === 0) fail(2, "--token requires a non-empty value");
  opts.token = t;
}

const logFile = path.join(opts.scratch, "server.log");
const configPath = path.join(opts.locationDir, ".opencode", "opencode.jsonc");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── helpers ──────────────────────────────────────────────────────────────

/** Process listening on the port ({ pid, name }) or null. */
function pidOnPort(port) {
  let out;
  try {
    out = execFileSync("ss", ["-tlnp"], { encoding: "utf8" });
  } catch {
    return null;
  }
  const line = out
    .split("\n")
    .find((l) => l.startsWith("LISTEN") && new RegExp(`:${port}(\\s|$)`).test(l));
  if (!line) return null;
  const pid = (line.match(/pid=(\d+)/) ?? [])[1];
  const name = (line.match(/\(\("([^"]+)",pid=/) ?? [])[1];
  return pid ? { pid: Number(pid), name: name ?? "?" } : null;
}

/** One value from /proc/<pid>/environ ("" values are valid), or null. */
function readEnv(pid, key) {
  try {
    const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
    const entry = env.split("\0").find((e) => e.startsWith(key + "="));
    return entry ? entry.slice(key.length + 1) : null;
  } catch {
    return null;
  }
}

/** True when the process's XDG homes are under the scratch dir — i.e. it is the test server. */
function isTestServer(pid) {
  const xdg = readEnv(pid, "XDG_DATA_HOME");
  return xdg !== null && xdg.startsWith(opts.scratch);
}

/** This repo — the script lives in <repo>/scripts/, the plugin pin is the repo root. */
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/**
 * Scaffold the location project on a fresh scratch tree — only when the
 * location config is missing (an existing project is left untouched, git
 * repo or not). Creates .opencode/opencode.jsonc pinning this repo as a
 * dev plugin with the AHP host on 0.0.0.0:8767, an AHP token (random per
 * fresh tree, or the --token value when given), a 1-minute keep-alive
 * touch interval, and event capture on (logEvents — the server log gets
 * a timestamped event ok/dropped/unimplemented line per opencode event),
 * a .gitignore (keeps .opencode/ out of the git status the changeset
 * surface reads),
 * `git init`, and an initial commit of whatever is uncommitted — the
 * changeset surface reads git status, so the tree must start clean (the
 * notes.txt baseline stays with scripts/ahp-changesets.mjs). Nothing is
 * ever copied over from a previous tree.
 */
function ensureLocation() {
  fs.mkdirSync(opts.locationDir, { recursive: true });
  if (fs.existsSync(configPath)) return;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // R4: a non-loopback bind requires an explicit token. Fresh trees get a
  // random one; --token pins a stable value for the PC B URL.
  const ahpToken = opts.token ?? randomBytes(30).toString("base64url");
  fs.writeFileSync(
    configPath,
    `{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      // LAN test — dev checkout, AHP host on 0.0.0.0:8767, 1-minute
      // keep-alive touch interval, event capture on (testing.md §3.1).
      "package": ${JSON.stringify(repoRoot)},
      "options": {
        "host": "0.0.0.0",
        "port": 8767,
        "token": ${JSON.stringify(ahpToken)},
        "allowedOrigins": "*",
        "keepAliveIntervalMinutes": 1,
        "logEvents": true
      }
    }
  ]
}
`,
  );
  const gitignore = path.join(opts.locationDir, ".gitignore");
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, ".opencode/\n");
  const git = (...args) =>
    execFileSync("git", args, { cwd: opts.locationDir, encoding: "utf8", stdio: "pipe" });
  if (!fs.existsSync(path.join(opts.locationDir, ".git"))) {
    try {
      git("init");
    } catch (e) {
      fail(2, `git init failed in ${opts.locationDir}: ${e.message}`);
    }
  }
  // Commit the scaffold so the working tree starts clean: the changeset
  // surface reads git status, and an untracked .gitignore would surface
  // in the uncommitted changeset. Skipped when the tree is already clean
  // (a partial prior scaffold), which also keeps re-runs idempotent.
  try {
    if (git("status", "--porcelain").trim() !== "") {
      git("add", "-A");
      git(
        "-c", "user.name=ahp-test",
        "-c", "user.email=ahp-test@local",
        "commit", "-m", "scaffold: .gitignore",
      );
    }
  } catch (e) {
    fail(2, `git commit failed in ${opts.locationDir}: ${e.message}`);
  }
  console.log(`${TAG} scaffolded ${opts.locationDir} (opencode.jsonc + .gitignore + git init + initial commit)`);
}

/** AHP token + listener port from the location project's plugin options. */
function readAhpConfig() {
  let text;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch {
    fail(2, `location project config not found: ${configPath} (this should have been scaffolded — check ${opts.locationDir})`);
  }
  const token = (text.match(/"token"\s*:\s*"([^"]+)"/) ?? [])[1];
  const ahpPort = Number((text.match(/"port"\s*:\s*(\d+)/) ?? [])[1]);
  if (!token || !Number.isInteger(ahpPort) || ahpPort <= 0) {
    fail(2, `could not read token/port from ${configPath}`);
  }
  return { token, ahpPort };
}

function lanIp() {
  try {
    return execFileSync("hostname", ["-I"], { encoding: "utf8" }).trim().split(/\s+/)[0];
  } catch {
    return "127.0.0.1";
  }
}

function logTail(file, lines = 15) {
  try {
    return fs.readFileSync(file, "utf8").trim().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}

/** Poll until the URL answers; any status (even 401) proves it is up. */
async function waitForHttp(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      await res.body?.cancel();
      return res.status;
    } catch {
      if (Date.now() > deadline) throw new Error(`${label} not ready after ${timeoutMs} ms (${url})`);
      await sleep(250);
    }
  }
}

// ── stop ─────────────────────────────────────────────────────────────────

async function stopServer() {
  const proc = pidOnPort(opts.port);
  if (!proc) {
    console.log(`${TAG} nothing listening on :${opts.port} — nothing to stop`);
    return;
  }
  if (!isTestServer(proc.pid)) {
    fail(2, `pid ${proc.pid} (${proc.name}) on :${opts.port} is not the isolated test server (XDG homes not under ${opts.scratch}) — stop it manually`);
  }
  console.log(`${TAG} stopping test server (pid ${proc.pid}, :${opts.port})…`);
  try {
    process.kill(proc.pid, "SIGTERM");
  } catch (e) {
    fail(2, `SIGTERM failed: ${e.message}`);
  }
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    if (!pidOnPort(opts.port)) break;
  }
  if (pidOnPort(opts.port)) {
    console.log(`${TAG} still up after SIGTERM — sending SIGKILL`);
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch {
      // gone in the meantime
    }
    await sleep(500);
  }
  console.log(`${TAG} stopped. Isolated state kept under ${opts.scratch} (rm -rf it to wipe — testing.md §4.4).`);
}

if (opts.stop) {
  await stopServer();
  process.exit(0);
}

fs.mkdirSync(opts.scratch, { recursive: true });
for (const d of ["data", "state", "cache"]) fs.mkdirSync(path.join(opts.scratch, d), { recursive: true });

ensureLocation();
const { token, ahpPort } = readAhpConfig();

if (opts.restart) {
  const running = pidOnPort(opts.port);
  if (running) {
    if (!isTestServer(running.pid)) {
      fail(2, `pid ${running.pid} on :${opts.port} is not the isolated test server — stop it manually, then re-run`);
    }
    await stopServer();
  }
}

// ── start or reuse ───────────────────────────────────────────────────────

let child = null;
let logStream = null;
let mode; // "started" | "reused"
let pid;
let pw;

const existing = pidOnPort(opts.port);
if (existing) {
  if (existing.name !== "opencode") {
    fail(2, `:${opts.port} is occupied by ${existing.name} (pid ${existing.pid}) — stop it or use --port`);
  }
  if (!isTestServer(existing.pid)) {
    fail(2, `pid ${existing.pid} on :${opts.port} is an opencode server, but not the isolated test instance (XDG homes not under ${opts.scratch}) — stop it manually or use --port`);
  }
  pid = existing.pid;
  mode = "reused";
  pw = readEnv(pid, "OPENCODE_SERVER_PASSWORD");
  if (!pw) {
    fail(2, `the reused server (pid ${pid}) has no OPENCODE_SERVER_PASSWORD in its environment — its generated boot-time password is lost. Re-run with --restart for a fresh server.`);
  }
  console.log(`${TAG} test server already running (pid ${pid}, :${opts.port}) — reusing`);
} else {
  mode = "started";
  pw = randomBytes(32).toString("base64url");
  try {
    if (fs.existsSync(logFile)) fs.renameSync(logFile, logFile + ".prev");
  } catch {
    // rotation is best-effort
  }
  console.log(`${TAG} starting opencode serve --hostname ${opts.hostname} --port ${opts.port} (cwd ${opts.locationDir})`);
  const env = {
    ...process.env,
    XDG_DATA_HOME: path.join(opts.scratch, "data"),
    XDG_STATE_HOME: path.join(opts.scratch, "state"),
    XDG_CACHE_HOME: path.join(opts.scratch, "cache"),
    OPENCODE_SERVER_PASSWORD: pw,
  };
  const args = ["serve", "--hostname", opts.hostname, "--port", String(opts.port)];
  if (opts.foreground) {
    logStream = fs.createWriteStream(logFile, { flags: "a" });
    child = spawn("opencode", args, { cwd: opts.locationDir, env, stdio: ["ignore", "pipe", "pipe"] });
    const tee = (c) => {
      logStream.write(c);
      process.stdout.write(c);
    };
    child.stdout.on("data", tee);
    child.stderr.on("data", tee);
    // Install early so a Ctrl-C during the wait phases still stops the server.
    process.on("SIGINT", () => {
      console.log(`\n${TAG} stopping server (pid ${pid})…`);
      child.kill("SIGTERM");
      const bail = setTimeout(() => process.exit(0), 5000);
      bail.unref();
      child.once("close", () => {
        console.log(`${TAG} stopped`);
        process.exit(0);
      });
    });
  } else {
    const fd = fs.openSync(logFile, "a");
    child = spawn("opencode", args, { cwd: opts.locationDir, env, stdio: ["ignore", fd, fd], detached: true });
    child.unref();
  }
  pid = child.pid;
  child.on("error", (e) => fail(2, `spawn failed: ${e.message}`));
}

// Wait for the HTTP server to answer (any status, 401 included).
if (mode === "started") {
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) {
      fail(2, `server exited early (code ${child.exitCode}); log tail:\n${logTail(logFile)}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${opts.port}/api/location`);
      await res.body?.cancel();
      console.log(`${TAG} server up (pid ${pid}); first response HTTP ${res.status}`);
      break;
    } catch {
      if (Date.now() > deadline) fail(2, `server did not come up within 30000 ms; log tail:\n${logTail(logFile)}`);
      await sleep(250);
    }
  }
}

// ── boot the location (the one-time cold-boot step) ──────────────────────

const healthUrl = `http://127.0.0.1:${ahpPort}/healthz`;
let bootStatus = null;
let ahpStatus = null;

if (opts.noBoot) {
  console.log(`${TAG} --no-boot: skipping the location boot request`);
  try {
    const res = await fetch(healthUrl);
    await res.body?.cancel();
    ahpStatus = res.status;
  } catch {
    ahpStatus = null;
  }
  if (ahpStatus === 200) console.log(`${TAG} AHP host already up: ${healthUrl} → 200`);
  else console.log(`${TAG} AHP host not responding (${healthUrl}) — expected unless the location is booted separately`);
} else {
  const auth = "Basic " + Buffer.from(`opencode:${pw}`).toString("base64");
  let boot;
  try {
    boot = await fetch(
      `http://127.0.0.1:${opts.port}/api/location?location[directory]=${encodeURIComponent(opts.locationDir)}`,
      { headers: { authorization: auth } },
    );
  } catch (e) {
    fail(2, `location boot request failed: ${e.message}`);
  }
  const body = await boot.text().catch(() => "");
  bootStatus = boot.status;
  if (!boot.ok) {
    fail(1, `location boot failed: HTTP ${boot.status} ${body.slice(0, 200)}`);
  }
  console.log(`${TAG} location booted: GET /api/location → ${bootStatus}`);
  // The AHP listener starts as part of the location boot — wait for it.
  try {
    ahpStatus = await waitForHttp(healthUrl, 20000, "AHP host");
  } catch (e) {
    fail(1, `${e.message} — the location booted but the AHP listener never came up; log tail:\n${logTail(logFile)}`);
  }
  if (ahpStatus !== 200) fail(1, `AHP healthz returned ${ahpStatus} (expected 200)`);
  console.log(`${TAG} AHP host up: ${healthUrl} → 200`);
}

// ── summary ──────────────────────────────────────────────────────────────

const ip = lanIp();
const ahpUrl = `ws://${ip}:${ahpPort}/ahp`;
console.log("");
console.log(`${TAG} ── LAN test server ready ──`);
console.log(`${TAG}   opencode server : http://127.0.0.1:${opts.port}  (pid ${pid}, ${mode})`);
console.log(`${TAG}   basic auth      : opencode / ${pw}`);
console.log(
  `${TAG}   location        : ${opts.locationDir}` +
    (opts.noBoot ? "  (boot skipped — --no-boot)" : `  (booted: GET /api/location → ${bootStatus})`),
);
console.log(
  `${TAG}   tui             : OPENCODE_SERVER_PASSWORD=${pw} opencode --server http://127.0.0.1:${opts.port} ${opts.locationDir}`,
);
console.log(`${TAG}   AHP host        : ${ahpUrl}  (healthz ${ahpStatus === 200 ? "200" : ahpStatus ?? "no response"})`);
console.log(`${TAG}   PC B URL        : ${ahpUrl}?token=${token}`);
console.log(`${TAG}   log             : tail -f ${logFile}`);
console.log(`${TAG}   stop            : node scripts/ahp-server.mjs --stop  (or: kill ${pid})`);
if (ip !== "127.0.0.1") console.log(`${TAG}   firewall        : if PC B can't connect: sudo ufw allow ${ahpPort}/tcp`);

// ── foreground: stay attached ────────────────────────────────────────────

if (opts.foreground) {
  if (mode === "reused") {
    console.log(`${TAG} foreground: tailing ${logFile} from the current end (Ctrl-C to detach — the server keeps running)…`);
    let off = 0;
    try {
      off = fs.statSync(logFile).size;
    } catch {
      // log not written yet
    }
    setInterval(() => {
      try {
        const size = fs.statSync(logFile).size;
        if (size > off) {
          const fd = fs.openSync(logFile, "r");
          const buf = Buffer.alloc(size - off);
          fs.readSync(fd, buf, 0, buf.length, off);
          fs.closeSync(fd);
          process.stdout.write(buf);
          off = size;
        } else if (size < off) {
          off = size; // rotated/truncated
        }
      } catch {
        // transient — keep polling
      }
    }, 500);
    process.on("SIGINT", () => process.exit(0));
  } else {
    console.log(`${TAG} foreground: streaming the server log (Ctrl-C stops the server)…`);
    // The piped stdio keeps the event loop alive while the server runs;
    // the SIGINT handler installed at spawn stops it.
  }
} else {
  process.exit(0);
}
