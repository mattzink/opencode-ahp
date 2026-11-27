#!/usr/bin/env node
/**
 * opencode-ahp live verification: working directories (cross-location
 * sessions) end to end — the surface that makes VS Code "add projects"
 * work: the `resource*` commands the folder picker drives plus
 * `createSession.workingDirectories` (design.md §7.3).
 *
 * resource* (root commands; token-authenticated, NOT location-confined):
 *   1. initialize (root subscription)
 *   2. resourceMkdir file://target/ → {} (the target directory is
 *      created by the dogfooded command itself) + a local probe.txt
 *   3. resourceResolve: file (size + exact etag + exact uri), directory
 *      (trailing-slash URI in → trailing-slash uri out, type directory),
 *      symlink follow vs followSymlinks:false (type symlink), missing →
 *      -32008, non-file URI → -32602
 *   4. permission probe (skipped as root): noaccess/ chmod 000 →
 *      resolve-inside + list → -32009 (chmod restored before git)
 *   5. resourceMkdir parents (nested/deep) → {}; resourceList → the
 *      exact sorted entries (runs BEFORE git init so .git is absent);
 *      list missing → -32008, list on a file → -32602, mkdir onto a
 *      file → -32010, mkdir existing dir → {} no-op
 *   6. git fixture: notes.txt baseline + git init + commit (a clean
 *      changeset baseline in the target, which is its own repo)
 *
 * workingDirectories (createSession):
 *   7. createSession with workingDirectories [file://target/] (the
 *      trailing slash exercises the host's strip) → null; wait the root
 *      sessionAdded → summary.workingDirectories; subscribe the session
 *      → state.workingDirectories + defaultChat + the directory
 *      customization; listSessions → the item; malformed workingDirectories
 *      → -32602
 *   8. changeset confinement: subscribe the chat (catalogues) + the
 *      uncommitted changeset (ready, files: [] — clean tree via the
 *      cross-location git fallback); dispatch the same deterministic
 *      file-editing turn as ahp-changesets → turnComplete (proves the
 *      cross-location AHP tracking); the turn-end refresh surfaces
 *      notes.txt in the uncommitted changeset with the before ref
 *      ahp-content://head/<b64url(target/notes.txt)> — the decisive
 *      cross-location assertion — + the discard op; resourceRead file://
 *      target (live disk) vs file:///etc/passwd (-32009, outside);
 *      subscribe the turn changeset → snap refs; resourceRead before
 *      snap === the exact baseline
 *   9. terminal: createTerminal with a session claim (session + chat)
 *      and cwd file:///etc (out of bounds → must clamp) → snapshot
 *      isPty + cwd === file://target/ (the session's own directory);
 *      terminal/input pwd → the stream carries the target path;
 *      disposeTerminal → terminal/exited
 *
 * The target directory is script-owned scratch: it is removed (and
 * recreated) at the start of every run.
 *
 * Dependency-free: Node ≥ 22 global WebSocket.
 *
 * Usage:
 *   node scripts/ahp-working-dirs.mjs --token <token> \
 *     [--base http://127.0.0.1:8767] [--path /ahp] \
 *     [--scratch /tmp/ahp-server] [--target-dir /tmp/ahp-server/wd-probe] \
 *     [--provider opencode] [--timeout-ms 120000]
 *
 * Exit codes: 0 success · 1 protocol/verification failure · 2 connection
 */
import { rmSync, mkdirSync, writeFileSync, readFileSync, statSync, chmodSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const TAG = "[ahp-working-dirs]";
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
  scratch: arg("--scratch", "/tmp/ahp-server"),
  targetDir: arg("--target-dir", "/tmp/ahp-server/wd-probe"),
  provider: arg("--provider", "opencode"),
  timeoutMs: Number(arg("--timeout-ms", "120000")),
};
if (!opts.token) fail(2, "--token is required");

const TARGET = opts.targetDir;
const fileUri = (p) => "file://" + p;
const dirUri = (p) => "file://" + (p.endsWith("/") ? p : p + "/");
const PROBE_TXT = join(TARGET, "probe.txt");
const PROBE_TXT_CONTENT = "hello\n";
const LINK = join(TARGET, "link");
const NOACCESS = join(TARGET, "noaccess");
const NESTED_DEEP = join(TARGET, "nested", "deep");
const FILE = join(TARGET, "notes.txt");
const FILE_BEFORE = "line1\nline2\n";
const b64 = (s) => Buffer.from(s, "utf-8").toString("base64");
const b64url = (s) =>
  Buffer.from(s, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const headRef = `ahp-content://head/${b64url(FILE)}`;
const fileRef = fileUri(FILE);
// Unique per run: a session channel is host-unique for the location's
// lifetime (no client-side delete), so a fixed channel would collide with
// the previous run's still-registered session on a re-run without a reload.
const sessionURI = "ahp-session:/wd-" + randomBytes(4).toString("hex");

/**
 * The git fixture in the target: notes.txt at the baseline, committed,
 * so the uncommitted changeset starts clean. The target is its own repo
 * (there is no .git in the scratch root — only test-project has one).
 */
function ensureGitFixture() {
  const git = (...args) => execFileSync("git", args, { cwd: TARGET, encoding: "utf8", stdio: "pipe" });
  if (!existsSync(join(TARGET, ".git"))) {
    git("init");
    git("add", "-A");
    git("-c", "user.name=ahp-test", "-c", "user.email=ahp-test@local", "commit", "-m", "wd-probe baseline");
    console.log(`${TAG} git init + baseline commit in ${TARGET}`);
  }
  let headContent = null;
  try {
    headContent = git("show", "HEAD:notes.txt");
  } catch {
    headContent = null;
  }
  if (headContent !== FILE_BEFORE) {
    writeFileSync(FILE, FILE_BEFORE);
    git("add", "notes.txt");
    git("-c", "user.name=ahp-test", "-c", "user.email=ahp-test@local", "commit", "-m", "notes.txt baseline");
    console.log(`${TAG} committed notes.txt baseline`);
  } else if (readFileSync(FILE, "utf8") !== FILE_BEFORE) {
    git("checkout", "--", "notes.txt");
    console.log(`${TAG} restored notes.txt working tree to baseline`);
  }
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
    console.log(
      `${TAG}   action ${ch} seq=${msg.params?.serverSeq} ${a?.type}${a?.turnId ? ` (${a.turnId})` : ""}${msg.params?.rejectionReason ? ` REJECTED: ${msg.params.rejectionReason}` : ""}`,
    );
    return;
  }
  rootNotifications.push(msg);
  console.log(`${TAG}   notification ${msg.method}: ${JSON.stringify(msg.params ?? null).slice(0, 200)}`);
}

function connect() {
  const wsUrl =
    opts.base.replace(/^http/, "ws") + opts.path + "?token=" + encodeURIComponent(opts.token);
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

let clientSeq = 0;
function startTurn(chatChannel, turnId, text) {
  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "dispatchAction",
      params: {
        channel: chatChannel,
        clientSeq: ++clientSeq,
        action: {
          type: "chat/turnStarted",
          turnId,
          startedAt: new Date().toISOString(),
          message: { text, origin: { kind: "user" } },
        },
      },
    }),
  );
  return turnId;
}

try {
  // ── setup: the script owns the target scratch dir ───────────────────────
  rmSync(TARGET, { recursive: true, force: true });
  mkdirSync(opts.scratch, { recursive: true });

  const clientId = "working-dirs-" + randomBytes(4).toString("hex");
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

  // ── 2. resourceMkdir (dogfooded: creates the target) ─────────────────────
  const mk = await request("resourceMkdir", { channel: "ahp-root://", uri: dirUri(TARGET) });
  if (mk.error) fail(1, `resourceMkdir: ${JSON.stringify(mk.error)}`);
  check("resourceMkdir target → {}", mk.result !== null && mk.result !== undefined, JSON.stringify(mk.result ?? null));
  check("resourceMkdir created the dir on disk", existsSync(join(TARGET, ".")) && statSync(TARGET).isDirectory());

  writeFileSync(PROBE_TXT, PROBE_TXT_CONTENT);

  // ── 3. resourceResolve ──────────────────────────────────────────────────
  const probeStat = statSync(PROBE_TXT);
  const resProbe = await request("resourceResolve", { channel: "ahp-root://", uri: fileUri(PROBE_TXT) });
  if (resProbe.error) fail(1, `resourceResolve file: ${JSON.stringify(resProbe.error)}`);
  check(
    "resolve file: type/size/etag/uri",
    resProbe.result?.type === "file" &&
      resProbe.result?.size === probeStat.size &&
      resProbe.result?.etag === `W/"${probeStat.size}-${probeStat.mtimeMs}"` &&
      resProbe.result?.uri === fileUri(PROBE_TXT) &&
      typeof resProbe.result?.mtime === "string" &&
      typeof resProbe.result?.ctime === "string",
    JSON.stringify(resProbe.result),
  );

  // The directory URI carries a trailing slash (RFC 8089); the resolve
  // result must re-add it for directories.
  const resDir = await request("resourceResolve", { channel: "ahp-root://", uri: dirUri(TARGET) });
  if (resDir.error) fail(1, `resourceResolve dir: ${JSON.stringify(resDir.error)}`);
  check(
    "resolve dir (trailing-slash URI in/out, type directory)",
    resDir.result?.type === "directory" && resDir.result?.uri === dirUri(TARGET),
    JSON.stringify(resDir.result),
  );

  // Symlink: follow (default) → the target's identity; followSymlinks:false
  // → the link itself (type symlink).
  execFileSync("ln", ["-s", PROBE_TXT, LINK]);
  const resFollow = await request("resourceResolve", { channel: "ahp-root://", uri: fileUri(LINK) });
  if (resFollow.error) fail(1, `resourceResolve symlink (follow): ${JSON.stringify(resFollow.error)}`);
  check(
    "resolve symlink follows by default (uri = target, type file)",
    resFollow.result?.uri === fileUri(PROBE_TXT) && resFollow.result?.type === "file",
    JSON.stringify(resFollow.result),
  );
  const resNoFollow = await request("resourceResolve", {
    channel: "ahp-root://",
    uri: fileUri(LINK),
    followSymlinks: false,
  });
  if (resNoFollow.error) fail(1, `resourceResolve symlink (no-follow): ${JSON.stringify(resNoFollow.error)}`);
  check(
    "resolve symlink with followSymlinks:false → type symlink",
    resNoFollow.result?.type === "symlink" && resNoFollow.result?.uri === fileUri(LINK),
    JSON.stringify(resNoFollow.result),
  );

  const resMissing = await request("resourceResolve", { channel: "ahp-root://", uri: fileUri(join(TARGET, "nope.txt")) });
  check("resolve missing → -32008", resMissing.error?.code === -32008, JSON.stringify(resMissing.error ?? null));
  const resBadScheme = await request("resourceResolve", { channel: "ahp-root://", uri: "https://example.com/x" });
  check("resolve non-file URI → -32602", resBadScheme.error?.code === -32602, JSON.stringify(resBadScheme.error ?? null));

  // ── 4. permission probe (skipped as root: chmod does not bind root) ──────
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    console.log(`${TAG} skip  permission probe (running as root)`);
  } else {
    mkdirSync(NOACCESS, { recursive: true });
    writeFileSync(join(NOACCESS, "secret.txt"), "top secret\n");
    chmodSync(NOACCESS, 0o000);
    const resDeny = await request("resourceResolve", { channel: "ahp-root://", uri: fileUri(join(NOACCESS, "secret.txt")) });
    check("resolve inside chmod-000 dir → -32009", resDeny.error?.code === -32009, JSON.stringify(resDeny.error ?? null));
    const listDeny = await request("resourceList", { channel: "ahp-root://", uri: dirUri(NOACCESS) });
    check("list chmod-000 dir → -32009", listDeny.error?.code === -32009, JSON.stringify(listDeny.error ?? null));
    chmodSync(NOACCESS, 0o755); // restore before the git fixture (git must traverse)
    rmSync(NOACCESS, { recursive: true, force: true });
  }

  // ── 5. resourceMkdir parents + resourceList ─────────────────────────────
  const mkDeep = await request("resourceMkdir", { channel: "ahp-root://", uri: fileUri(NESTED_DEEP) });
  if (mkDeep.error) fail(1, `resourceMkdir parents: ${JSON.stringify(mkDeep.error)}`);
  check("resourceMkdir nested/deep (parents) → {}", mkDeep.result !== null && mkDeep.result !== undefined, JSON.stringify(mkDeep.result ?? null));
  check("nested/deep exists on disk", statSync(NESTED_DEEP).isDirectory());

  // BEFORE git init: the exact entry set (no .git yet). Directories first,
  // then by name.
  const list = await request("resourceList", { channel: "ahp-root://", uri: dirUri(TARGET) });
  if (list.error) fail(1, `resourceList: ${JSON.stringify(list.error)}`);
  check(
    "resourceList exact entries (dirs first, then name)",
    JSON.stringify(list.result?.entries) ===
      JSON.stringify([
        { name: "nested", type: "directory" },
        { name: "link", type: "file" },
        { name: "probe.txt", type: "file" },
      ]),
    JSON.stringify(list.result?.entries),
  );
  const listMissing = await request("resourceList", { channel: "ahp-root://", uri: dirUri(join(TARGET, "ghost")) });
  check("list missing → -32008", listMissing.error?.code === -32008, JSON.stringify(listMissing.error ?? null));
  const listOnFile = await request("resourceList", { channel: "ahp-root://", uri: fileUri(PROBE_TXT) });
  check("list on a file → -32602", listOnFile.error?.code === -32602, JSON.stringify(listOnFile.error ?? null));
  const mkOnFile = await request("resourceMkdir", { channel: "ahp-root://", uri: fileUri(PROBE_TXT) });
  check("mkdir onto a file → -32010", mkOnFile.error?.code === -32010, JSON.stringify(mkOnFile.error ?? null));
  const mkExisting = await request("resourceMkdir", { channel: "ahp-root://", uri: fileUri(NESTED_DEEP) });
  check("mkdir existing dir → {} no-op", mkExisting.error === undefined && mkExisting.result !== null && mkExisting.result !== undefined, JSON.stringify(mkExisting.error ?? mkExisting.result));

  // ── 6. git fixture (clean changeset baseline in the target's own repo) ───
  writeFileSync(FILE, FILE_BEFORE);
  ensureGitFixture();

  // ── 7. createSession with workingDirectories ────────────────────────────
  // The trailing slash exercises the host's strip at the wire boundary.
  const create = await request("createSession", {
    channel: sessionURI,
    provider: opts.provider,
    workingDirectories: [dirUri(TARGET)],
  });
  if (create.error) fail(1, `createSession: ${JSON.stringify(create.error)}`);
  check("createSession (workingDirectories) → null", create.result === null);

  await waitFor(
    () => rootNotifications.some((m) => m.method === "root/sessionAdded" && m.params?.summary?.resource === sessionURI),
    "root/sessionAdded",
  );
  const added = rootNotifications.find((m) => m.method === "root/sessionAdded" && m.params?.summary?.resource === sessionURI);
  check(
    "sessionAdded summary.workingDirectories",
    JSON.stringify(added.params.summary.workingDirectories) === JSON.stringify([dirUri(TARGET)]),
    JSON.stringify(added.params.summary.workingDirectories),
  );

  const sessSub = await request("subscribe", { channel: sessionURI });
  if (sessSub.error) fail(1, `subscribe session: ${JSON.stringify(sessSub.error)}`);
  const sessState = sessSub.result?.snapshot?.state;
  check(
    "session state.workingDirectories",
    JSON.stringify(sessState?.workingDirectories) === JSON.stringify([dirUri(TARGET)]),
    JSON.stringify(sessState?.workingDirectories),
  );
  const chatURI = sessState?.defaultChat;
  check("session state.defaultChat present", typeof chatURI === "string" && chatURI.startsWith("ahp-chat:"), String(chatURI));
  // The customization's uri uses the reference host's uri.toString() form
  // (no trailing slash — the AHP spec's own directory-URI examples match
  // it; identity is the opaque `id`), while workingDirectories above uses
  // the RFC 8089 directory form (trailing slash).
  const dirCust = (sessState?.customizations ?? []).find((c) => c?.type === "directory");
  check(
    "session state carries the directory customization for the target",
    dirCust !== undefined && dirCust.uri === fileUri(TARGET) && dirCust.name === basename(TARGET),
    JSON.stringify({ uri: dirCust?.uri, name: dirCust?.name, id: dirCust?.id }),
  );

  const listed = await request("listSessions", { channel: "ahp-root://" });
  if (listed.error) fail(1, `listSessions: ${JSON.stringify(listed.error)}`);
  const listItem = (listed.result?.items ?? []).find((s) => s.resource === sessionURI);
  check(
    "listSessions carries the item with workingDirectories",
    listItem !== undefined &&
      JSON.stringify(listItem.workingDirectories) === JSON.stringify([dirUri(TARGET)]),
    JSON.stringify(listItem?.workingDirectories ?? null),
  );

  const badCreate = await request("createSession", {
    channel: "ahp-session:/wd-probe-bad",
    provider: opts.provider,
    workingDirectories: ["not-a-uri"],
  });
  check("createSession malformed workingDirectories → -32602", badCreate.error?.code === -32602, JSON.stringify(badCreate.error ?? null));

  // ── 8. changeset confinement (cross-location git fallback) ───────────────
  const chatSub = await request("subscribe", { channel: chatURI });
  if (chatSub.error) fail(1, `subscribe chat: ${JSON.stringify(chatSub.error)}`);
  const chatCatalog = chatSub.result?.snapshot?.state?.changesets ?? [];
  check(
    "chat snapshot carries the 3-entry changeset catalogue",
    JSON.stringify(chatCatalog.map((c) => c.changeKind)) === JSON.stringify(["uncommitted", "session", "turn"]),
    JSON.stringify(chatCatalog.map((c) => [c.label, c.uriTemplate, c.changeKind])),
  );
  const uncommittedURI = chatCatalog.find((c) => c.changeKind === "uncommitted")?.uriTemplate;
  const turnTemplate = chatCatalog.find((c) => c.changeKind === "turn")?.uriTemplate;
  if (uncommittedURI === undefined || turnTemplate === undefined) fail(1, "catalogue missing uncommitted/turn entries");

  const unsubSub = await request("subscribe", { channel: uncommittedURI });
  if (unsubSub.error) fail(1, `subscribe uncommitted: ${JSON.stringify(unsubSub.error)}`);
  const initialState = unsubSub.result?.snapshot?.state;
  check(
    "uncommitted changeset starts ready + empty (clean tree via the git fallback)",
    initialState?.status === "ready" && initialState?.files?.length === 0,
    `status=${initialState?.status} files=${initialState?.files?.length ?? "?"} error=${JSON.stringify(initialState?.error ?? null)}`,
  );

  const turnId = "turn-wd-" + Date.now().toString(36);
  startTurn(
    chatURI,
    turnId,
    `Use the write tool to overwrite the file notes.txt (in the project root) with exactly this content:\nline1\nline2\nline3\nDo not create or modify any other file, and do not reply with anything but a short confirmation.`,
  );
  console.log(`${TAG} dispatched chat/turnStarted ${turnId} (file-editing prompt, cross-location)`);

  await waitFor(
    () => (actionsByChannel.get(chatURI) ?? []).some((a) => a.action?.type === "chat/turnStarted" && !a.rejectionReason),
    "turnStarted echo",
  );
  await waitFor(
    () => (actionsByChannel.get(chatURI) ?? []).some((a) => a.action?.type === "chat/turnComplete" || a.action?.type === "chat/turnError"),
    "turn end",
  );
  const endAction = (actionsByChannel.get(chatURI) ?? []).find((a) => a.action?.type === "chat/turnComplete" || a.action?.type === "chat/turnError");
  check("turn completed (cross-location tracking works)", endAction?.action?.type === "chat/turnComplete", endAction?.action?.type);

  const diskAfterTurn = readFileSync(FILE, "utf8");
  check("notes.txt was edited on disk (in the target)", diskAfterTurn !== FILE_BEFORE, JSON.stringify(diskAfterTurn));

  // Turn-end refresh: the cross-location diff must join onto the target's
  // own repo — the before ref is the target's HEAD, not the location's.
  await waitFor(
    () =>
      (actionsByChannel.get(uncommittedURI) ?? []).some(
        (a) => a.action?.type === "changeset/contentChanged" && (a.action.files ?? []).some((f) => f.id === fileRef),
      ),
    "uncommitted contentChanged with notes.txt",
  );
  const ccAction = (actionsByChannel.get(uncommittedURI) ?? []).find(
    (a) => a.action?.type === "changeset/contentChanged" && (a.action.files ?? []).some((f) => f.id === fileRef),
  );
  const ccFile = ccAction.action.files.find((f) => f.id === fileRef);
  check(
    "uncommitted diff entry has live after + target-HEAD before (cross-location)",
    ccFile?.edit?.after?.content?.uri === fileRef && ccFile?.edit?.before?.content?.uri === headRef,
    JSON.stringify({ after: ccFile?.edit?.after, before: ccFile?.edit?.before }),
  );
  check(
    "contentChanged attaches the discard operation",
    (ccAction.action.operations ?? []).some((o) => o?.id === "discard-changes"),
    JSON.stringify((ccAction.action.operations ?? []).map((o) => o.id)),
  );

  const rr = (uri, encoding) => request("resourceRead", encoding ? { uri, encoding } : { uri });
  const live = await rr(fileRef, "utf-8");
  check(
    "resourceRead file:// serves the live disk (confined to the session dir)",
    live.result?.data === diskAfterTurn && live.result?.encoding === "utf-8",
    JSON.stringify(live.result ?? live.error),
  );
  const outside = await rr("file:///etc/passwd");
  check("resourceRead rejects outside the session dir (-32009)", outside.error?.code === -32009, JSON.stringify(outside.error ?? null));

  const turnURI = turnTemplate.replace("{turnId}", turnId);
  const turnSub = await request("subscribe", { channel: turnURI });
  if (turnSub.error) fail(1, `subscribe turn changeset: ${JSON.stringify(turnSub.error)}`);
  const turnState = turnSub.result?.snapshot?.state;
  const turnFile = turnState?.files?.find((f) => f.id === fileRef);
  check(
    "turn changeset shows notes.txt with snap refs",
    turnState?.status === "ready" && turnFile !== undefined,
    `status=${turnState?.status} files=${turnState?.files?.length ?? "?"}`,
  );
  check(
    "turn before/after are opaque snap refs",
    /^ahp-content:\/\/snap\//.test(turnFile?.edit?.before?.content?.uri ?? "") &&
      /^ahp-content:\/\/snap\//.test(turnFile?.edit?.after?.content?.uri ?? ""),
    JSON.stringify({ b: turnFile?.edit?.before?.content?.uri, a: turnFile?.edit?.after?.content?.uri }),
  );
  const before = await rr(turnFile?.edit?.before?.content?.uri, "utf-8");
  check(
    "resourceRead before snap = the exact baseline (pre-edit capture)",
    before.result?.data === FILE_BEFORE,
    JSON.stringify(before.result ?? before.error),
  );

  // ── 9. terminal (session claim → cwd clamped to the session dir) ────────
  const terminalURI = "agenthost-terminal://wd-" + randomBytes(6).toString("hex");
  const createTerm = await request("createTerminal", {
    channel: terminalURI,
    claim: { kind: "session", session: sessionURI, chat: chatURI },
    name: "wd-probe shell",
    // Out of bounds: must be clamped to the session's own directory.
    cwd: "file:///etc",
    cols: 100,
    rows: 30,
  });
  if (createTerm.error) fail(1, `createTerminal: ${JSON.stringify(createTerm.error)}`);
  check("createTerminal (session claim) → null", createTerm.result === null);

  const termSub = await request("subscribe", { channel: terminalURI });
  if (termSub.error) fail(1, `subscribe terminal: ${JSON.stringify(termSub.error)}`);
  const termState = termSub.result?.snapshot?.state;
  check("terminal snapshot isPty", termState?.isPty === true, JSON.stringify(termState?.lifecycle));
  check(
    "terminal cwd clamped to the session's directory",
    termState?.cwd === dirUri(TARGET),
    String(termState?.cwd),
  );

  // pwd must print the target path (the shell really opened there).
  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "dispatchAction",
      params: {
        channel: terminalURI,
        clientSeq: ++clientSeq,
        action: { type: "terminal/input", data: "pwd\r" },
      },
    }),
  );
  const dataStream = () =>
    (actionsByChannel.get(terminalURI) ?? [])
      .filter((a) => a.action.type === "terminal/data")
      .map((a) => a.action.data)
      .join("")
      .replace(/\u001b\][^\u0007]*\u0007/g, "") // OSC (e.g. xterm title)
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "") // CSI (colors, bracketed paste)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "");
  await waitFor(
    () => dataStream().includes(TARGET),
    "pwd output carries the target path",
    opts.timeoutMs / 2,
  );
  check("terminal pwd prints the session's directory", dataStream().includes(TARGET));

  const dispose = await request("disposeTerminal", { channel: terminalURI });
  if (dispose.error) fail(1, `disposeTerminal: ${JSON.stringify(dispose.error)}`);
  check("disposeTerminal → null", dispose.result === null);
  await waitFor(
    () => (actionsByChannel.get(terminalURI) ?? []).some((a) => a.action?.type === "terminal/exited"),
    "terminal/exited",
  );
  check("terminal exited after dispose", true);
} catch (e) {
  fail(1, e.message);
}

if (failures > 0) {
  console.error(`${TAG} ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`${TAG} OK: working directories (resource* + cross-location session) verification passed`);
try {
  ws.close(1000);
} catch {
  // already closed
}
process.exit(0);
