#!/usr/bin/env node
/**
 * opencode-ahp AHP conformance runner (official fixture corpus).
 *
 * Runs the official AHP conformance fixtures
 * (microsoft/agent-host-protocol `types/test-cases`) against the
 * `spec/v1.0.0` tag — the corpus matching this repo's strict-pinned
 * `@microsoft/agent-host-protocol@1.0.0`. See docs/testing.md §5.
 *
 * The script works on a throwaway shallow clone in scratch under
 * /tmp/opencode/ — it never touches a local checkout of the AHP repo.
 * Scratch is removed afterwards unless --keep is given.
 *
 * Gates:
 *   1. Fixtures — `tsx --test types/*.test.ts types/version/*.test.ts`
 *      (reducer, version-negotiation, message-map, extension-prefix).
 *   2. TS client — `clients/typescript` `npm test` (wire round-trip
 *      corpus + the client's own unit suites). Prerequisite:
 *      `npm run generate:typescript` at the repo root (the client's
 *      src/types/ is generated and gitignored).
 *   3. Coverage — the official root-gate test files under c8 with
 *      `--include types/reducers.ts --check-coverage --branches 100`.
 *   4. Installed dist — the same reducer + version-negotiation corpora
 *      run against the @microsoft/agent-host-protocol package installed
 *      in THIS repo's node_modules (the exact exports our host imports):
 *      the pin-drift guard, so the check covers what we ship, not just
 *      the tag.
 *      c8's `outputReport` is driven programmatically (not via the CLI):
 *      on Node 26 the c8 11.0.0 CLI crashes before any test runs (its
 *      `require('yargs/yargs')` hits yargs 17.7.2's "type": "module"
 *      package and Node's require(ESM) bridge). The programmatic path
 *      runs the identical gate on any Node version. The include pattern
 *      is resolved relative to cwd, so the report runs from the repo
 *      root; the result is additionally verified against the coverage
 *      map directly, since an empty map would make the threshold check
 *      vacuous (istanbul reports NaN pct and `NaN < 100` is false).
 *
 * Dependency-free: Node ≥ 22 (child_process + fs + createRequire only;
 * the test toolchain comes from the cloned repo's own node_modules).
 *
 * Usage:
 *   node scripts/ahp-conformance.mjs [--tag spec/v1.0.0]
 *     [--repo-url https://github.com/microsoft/agent-host-protocol]
 *     [--dir /tmp/opencode/ahp-conformance] [--keep]
 *
 * Exit codes: 0 all gates green · 1 fixture/coverage failure · 2 setup
 * failure (clone / npm ci / generate / installed package missing)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const TAG = "[ahp-conformance]";
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
  tag: arg("--tag", "spec/v1.0.0"),
  repoUrl: arg("--repo-url", "https://github.com/microsoft/agent-host-protocol"),
  dir: arg("--dir", "/tmp/opencode/ahp-conformance"),
  keep: has("--keep"),
};

const scratch = opts.dir;
const repoDir = path.join(scratch, "agent-host-protocol");

// ── subprocess helper ────────────────────────────────────────────────────

/**
 * Spawn a child, tee its stdio to this console, and resolve with
 * { code, output } once it exits.
 */
function run(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env });
    let output = "";
    const tee = (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    };
    child.stdout.on("data", tee);
    child.stderr.on("data", tee);
    child.on("error", (e) => {
      console.error(`${TAG} spawn error: ${e.message}`);
      resolve({ code: 127, output });
    });
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

/** Extract the node test-runner summary (tests/pass/fail) from output. */
function summarize(output) {
  const grab = (name) => {
    const m = output.match(new RegExp(`^ℹ ${name} (\\d+)`, "m"));
    return m ? Number(m[1]) : null;
  };
  return { tests: grab("tests"), pass: grab("pass"), fail: grab("fail") };
}

/** List `<dir>/*.test.ts` as repo-relative paths (no shell globbing). */
function testFiles(relDir) {
  return fs
    .readdirSync(path.join(repoDir, relDir))
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => `${relDir}/${f}`);
}

// ── main ─────────────────────────────────────────────────────────────────

process.on("exit", () => {
  if (opts.keep) return;
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

console.log(`${TAG} AHP conformance pass — tag ${opts.tag}`);
console.log(`${TAG} scratch: ${scratch} (${opts.keep ? "kept on exit" : "removed on exit"})`);

// 1. Throwaway shallow clone of the pinned tag.
fs.rmSync(repoDir, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
console.log(`${TAG} cloning ${opts.repoUrl} @ ${opts.tag} (shallow, throwaway)`);
let r = await run("git", ["clone", "--quiet", "--depth", "1", "--branch", opts.tag, opts.repoUrl, repoDir]);
if (r.code !== 0) fail(2, `git clone of ${opts.tag} failed`);
r = await run("git", ["-C", repoDir, "rev-parse", "HEAD"]);
const sha = r.output.trim();
console.log(`${TAG} checked out ${opts.tag} @ ${sha.slice(0, 8)}`);

// 2. Root dependencies.
console.log(`${TAG} npm ci (repo root)`);
r = await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: repoDir });
if (r.code !== 0) fail(2, "root npm ci failed");

const tsxBin = path.join(repoDir, "node_modules/.bin/tsx");

// Gate 1: the fixture corpora.
const gate1Files = [...testFiles("types"), ...testFiles("types/version")];
console.log(`\n${TAG} gate 1 — fixtures: ${gate1Files.length} file(s)`);
let r1 = await run("node", [tsxBin, "--test", ...gate1Files], { cwd: repoDir });
const g1 = summarize(r1.output);

// Prerequisite for gate 2: the TS client's src/types/ is generated from
// the root types/ and gitignored.
console.log(`\n${TAG} npm run generate:typescript (client src/types/ prerequisite)`);
r = await run("npm", ["run", "generate:typescript"], { cwd: repoDir });
if (r.code !== 0) fail(2, "generate:typescript failed");

// Gate 2: round-trip corpus + the TS client's own unit suites.
const clientDir = path.join(repoDir, "clients/typescript");
console.log(`${TAG} npm ci (clients/typescript)`);
r = await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: clientDir });
if (r.code !== 0) fail(2, "clients/typescript npm ci failed");
console.log(`\n${TAG} gate 2 — TS client suites (npm test)`);
let r2 = await run("npm", ["test", "--no-audit", "--no-fund"], { cwd: clientDir });
const g2 = summarize(r2.output);

// Gate 3: the official root-gate coverage requirement (100 % branches on
// types/reducers.ts) over the full official test-file set.
const gate3Files = [...gate1Files, ...testFiles("clients/dotnet/codegen/telemetry"), ...testFiles("scripts")];
const tempDir = path.join(scratch, "c8-coverage");
fs.rmSync(tempDir, { recursive: true, force: true });
fs.mkdirSync(tempDir, { recursive: true });
console.log(`\n${TAG} gate 3 — coverage gate: ${gate3Files.length} file(s) under c8 (100 % branches, types/reducers.ts)`);
let r3 = await run("node", [tsxBin, "--test", ...gate3Files], {
  cwd: repoDir,
  env: { ...process.env, NODE_V8_COVERAGE: tempDir },
});
const g3 = summarize(r3.output);

// c8 resolves include/exclude patterns relative to cwd — run from the
// repo root (the same cwd the official gate uses).
process.chdir(repoDir);
const repoRequire = createRequire(path.join(repoDir, "package.json"));
const { outputReport } = repoRequire(path.join(repoDir, "node_modules/c8/lib/commands/report.js"));
const Report = repoRequire(path.join(repoDir, "node_modules/c8/lib/report.js"));
try {
  await outputReport({
    include: ["types/reducers.ts"],
    checkCoverage: true,
    branches: 100,
    reporter: "text",
    tempDirectory: tempDir,
  });
} catch (e) {
  fail(1, `c8 report failed: ${e.message}`);
}
const covMet = process.exitCode !== 1;

// Guard against a vacuous pass: with an empty coverage map (e.g. the
// include pattern matched nothing), istanbul reports NaN pct and
// `NaN < 100` is false, so the threshold check passes on air. Require
// types/reducers.ts to actually be in the map at 100 % branches.
let covBranchPct = null;
let covHasReducers = false;
try {
  const map = await Report({ include: ["types/reducers.ts"], tempDirectory: tempDir, reporter: ["text"] })
    .getCoverageMapFromAllCoverageFiles();
  covHasReducers = map.files().some((f) => f.endsWith("types/reducers.ts"));
  covBranchPct = map.getCoverageSummary().data.branches.pct;
} catch (e) {
  fail(1, `coverage map read failed: ${e.message}`);
}

// Gate 4: the tag's corpus against the INSTALLED package — the exact
// dist our host imports (`@microsoft/agent-host-protocol` in this repo's
// node_modules). Mirrors the official runners' semantics: reducer
// fixtures fold actions through the named reducer then deep-equal
// expected (with the corpus's JSON null normalized to undefined);
// negotiation cases select / yield undefined / throw.
console.log(`\n${TAG} gate 4 — installed @microsoft/agent-host-protocol dist vs corpus`);
let g4 = { total: 0, pass: 0, failures: [] };
try {
  const ahp = await import("@microsoft/agent-host-protocol");
  const nullToUndefined = (value) => {
    if (value === null) return undefined;
    if (Array.isArray(value)) return value.map(nullToUndefined);
    if (typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = nullToUndefined(v);
      return out;
    }
    return value;
  };
  const check = (label, fn) => {
    g4.total++;
    try {
      fn();
      g4.pass++;
    } catch (e) {
      g4.failures.push(`${label}: ${String(e.message).split("\n")[0]}`);
    }
  };

  const reducers = {
    root: ahp.rootReducer,
    session: ahp.sessionReducer,
    chat: ahp.chatReducer,
    canvas: ahp.canvasReducer,
    terminal: ahp.terminalReducer,
    changeset: ahp.changesetReducer,
    annotations: ahp.annotationsReducer,
    resourceWatch: ahp.resourceWatchReducer,
    automation: ahp.automationReducer,
    automationRun: ahp.automationRunReducer,
  };
  const reducerDir = path.join(repoDir, "types/test-cases/reducers");
  for (const f of fs.readdirSync(reducerDir).filter((f) => f.endsWith(".json")).sort()) {
    const fx = nullToUndefined(JSON.parse(fs.readFileSync(path.join(reducerDir, f), "utf8")));
    check(fx.description, () => {
      const reducer = reducers[fx.reducer];
      if (typeof reducer !== "function") throw new Error(`installed package has no ${fx.reducer}Reducer export`);
      let state = fx.initial;
      for (const action of fx.actions) state = reducer(state, action);
      assert.deepStrictEqual(state, fx.expected);
    });
  }

  const cases = JSON.parse(
    fs.readFileSync(path.join(repoDir, "types/test-cases/version-negotiation.json"), "utf8"),
  );
  for (const c of cases) {
    check(`negotiation [${c.offered.join(", ")}]`, () => {
      if (c.invalid) {
        assert.throws(() => ahp.negotiateProtocolVersion(c.offered), /Invalid protocol version/);
      } else {
        assert.equal(ahp.negotiateProtocolVersion(c.offered), c.expected ?? undefined);
      }
    });
  }
  console.log(`${TAG} gate 4: ${g4.pass}/${g4.total} fixtures pass (reducer + version-negotiation)`);
  for (const f of g4.failures.slice(0, 10)) console.error(`${TAG} gate 4 FAIL: ${f}`);
} catch (e) {
  fail(2, `installed package import failed (is @microsoft/agent-host-protocol installed?): ${e.message}`);
}

// ── summary ──────────────────────────────────────────────────────────────

const fmt = (g) =>
  g && g.tests !== null ? `${g.pass}/${g.tests} pass` : "no test summary";
const failures = [];
if (r1.code !== 0 || !g1 || g1.fail > 0) failures.push(`gate 1 fixtures (exit ${r1.code}, ${fmt(g1)})`);
if (r2.code !== 0 || !g2 || g2.fail > 0) failures.push(`gate 2 TS client (exit ${r2.code}, ${fmt(g2)})`);
if (r3.code !== 0 || !g3 || g3.fail > 0) failures.push(`gate 3 test run (exit ${r3.code}, ${fmt(g3)})`);
if (!covMet || !covHasReducers || covBranchPct !== 100) {
  failures.push(
    `gate 3 coverage (threshold ${covMet ? "met" : "NOT met"}; reducers.ts in map: ${covHasReducers}; ` +
      `branches: ${covBranchPct === null ? "n/a" : `${covBranchPct}%`})`,
  );
}
if (g4.pass < g4.total) {
  failures.push(`gate 4 installed dist (${g4.pass}/${g4.total} fixtures; first: ${g4.failures[0]})`);
}

console.log(`\n${TAG} ── summary ── tag ${opts.tag} @ ${sha.slice(0, 8)}`);
console.log(`${TAG}   gate 1 fixtures:          ${fmt(g1)}`);
console.log(`${TAG}   gate 2 TS client:         ${fmt(g2)}`);
console.log(
  `${TAG}   gate 3 coverage:          ${fmt(g3)}; reducers.ts branches ${
    covBranchPct === null ? "n/a" : `${covBranchPct}%`
  } (threshold 100 % ${covMet && covHasReducers && covBranchPct === 100 ? "met" : "NOT met"})`,
);
console.log(`${TAG}   gate 4 installed dist:    ${g4.pass}/${g4.total} fixtures (reducer + version-negotiation)`);

if (failures.length > 0) {
  for (const f of failures) console.error(`${TAG} FAIL: ${f}`);
  process.exitCode = 1;
} else {
  console.log(`${TAG} OK: all conformance gates green`);
}
if (!opts.keep) console.log(`${TAG} scratch removed: ${scratch}`);
