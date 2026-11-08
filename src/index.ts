/**
 * opencode-ahp — OpenCode V2 plugin: hosts the **Agent Host Protocol
 * (AHP) 1.0.0** in-process so opencode appears as a native agent in the
 * VS Code Agents window (plan §8.1).
 *
 * This is the only module that touches the plugin `ctx` (plan §7
 * pure-module principle). Everything else — options, transport,
 * handshake, channels, seq, state, bridge, host — is pure or
 * dependency-injected and unit-tested without an OpenCode runtime.
 *
 * Lifecycle:
 *   1. resolve options (ctx.options ▸ options.jsonc sibling ▸ built-ins;
 *      a malformed sibling file → one error log + re-resolve without it)
 *   2. `enabled: false` → the plugin is fully inert (no listener)
 *   3. token: explicit option, else persisted in ctx.storage (generated
 *      once, printed once to the server log)
 *   4. wire the Host (JSON-RPC router) to the transport (Bun.serve)
 *   5. start the opencode event pump (maps `ctx.event.subscribe` into
 *      the host's AHP action stream — plan §6.1/§11)
 *   6. return cleanup that stops the pump and the listener
 *
 * Every failure path logs and stays up: a bad client connection or a
 * bridge error must never take down the opencode server (R2).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
import { isRecord, resolveOptions, type Options } from "./options.js";
import { createListener, type Listener } from "./transport.js";
import { Host } from "./host.js";
import {
  mapV2Event,
  type FacadeAgent,
  type FacadeModel,
  type FacadeModelRef,
  type FacadeSession,
  type OpencodeFacade,
} from "./bridge.js";

const TAG = "[opencode-ahp]";

/** ctx.storage key for the persisted auto-generated token. */
const TOKEN_STORAGE_KEY = "ahp.token";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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
  return "0.1.0";
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
 * must not go stale on `opencode service restart` (plan §8.1).
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
    time: { created: info.time.created, updated: info.time.updated },
  };
}

/**
 * The narrow opencode surface the bridge needs (plan §3.2, §14.7, §11).
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
 * Phase 1 adds the session surface: create/list/get, prompt with
 * `delivery` (steer|queue), switchModel/switchAgent, interrupt, update
 * (rename), permission reply, and the mapped event stream.
 */
function implementFacade(ctx: Context): OpencodeFacade {
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
    // ── Phase 1: sessions ────────────────────────────────────────────────
    async createSession(input?: { id?: string; title?: string; agent?: string; model?: FacadeModelRef }) {
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
      });
      return mapSessionInfo(info);
    },
    async listSessions() {
      const { data } = await ctx.session.list();
      return data.map(mapSessionInfo);
    },
    async getSession(sessionID: string) {
      try {
        return mapSessionInfo(await ctx.session.get({ sessionID }));
      } catch {
        return null; // gone (removed) — the pump treats null as "skip"
      }
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
        const mapped = mapV2Event(event);
        if (mapped !== null) yield mapped;
      }
    },
  };
}

export default Plugin.define({
  id: "opencode-ahp",
  async setup(ctx: Context) {
    // 1. Options — resolved before anything else (plan §8.1).
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

    // 3. Host + transport. The host's send/close callbacks close over the
    // listener variable, which is assigned immediately after the host is
    // constructed (the listener's socket ids are the host's socket ids).
    let listener: Listener | null = null;
    let cleanupHost: (() => void) | null = null;
    try {
      const host = new Host({
        serverInfo: { name: "opencode-ahp", version: pluginVersion(), title: "OpenCode" },
        facade: implementFacade(ctx),
        replayWindow: opts.replayWindow,
        defaultDirectory: ctx.location.directory,
        send: (socketId, message) => {
          listener?.sendTo({ id: socketId }, JSON.stringify(message));
        },
        close: (socketId, code, reason) => {
          listener?.closeConnection({ id: socketId }, code, reason);
        },
        log: (msg) => console.warn(`${TAG} ${msg}`),
      });
      listener = createListener(
        {
          host: opts.host,
          port: opts.port,
          path: opts.path,
          healthPath: opts.healthPath,
          token,
          allowedOrigins: opts.allowedOrigins,
          tls: opts.tls,
        },
        {
          onOpen: (info) => host.onOpen(info.id),
          onMessage: (info, text) => host.onMessage(info.id, text),
          onClose: (info) => host.onClose(info.id),
        },
      );
      // 5. Event pump: opencode V2 events → AHP actions (the streaming
      // text/reasoning, tool lifecycle, permissions, usage, turn
      // terminals, steering/queue handoff — plan §11).
      host.startEventPump();
      cleanupHost = () => host.stopEventPump();
      console.log(
        `${TAG} AHP 1.0.0 host listening on ws${opts.tls ? "s" : ""}://${opts.host}:${listener.port}${opts.path} ` +
          `(token ${opts.token ? "from options" : "auto-generated"}; health ${opts.healthPath})`,
      );
    } catch (e) {
      console.error(`${TAG} failed to start the AHP listener: ${errorMessage(e)}`);
      listener?.stop();
      listener = null;
      return; // R2: the opencode server stays up without AHP
    }

    // 4. Cleanup: stop the pump (aborts the event subscription) and stop
    //    the listener, dropping every client connection. Logged because
    //    opencode silently unloads idle locations
    //    (`experimental.location_idle_timeout`, default 60 minutes) and a
    //    torn-down listener with no log line is otherwise undiagnosable
    //    (plan §14.8).
    return () => {
      console.log(`${TAG} location teardown — stopping the AHP host (location unloaded by opencode)`);
      cleanupHost?.();
      listener?.stop();
    };
  },
});
