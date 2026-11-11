# Testing

This document covers every test layer of `opencode-ahp` and how to
execute it:

1. **[Unit tests](#1-unit-tests-vitest)** — offline Vitest suites over the
   pure modules.
2. **[Static checks & CI](#2-static-checks--ci)** — typecheck and what CI
   runs on push.
3. **[Live verification](#3-live-verification)** — the `scripts/` probes
   driving the real protocol against an isolated test server.
4. **[LAN two-machine test](#4-lan-two-machine-test-vs-code)** — the manual
   end-to-end walkthrough with VS Code on a second machine.
5. **[Conformance](#5-conformance-ahp-official-fixtures)** — the official
   AHP fixture corpus.

The standing rule: after **any** code change, `pnpm typecheck` and
`pnpm test` must pass — never complete work with a red suite.

Companions: [`design.md`](design.md) describes how the implementation
works; [`futures.md`](futures.md) lists what is not done yet; the
[README](../README.md) and
[`options.example.jsonc`](../options.example.jsonc) cover installation and
options.

---

## 1. Unit tests (Vitest)

`pnpm test` runs `vitest run` over `src/test/**/*.test.ts`
(`vitest.config.ts`). Nine suites, 298 tests as of 2026-11-10, a few
seconds wall time:

```sh
pnpm test                        # all suites
pnpm test src/test/host.test.ts  # one suite
pnpm test -t "turn lifecycle"    # tests whose name matches
```

**Design (house pattern).** Every module under test is a pure
function/class with its dependencies — session access, timers, logging,
sockets — **injected**, so tests never touch the opencode runtime, the
network, or the filesystem. `src/test/keep-alive.test.ts` is the reference
idiom: injected capturing timers (no real `setInterval`), and the returned
mocks are the effective deps, so assertions observe exactly what the unit
under test used.

| Suite | What it covers |
| --- | --- |
| `options.test.ts` | `stripJsonc`; `resolveOptions` precedence (plugin options ▸ `options.jsonc` ▸ built-ins), validation, non-throwing fallbacks, and the malformed-file throw that lets the caller degrade. |
| `transport.test.ts` | `isLoopback`, token extraction (query / header), token validity, Origin policy, path routing (`/ahp` vs `/healthz` vs 404), listener creation — including refusing a non-loopback bind without a token. |
| `handshake.test.ts` | `handleInitialize`: parameter validation, version negotiation (delegated to the pinned package — see [§5.3](#53-what-it-covers-for-this-host)), result shape. |
| `seq.test.ts` | the global `Sequencer`: monotonic seq, snapshot `fromSeq`, replay window (within → replay, evicted → snapshot). |
| `channels.test.ts` | channel kind + session/changeset URI helpers; `ChannelRegistry`: snapshot on subscribe, broadcast targets and sockets, live sessions. |
| `bridge.test.ts` | the `mapV2Event` catalog — opencode V2 events → AHP chat actions (part deltas, tool lifecycle, permission events, usage, inbox, execution terminals); `mapV2EventRaw` classification (ok / dropped-with-reason / unimplemented / malformed envelopes) + the `eventLogLine`/`timeStamp` capture-line format; catalog mapping (providers/models/agents/customizations); changeset file builders + diff stats; content refs. |
| `client-tools.test.ts` | client-provided tool definition normalization, the cross-session union, provider lookup, schema/description extraction. |
| `keep-alive.test.ts` | `KeepAlive` start/tick/stop with injected capturing timers. |
| `host.test.ts` | the whole host: `initialize`, `createSession`/`listSessions`, the turn lifecycle, permission round trips, steering/queue, cancel + terminal events, external sessions, changesets (catalogues, subscribe/refresh, turn before-capture), `resourceRead`, `invokeChangesetOperation`, `filesReviewChanged`, teardown + capability gating, client tools, multi-chat + chat-binding durability, terminals (synthetic shell-tool renderings + pty `createTerminal`/`disposeTerminal` with a fake `spawnPty` seam), `resolveSessionConfig`. |

**Fixtures.** `src/test/fixtures/events.jsonl` holds a captured
`V2EventEncoded` stream (one event per line, arrival order) that
`host.test.ts` loads; it was recorded with
[`scripts/capture-events.mjs`](#32-the-scripts) against the scratch
server. Recapture it whenever opencode's event catalog changes shape.

---

## 2. Static checks & CI

- `pnpm typecheck` — `tsc --noEmit` (strict, NodeNext) over `src/`
  **including the tests**.
- Toolchain (Node 26 + pnpm) is managed by `mise.toml` — pnpm's version
  comes from the `packageManager` field in `package.json`. First-time
  setup: `mise trust && mise install && mise run setup`.
- CI (`.github/workflows/ci.yml`) runs on every push to `main` and on
  pull requests: `jdx/mise-action@v5` → `pnpm install --frozen-lockfile`
  → `pnpm typecheck` → `pnpm test`. Publishing (the trusted-publisher
  workflow on push) runs the same pair first via `prepublishOnly`.
- Gotcha: when piping `tsc` output (e.g. through `head`), set
  `set -o pipefail` first — otherwise the pipe masks `tsc`'s exit code
  and a broken build looks clean.

---

## 3. Live verification

The unit suites deliberately do not exercise the transport, the live
plugin lifecycle, or real opencode. The scripts in `scripts/` fill that
gap: each is a dependency-free Node ≥ 22 program (global `WebSocket` +
`fetch`) that speaks **real AHP 1.0.0 over WebSocket** against a real
`opencode serve` with the plugin loaded, and exits non-zero on any
protocol or verification failure.

Exit codes are uniform: `0` success · `1` protocol/verification failure ·
`2` connection failure (`capture-events.mjs` uses `2` for timeout).

### 3.1 The isolated test server

The tests run against a **separate isolated server** — never the daily
`:80` `opencode serve --service` (and its `opencode.jsonc`), which stays
untouched. All scratch state lives under `/tmp/ahp-server/` (isolated XDG
homes under `{data,state,cache}`, and the location/project directory at
`test-project/`).

[`scripts/ahp-server.mjs`](../scripts/ahp-server.mjs) (dependency-free
Node) brings the whole thing up: it creates the isolated XDG homes and —
on a fresh scratch tree, never copying previous state — scaffolds the
location project `/tmp/ahp-server/test-project` (a
`.opencode/opencode.jsonc` pinning this checkout as a dev plugin with
`host: 0.0.0.0`, `port: 8767`, a fixed `token`, `allowedOrigins: "*"`,
a 1-minute keep-alive interval, and event capture on
(`logEvents: true` — design.md [§8.1](design.md#81-event-capture-logevents)),
plus a `.gitignore`, `git init`, and
an initial commit of the scaffold so the working tree starts clean),
generates the Basic-auth password itself via
`OPENCODE_SERVER_PASSWORD` and prints it, boots the location — the
one-time cold-boot step that starts the AHP listener (a location and its
plugins only boot when a client opens it or the API is asked for it; the
keep-alive then holds it indefinitely) — waits for the AHP healthz, and
prints a summary (Basic-auth password, AHP URL, the PC B URL with token,
the TUI command line, log path). It is idempotent: an already-running test server is reused (its
password is recovered from the process environment), and the location boot
is idempotent.

```sh
node scripts/ahp-server.mjs              # start (or reuse) + boot location + wait for healthz; exit 0, server left running
node scripts/ahp-server.mjs --foreground # same, but stay attached (Ctrl-C stops the server)
node scripts/ahp-server.mjs --restart    # stop the running test server first, then start fresh
node scripts/ahp-server.mjs --no-boot    # skip the location boot (AHP host state reported informationally)
node scripts/ahp-server.mjs --stop       # stop the test server (isolated state is kept)
```

Flags: `--port 4098` · `--hostname 0.0.0.0` · `--scratch /tmp/ahp-server`
(the whole tree) · `--location-dir` (defaults to
`<scratch>/test-project`).

Notes:

- The Basic-auth password (`opencode / <PASSWORD>`) is generated for each
  fresh server and printed by the script; a reused server's password comes
  from its process environment.
- The AHP token is fixed in the generated project config. R4 requires an
  explicit token for a non-loopback bind.
- `allowedOrigins: "*"` is test mode; production setups list exact
  Origins.
- **No `experimental.location_idle_timeout` entry** — not needed. The
  plugin's keep-alive (on by default; see
  [design.md §15.3](design.md#153-keep-alive-anchor)) periodically
  touches an internal anchor session, which opencode counts as location
  activity, so the 60-minute idle eviction never fires.
- **Event capture is on** (`logEvents: true` in the scaffolded config):
  `grep "event " /tmp/ahp-server/server.log` shows one timestamped
  `event ok|dropped|unimplemented` line per opencode event the plugin
  saw — use it to attribute turn latency to host vs client vs model
  (design.md [§8.1](design.md#81-event-capture-logevents)). An existing
  project tree is not rewritten — edit its
  `.opencode/opencode.jsonc` and re-boot the location (re-run the
  script) to pick the option up.

**Verify the host side** (the script already waited for the healthz):

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8767/healthz            # 200
curl -s -o /dev/null -w '%{http_code}\n' 'http://10.0.1.107:8767/ahp'             # 401 (no token, LAN-reachable)
curl -s -o /dev/null -w '%{http_code}\n' 'http://10.0.1.107:8767/ahp?token=wrong' # 401
```

If the LAN IP is not `10.0.1.107`: `hostname -I | awk '{print $1}'`.
(If the firewall blocks the port: `sudo ufw allow 8767/tcp` or
equivalent.)

**Troubleshooting — AHP port dead but the server is up** (`healthz` →
connection refused, :4098 still 200): with keep-alive active (check the
server log for `keep-alive active`) this should not happen; if it does,
the location was evicted or the plugin failed to start, and re-booting the
location fixes it — the plugin setup re-runs and the listener comes back.
Any of these re-boots the location (VS Code reconnects on its own — the
host's clientId registry resets, so the client re-initializes from a fresh
snapshot):

1. **Re-run the script** (idempotent — reuses the server and re-boots the
   location): `node scripts/ahp-server.mjs`
2. **Open the location in the opencode TUI**, pointed at the test server
   (`--server` is a global flag; the directory is a positional argument —
   the TUI opens the location for it; the script prints this line in its
   summary):

   ```sh
   OPENCODE_SERVER_PASSWORD=<password> opencode --server http://127.0.0.1:4098 /tmp/ahp-server/test-project
   ```

3. **Boot the location via the API**:

   ```sh
   curl -g -u "opencode:<password>" \
     'http://127.0.0.1:4098/api/location?location[directory]=/tmp/ahp-server/test-project'
   ```

A clean location teardown logs `location teardown — stopping the AHP
host`.

### 3.2 The scripts

| Script | What it verifies |
| --- | --- |
| `scripts/ahp-client.mjs` | The hello-world lifecycle: `initialize` (root subscription) → subscribe → ping, printing every response. `--probe` mode instead exercises the transport's HTTP matrix without a WebSocket handshake: healthz, token auth (401), Origin policy (403), routing (404), and the 101 upgrade. |
| `scripts/ahp-turn-lifecycle.mjs` | The full AHP 1.0.0 surface the Agents window needs: `initialize` → `createSession` (provider selection) → session subscribe (asserts the agent picker is present in the snapshot) → chat subscribe → `dispatchAction chat/turnStarted` → the observed turn lifecycle (echo → `responsePart`/deltas → `turnComplete`). |
| `scripts/ahp-changesets.mjs` | Changesets end to end: catalogues (session + chat), a file-editing turn surfacing the file in the uncommitted changeset, the turn changeset with snap content refs, `resourceRead` (`file://`, `ahp-content://head`, snap before/after, plus the -32009/-32008 error cases), `filesReviewChanged`, and `discard-changes` through `invokeChangesetOperation`. |
| `scripts/ahp-client-tools.mjs` | Client-provided tools through the real opencode tool registry: a `ping` tool registered via `createSession.activeClient.tools`, then three turns — happy path (client-executed contributor, single `toolCallComplete`, result in the snapshot), failed result (the model sees the error; the turn still completes), and `requiresResultConfirmation` (the call parks in `pending-result-confirmation`; approving via `chat/toolCallResultConfirmed` releases the held result). |
| `scripts/ahp-multi-chat.mjs` | Multi-chat: the `multipleChats` capability in the root catalog, `createChat` minting a fresh opencode backend on a client-chosen URI, independent turns on both chats, the `listSessions` differential (peer backends never resurface as sessions), and reload durability with `--leave-peer` / `--recheck` across a location reload. |
| `scripts/ahp-terminal-probe.mjs` | The pty terminal surface: `initialize` → `createTerminal` (a real shell pty on a client-chosen channel) → the root catalog row → the subscribe snapshot (`isPty`, title, size, directory cwd) → `terminal/input` (a marker command, expecting its output line back through `terminal/data` — the stream is stripped of ANSI/OSC/CSI prompt machinery first) → `terminal/resized` (state tracks it) → `disposeTerminal` (final `terminal/exited`, catalog row drops). |
| `scripts/capture-events.mjs` | Offline fixture capture (no AHP involved): boots a scratch location, opens the server's SSE event stream, runs one small tool-using prompt, and records every V2Event envelope to `src/test/fixtures/events.jsonl` for the unit suites ([§1](#1-unit-tests-vitest)). |

Usage (the token is the one from the project config):

```sh
TOKEN=$(sed -n 's/.*"token": "\([^"]*\)".*/\1/p' \
  /tmp/ahp-server/test-project/.opencode/opencode.jsonc)

node scripts/ahp-client.mjs  --token "$TOKEN" --base http://127.0.0.1:8767   # lifecycle probe
node scripts/ahp-client.mjs  --token "$TOKEN" --base http://127.0.0.1:8767 --probe
node scripts/ahp-turn-lifecycle.mjs --token "$TOKEN" --base http://127.0.0.1:8767
node scripts/ahp-changesets.mjs  --token "$TOKEN" --base http://127.0.0.1:8767 \
  --location-dir /tmp/ahp-server/test-project
node scripts/ahp-client-tools.mjs --token "$TOKEN" --base http://127.0.0.1:8767
node scripts/ahp-multi-chat.mjs  --token "$TOKEN" --base http://127.0.0.1:8767
node scripts/ahp-terminal-probe.mjs --token "$TOKEN" --base http://127.0.0.1:8767 \
  --project-dir /tmp/ahp-server/test-project
```

(`ahp-changesets.mjs` also ensures its git fixture — the `notes.txt`
baseline committed at `line1\nline2` — so it can run right after a fresh
`scripts/ahp-server.mjs` run.)

**When to run them.** Changes that alter live behavior (transport, host,
keep-alive) should be verified against the test server — at minimum
`ahp-turn-lifecycle.mjs`, plus the script dedicated to the changed surface —
**before** asking the user to publish. The test server may be reloaded
(`POST /api/location/reload`) or restarted for testing; the daily `:80`
service may not be touched.

---

## 4. LAN two-machine test (VS Code)

The manual end-to-end: the VS Code Agents window on **PC B** driving the
host on **PC A** over plain `ws://` on the LAN, with a real browser-class
client. This is the only layer that verifies token + Origin handling,
streaming, and tool round trips the way an actual user sees them.

Nothing is installed on PC B — VS Code ships the AHP client.

### 4.1 Preconditions

- PC A (this machine): opencode v2.2.6, repo at `/home/mattzink/opencode-ahp`.
- PC B: VS Code 1.145.2, same LAN, reachable from PC A.
- The daily `:80` service is **not touched** — the test runs the separate
  isolated server from [§3.1](#31-the-isolated-test-server).

### 4.2 PC A — host side

1. **Start the test server and boot the location** with
   `node scripts/ahp-server.mjs` ([§3.1](#31-the-isolated-test-server)).
   It prints the "PC B URL" line for you:

   ```text
   ws://10.0.1.107:8767/ahp?token=xsnilxgywpthjZuhdRbjpf5O5mNATD3BaGXhdcw5ui0
   ```

   (The IP is the machine's LAN IP; the token is the one from the project
   config — regenerate it there and re-run the script if you change it.)

### 4.3 PC B — client side (VS Code 1.145.2)

1. Open the Agents window: `code --agents`, or Command Palette →
   **`Chat: Open Agents Window`**.
2. Command Palette → **`Agents: Add Remote Agent Host...`** → paste the
   `ws://` URL → save. (Equivalent persistent form, `settings.json`:
   `"chat.remoteAgentHosts": [{ "name": "opencode", "address": "ws://…" }]`
   — with Settings Sync on, that one line propagates to every PC.)
3. The host appears in the Agents window picker → select it → start a new
   session.
4. Check:
   - Agent picker lists the opencode providers (free `opencode` models and
     `gpuz`).
   - Model picker shows the real catalog (~16 models); pick
     `gpuz/qwen3.8-27b-q5xl`.
   - Prompt: *Use your bash tool to run exactly: `echo hello-lan` — then
     reply with the command output.* → text streams in, the tool runs on
     PC A (watch the server terminal), the output comes back.
5. Reconnect check (optional): close the Agents window, reopen → the host
   re-appears in the picker (VS Code reconnects) and the session catalog
   returns from the root snapshot. (Paging past **turn** history is not
   implemented — `fetchTurns` is a potential item, see
   [futures.md §1.3](futures.md#13-turn-history-hydration-fetchturns).)

### 4.4 Teardown (PC A)

- `node scripts/ahp-server.mjs --stop` (or Ctrl-C in a `--foreground`
  serve terminal).
- `rm -rf /tmp/ahp-server` (isolated state, including the scaffolded
  `test-project/`).

### 4.5 Known-open manual verifications

The single-machine checklist is done; the items below are still open and
tracked in [futures.md §1.5](futures.md#15-open-live-verification-items) —
run them as part of this two-machine pass:

- PC B composer first-send retry (fresh session from the composer).
- Permission round trip through the window (approve → tool runs, deny →
  blocked).
- Token enforcement from the desktop client (no token / wrong token
  rejected; correct token from a VS Code desktop Origin accepted).
- Mid-turn disconnect (airplane mode / `ss -K`) → reconnect → replay or
  snapshot, no duplicate turns; mid-turn steering and queued messages.
- Clicking a session opens an **interactive terminal** (the pty path —
  no "createTerminal is not supported" toast) and typing in it reaches the
  shell (the wire surface is fully verified by
  `scripts/ahp-terminal-probe.mjs`; client-side rendering is not).

---

## 5. Conformance (AHP official fixtures)

The AHP repo ships a language-independent conformance corpus in
[`types/test-cases`](https://github.com/microsoft/agent-host-protocol/tree/main/types/test-cases).
It is the exit criterion for the host: **green for every capability the
host advertises**. It was first run on 2026-11-09 and is green
([§5.6](#56-results-2026-11-09-first-run)); this section records what the
corpus is, why it validates this host, and how to execute it.

### 5.1 The corpus

Three fixture families (verified against the repo at 2026-11-09):

| Family | Contents | Fixture shape |
| --- | --- | --- |
| `types/test-cases/reducers/` | 308 reducer fixtures at `spec/v1.0.0` — state-transition behavior of every channel reducer, including no-op and wrong-id guard cases. | `{ description, reducer, initial, actions, expected }` — feed `actions` through the named reducer starting from `initial`; the result must deep-equal `expected`. |
| `types/test-cases/round-trips/` | 67 wire round-trip fixtures — decode/re-encode parity for every wire type (envelopes, JSON-RPC frames, state snapshots, unknown-variant preservation). | `{ group?, type, input, acceptableOutputs [exactly 1], preservedOutput? }` — decode `input`, re-encode, and require the single canonical form; group **B** fixtures assert the key-preserving form (`preservedOutput`) for runtimes without a decoder (TypeScript). `KNOWN-FIDELITY-GAPS.md` in the directory documents what the corpus does *not* verify. |
| `types/test-cases/version-negotiation.json` | 22 negotiation cases — highest-offered-in-range selection, `null` for no overlap, and invalid-version rejection. | `{ offered, expected }` / `{ offered, invalid: true }` against `negotiateProtocolVersion`. |

The official gate for the reducer family is the repo's root `npm test`,
which runs `types/*.test.ts` and `types/version/*.test.ts` under `c8`
with **100 % branch coverage required on `types/reducers.ts`** — the
fixtures are designed to cover the reducer exhaustively. The round-trip
family runs inside the TypeScript client's own suite.

### 5.2 Pin to `spec/v1.0.0`, not `main`

The protocol is strict-pinned at 1.0.0, and the corpus on `main` has
already drifted to 1.1.0-dev: it grew (351 reducer fixtures vs 308, 109
round-trips vs 68), fixtures 040/052 were renamed with **changed
semantics**, and new fixtures target 1.1.0 actions. Always check out the
`spec/v1.0.0` tag for the fixtures that match the pinned package.

### 5.3 What it covers for this host

The fixtures test client-side artifacts — the type package, its
reducers, and version negotiation — not a host process (there is no
official host harness). That is exactly the right surface here, because
the host **delegates** to the pinned package for everything the corpus
covers:

| Host code | Delegated to | Covered by |
| --- | --- | --- |
| `src/handshake.ts` — `initialize` version negotiation | `negotiateProtocolVersion`, `SUPPORTED_PROTOCOL_VERSIONS` | `version-negotiation.json` |
| `src/state.ts` — every channel state store (root, session, chat, changeset, terminal — the five channels the host implements) | the official `rootReducer` / `sessionReducer` / `chatReducer` / `changesetReducer` / `terminalReducer` | the `reducers/` corpus (the fixtures for the channels the host does not implement — canvas, annotations, resource-watch, automations — validate the package only) |
| wire encoding/decoding | the package's generated types + `JSON.parse`/`stringify` | the `round-trips/` corpus |

Verified (2026-11-09): the installed
`@microsoft/agent-host-protocol@1.0.0` package's `src/` is byte-identical
to the `spec/v1.0.0` tag (`clients/typescript/src` verbatim; the canonical
`types/` modulo a 3-line "Generated" header). So a green suite at the
tag **is** conformance of the pinned dependency — and gate 4
([§5.4](#54-how-to-run-it)) re-runs the reducer + version-negotiation
corpora against the installed dist on every pass, so the delegation does
not rest on that one-time check alone. The unit + live layers
([§1](#1-unit-tests-vitest), [§3](#3-live-verification)) run
against the installed dist. Honest limits, per
`KNOWN-FIDELITY-GAPS.md`: the TS round-trip harness does not verify
generated-type correctness (types are erased at runtime — that is the
compiler's job, exercised by `pnpm typecheck`), and host-level behavior
(handling, replay, capability gating) is covered by the unit + live
layers, not by the corpus.

### 5.4 How to run it

`node scripts/ahp-conformance.mjs` runs the whole pass. It shallow-clones
the AHP repo at the `spec/v1.0.0` tag into a throwaway scratch copy under
`/tmp/opencode/ahp-conformance/` (any local reference checkout is never
touched), installs the repo's dependencies, runs the four gates, and
removes the scratch on exit:

1. **Fixtures** — `tsx --test types/*.test.ts types/version/*.test.ts`
   at the tag: the reducer, version-negotiation, message-map, and
   extension-prefix corpora.
2. **Round-trips + client units** — `clients/typescript` `npm ci` +
   `npm test`: the wire round-trip corpus and the TS client's own
   suites. Prerequisite (handled by the script): the client's
   `src/types/` is *generated* from the root `types/` and gitignored —
   without `npm run generate:typescript` at the repo root, the client
   suites fail with `ERR_MODULE_NOT_FOUND` on
   `src/types/common/errors.js`.
3. **Coverage gate** — the official root-gate test files
   (`types/*.test.ts`, `types/version/*.test.ts`,
   `clients/dotnet/codegen/telemetry/*.test.ts`, `scripts/*.test.ts`)
   under c8 with `--include types/reducers.ts --check-coverage
   --branches 100` (100 % branch coverage on `types/reducers.ts` is
   required). The script drives c8's `outputReport` programmatically
   instead of via the CLI: on Node 26 the c8 11.0.0 CLI crashes before
   any test runs (its `require('yargs/yargs')` hits yargs 17.7.2's
   `"type": "module"` package and Node's require(ESM) bridge); the
   programmatic path runs the identical gate on any Node version. The
   include pattern resolves relative to cwd, so the report runs from the
   repo root, and the result is verified against the coverage map
   directly — with an empty map istanbul reports NaN pct and
   `NaN < 100` is false, so the threshold check would otherwise pass on
   air.
4. **Installed dist** — the tag's reducer + version-negotiation corpora
   run against the `@microsoft/agent-host-protocol` package installed in
   *this* repo's `node_modules` (the exact exports our host imports:
   `src/state.ts`'s five reducers, `src/handshake.ts`'s
   `negotiateProtocolVersion`): the pin-drift guard, so the pass covers
   what we ship, not only the tag.

Options: `--tag <tag>` (default `spec/v1.0.0`), `--repo-url <url>`,
`--dir <scratch root>`, `--keep` (retain the scratch checkout). Exit
codes (house convention): `0` all gates green · `1` fixture or coverage
failure · `2` setup failure (clone / `npm ci` / generate).

The repo's full root gate (`npm test`) additionally runs lint and the
release-metadata/changelog/change-fragment/generated verifications on top
of the same test files; it is the upstream repo's release gate, not part
of this host's conformance pass.

### 5.5 Status

Run and green as of the 2026-11-09 first pass
([§5.6](#56-results-2026-11-09-first-run)). The pass was deliberately
scheduled last — after the other [`futures.md`](futures.md) candidates
land or are set aside — so it validates the full advertised surface.
Re-run `scripts/ahp-conformance.mjs` whenever new capabilities are turned
on, the pinned AHP package changes, or the `spec/v1.0.0` corpus moves.

### 5.6 Results (2026-11-09 first run)

First pass via `scripts/ahp-conformance.mjs`, `spec/v1.0.0`
tag at `5f16d81b` ("release: AHP 1.0.0"):

| Gate | Result |
| --- | --- |
| 1 — fixtures (`types/*.test.ts` + `types/version/*.test.ts`) | 400/400 pass |
| 2 — TS client (`npm test`: round-trip corpus + client units) | 77/77 pass |
| 3 — coverage gate (official root-gate files under c8) | 516/516 pass; `types/reducers.ts` 100 % stmts / branches / funcs / lines — 100 % branch threshold met |
| 4 — installed dist vs corpus (reducer + version-negotiation) | 330/330 fixtures pass against the `@microsoft/agent-host-protocol@1.0.0` installed in this repo |

Fixture counts at the tag match [§5.1](#51-the-corpus): 308 reducer
files, 67 round-trip fixtures (the 68th directory entry is
`KNOWN-FIDELITY-GAPS.md`), 22 version-negotiation cases.

**Exit criterion met: green for every capability the host advertises.**
Per [§5.3](#53-what-it-covers-for-this-host), the corpus covers
everything the host delegates to the pinned package — version
negotiation, the five implemented channel reducers, and wire
round-trips — so a green tag suite is conformance of the pinned
dependency.

---

## 6. When to run what

| Trigger | Layers |
| --- | --- |
| Any code change (required before work is complete) | §1 `pnpm test` + §2 `pnpm typecheck` — both green, root-caused, never skipped. |
| Live-behavior change (transport, host, keep-alive) — before asking the user to publish | §3 test server + `ahp-turn-lifecycle.mjs` minimum, plus the script dedicated to the changed surface. |
| opencode event-catalog change | §3 `capture-events.mjs` to refresh `src/test/fixtures/events.jsonl`, then §1. |
| Publish (user's push; CI trusted publisher) | §2 re-runs in CI; `prepublishOnly` runs the same pair first. |
| Conformance gate | §5 — re-run on new capabilities, pin changes, or corpus moves (§5.5). |
