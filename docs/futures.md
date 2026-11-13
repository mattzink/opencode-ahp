# Future work

This document covers **potential work**: candidate extensions, parts
of the AHP 1.0.0 surface the host does not implement, the upgrade
outlook for AHP 1.1.0, and upstream changes (opencode, VS Code) that
would unlock more use cases.

**Nothing in this document is planned or scheduled.** Every item
carries one or more issues — a missing plugin surface, a missing
upstream feature, a protocol gap, or no client that drives it — that
make it hard to implement, or not worth implementing, today. This
is a backlog of candidates (what *could* be done, and what stands in
the way), not a roadmap.

It is the forward-looking companion to [`design.md`](design.md), which
describes how the plugin works today. For installation and options, see
the [README](../README.md) and [`options.example.jsonc`](../options.example.jsonc);
for testing (unit, static, live verification, two-machine, and
conformance), see [`docs/testing.md`](testing.md).

Protocol facts are verified against the installed
`@microsoft/agent-host-protocol@1.0.0` dist (the wire ground truth) and
the upstream [`microsoft/agent-host-protocol`](https://github.com/microsoft/agent-host-protocol)
repository (checked 2026-11-09). opencode findings are verified against
v2.2.6 source and current `main` where noted.

---

## 1. Potential work items

Candidate work — **none of it planned or scheduled**. Each item below
names its blocker, or the reason it is not worth doing today.

### 1.1 Elicitation completion (decision pending)

**What it is.** AHP 1.0.0 *elicitation* is the host asking the **user**
for structured input mid-turn — a preference, a clarification, a
decision, or a URL to review. It is distinct from tool-call confirmation:

- the host inserts an `InputRequestResponsePart` into the turn via
  `chat/inputRequested`, carrying a
  `ChatInputRequest { id, message?, url?, questions?, answers? }`;
  `url?` is for URL-style elicitations (a link to review/open);
- `questions[]` are typed: **text** (format / min / max / default),
  **number/integer** (min / max / default), **boolean** (default),
  **single-select** (options + freeform), **multi-select** (options +
  min / max + freeform); each question's `id` keys `answers`;
- the client answers with `chat/inputAnswerChanged` (sync drafts) and
  `chat/inputCompleted` (submit: **`accept` | `decline` | `cancel`**);
- the part **updates in place** (stable stream position), so a settled
  Q&A is durable in the turn transcript; if the turn ends unanswered the
  part simply stays with `response` absent;
- an unresolved chat input request is also mirrored at session level as
  a `SessionChatInputRequest` (kind `chatInput`) via
  `session/inputNeededSet` / `session/inputNeededRemoved`, so a client
  can see and answer it without subscribing to the chat.

**The opencode side.** opencode's native elicitation is the **`question`
tool** — *model-initiated* (the model decides to ask), not
host-initiated: its input is `questions[]` of
`{ question, header, options[], multiple? }`; execution is gated by a
permission assertion, then it calls the **Form** system
(`forms.ask({ sessionID, title, metadata, fields })`), which presents
the questions and **blocks** on a deferred until answered or dismissed.
Only `forms.reply({ id, answer })` (or `forms.cancel`) unblocks it; the
answers then return to the model as tool output.

**The load-bearing asymmetry (verified).**

- **Detection is easy and durable.** A `question` tool call is an
  ordinary tool call in the turn — the host already handles tool-call
  events for every tool, so it can recognize the `question` tool by name
  and surface its input as `chat/inputRequested` (plus the session-level
  `inputNeededSet` mirror).
- **Settlement is the gap.** The blocked `question` tool can only be
  resolved by `forms.reply` — but the **Form service is not on the
  plugin surface** (there is no `ctx.form`; `Form.Interface` =
  `create/ask/get/list/state/reply/cancel`, none exposed to plugins). A
  remote AHP client's answer therefore **cannot be routed back into
  opencode** through any plugin API.
- **Form events are live-only.** `form.created` / `form.replied` /
  `form.cancelled` are *ephemeral* (not replayed on reload/reconnect)
  but **are** server events, so the host can observe them live on the
  plugin event stream and cannot recover them later. The durable,
  replayable signal is the `question` **tool call**, not the Form.

**Status.** The host handles the other two input-request kinds
(`toolConfirmation` and `toolClientExecution`); it does **not** handle
`chatInput` — hence elicitation is partial today. Surfacing an
elicitation to AHP clients is well within the existing surface;
completing it has no plugin-side path today.

**Options (a real design decision, user call pending):**

- **(a) opencode feature request** — expose a Form reply surface to
  plugins (`ctx.form` with `reply`/`cancel`); parallel to the other
  queued requests in [§4.1](#41-opencode--feature-requests-to-file).
  The clean fix; blocked on upstream.
- **(b) Host-side elicitation that bypasses the Form** — the host owns
  the request and the answer, then injects the answer back into the
  model as a follow-up prompt. Workable **today** within the plugin
  surface, but it changes the turn shape (two prompts instead of one
  tool round trip) and does not reuse opencode's native question UI.
- **(c) Read-only for AHP clients** — accept that elicitation is
  answered in the opencode UI (TUI) only; AHP clients see the request
  but not the answer flow. Still requires the host-side surfacing work
  (detect → `chat/inputRequested` + session mirror).

### 1.2 Terminals beyond the synthetic command terminals

Beyond the shipped synthetic terminals (read-only `ahp-terminal:`
channels rendered from `shell`-tool executions — see
[design.md §12](design.md#12-synthetic-terminals)), two further
terminal modes remain potential work, each with its own blocker:

- **(b) Read-only mirror of the session's persistent-pty** (the user's
  TUI "Terminal" pane). Mechanism: subscribe to
  `persistent-pty.added/removed/updated` (ephemeral server events,
  live-observable) and poll
  `ctx.experimental.terminal.read({ sessionID, lines? })` — a **screen
  snapshot** (rendered text, not a raw VT stream) of the session's
  **selected** terminal — publishing `ahp-terminal:` channels with the
  screen text as `unclassified` parts. `isPty: false` is accurate about
  the payload. Limits: selected terminal only; snapshot-based content
  (diffed or full-replace); no input, resize, or creation (clean
  rejections); lifecycle events are live-only. One nice property:
  **reload-recoverable for the selected terminal** — the persistent-pty
  runs in a separate daemon that outlives the location (handoff /
  shutdown operations), so a reloaded host can re-discover the terminal
  via `read(sessionID)`; the only state worth persisting is the
  channel-URI mapping.
- **(d) Interactive remote terminals** — a client typing into a pty
  (`terminal/input` → pty write). This is **impossible inside the
  plugin boundary today**: the surface exposes only
  `ctx.experimental.terminal.read`; the full `PersistentPty`/`Pty`
  APIs (create / write / resize / attach) are on the opencode HTTP
  surface but deliberately not on the plugin ctx. It requires the pty
  plugin-surface request in [§4.1](#41-opencode--feature-requests-to-file).
  Note that the agent's own command execution (`shell` tool) is
  pipe-backed, not a pty — there is no pty to claim for a tool call.

### 1.3 Turn history hydration (`fetchTurns`)

**The gap.** A location reload or server restart tears down all
in-memory turn state; a reconnecting client sees the session's *state*
(titles, chats, current activity) but not its past turns. It is the
one durability gap with a clear implementation path — but it is
**potential, not planned**: it is extension-scale work, and no client
currently asks for it (below), so doing it now would buy nothing
visible.

**The AHP wire path already exists in 1.0.0:**

- `fetchTurns` (chat channel) — cursor-based; the cursor comes from
  `ChatState.turnsNextCursor` and the command returns an empty result
  once older turns are loaded into chat state;
- `SubscribeParams.view.turns` — subscribe to a bounded tail of chat
  history;
- `chat/turnsLoaded` — page older turns into the reduced chat state.

**The durable data source is opencode's own session store** —
`ctx.session.context` (a `SessionContext` message window over the
persisted messages). The bridge already maps the raw event shapes these
messages carry into turn state, so hydration is largely re-running the
existing mappers over durable data.

**Why it stays potential.** The current VS Code 1.145.2 client
**never requests turn history** (`fetchTurns` is type-only in the
official TS client), so this work has no user-visible effect until a
client — VS Code or another AHP client — starts paging history. It
becomes worth doing only once that happens.

### 1.4 Small chat-surface gaps

- **Cancelling a queued message** — `chat/pendingMessageRemoved` is
  rejected today: *"opencode has no inbox cancel."* Once a
  steer/queue message is sent it cannot be withdrawn; opencode has no
  API to cancel a pending inbox item. This is an upstream dependency
  ([§4.1](#41-opencode--feature-requests-to-file)), not a design choice.
  (The host still *publishes* `chat/pendingMessageRemoved` when a
  steering message is consumed — that direction already works.)
- **The `always` permission reply** — AHP 1.0.0's
  `chat/toolCallConfirmed` is an `Approved | Denied` union with **no
  reply-mode field**, so the host maps approved → `once`, denied →
  `reject`. opencode's permission reply surface *does* support
  `always` (the TUI's "always allow"); the plugin-side type deliberately
  narrows it out for now. This is a **protocol-side watch**: if AHP
  adds a reply mode (or confirmation-option id), the host can map it to
  opencode's `always` decision.
- **`chat/truncated`** — client-dispatchable and **state-only** (records
  a client-side turn truncation in the reduced state); no opencode
  dependency. The one micro-improvement here with **no blocker** —
  accept it through the official reducer instead of the current
  rejection echo. Potential, not planned: it is small, and nothing
  currently demands it.

---

## 2. The AHP 1.0.0 surface the host does not implement

The strict-pinned 1.0.0 package exposes more than the host implements.
The host implements only what opencode can back and what a conforming
client actually drives, and never advertises what it does not
implement. Nothing in this inventory is planned; each entry is a
**candidate** that would become work once its blocker clears — an
opencode surface, a protocol field, or a client that drives it. Each
item notes why it is absent and whether an opencode surface exists to
back it.

### 2.1 Commands

| Command | Status | opencode backing | Notes |
| --- | --- | --- | --- |
| `fetchTurns` | not implemented | **yes** — `ctx.session.context` | Turn history hydration; [§1.3](#13-turn-history-hydration-fetchturns). |
| `disposeSession` | not implemented | **yes** — `ctx.session.remove` (already used by `disposeChat`) | Pure host-side work. Careful with multi-chat: one session may back several chats — disposal must handle the peer bindings. |
| `moveChat` | not implemented | no — no session fork/copy API; a chat is 1:1 with its opencode backend session | 1.1.0-in-flight companion action `chat/moved` ([§3.2](#32-what-is-in-flight-on-upstream-main)); VS Code 1.145.2 does not call it. |
| `completions` | not implemented | **partially** — `ctx.experimental.generate` (stateless model generation) | A mapping is implementable today; no client in the field drives it against this host. |
| `sessionConfigCompletions` | **intentionally unreachable** | n/a — `resolveSessionConfig` answers an empty schema | The client-side guard ("property not advertised") makes the command unreachable; never advertise what we don't implement. |
| `resourceList` / `resourceRequest` / `resourceResolve` / `resourceCopy` / `resourceMove` / `resourceDelete` / `resourceMkdir` / `resourceWrite` | not implemented (only `resourceRead`, for changeset content) | AHP's resource family is formally **bidirectional** (client → host is permitted) | Implementing the write/copy/move family is a file-access policy decision (a remote client writing into the location directory); the VS Code client drives only `resourceRead` against this host. |
| `createResourceWatch` | not implemented | no watch subscription on the plugin surface | Long-lived file-change streams on `ahp-resource-watch:` channels; needs the upstream request in [§4.1](#41-opencode--feature-requests-to-file). |
| `authenticate` (+ `auth/required`) | not implemented | the host authenticates with the transport token; no OAuth flows | AHP's auth surface is for OAuth / protected-resource challenges (e.g. per-MCP-server auth); this host exposes no MCP servers. |
| `runAutomation` / `fetchAutomationRuns` / `listAutomationTriggerDefinitions` | not implemented | no scheduled-automation concept in opencode | See the automations stability watch in [§3](#3-ahp-110-status-and-upgrade-path); the reserved `capabilities.automations: false` option is already in place. |

### 2.2 Channels

- **`ahp-automations://` + `ahp-automation-run:`** — the automation
  catalogue and automation-run channels. Nuance worth stating plainly:
  these are shipped **inside the published 1.0.0 package** at
  *"1.0 - Early development"* stability — they are not "1.1 territory"
  in the version sense; **stability, not version, is the right frame**.
  They are in flux, and opencode has no corresponding concept (no
  scheduled, trigger-based agent runs).
- **`ahp-canvas:`** — *"1 - Experimental"*; per-canvas presentation
  channels. No canvas concept in opencode.
- **`ahp-resource-watch:`** — see `createResourceWatch` above.
- **OTLP notifications** (`otlp/exportLogs` / `otlp/exportTraces` /
  `otlp/exportMetrics`) — host → client telemetry export. The host logs
  through the plugin logger today; no client in the field consumes these
  against this host. A possible future observability path (opencode's
  event stream → OTLP export), not a gap any current client hits.

### 2.3 Client-dispatchable actions

**Chat** — unhandled (rejected echo):

- `turnResume` — reopen a turn from a resumable error (AHP 0.9.0);
  opencode has no resumable-turn surface (an interrupted execution
  cannot be resumed).
- `queuedMessagesReordered` — reorder queued messages; no inbox
  reordering API in opencode.
- `truncated` — state-only; **cheap win** ([§1.4](#14-small-chat-surface-gaps)).
- `workingDirectorySet` / `workingDirectoryRemoved` — multiroot working
  directories; the host advertises no `multipleWorkingDirectories`
  capability (a location is one directory), so conformant clients never
  send them.
- `inputAnswerChanged` / `inputCompleted` — elicitation;
  [§1.1](#11-elicitation-completion-decision-pending).

**Session** — unhandled:

- `workingDirectorySet` / `workingDirectoryRemoved` /
  `workingDirectoryReplaced` — same multiroot reason as above.
- `customizationToggled` — toggle a customization on/off; opencode's
  agents are static file/config definitions, and the plugin surface has
  no agent enable/disable toggle.
- `mcpServerStartRequested` / `mcpServerBackgroundRequested` /
  `mcpServerStopRequested` — MCP server control. `ctx.mcp` is
  **config-level only** (`list` + a `transform` hook over server configs
  - `reload`); there is no runtime server state (starting / ready /
  authRequired / error / stopped) and no start/stop control, and the
  host does not expose MCP servers as session customizations at all.
- `configChanged` — 1.1.0-in-flight ([§3.2](#32-what-is-in-flight-on-upstream-main));
  not part of the 1.0.0 wire; listed for completeness.

**Accepted as client-local no-ops** (echoed; the state is
client-bookkeeping only): `chat/draftChanged`, `chat/isReadChanged`,
`chat/isArchivedChanged`, `session/isReadChanged`,
`session/isArchivedChanged`.

**Rejected by design:** every client-dispatchable `terminal/*` action
(`input`, `resized`, `claimed`, `titleChanged`, `cleared`) — the
synthetic terminals are read-only renderings of shell-tool calls
([design.md §12](design.md#12-synthetic-terminals)); and
`chat/pendingMessageRemoved` — [§1.4](#14-small-chat-surface-gaps).

### 2.4 Notifications

- **`root/progress`** — host → client progress correlated by a
  `progressToken` the client supplies on `createSession`; for long
  bring-up work. The host never emits progress today; a candidate if
  session creation ever gets slow.
- **`auth/required`** — see `authenticate` above.
- **`otlp/*`** — see [§2.2](#22-channels).
- **`setClientManagedSettingsPermissions`** — *not* AHP; a
  VS Code-specific post-init notification with no 1.0.0 counterpart.
  Accepted and logged as a no-op (the connection must stay up) —
  [design.md §6](design.md#6-command-surface).

---

## 3. AHP 1.1.0: status and upgrade path

The upgrade is **potential, not planned** — nothing on the client side
can force it, and nothing in the current feature set needs it
([§3.1](#31-status-verified-2026-11-09)). What follows is the state of
the question, and what an upgrade would involve if and when it becomes
worth doing.

### 3.1 Status (verified 2026-11-09)

- **npm:** the latest published `@microsoft/agent-host-protocol` is
  **1.0.0** (published 2026-10-03). There is no 1.1.x release.
- **Upstream `main`:** `PROTOCOL_VERSION = '1.1.0'` (the development
  version), but `SUPPORTED_PROTOCOL_VERSIONS` is still
  `['1.0.0', '0.9.0']` — a 1.1.0-dev client **negotiates down to 1.0.0**,
  so no client in the field can force this host to upgrade.
- **Spec changelog:** the
  [`CHANGELOG.md`](https://github.com/microsoft/agent-host-protocol/blob/main/CHANGELOG.md)
  carries a `## [1.1.0] — Unreleased` placeholder with no items yet;
  in-flight protocol changes are tracked via PRs touching `types/` and
  the per-symbol `ACTION_INTRODUCED_IN` / `NOTIFICATION_INTRODUCED_IN`
  maps in `types/version/registry.ts`.

### 3.2 What is in flight on upstream main

Read from the registry maps on `main` (2026-11-09):

- **Actions introduced in 1.1.0:** `chat/configChanged`, `chat/moved`
  (the companion to the 1.0.0 `moveChat` command).
- **Notifications introduced in 1.1.0:** `channel/frame`,
  `channel/credit`, `channel/snapshot` — frame-based channel
  multiplexing over the transport — plus `tcp/data`, `tcp/eof`,
  `tcp/reset` — a **raw TCP byte-stream surface**. This is a new
  capability class (byte streams over AHP), not needed by the current
  feature set.
- **Stability churn to expect:** the below-stable channels shipped in
  1.0.0 — automations (*Early development*) and canvas
  (*Experimental*) — are the likeliest 1.1.0 change surface.

### 3.3 What an upgrade would look like

- Bump the strict pin to `@microsoft/agent-host-protocol@1.1.0`.
  Policy: AHP stays **strict-pinned** — an upgrade is a deliberate
  release, not a `^`-range drift.
- **Handshake: no code change.** `src/handshake.ts` delegates to the
  pinned package's `negotiateProtocolVersion` +
  `SUPPORTED_PROTOCOL_VERSIONS`; upgrading the package widens the
  accepted baselines automatically ([design.md §4](design.md#4-connection-model--handshake)).
- The new surface (frame/credit, `tcp/*`, `configChanged`, `moved`) is
  additive and opt-in — nothing is required to interoperate.
- `serverInfo.version` is *this package's* version (read from
  `package.json` at runtime), not the protocol version — unaffected.
- **Decision triggers to watch:** automations stabilizing (relevant
  only if an opencode-side automation concept is ever built — the
  blocker today is opencode, not the protocol); client adoption of
  `fetchTurns` (makes [§1.3](#13-turn-history-hydration-fetchturns)
  user-visible); any 1.1.0 change to elicitation or terminal I/O
  semantics that alters the mappings in [§1.1](#11-elicitation-completion-decision-pending)
  / [design.md §12](design.md#12-synthetic-terminals).

---

## 4. Upstream changes that would unlock more

### 4.1 opencode — feature requests to file

Queued as "investigate upstream later" from the keep-alive work;
ordered by impact. Findings verified against v2.2.6 source and current
`main` (88 commits ahead) where noted.

1. **Auto-boot / server-scoped plugin hook** — the **cold-boot
   residual**. A location boots only on an HTTP request to the opencode
   API or a TUI/IDE opening the project; plugins load *per location* and
   cannot run before the location boots; the AHP client never touches
   the opencode API (it dials the AHP WebSocket), so it cannot trigger
   a boot. No auto-boot / initialLocation / defaultLocation config
   exists. The in-plugin keep-alive covers **idle eviction only**
   (the 60-minute TTL); a fresh server process still needs the one-time
   boot step (README step 3). A zero-touch boot needs an auto-boot
   config (a location that boots at server start) or a server-scoped
   plugin hook.
2. **`session.update` dropping `archived`** — the plugin host's
   `session.update` forwards only title / metadata / permissions and
   **silently drops `input.archived`** (v2.2.6 and current dev); HTTP
   `PATCH /api/session/{id}` accepts `{archived}`. Consequence today:
   the keep-alive anchor session (`ses_ahp_keepalive`) cannot be
   archived and is visible in the opencode TUI session list as
   "opencode-ahp (keep-alive)"; it is filtered from every AHP surface
   by ID ([design.md §15.3](design.md#153-keep-alive-anchor)).
3. **Form reply surface for plugins** (`ctx.form` with `reply` /
   `cancel`) — the load-bearing blocker for elicitation completion
   ([§1.1](#11-elicitation-completion-decision-pending), option (a));
   the Form system is the only way to unblock the `question` tool.
4. **pty surface for plugins** (`write` / `attach`, or at minimum
   `list` / `create` for persistent-pty) — needed **only** for fully
   *interactive* remote terminals ([§1.2](#12-terminals-beyond-the-synthetic-command-terminals),
   option (d)). The read-only mirror (option (b)) does not need it.
5. **Inbox cancel** — a way to withdraw a pending steer/queue message;
   unlocks `chat/pendingMessageRemoved` ([§1.4](#14-small-chat-surface-gaps)).
6. **File-watch subscription** (or a durable file-change event stream)
   — would back `createResourceWatch` / `ahp-resource-watch:`
   ([§2.1](#21-commands)). Long-term; no current client need.

Impact note: #1 changes the deployment UX (zero-touch boot), #2 removes
a visible TUI artifact, #3 is the only path to remote elicitation — the
three that change the shape of the product. #4–#6 are on-demand feature
unlocks.

### 4.2 VS Code — upstream requests & watches

Work candidates the 1.145.2 client (and the two-machine pass,
testing.md §4) point at. The client-behavior facts themselves live in
design.md — terminal rendering (§12.1), the permission-card UI (§7.4),
command requirements (§6).

- **Request to VS Code: render session-claimed terminals.** The current
  Agents window renders none of the host's `ahp-terminal:` channels
  (design.md §12.1) — until it does, the synthetic terminal feature is
  wire-only ([§1.2](#12-terminals-beyond-the-synthetic-command-terminals)).
- **Request to the AHP docs: note that `resolveSessionConfig` is a hard
  requirement for new-session sends.** VS Code fires it when the
  composer opens (failure swallowed) and strictly before the first send
  (failure fatal — design.md §6); this host's original -32601 broke
  new-session sends. Latent for **every** third-party host — worth a
  host-implementer documentation note.
- **Clarify with VS Code: what `setClientManagedSettingsPermissions`
  expects.** VS Code-specific post-init notification with no AHP 1.0.0
  counterpart; the host accepts it as a no-op (design.md §6). If the
  client expects a specific response or behavior, that should be
  documented.
- **Potential host work: publish `ConfirmationOption`s for a richer
  permission card** (custom labels instead of the plain approve/deny UI
  whose deny action reads "Skip" — design.md §7.4). An AHP 1.0.0 field,
  but the options can only express what opencode's permission reply can
  answer with (`once` / `reject` today) — blocked by the `always` gap
  ([§1.4](#14-small-chat-surface-gaps)).
- **`fetchTurns` is unused by the 1.145.2 client** (type-only in the
  official TS client) — turn hydration ([§1.3](#13-turn-history-hydration-fetchturns))
  has no user-visible effect until client adoption.
- **Watch:** AHP client updates in VS Code that drive more of the
  protocol surface (resource watches, `root/progress`, automations,
  elicitations) — each becomes a candidate for host support in the
  priority order of [§2](#2-the-ahp-100-surface-the-host-does-not-implement).

---

## 5. Deferred v1 non-goals

Carried forward from the original v1 scoping; revisit only if the use
case changes:

- **Standalone (non-plugin) host binary** — the `opencode acp`
  sidecar proposal was explicitly re-rejected; the solution lives
  entirely inside the opencode plugin `setup(ctx)` interface.
- **Replacing the opencode TUI or its UI.**
- **Multi-user / multi-tenant policy, sandboxing.**
- **Windows-first deployment polish** — build for Linux first, verify
  cross-platform later.
- **Off-LAN transports beyond native `wss://`** (Tailscale, dev
  tunnels, TLS reverse proxies) — the native TLS termination shipped;
  the rest is operational, not architectural.
- **AHP in-flux features** (automations, canvas) — tracked by
  stability, not version ([§3](#3-ahp-110-status-and-upgrade-path)).

---

## 6. Items awaiting a decision

| Item | Where | Awaiting |
| --- | --- | --- |
| Elicitation settlement design — options (a) / (b) / (c) | [§1.1](#11-elicitation-completion-decision-pending) | user decision |
| Filing the opencode feature requests | [§4.1](#41-opencode--feature-requests-to-file) | "investigate upstream later" |
