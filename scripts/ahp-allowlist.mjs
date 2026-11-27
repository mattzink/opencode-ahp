#!/usr/bin/env node
/**
 * opencode-ahp live verification: the directory allowlist
 * (`allowedWorkingDirectories`) end to end (design.md §3.3) — against the
 * LAN test server, whose scaffolded location config pins the allowlist to
 * `[<scratch>, "/home"]` (ahp-server.mjs; scratch defaults to
 * `/tmp/ahp-server` — narrowed on purpose, so the rest of /tmp stays a
 * deny surface).
 *
 * The allowlist gates the client-named path surfaces:
 *   `createSession.workingDirectories` and the unconfined `resource*`
 *   commands (`resourceResolve` / `resourceList` / `resourceMkdir`).
 * `resourceRead` stays per-session-confined (NOT policy-gated).
 *
 * Checks:
 *   1. initialize (root subscription)
 *   2. positive control: resourceList under a prefix (the scratch tree) →
 *      the exact sorted entries
 *   3. outside the prefixes → flat -32009 "path is not permitted by host
 *      policy": resourceList file:///etc, resourceResolve
 *      file:///etc/hostname (the SAME message — no existence oracle), and
 *      resourceList file:///tmp (the PARENT of the allowed scratch prefix
 *      — the narrowing assertion)
 *   4. resourceMkdir outside the prefixes → -32009 + the directory was
 *      NOT created (local probe)
 *   5. symlink escape: a local symlink under a prefix pointing outside
 *      (/tmp/… → /etc) → resourceList -32009 (the RESOLVED form is
 *      checked); a symlink that stays inside → the entries
 *   6. createSession with workingDirectories outside the prefixes (an
 *      existing dir — /etc — and a missing dir outside the scratch prefix
 *      — /tmp/ahp-no-such-dir) → flat -32009 "working directory is not
 *      permitted by host policy", before any location boot
 *   7. createSession with workingDirectories under a prefix (a fresh
 *      scratch dir, created via resourceMkdir — the positive mkdir
 *      control) → null + root sessionAdded; a session WITHOUT
 *      workingDirectories still runs in the plugin's own location (the
 *      location directory is not policy-gated)
 *
 * The probe directory and symlinks are script-owned scratch: removed at
 * the start of every run; the symlinks are removed at the end.
 *
 * Dependency-free: Node ≥ 22 global WebSocket.
 *
 * Usage:
 *   node scripts/ahp-allowlist.mjs --token <token> \
 *     [--base http://127.0.0.1:8767] [--path /ahp] \
  *     [--provider opencode] \
 *     [--scratch /tmp/ahp-server] [--timeout-ms 120000]
 *
 * Exit codes: 0 success · 1 protocol/verification failure · 2 connection
 */
import { rmSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const TAG = "[ahp-allowlist]";
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
  provider: arg("--provider", "opencode"),
  scratch: arg("--scratch", "/tmp/ahp-server"),
  timeoutMs: Number(arg("--timeout-ms", "120000")),
};
if (!opts.token) fail(2, "--token is required");

const PROBE = join(opts.scratch, "allowlist-probe");
const LINK_OUT = join(opts.scratch, "allowlist-escape"); // → /etc (must be denied)
const LINK_IN = join(opts.scratch, "allowlist-inside"); // → the scratch root (must pass)
const fileUri = (p) => "file://" + p;
const dirUri = (p) => "file://" + (p.endsWith("/") ? p : p + "/");
// Unique per run: a session channel is host-unique for the location's
// lifetime (no client-side delete), so a fixed channel would collide with
// the previous run's still-registered session on a re-run without a reload.
const sessionURI = "ahp-session:/allowlist-" + randomBytes(4).toString("hex");
const sessionURI2 = "ahp-session:/allowlist-" + randomBytes(4).toString("hex");

// Script-owned scratch: a fresh probe tree, no stale symlinks (rmSync with
// recursive+force removes the link itself, never follows it, and ignores
// missing paths).
for (const p of [PROBE, LINK_OUT, LINK_IN]) {
  rmSync(p, { recursive: true, force: true });
}

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${TAG} ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── AHP session (single connection, no reconnect phase) ───────────────────

let ws = null;
let nextId = 1;
const pending = new Map();
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
    const a = msg.params?.action;
    console.log(`${TAG}   action ${msg.params?.channel} seq=${msg.params?.serverSeq} ${a?.type}`);
    return;
  }
  rootNotifications.push(msg);
  console.log(`${TAG}   notification ${msg.method}: ${JSON.stringify(msg.params ?? null).slice(0, 200)}`);
}

function connect() {
  const wsUrl = opts.base.replace(/^http/, "ws") + opts.path + "?token=" + encodeURIComponent(opts.token);
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

try {
  await connect();
  console.log(`${TAG} connected to ${opts.base}${opts.path}`);

  // 1. initialize.
  const clientId = "allowlist-" + randomBytes(4).toString("hex");
  const init = await request("initialize", {
    channel: "ahp-root://",
    clientId,
    protocolVersions: ["1.1.0", "1.0.0"],
    initialSubscriptions: ["ahp-root://"],
  });
  check("initialize", init.result !== undefined && init.result.protocolVersion === "1.1.0");

  const POLICY_MSG = "path is not permitted by host policy";
  const SESSION_POLICY_MSG = "working directory is not permitted by host policy";

  // 2. Positive control: a listing under a prefix.
  const list = await request("resourceList", { uri: dirUri(opts.scratch) });
  check(
    "resourceList under a prefix → entries (positive control)",
    list.error === undefined &&
      Array.isArray(list.result?.entries) &&
      list.result.entries.some((e) => e.name === "test-project" && e.type === "directory"),
  );

  // 3. Outside the prefixes: flat -32009, the same message for every
  //    denied path (no existence oracle).
  const den1 = await request("resourceList", { uri: dirUri("/etc") });
  check(
    "resourceList /etc → -32009 (flat policy message)",
    den1.error?.code === -32009 && den1.error?.message === POLICY_MSG,
    `code=${den1.error?.code} message=${den1.error?.message}`,
  );
  const den2 = await request("resourceResolve", { uri: fileUri("/etc/hostname") });
  check(
    "resourceResolve /etc/hostname → -32009 (same message — no oracle)",
    den2.error?.code === -32009 && den2.error?.message === POLICY_MSG,
  );
  // The allowlist is narrowed to the scratch tree, not all of /tmp: the
  // parent of the allowed prefix is denied too (otherwise /tmp/… siblings
  // would leak).
  const den3 = await request("resourceList", { uri: dirUri("/tmp") });
  check(
    `resourceList /tmp (parent of the ${opts.scratch} prefix) → -32009`,
    den3.error?.code === -32009 && den3.error?.message === POLICY_MSG,
    `code=${den3.error?.code} message=${den3.error?.message}`,
  );

  // 4. resourceMkdir outside the prefixes: denied, nothing created.
  const denMkdir = await request("resourceMkdir", { uri: dirUri("/etc/ahp-allowlist-probe") });
  check(
    "resourceMkdir /etc/… → -32009 and the directory was NOT created",
    denMkdir.error?.code === -32009 && !existsSync("/etc/ahp-allowlist-probe"),
  );

  // 5. Symlink handling: the RESOLVED form is what is checked.
  symlinkSync("/etc", LINK_OUT);
  const denLink = await request("resourceList", { uri: dirUri(LINK_OUT) });
  check(
    "symlink under a prefix → outside: resourceList -32009 (resolved form)",
    denLink.error?.code === -32009 && denLink.error?.message === POLICY_MSG,
  );
  symlinkSync(opts.scratch, LINK_IN);
  const okLink = await request("resourceList", { uri: dirUri(LINK_IN) });
  check(
    "symlink under a prefix → inside: resourceList → entries",
    okLink.error === undefined && Array.isArray(okLink.result?.entries),
  );

  // 6. createSession: working directories outside the prefixes are denied
  //    BEFORE any location boot (both an existing and a missing target —
  //    the flat message either way; the missing target sits outside the
  //    scratch prefix, where the policy decides before opencode could
  //    answer ENOENT).
  const denSess = await request("createSession", {
    channel: sessionURI,
    provider: opts.provider,
    workingDirectories: [dirUri("/etc")],
  });
  check(
    "createSession workingDirectories /etc → -32009 (flat session policy message)",
    denSess.error?.code === -32009 && denSess.error?.message === SESSION_POLICY_MSG,
    `code=${denSess.error?.code} message=${denSess.error?.message}`,
  );
  const denSess2 = await request("createSession", {
    channel: sessionURI,
    provider: opts.provider,
    workingDirectories: [dirUri("/tmp/ahp-no-such-dir")],
  });
  check(
    "createSession workingDirectories (missing, outside) → same -32009 (no oracle)",
    denSess2.error?.code === -32009 && denSess2.error?.message === SESSION_POLICY_MSG,
  );

  // 7. Positive: a fresh scratch dir under a prefix (created by the
  //    dogfooded resourceMkdir — the positive mkdir control) hosts a
  //    session; and a session WITHOUT workingDirectories still runs in
  //    the plugin's own location (the location directory is not gated).
  const mkProbe = await request("resourceMkdir", { uri: dirUri(PROBE) });
  check("resourceMkdir under a prefix → {} (positive mkdir control)", mkProbe.error === undefined);
  const okSess = await request("createSession", {
    channel: sessionURI,
    provider: opts.provider,
    workingDirectories: [dirUri(PROBE)],
  });
  check("createSession workingDirectories under a prefix → null", okSess.error === undefined, `error=${JSON.stringify(okSess.error ?? null)}`);
  await waitFor(
    () => rootNotifications.some((n) => n.method === "root/sessionAdded" && n.params?.summary?.resource === sessionURI),
    "root/sessionAdded for the allowlisted session",
  );
  const added = rootNotifications.find((n) => n.method === "root/sessionAdded" && n.params?.summary?.resource === sessionURI);
  check(
    "sessionAdded summary.workingDirectories carries the target",
    added.params.summary.workingDirectories?.[0] === dirUri(PROBE),
  );
  const okSess2 = await request("createSession", { channel: sessionURI2, provider: opts.provider });
  check(
    "createSession without workingDirectories → the plugin's own location (not gated)",
    okSess2.error === undefined,
    `error=${JSON.stringify(okSess2.error ?? null)}`,
  );
  await waitFor(
    () => rootNotifications.some((n) => n.method === "root/sessionAdded" && n.params?.summary?.resource === sessionURI2),
    "root/sessionAdded for the own-location session",
  );

  ws.close();
} catch (e) {
  fail(1, String(e?.message ?? e));
} finally {
  for (const p of [LINK_OUT, LINK_IN]) {
    rmSync(p, { recursive: true, force: true });
  }
}

if (failures > 0) {
  fail(1, `${failures} check(s) failed`);
}
console.log(`${TAG} all checks passed`);
process.exit(0);
