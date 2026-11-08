# AGENTS.md

This file provides guidance to agents when working in this repository.

## Stack

Single-package TypeScript plugin for **opencode v2** that hosts the **Agent
Host Protocol (AHP) 1.0.0** in-process (`@microsoft/agent-host-protocol`,
strict-pinned — the installed dist is the wire ground truth). House pattern
(shared with llama-sync): **no build step** — `package.json` `exports` point
at `./src/index.ts` and opencode (Bun runtime) loads the TS source directly;
pure, dependency-injected modules (`host.ts`, `bridge.ts`, `transport.ts`,
`keep-alive.ts`) unit-tested with Vitest without an opencode runtime.
`plan.md` is the canonical design doc and wire-finding log — the source of
truth for *why* the code is shaped the way it is.

## Commands

- **Toolchain (Node 26 + pnpm)**: managed via [`mise.toml`](mise.toml) —
  first-time setup: `mise trust && mise install && mise run setup`. CI uses
  `jdx/mise-action` to consume the same config.
- **Bumping the pnpm version**: the pnpm version is read from the
  `packageManager` field in `package.json` (via
  `idiomatic_version_file_enable_tools` in `mise.toml`) — after bumping that
  field, just run `mise install` to fetch and install the new version. Shims
  resolve the declared version on every invocation, so no reactivation,
  reshim, or other mise config change is needed; CI picks it up automatically.
- **Typecheck**: `pnpm typecheck` (`tsc --noEmit` over source and tests).
- **Tests**: `pnpm test` (Vitest, `vitest run` — all suites in
  `src/test/`). There is no build step and no E2E suite in CI; live
  verification is done manually against the LAN test server via
  `scripts/ahp-client.mjs` (handshake/probe) and `scripts/ahp-phase1.mjs`
  (full Phase 1 lifecycle).
- **Publishing**: CI only — push to GitHub and the trusted-publisher
  workflow (`.github/workflows/publish.yml`) publishes
  `0.1.<GITHUB_RUN_NUMBER>` (gaps in run numbers are expected) and creates
  a tagged GitHub release (`v<version>`) with a short install pointer +
  the push's commit list. `prepublishOnly` runs typecheck + tests as a
  guard. Do not run `npm publish` from a shell (interactive 2FA blocks it;
  the user's terminal is the only other path).

## Critical Patterns

- **No build step — ever**: the package ships TS source; do not add a
  `dist/`, bundler, or build script. Edits to `src/` are picked up by
  opencode on location reload (local-path plugin installs load
  `./src/index.ts` directly).
- **Pure modules + DI (house pattern)**: every module that is unit-tested is
  a pure function/class with its dependencies (session access, timers,
  logging, sockets) injected — tests never touch the opencode runtime, the
  network, or the filesystem (see `src/test/keep-alive.test.ts` for the
  current idiom, including injected fake timers).
- **R2 — the opencode server must stay up**: the plugin never throws out of
  `setup(ctx)`; every failure path (bad options, token failure, listener
  failure, keep-alive failure) logs and degrades gracefully with AHP off
  while opencode itself keeps serving. Follow this on any new failure mode.
- **Token always enforced**: the AHP listener refuses to start without a
  token, and a non-loopback bind requires one (R4). Never add a
  no-token dev mode.
- **ESM imports require `.js` extensions**: all internal imports use the
  explicit `.js` suffix (TS source references `.js` not `.ts`).
- **AHP wire contract**: protocol behavior is defined by AHP 1.0.0 — when in
  doubt about a method/field, check `node_modules/@microsoft/agent-host-protocol`
  dist and the VS Code 1.145.2 AHP client sources (`/tmp/opencode/vscode-*.ts`),
  and record findings in `plan.md` §14. The host's `serverInfo.version` is
  read from `package.json` at runtime (`pluginVersion()` in `src/index.ts`).
- **opencode v2 is per-location**: plugins load per location (a location
  boots on first use and is idle-evicted after 60 min by default). The
  keep-alive module (`src/keep-alive.ts`, plan §15) is what holds the
  location loaded; its anchor session `ses_ahp_keepalive` is deliberately
  filtered from every AHP surface — keep it that way if the anchor changes.
- **Typecheck gotcha**: when piping `tsc` output (e.g. through `head`), use
  `set -o pipefail` first — otherwise the pipe masks `tsc`'s exit code and a
  broken build looks clean.

## Agent Rules

### Git

- **The user does all git commits and pushes manually.** Agents must never
  run `git commit`, `git push`, `git tag`, `git rebase`, or any other
  history-mutating git command. Prepare the working tree (stage nothing
  required — just make the changes), then tell the user exactly what to
  commit and push. Publishing rides on the push (CI trusted publisher), so
  "ready to publish" = "working tree complete, user pushes".
- `npm publish` is user-run only as well (interactive 2FA); CI is the normal
  publish path.

### Environment boundaries

- **Never touch the daily `:80` `opencode serve --service`** (or its
  `~/.config/opencode/opencode.jsonc` config) — it is the user's running
  service.
- The **LAN test server** (port 4098, AHP 8767, isolated XDG homes under
  `/tmp/opencode/ahp-lan/`, config in
  `/tmp/opencode/ahp-scratch/project-lan/.opencode/opencode.jsonc`) may be
  reloaded (`POST /api/location/reload`) or restarted for testing.
- Scratch state goes under `/tmp/opencode/`, never in tracked directories.

### Architecture constraints

- **Plugin interface only**: solutions must live inside the existing opencode
  plugin `setup(ctx)` interface — no separate processes (a sidecar `opencode
  acp` was explicitly rejected), no upstream opencode changes, no standalone
  bin (plan §12 D4/D5).
- **MVP transport is plain `ws://` + token on the local LAN** (D3); no TLS or
  off-LAN routing in this phase.
- **AHP stays strict-pinned at 1.0.0.**

### Documentation updates

- Behavior, architecture, or wire-contract changes MUST update
  [`plan.md`](plan.md) (findings go in §14, new topics get a new §).
- User-facing behavior (install, config, options, runbook) MUST update
  [`README.md`](README.md) and/or `options.example.jsonc`.

### Test execution

- After ANY code change, run `pnpm typecheck` and `pnpm test` before marking
  the task complete. Tests MUST pass — debug and fix root causes, never
  complete a task with failing tests.
- Changes that alter live behavior (transport, host, keep-alive) should be
  verified against the LAN test server with `scripts/ahp-phase1.mjs` before
  asking the user to publish.

### API validation

- All third-party library/framework/SDK usage MUST be validated using the
  **context7 MCP** tool before implementation. Never assume API signatures —
  verify against up-to-date documentation.
