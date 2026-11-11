/**
 * opencode-ahp — OpenCode V2 plugin: hosts the **Agent Host Protocol
 * (AHP) 1.0.0** in-process so opencode appears as a native agent in the
 * VS Code Agents window.
 *
 * This is the only module that touches the plugin `ctx` — everything
 * else (options, transport, handshake, channels, seq, state, bridge,
 * host) is pure or dependency-injected and unit-tested without an
 * OpenCode runtime.
 *
 * Lifecycle:
 *   1. resolve options (ctx.options ▸ options.jsonc sibling ▸ built-ins;
 *      a malformed sibling file → one error log + re-resolve without it);
 *      `enabled: false` → the plugin is fully inert (no listener)
 *   2. token: explicit option, else persisted in ctx.storage (generated
 *      once, printed once to the server log)
 *   3. keep-alive: get-or-create the anchor session and start
 *      touching it periodically so the location survives the idle timeout
 *      without any user config
 *   4. wire the Host (JSON-RPC router) to the transport (Bun.serve)
 *   5. start the opencode event pump (maps `ctx.event.subscribe` into
 *      the host's AHP action stream)
 *   6. return cleanup that stops the keep-alive, the pump, and the listener
 *
 * Every failure path logs and stays up: a bad client connection or a
 * bridge error must never take down the opencode server (R2).
 */
import { execFile } from "node:child_process";
import { mkdir, readFile as fsReadFile, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Plugin } from "@opencode/plugin";
// Type-only import of the plugin context. The package's root entry
// intentionally re-exports no `Context` (it is only ever observed as the
// `setup` parameter of `Plugin.define`); the subpath is part of the
// package's declared exports map (`./*` → `./dist/*`).
import type { Context } from "@opencode/plugin/promise/plugin";
import type { SessionDomain } from "@opencode/plugin/promise/session";
/**
 * The opencode `SessionInfo` type (the plugin package does not re-export
 * it from its public entry points; `SessionDomain["get"]` returns it).
 * `@opencode/client` itself is only a transitive dependency, so the type
 * is derived through the plugin package's declared subpaths.
 */
type SessionInfo = Awaited<ReturnType<SessionDomain["get"]>>;
/**
 * The `SessionCreateInput["metadata"]` type — a JSON record per the
 * `Session.Metadata` schema (derived the same way as `SessionInfo`).
 */
type SessionCreateMetadata = NonNullable<Parameters<SessionDomain["create"]>[0]>["metadata"];
import { isRecord, resolveOptions, type Options } from "./options.js";
import { createListener, type Listener } from "./transport.js";
import { Host } from "./host.js";
import type { SpawnPty } from "./host-types.js";
import { KeepAlive, KEEPALIVE_SESSION_ID } from "./keep-alive.js";
import { errorMessage } from "./error.js";
import {
  mapV2Event,
  type FacadeAgent,
  type FacadeClientTool,
  type FacadeModel,
  type FacadeModelRef,
  type FacadeSession,
  type OpencodeFacade,
} from "./bridge.js";
import { normalizedName } from "./client-tools.js";
/**
 * The opencode tool surface for client-provided tools. `ToolError` is
 * the schema `Error` class (thrown from the `execute` bridge); `ToolInfo`
 * is the promise-flavored
 * tool registration; `ToolContext` carries the tool-call context
 * (sessionID, the tool-call `id`, the abort `signal`).
 */
import {
  Error as ToolError,
  type Info as ToolInfo,
  type ToolContext,
} from "@opencode/plugin/promise/tool";

const TAG = "[opencode-ahp]";

/** ctx.storage key for the persisted auto-generated token. */
const TOKEN_STORAGE_KEY = "ahp.token";

/** Raw text of the `options.jsonc` sibling of this file, or null when absent. */
function readOptionsFile(): string | null {
  try {
    return readFileSync(fileURLToPath(new URL("./options.jsonc", import.meta.url)), "utf8");
  } catch {
    return null;
  }
}

/**
 * The plugin's version for `InitializeResult.serverInfo`. Read from the
 * package.json two levels up (src/index.ts → package root); falls back to
 * the in-repo base version when the file is unavailable.
 */
function pluginVersion(): string {
  try {
    const raw = readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed["version"] === "string") return parsed["version"];
  } catch {
    // fall through to the fallback
  }
  return "0.1.1";
}

/**
 * The Bun runtime surface the pty seam uses. opencode ships as a
 * Bun-compiled binary, so `globalThis.Bun` is present at runtime; the
 * package's typecheck only knows the Node types, so the minimal shape is
 * declared locally rather than taking a dev dependency on Bun's types.
 */
interface BunPty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface BunChildProcess {
  kill(): void;
  readonly terminal: BunPty;
  readonly exited: Promise<number>;
}

interface BunLike {
  spawn(
    cmd: string[],
    opts: {
      cwd: string;
      env: Record<string, string | undefined>;
      terminal: {
        cols: number;
        rows: number;
        name: string;
        data(term: unknown, data: string | Uint8Array): void;
      };
    },
  ): BunChildProcess;
}

/**
 * The host's `spawnPty` seam backed by `Bun.spawn`'s `terminal` option —
 * a real pty with no external dependency (the plugin runs inside the Bun
 * runtime). Returns undefined when the runtime is not Bun (the terminal
 * commands then answer -32601 instead of the host crashing). The shell is
 * `$SHELL` (fallback /bin/bash); login shells get `-l` (fish has none).
 * Output is decoded defensively (string or bytes) and the exit code
 * normalized (signal-killed → undefined).
 */
function createBunSpawnPty(): SpawnPty | undefined {
  const bun = (globalThis as { Bun?: BunLike }).Bun;
  if (bun === undefined) return undefined;
  const decoder = new TextDecoder();
  return (input) => {
    const shell = process.env.SHELL ?? "/bin/bash";
    const base = shell.split("/").pop() ?? "";
    const login = ["bash", "zsh", "ksh", "sh", "dash", "ash"].includes(base) ? ["-l"] : [];
    const proc = bun.spawn([shell, ...login], {
      cwd: input.cwd,
      env: { ...process.env, TERM: "xterm-256color" },
      terminal: {
        cols: input.cols,
        rows: input.rows,
        name: "xterm-256color",
        data: (_term, data) => {
          input.onOutput(typeof data === "string" ? data : decoder.decode(data));
        },
      },
    });
    void proc.exited.then(
      (code) => input.onExit(Number.isInteger(code) && code >= 0 ? code : undefined),
      () => input.onExit(undefined),
    );
    return {
      write: (data) => proc.terminal.write(data),
      resize: (cols, rows) => proc.terminal.resize(cols, rows),
      kill: () => {
        try {
          proc.kill();
        } catch {
          // already gone
        }
        try {
          proc.terminal.close();
        } catch {
          // already closed
        }
      },
    };
  };
}

/** 32 random bytes, base64url — 43 chars, comfortably over the 16-char floor. */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Token from options when set; otherwise the persisted one from plugin
 * storage, generated (and printed once) on first start. Persisting in
 * `ctx.storage` means restarts reuse the same token — a printed token
 * must not go stale on `opencode service restart`.
 */
async function ensureToken(ctx: Context): Promise<string> {
  const existing = await ctx.storage.get(TOKEN_STORAGE_KEY);
  if (typeof existing === "string" && existing.length >= 16) return existing;
  const token = generateToken();
  await ctx.storage.set(TOKEN_STORAGE_KEY, token);
  console.log(`${TAG} AHP token (auto-generated, persisted in plugin storage): ${token}`);
  return token;
}

/**
 * The opencode model ref (`Model.Ref = {id, providerID, variant?}`)
 * behind an opencode session info entry.
 */
function modelRefOf(info: SessionInfo): FacadeModelRef | undefined {
  if (info.model === undefined) return undefined;
  return {
    providerID: String(info.model.providerID),
    modelID: String(info.model.id),
    ...(info.model.variant !== undefined ? { variant: String(info.model.variant) } : {}),
  };
}

/** Map an opencode `SessionInfo` to the narrow `FacadeSession`. */
function mapSessionInfo(info: SessionInfo): FacadeSession {
  return {
    sessionID: String(info.id),
    ...(info.title !== undefined && info.title !== null ? { title: String(info.title) } : {}),
    ...(info.agent !== undefined ? { agent: String(info.agent) } : {}),
    ...(info.model !== undefined ? { model: modelRefOf(info) } : {}),
    // SessionInfo.time carries `archived` only while archived.
    ...(info.time.archived !== undefined ? { archived: true } : {}),
    // Durable, core-opaque metadata: the host reads its
    // `opencode-ahp` chat-binding marker from it on external registration.
    ...(isRecord(info.metadata) ? { metadata: info.metadata as Record<string, unknown> } : {}),
    time: { created: info.time.created, updated: info.time.updated },
  };
}

/** True when a raw V2 event envelope (`{id, type, data}`) belongs to a session. */
function isHiddenSessionEvent(event: unknown, hiddenSessionID: string): boolean {
  if (!isRecord(event)) return false;
  const data = event["data"];
  return isRecord(data) && data["sessionID"] === hiddenSessionID;
}

// ── changeset git helpers ──────────────────────────
//
// The plugin `ctx` has no "file content at HEAD" or "discard one file"
// surface (`ctx.vcs` only diffs), so the facade shells out to `git` in the
// location directory. Every helper degrades to null/[] on any failure — a
// VCS hiccup must never throw into the host (R2).

const execFileAsync = promisify(execFile);

/** Run `git <args…>` in `cwd` and return stdout. Throws on non-zero exit. */
async function git(cwd: string, args: string[]): Promise<string> {
  // 64 MiB buffer: file contents can be large; a buffer overflow must read
  // as "failed" (→ null/[]), not hang the host.
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** The git repo root containing `cwd`, or null when it is not inside one. */
async function gitRepoRoot(cwd: string): Promise<string | null> {
  try {
    const out = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** The repo-root-relative path of `absPath`, or null when outside the repo. */
function repoRelative(root: string, absPath: string): string | null {
  const rel = relative(root, absPath);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * The narrow opencode surface the bridge needs.
 *
 * The catalog and agents are re-read on every call (the host snapshots
 * lazily on initialize/subscribe/reconnect, not at setup) from the
 * registry read APIs: `ctx.provider.list()` (provider metadata incl.
 * `activation`) joined with `ctx.model.list()` (the materialized model
 * infos), and `ctx.agent.list()` (opencode's agents, incl. built-in
 * Build/Plan and user-defined ones). The v2 plugin docs guarantee
 * registry reads reflect every registration so far — including during
 * plugin setup — so no setup-time race.
 *
 * The session surface covers create/list/get, prompt with `delivery`
 * (steer|queue), switchModel/switchAgent, interrupt, update (rename),
 * permission reply, and the mapped event stream.
 *
 * `hiddenSessionID` (the keep-alive anchor) is filtered from all
 * three session surfaces so the AHP client never sees it: `list`/snapshots
 * (by ID), `get` (null = not found), and the event stream (by
 * `data.sessionID` — covers `session.created` and anything a future bridge
 * version may map).
 *
 * `hostRef`: the client-tool
 * `execute` bridge needs the host, but the facade is constructed as part
 * of the host's own options — a mutable holder assigned right after
 * `new Host(...)` returns (the `listener` closure pattern).
 */
type HostRef = { current: Host | null };

function implementFacade(ctx: Context, hiddenSessionID: string | null, hostRef: HostRef): OpencodeFacade {
  const locationDir = ctx.location.directory;

  // The cross-session client-tool set (client-provided tools).
  // The single `ctx.tool.transform` registration is applied on every
  // registry rebuild (opencode rebuilds from scratch, re-running all
  // transforms over a fresh base — verified in core `State.create`), so
  // the sync is: replace the set, (register the transform once), reload.
  let clientTools: FacadeClientTool[] = [];
  let clientToolsTransformRegistered = false;

  const readTextFile = async (absPath: string): Promise<string | null> => {
    try {
      return await fsReadFile(absPath, "utf-8");
    } catch (err) {
      if (isEnoent(err)) return null; // absent → null (caller decides)
      throw err; // other errors propagate (host maps them)
    }
  };
  const removeFile = async (absPath: string): Promise<void> => {
    try {
      await rm(absPath);
    } catch (err) {
      if (!isEnoent(err)) throw err; // already gone → no-op
    }
  };

  return {
    async listCatalog() {
      const [providers, models] = await Promise.all([ctx.provider.list(), ctx.model.list()]);
      const modelsByProvider = new Map<string, FacadeModel[]>();
      for (const m of models.data) {
        const key = String(m.providerID);
        let list = modelsByProvider.get(key);
        if (!list) {
          list = [];
          modelsByProvider.set(key, list);
        }
        list.push({
          providerID: key,
          modelID: String(m.modelID),
          name: m.name,
          enabled: m.enabled,
          limit: {
            context: m.limit.context,
            output: m.limit.output,
            input: m.limit.input,
          },
          inputModalities: [...m.capabilities.input],
        });
      }
      return providers.data.map((p) => ({
        providerID: String(p.id),
        name: p.name,
        activation: p.activation,
        models: modelsByProvider.get(String(p.id)) ?? [],
      }));
    },
    async listAgents(): Promise<readonly FacadeAgent[]> {
      const { data: agents } = await ctx.agent.list();
      return agents.map((a) => ({
        id: String(a.id),
        name: a.name,
        description: a.description,
        model: a.model
          ? { providerID: String(a.model.providerID), modelID: String(a.model.id) }
          : undefined,
        mode: a.mode,
        hidden: a.hidden,
      }));
    },
    // ── sessions ────────────────────────────────────────────────
    async createSession(input?: {
      id?: string;
      title?: string;
      agent?: string;
      model?: FacadeModelRef;
      metadata?: Record<string, unknown>;
    }) {
      const info = await ctx.session.create({
        ...(input?.id !== undefined ? { id: input.id } : {}),
        ...(input?.title !== undefined ? { title: input.title } : {}),
        ...(input?.agent !== undefined ? { agent: input.agent } : {}),
        ...(input?.model !== undefined
          ? {
              model: {
                id: input.model.modelID,
                providerID: input.model.providerID,
                ...(input.model.variant !== undefined ? { variant: input.model.variant } : {}),
              },
            }
          : {}),
        // The chat-binding marker is written atomically at
        // create (no read-merge — core projects MetadataUpdated as a full
        // column replacement, so a later update would clobber it). Session
        // metadata is JSON by the Session.Metadata schema; the facade keeps
        // it unknown-typed, so the single cast lives here.
        ...(input?.metadata !== undefined ? { metadata: input.metadata as SessionCreateMetadata } : {}),
      });
      return mapSessionInfo(info);
    },
    async listSessions() {
      const { data } = await ctx.session.list();
      return data
        .filter((s) => String(s.id) !== hiddenSessionID)
        .map(mapSessionInfo);
    },
    async getSession(sessionID: string) {
      if (sessionID === hiddenSessionID) return null;
      try {
        return mapSessionInfo(await ctx.session.get({ sessionID }));
      } catch {
        return null; // gone (removed) — the pump treats null as "skip"
      }
    },
    async removeSession(sessionID: string) {
      await ctx.session.remove({ sessionID });
    },
    async prompt(input: { sessionID: string; text: string; delivery?: "steer" | "queue" }) {
      const res = await ctx.session.prompt({
        sessionID: input.sessionID,
        text: input.text,
        ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
      });
      return { messageID: String(res.id) };
    },
    async switchModel(input: { sessionID: string; model: FacadeModelRef }) {
      await ctx.session.switchModel({
        sessionID: input.sessionID,
        model: {
          id: input.model.modelID,
          providerID: input.model.providerID,
          ...(input.model.variant !== undefined ? { variant: input.model.variant } : {}),
        },
      });
    },
    async switchAgent(input: { sessionID: string; agent: string }) {
      await ctx.session.switchAgent({ sessionID: input.sessionID, agent: input.agent });
    },
    async interrupt(input: { sessionID: string }) {
      await ctx.session.interrupt({ sessionID: input.sessionID });
    },
    async rename(input: { sessionID: string; title: string }) {
      await ctx.session.update({ sessionID: input.sessionID, title: input.title });
    },
    async replyPermission(input: { sessionID: string; requestID: string; decision: "once" | "reject" }) {
      await ctx.permission.reply({
        sessionID: input.sessionID,
        requestID: input.requestID,
        decision: input.decision,
      });
    },
    /**
     * The mapped event stream (bridge.ts `mapV2Event` is the only place
     * that knows the raw wire shape). Ends without error when the host's
     * pump signal aborts (teardown).
     */
    async *events(signal: AbortSignal) {
      for await (const event of ctx.event.subscribe({ signal })) {
        if (hiddenSessionID !== null && isHiddenSessionEvent(event, hiddenSessionID)) continue;
        const mapped = mapV2Event(event);
        if (mapped !== null) yield mapped;
      }
    },
    // ── changesets ────────────────────────────────
    async vcsDiffWorking() {
      const root = await gitRepoRoot(locationDir);
      if (root === null) return []; // not a git repo → no working diff
      try {
        // `ctx.vcs.diff` returns `{ location, data: FileDiff.Info[] }` with
        // repo-root-relative `file` paths — join to the repo root for the
        // facade's absolute-path contract.
        const res = await ctx.vcs.diff({ mode: "working", untracked: "files" });
        return res.data.map((d) => ({
          path: join(root, d.file),
          additions: d.additions,
          deletions: d.deletions,
          status: d.status,
        }));
      } catch {
        return []; // R2: degrade to empty, never throw
      }
    },
    async gitHeadFile(absPath: string) {
      const root = await gitRepoRoot(locationDir);
      if (root === null) return null;
      const rel = repoRelative(root, absPath);
      if (rel === null) return null;
      try {
        return await git(root, ["show", `HEAD:${rel}`]);
      } catch {
        return null; // no HEAD / not tracked / failed → absent
      }
    },
    async readFile(absPath: string) {
      return readTextFile(absPath);
    },
    async writeFile(absPath: string, content: string) {
      await mkdir(dirname(absPath), { recursive: true });
      await fsWriteFile(absPath, content, "utf-8");
    },
    async deleteFile(absPath: string) {
      await removeFile(absPath);
    },
    async discardFile(absPath: string) {
      const root = await gitRepoRoot(locationDir);
      const rel = root !== null ? repoRelative(root, absPath) : null;
      if (root === null || rel === null) {
        await removeFile(absPath); // not in a repo → just delete
        return;
      }
      try {
        await git(root, ["ls-files", "--error-unmatch", "--", rel]);
      } catch {
        await removeFile(absPath); // untracked (or staged-new) → delete
        return;
      }
      try {
        await git(root, ["checkout", "HEAD", "--", rel]);
      } catch {
        await removeFile(absPath); // in the index but not in HEAD → delete
      }
    },
    // ── client-provided tools ───────
    async syncClientTools(tools: readonly FacadeClientTool[]) {
      clientTools = [...tools];
      if (!clientToolsTransformRegistered) {
        clientToolsTransformRegistered = true;
        // Registered once for the location lifetime (scoped: disposed on
        // location teardown). The callback is synchronous and reads the
        // closure `clientTools` at rebuild time; each rebuild is a fresh
        // registry, so only (re-)adding the current set is needed.
        await ctx.tool.transform((editor) => {
          const added = new Set<string>();
          for (const tool of clientTools) {
            const id = normalizedName(tool.name);
            if (added.has(id)) continue; // normalized-name collision → first wins
            added.add(id);
            editor.add({
              name: tool.name,
              // The AHP `inputSchema` is a raw object JSON Schema —
              // opencode's `inputJsonSchema` passes it through verbatim
              // and validates model inputs against it.
              input: tool.inputSchema,
              description: tool.description,
              // A client tool must be a DIRECT tool: under Code Mode a
              // tool in the `execute` catalog is invoked as nested JS
              // (`tools.ping(...)`) that emits no tool events of its own
              // (only the outer `execute` call does), so the host could
              // never see the call to track + relay to the client.
              // `codemode: false` keeps it out of the catalog and in
              // the direct list (live finding 2026-11-08).
              options: { codemode: false },
              execute: async (_input: unknown, context: ToolContext) => {
                const host = hostRef.current;
                if (host === null) {
                  throw new ToolError({ message: "the AHP host is not running" });
                }
                const result = await host.executeClientTool({
                  sessionID: String(context.sessionID),
                  toolCallId: String(context.id),
                  name: tool.name,
                  signal: context.signal,
                });
                if (!result.ok) throw new ToolError({ message: result.error });
                const text = [result.pastTenseMessage, result.content]
                  .filter((part): part is string => typeof part === "string" && part.length > 0)
                  .join("\n\n");
                return {
                  ...(text.length > 0 ? { content: text } : {}),
                  // No `output` (no output schema is declared — the
                  // runtime rejects one); structured content rides in
                  // the tool part's metadata.
                  ...(result.structuredContent !== undefined
                    ? { metadata: { structured: result.structuredContent } }
                    : {}),
                };
              },
            } as unknown as ToolInfo);
          }
        });
      }
      await ctx.tool.reload();
    },
  };
}

export default Plugin.define({
  id: "opencode-ahp",
  async setup(ctx: Context) {
    // 1. Options — resolved before anything else.
    let opts: Options;
    try {
      opts = resolveOptions(ctx.options, readOptionsFile());
    } catch (e) {
      console.error(`${TAG} malformed options.jsonc (${errorMessage(e)}); re-resolving without it`);
      opts = resolveOptions(ctx.options, null);
    }
    if (!opts.enabled) {
      console.log(`${TAG} disabled (enabled: false); not starting the AHP host`);
      return;
    }

    // 2. Token.
    let token: string;
    try {
      token = opts.token ?? (await ensureToken(ctx));
    } catch (e) {
      console.error(`${TAG} could not resolve an AHP token: ${errorMessage(e)}`);
      return; // R2: the opencode server stays up without AHP
    }

    // 3. Keep-alive. Before the host exists, so the anchor
    //    session's `session.created` fires before the event pump subscribes
    //    and never reaches AHP clients (the facade filters it from the
    //    snapshot/list surfaces regardless). A deterministic session ID means
    //    reloads reuse the same session — no accumulation in the DB.
    //    start() never throws: on failure the keep-alive stays off and
    //    opencode's idle timeout applies as before (R2).
    const hiddenSessionID = opts.keepAlive ? KEEPALIVE_SESSION_ID : null;
    let keepAlive: KeepAlive | null = null;
    if (opts.keepAlive) {
      keepAlive = new KeepAlive({
        // Get-or-create. (Upstream gap: `SessionUpdateInput`
        // advertises `archived`, but the plugin host's `session.update`
        // drops it — `packages/core/src/plugin/host.ts` forwards only
        // title/metadata/permissions, in v2.2.6 and current dev. So the
        // anchor cannot be archived from a plugin; it is visible in the
        // opencode TUI session list as "opencode-ahp (keep-alive)" and is
        // filtered out of every AHP surface by ID instead.)
        ensureSession: async () => {
          try {
            await ctx.session.get({ sessionID: KEEPALIVE_SESSION_ID });
          } catch {
            await ctx.session.create({
              id: KEEPALIVE_SESSION_ID,
              title: "opencode-ahp (keep-alive)",
              metadata: { "opencode-ahp": "keep-alive" },
            });
          }
        },
        touch: () =>
          ctx.session.update({
            sessionID: KEEPALIVE_SESSION_ID,
            metadata: { "opencode-ahp": "keep-alive", keepAliveAt: Date.now() },
          }),
        intervalMs: opts.keepAliveIntervalMinutes * 60_000,
        log: (msg) => console.warn(`${TAG} ${msg}`),
      });
      await keepAlive.start();
    }

    // 4. Host + transport. The host's send/close callbacks close over the
    // listener variable, which is assigned immediately after the host is
    // constructed (the listener's socket ids are the host's socket ids).
    let listener: Listener | null = null;
    let cleanupHost: (() => void) | null = null;
    // The host back-reference for the client-tool `execute` bridge (the
    // facade is built from the host's options, so the reference lands
    // one statement later — the `listener` pattern).
    const hostRef: HostRef = { current: null };
    try {
      const host = new Host({
        serverInfo: { name: "opencode-ahp", version: pluginVersion(), title: "OpenCode" },
        facade: implementFacade(ctx, hiddenSessionID, hostRef),
        replayWindow: opts.replayWindow,
        defaultDirectory: ctx.location.directory,
        changesets: opts.capabilities.changesets,
        terminals: opts.capabilities.terminals,
        spawnPty: createBunSpawnPty(),
        send: (socketId, message) => {
          listener?.sendTo({ id: socketId }, JSON.stringify(message));
        },
        close: (socketId, code, reason) => {
          listener?.closeConnection({ id: socketId }, code, reason);
        },
        log: (msg) => console.warn(`${TAG} ${msg}`),
      });
      hostRef.current = host; // the client-tool execute bridge can route now
      // TLS material: read the key/cert files here so a
      // missing/unreadable file fails before binding and takes the R2
      // degrade path below — the transport itself stays
      // filesystem-free (it receives the PEM contents).
      const tls = opts.tls
        ? {
            key: await fsReadFile(opts.tls.keyPath, "utf8"),
            cert: await fsReadFile(opts.tls.certPath, "utf8"),
          }
        : null;
      listener = createListener(
        {
          host: opts.host,
          port: opts.port,
          path: opts.path,
          healthPath: opts.healthPath,
          token,
          allowedOrigins: opts.allowedOrigins,
          tls,
        },
        {
          onOpen: (info) => host.onOpen(info.id),
          onMessage: (info, text) => host.onMessage(info.id, text),
          onClose: (info) => host.onClose(info.id),
        },
      );
      // 5. Event pump: opencode V2 events → AHP actions (the streaming
      // text/reasoning, tool lifecycle, permissions, usage, turn
      // terminals, steering/queue handoff).
      host.startEventPump();
      cleanupHost = () => {
        // Kill the pty terminals before the listener stops — their final
        // terminal/exited actions still reach subscribers while it is up.
        host.stopTerminals();
        host.stopEventPump();
      };
      console.log(
        `${TAG} AHP 1.0.0 host listening on ws${opts.tls ? "s" : ""}://${opts.host}:${listener.port}${opts.path} ` +
          `(token ${opts.token ? "from options" : "auto-generated"}; health ${opts.healthPath})`,
      );
    } catch (e) {
      console.error(`${TAG} failed to start the AHP listener: ${errorMessage(e)}`);
      keepAlive?.stop(); // don't hold the location for a dead AHP host
      listener?.stop();
      listener = null;
      return; // R2: the opencode server stays up without AHP
    }

    // 6. Cleanup: stop the keep-alive timer, stop the pump (aborts the
    //    event subscription), and stop the listener, dropping every client
    //    connection. Logged because a torn-down listener with no log line
    //    is otherwise undiagnosable.
    return () => {
      console.log(`${TAG} location teardown — stopping the AHP host (location unloaded by opencode)`);
      keepAlive?.stop();
      cleanupHost?.();
      listener?.stop();
    };
  },
});
