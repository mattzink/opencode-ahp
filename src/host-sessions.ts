/**
 * Session section (design §7): `createSession`/`listSessions`/`resolveSessionConfig`, external session registration (TUI/restart resurfacing, AHP markers, peer-chat re-attach), and record removal.
 */

import { HostChats } from "./host-chats.js";
import { ActionType, SessionStatus, ResolveSessionConfigResult, SessionActiveClient, SessionSummary } from "@microsoft/agent-host-protocol";
import { agentDirectoryCustomization, chatChangesetCatalog, chatSummaryOf, directoryUri, initialSessionState, mapAgentCustomizations, sessionChangesetCatalog, FacadeSession } from "./bridge.js";
import { ROOT_CHANNEL, channelKind, chatChannelURI, sessionChannelURI, sessionIDOf } from "./channels.js";
import { ERROR_INVALID_PARAMS } from "./handshake.js";
import { isRecord } from "./options.js";
import { createSessionStateStore } from "./state.js";
import { ERROR_NO_PROVIDER, ERROR_SESSION_EXISTS } from "./host-errors.js";
import { RpcMessage, SessionRecord } from "./host-types.js";
import { EXTERNAL_REGISTER_GRACE_MS, AHP_METADATA_KEY, parseAhpMarker, errorMessage, firstEnabledModelRef, normalizeActiveClient } from "./host-util.js";

/** Default page size for `listSessions` (AHP `PaginatedParams.limit`). */
const LIST_SESSIONS_DEFAULT_LIMIT = 100;

export class HostSessions extends HostChats {
  /**
   * `createSession` (AHP 1.0.0 session-channel command). Creates a real
   * opencode session, seeds its session/chat stores, publishes the
   * session-channel lifecycle actions, announces the session on the root
   * channel, and responds `null` (per the command contract).
   *
   * Error codes: -32002 (no agent for the requested provider),
   * -32003 (the session URI already exists).
   */
  protected async handleCreateSession(socketId: number, msg: RpcMessage): Promise<void> {
    const params = isRecord(msg.params) ? msg.params : {};
    const channel = params["channel"];
    if (typeof channel !== "string" || channelKind(channel) !== "session") {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "createSession requires an ahp-session:/… channel");
      return;
    }
    const suffix = sessionIDOf(channel) as string;
    // A suffix containing the changeset marker would make this session
    // channel string-identical to the changeset URI of the session before
    // the marker — the changeset kind would win (channelKind), making the
    // session channel un-subscribable. Reject it instead.
    if (suffix.includes("/changeset/")) {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "channel suffix must not contain \"/changeset/\"");
      return;
    }
    for (const rec of this.sessions.values()) {
      if (rec.channel === channel) {
        this.sendError(socketId, msg.id, ERROR_SESSION_EXISTS, "Session already exists");
        return;
      }
    }

    // Resolve the provider/model for the new session.
    const providers = await this.opts.facade.listCatalog();
    const providerParam = params["provider"];
    let provider;
    if (typeof providerParam === "string" && providerParam.length > 0) {
      provider = providers.find((p) => p.providerID === providerParam && p.activation !== "disabled");
      if (provider === undefined) {
        this.sendError(socketId, msg.id, ERROR_NO_PROVIDER, `No agent for provider ${providerParam}`);
        return;
      }
    } else {
      provider = providers.find((p) => p.activation !== "disabled");
    }
    const model = provider !== undefined ? firstEnabledModelRef(provider.models) : undefined;

    // `activeClient` eagerly claims an active-client role; the spec requires
    // the clientId to match the creating client.
    let activeClients: SessionActiveClient[] = [];
    const activeClientParam = params["activeClient"];
    if (activeClientParam !== undefined) {
      const socket = this.sockets.get(socketId);
      const ac = activeClientParam as Record<string, unknown>;
      if (
        !isRecord(ac) ||
        typeof ac["clientId"] !== "string" ||
        ac["clientId"] !== socket?.clientId
      ) {
        this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "activeClient.clientId must match the initializing clientId");
        return;
      }
      activeClients = [normalizeActiveClient(ac)];
    }

    // opencode SessionIDs must start with "ses": pass the suffix through
    // only when it already is one; otherwise let opencode mint an id and
    // record the suffix→id mapping (the record key is the opencode id).
    const passID = suffix.startsWith("ses") ? suffix : undefined;
    const created = await this.opts.facade.createSession({
      id: passID,
      model,
      // Durability: a minted-id default backend carries
      // the client-chosen session channel in its opencode metadata —
      // after a restart the session resurfaces under the ORIGINAL channel
      // instead of its opencode id (a "ses" suffix IS the opencode id and
      // needs no marker).
      ...(passID === undefined ? { metadata: { [AHP_METADATA_KEY]: { channel } } } : {}),
    });

    // Slow-create race: the pump may have registered this opencode session
    // under its own id as an external session while `createSession` was in
    // flight. Remap: drop the interim record (root/sessionRemoved) and
    // re-register under the client-chosen channel below.
    //
    // Marker interaction: with the channel marker, the
    // interim external registration lands under the MARKED channel (the
    // client's own), so `interim.channel !== channel` is false and the
    // remap is skipped — the re-registration below then re-announces the
    // session (a duplicate root/sessionAdded in this rare race; cosmetic,
    // the client converges on the snapshot, and the race requires
    // createSession to exceed the 250 ms external-register grace).
    const interim = this.sessions.get(created.sessionID);
    if (interim !== undefined && interim.channel !== channel) {
      this.removeRecord(interim);
    }

    const agents = await this.opts.facade.listAgents();
    const customizations =
      mapAgentCustomizations(agents).length > 0 && this.opts.defaultDirectory !== undefined
        ? [agentDirectoryCustomization(this.opts.defaultDirectory, agents)]
        : undefined;
    const now = new Date().toISOString();
    const sessionStore = createSessionStateStore(
      initialSessionState({
        sessionID: created.sessionID,
        provider: created.model?.providerID ?? provider?.providerID ?? "opencode",
        title: created.title ?? "New Session",
        activeClients,
        customizations,
        workingDirectories: this.workingDirectories(),
      }),
    );
    const rec: SessionRecord = {
      sessionID: created.sessionID,
      channel,
      provider: sessionStore.state.provider,
      createdAt: new Date(created.time.created).toISOString(),
      modifiedAt: new Date(created.time.updated).toISOString() > now
        ? new Date(created.time.updated).toISOString()
        : now,
      sessionStore,
      chats: new Map(),
      defaultChatURI: chatChannelURI(created.sessionID),
      sessionChangesets: new Map(),
    };
    this.sessions.set(created.sessionID, rec);
    this.byChannel.set(channel, rec);
    // The session channel carries the client-chosen suffix; the chat
    // channel and the event pump carry the opencode id — both must
    // resolve in the registry.
    this.channels.addSession(suffix);
    this.channels.addSession(created.sessionID);
    const defaultChat = this.newChatRuntime(rec.defaultChatURI, created.sessionID, "Chat 1", now);
    this.bindChat(rec, defaultChat);

    // A createSession `activeClient` seeds the
    // session's tools — register them with opencode now.
    if (activeClients.length > 0) void this.syncClientToolsToOpencode();

    // Session-channel lifecycle (server-side, no origin).
    this.publish({ channel, action: { type: ActionType.SessionReady } });
    this.publish({
      channel,
      action: { type: ActionType.SessionChatAdded, summary: chatSummaryOf(defaultChat.chatStore.state) },
    });
    this.publish({
      channel,
      action: { type: ActionType.SessionDefaultChatChanged, defaultChat: rec.defaultChatURI },
    });
    // Advertise the changeset catalogues (session channel: the
    // session-wide changeset; chat channel: uncommitted + session + the
    // per-turn template).
    if (this.opts.changesets) {
      this.publish({
        channel,
        action: { type: ActionType.SessionChangesetsChanged, changesets: sessionChangesetCatalog(channel) },
      });
      this.publish({
        channel: rec.defaultChatURI,
        action: {
          type: ActionType.ChatChangesetsChanged,
          changesets: chatChangesetCatalog(rec.defaultChatURI, channel),
        },
      });
    }
    // Root: active-session count (action, replayed) + sessionAdded (notification).
    this.publish({
      channel: ROOT_CHANNEL,
      action: { type: ActionType.RootActiveSessionsChanged, activeSessions: this.sessions.size },
    });
    this.notifyRoot("root/sessionAdded", {
      channel: ROOT_CHANNEL,
      summary: this.sessionSummary(rec),
    });

    this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, result: null });
  }

  /**
   * `listSessions` (AHP 1.0.0 root command): all opencode sessions,
   * most-recently-modified first, with in-memory cursor pagination.
   * Unknown sessions are lazily registered (so their channels become
   * subscribable); registration is idempotent per opencode session id.
   */
  protected async handleListSessions(socketId: number, msg: RpcMessage): Promise<void> {
    const params = isRecord(msg.params) ? msg.params : {};
    const limit =
      typeof params["limit"] === "number" && Number.isInteger(params["limit"]) && (params["limit"] as number) > 0
        ? (params["limit"] as number)
        : LIST_SESSIONS_DEFAULT_LIMIT;
    let offset = 0;
    if (typeof params["cursor"] === "string" && params["cursor"].length > 0) {
      const parsed = Number.parseInt(params["cursor"], 10);
      if (Number.isInteger(parsed) && parsed > 0) offset = parsed;
    }
    const listed = await this.opts.facade.listSessions();
    const records: (SessionRecord | undefined)[] = [];
    for (const fs of listed) {
      records.push(this.registerExternal(fs) ?? this.sessions.get(fs.sessionID));
    }
    const sorted = records
      .filter((r): r is SessionRecord => r !== undefined)
      .sort((a, b) => {
        const ta = this.sessions.get(a.sessionID)?.modifiedAt ?? a.modifiedAt;
        const tb = this.sessions.get(b.sessionID)?.modifiedAt ?? b.modifiedAt;
        return ta < tb ? 1 : ta > tb ? -1 : 0;
      });
    const page = sorted.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    const result: { items: SessionSummary[]; nextCursor?: string } = {
      items: page.map((rec) => this.sessionSummary(rec)),
    };
    if (nextOffset < sorted.length) result.nextCursor = String(nextOffset);
    this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, result });
  }

  /**
   * AHP 1.0.0 root command — the client resolves the session-creation
   * config schema. VS Code calls it every time the new-session composer
   * opens and STRICTLY again before the first send of a new session
   * (`_sendNewSessionRequest`), so an unimplemented host makes every
   * fresh session unstartable ("unknown method: resolveSessionConfig").
   * opencode collects no session-creation configuration —
   * agent/model choice rides session-state customizations and the
   * per-turn message — so the honest answer is an empty schema with
   * empty values. `provider` / `workingDirectory` / `config` are
   * accepted and deliberately unused: sessions run in the location
   * directory and the host advertises no config properties (which also
   * keeps `sessionConfigCompletions` unreachable — it only serves
   * `enumDynamic` properties this schema does not carry).
   */
  protected handleResolveSessionConfig(socketId: number, msg: RpcMessage): void {
    const params = isRecord(msg.params) ? msg.params : {};
    if (params["channel"] !== ROOT_CHANNEL) {
      this.sendError(
        socketId,
        msg.id,
        ERROR_INVALID_PARAMS,
        "resolveSessionConfig requires the ahp-root:// channel",
      );
      return;
    }
    const result: ResolveSessionConfigResult = {
      schema: { type: "object", properties: {} },
      values: {},
    };
    this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, result });
  }

  /**
   * Verify a `session.created` event via the session API and register the
   * session under its own id as the channel suffix (the suffix starts
   * with "ses" — opencode ids are valid suffixes). No-op when the session
   * is gone, already registered, or a createSession remap is pending.
   */
  // ── session registration / removal ─────────────────────────────────────
  protected async registerExternalDeferred(sessionID: string): Promise<void> {
    if (this.sessions.has(sessionID) || this.byOpencode.has(sessionID)) return;
    let fs: FacadeSession | null;
    try {
      fs = await this.opts.facade.getSession(sessionID);
    } catch {
      return;
    }
    if (fs === null || this.sessions.has(fs.sessionID) || this.byOpencode.has(fs.sessionID)) return;
    this.registerExternal(fs);
  }

  /**
   * Register an opencode session the host did not create (TUI, another
   * client, or a session resurfacing after a restart).
   * Outcomes:
   *
   *  - the opencode id already backs a chat of a live record → skip
   *    (undefined); `listSessions` must not surface peer-chat backends
   *    as their own AHP sessions;
   *  - the session carries a peer marker and the owner record is
   *    registered (and the marker's chat URI is free) → re-attach it to
   *    the owner's chat catalog (undefined — no standalone session);
   *  - the peer marker's owner is not registered yet → queue the
   *    binding (undefined) — the owner may be listed later in the same
   *    `listSessions` pass (there is no boot-time event replay);
   *  - the session carries a channel marker (minted-id default backend)
   *    and the marked channel is free → a standalone session registered
   *    under the ORIGINAL client-chosen channel;
   *  - otherwise → a standalone session whose channel reuses the
   *    opencode id (the record).
   */
  private registerExternal(fs: FacadeSession): SessionRecord | undefined {
    const existing = this.sessions.get(fs.sessionID);
    if (existing !== undefined) return existing;
    if (this.byOpencode.has(fs.sessionID)) return undefined;
    const marker = parseAhpMarker(fs.metadata);
    if (marker !== null) {
      if (marker.chat !== undefined && marker.owner !== undefined) {
        const owner = this.sessions.get(marker.owner);
        if (owner !== undefined) {
          if (this.byChannel.has(marker.chat)) {
            // The marker's chat is already bound — e.g. a fork inherited
            // the parent's metadata (core documents the inheritance).
            // Standalone fallback: the data stays reachable in AHP.
            this.log(
              `ignoring the AHP marker on ${fs.sessionID}: chat ${marker.chat} is already bound (registering standalone)`,
            );
          } else {
            return this.reattachPeerChat(owner, fs, marker.chat);
          }
        } else {
          this.enqueueChatBinding(marker.owner, fs, marker.chat);
          return undefined;
        }
      } else if (marker.channel !== undefined) {
        // The default backend of a minted-id session carries the
        // client-chosen session channel — resurface under it.
        if (this.byChannel.has(marker.channel)) {
          this.log(
            `ignoring the AHP channel marker on ${fs.sessionID}: ${marker.channel} is already bound (registering under the opencode id)`,
          );
        } else {
          return this.registerExternalStandalone(fs, marker.channel);
        }
      }
    }
    return this.registerExternalStandalone(fs);
  }

  /**
   * Re-attach a marked peer backend to its owner session's chat catalog
   * after a restart. The owner store is LIVE (unlike a
   * fresh standalone registration), so the catalog change goes through
   * `publish` (store + any existing subscribers + the root diff), not a
   * direct apply. The chat title is re-derived (`Chat <n>`) — a
   * documented divergence from the pre-restart title. Returns undefined:
   * the backend gets no standalone AHP session (its session channel is
   * not registered — `sessions.get(peerID)` misses).
   */
  private reattachPeerChat(rec: SessionRecord, fs: FacadeSession, chatURI: string): undefined {
    const modifiedAt = new Date(fs.time.updated).toISOString();
    const chat = this.newChatRuntime(chatURI, fs.sessionID, `Chat ${rec.chats.size + 1}`, modifiedAt);
    this.bindChat(rec, chat);
    this.publish({
      channel: rec.channel,
      action: { type: ActionType.SessionChatAdded, summary: chatSummaryOf(chat.chatStore.state) },
    });
    if (this.opts.changesets) {
      this.publish({
        channel: chatURI,
        action: { type: ActionType.ChatChangesetsChanged, changesets: chatChangesetCatalog(chatURI, rec.channel) },
      });
    }
    this.log(`reattached peer chat ${chatURI} (backend ${fs.sessionID}) to session ${rec.channel} from its AHP marker`);
    return undefined;
  }

  /**
   * Queue a peer-chat binding whose owner is not registered yet (the
   * peer was listed before the owner, or the owner has not been listed
   * at all). `drainPendingChatBindings` resolves it when the owner
   * registers. The orphan fallback fires after the grace window: if the
   * owner is still unregistered and gone from opencode, the peer is
   * surfaced as its own AHP session instead (the data stays reachable).
   */
  private enqueueChatBinding(ownerID: string, fs: FacadeSession, chatURI: string): void {
    const queue = this.pendingChatBindings.get(ownerID) ?? [];
    queue.push({ fs, chatURI });
    this.pendingChatBindings.set(ownerID, queue);
    setTimeout(() => {
      void this.checkOrphanChatBindings(ownerID).catch((err) =>
        this.log(`orphan chat-binding check failed: ${errorMessage(err)}`),
      );
    }, EXTERNAL_REGISTER_GRACE_MS);
  }

  /**
   * Orphan fallback for queued peer-chat bindings: the
   * owner never registered and is gone from opencode (e.g. deleted in
   * the TUI while the plugin was down). Drop the queue and register each
   * peer as a standalone AHP session. A failed owner lookup keeps the
   * queue — the next registration or timer re-checks.
   */
  private async checkOrphanChatBindings(ownerID: string): Promise<void> {
    const queue = this.pendingChatBindings.get(ownerID);
    if (queue === undefined || queue.length === 0) return; // the owner registered — drained
    let owner: FacadeSession | null;
    try {
      owner = await this.opts.facade.getSession(ownerID);
    } catch {
      return;
    }
    if (owner !== null) return; // the owner still exists in opencode — it registers when listed
    this.pendingChatBindings.delete(ownerID);
    for (const { fs, chatURI } of queue) {
      if (this.sessions.has(fs.sessionID) || this.byOpencode.has(fs.sessionID)) continue;
      this.log(
        `AHP marker owner ${ownerID} is gone from opencode — registering the orphaned peer ${fs.sessionID} (chat ${chatURI}) as a standalone session`,
      );
      this.registerExternalStandalone(fs);
    }
  }

  /**
   * Resolve queued peer-chat bindings once their owner registers (called
   * from the standalone registration's success path). A chat URI that is
   * already bound by then (e.g. the client created it again across the
   * restart) falls back to standalone registration.
   */
  private drainPendingChatBindings(ownerID: string): void {
    const queue = this.pendingChatBindings.get(ownerID);
    const owner = this.sessions.get(ownerID);
    if (queue === undefined || queue.length === 0 || owner === undefined) return;
    this.pendingChatBindings.delete(ownerID);
    for (const { fs, chatURI } of queue) {
      if (this.sessions.has(fs.sessionID) || this.byOpencode.has(fs.sessionID)) continue;
      if (this.byChannel.has(chatURI)) {
        this.log(
          `ignoring the AHP marker on ${fs.sessionID}: chat ${chatURI} is already bound (registering standalone)`,
        );
        this.registerExternalStandalone(fs);
      } else {
        this.reattachPeerChat(owner, fs, chatURI);
      }
    }
  }

  /**
   * Register an opencode session as a single-chat AHP session (its
   * default chat reuses the opencode id). The session channel defaults
   * to the opencode id; the channel-marker path passes
   * the ORIGINAL client-chosen channel instead — the registry then
   * resolves both suffixes (mirroring `handleCreateSession`). Applied
   * directly to the fresh stores (no seq, no actions) — the
   * registration is server-side bookkeeping, not a client-visible state
   * transition; the root announcement carries the lifecycle.
   */
  private registerExternalStandalone(fs: FacadeSession, channel?: string): SessionRecord {
    const recChannel = channel ?? sessionChannelURI(fs.sessionID);
    const modifiedAt = new Date(fs.time.updated).toISOString();
    const sessionStore = createSessionStateStore(
      initialSessionState({
        sessionID: fs.sessionID,
        provider: fs.model?.providerID ?? "opencode",
        title: fs.title ?? "New Session",
        status: fs.archived
          ? ((SessionStatus.Idle | SessionStatus.IsRead | SessionStatus.IsArchived) as SessionStatus)
          : undefined, // Idle | IsRead | IsArchived
        workingDirectories: this.workingDirectories(),
      }),
    );
    const rec: SessionRecord = {
      sessionID: fs.sessionID,
      channel: recChannel,
      provider: sessionStore.state.provider,
      createdAt: new Date(fs.time.created).toISOString(),
      modifiedAt,
      sessionStore,
      chats: new Map(),
      defaultChatURI: chatChannelURI(fs.sessionID),
      sessionChangesets: new Map(),
    };
    this.sessions.set(fs.sessionID, rec);
    this.byChannel.set(recChannel, rec);
    // The registry resolves the opencode id (event pump, chat channels)
    // and — for a channel-marker registration — the client-chosen
    // suffix too (mirroring `handleCreateSession`).
    const suffix = sessionIDOf(recChannel) as string;
    if (suffix !== fs.sessionID) this.channels.addSession(suffix);
    const defaultChat = this.newChatRuntime(rec.defaultChatURI, fs.sessionID, "Chat 1", modifiedAt);
    this.bindChat(rec, defaultChat);
    sessionStore.apply({ type: ActionType.SessionReady });
    sessionStore.apply({ type: ActionType.SessionChatAdded, summary: chatSummaryOf(defaultChat.chatStore.state) });
    sessionStore.apply({ type: ActionType.SessionDefaultChatChanged, defaultChat: rec.defaultChatURI });
    // Advertise the changeset catalogues directly on the fresh
    // stores (registration is server-side bookkeeping — no seq, no actions).
    if (this.opts.changesets) {
      sessionStore.apply({ type: ActionType.SessionChangesetsChanged, changesets: sessionChangesetCatalog(recChannel) });
      defaultChat.chatStore.apply({
        type: ActionType.ChatChangesetsChanged,
        changesets: chatChangesetCatalog(rec.defaultChatURI, recChannel),
      });
    }
    // Durability: peers whose marker points at this
    // session may have been listed earlier in the same `listSessions`
    // pass — re-attach them before the root announcement so the
    // sessionAdded summary carries the full chat catalog.
    this.drainPendingChatBindings(fs.sessionID);
    this.publish({
      channel: ROOT_CHANNEL,
      action: { type: ActionType.RootActiveSessionsChanged, activeSessions: this.sessions.size },
    });
    this.notifyRoot("root/sessionAdded", { channel: ROOT_CHANNEL, summary: this.sessionSummary(rec) });
    return rec;
  }

  /** Drop a session record and announce the removal on the root channel. */
  protected removeRecord(rec: SessionRecord): void {
    const hadClients = rec.sessionStore.state.activeClients.length > 0;
    // Peer-chat backends are removed while their bindings are still live:
    // an unbound lingering backend would be re-registered by the next
    // listSessions scan as its own AHP session. R2: failures log — the
    // AHP side tears down either way (the ghost then shows in the TUI).
    for (const chat of rec.chats.values()) {
      if (chat.uri === rec.defaultChatURI) continue;
      void this.opts.facade
        .removeSession(chat.sessionID)
        .catch((err) => this.log(`failed to remove the peer chat's opencode session ${chat.sessionID}: ${errorMessage(err)}`));
    }
    // Every live changeset URI is about to become un-subscribable
    // — dispatch `changeset/cleared` (protocol case 2) before the teardown
    // so subscribers release their references.
    for (const uri of rec.sessionChangesets.keys()) {
      this.publish({ channel: uri, action: { type: ActionType.ChangesetCleared } });
    }
    rec.sessionChangesets.clear();
    // Per-chat teardown: live chat changesets
    // (`changeset/cleared`), in-flight client-tool executions failed
    // (the waiters must not leak), and every binding dropped.
    let failedTools = false;
    for (const chat of [...rec.chats.values()]) {
      failedTools = failedTools || [...chat.clientToolCalls.values()].some((inv) => inv.result === undefined);
      this.removeChat(rec, chat, "session removed before the client completed the tool call");
    }
    this.sessions.delete(rec.sessionID);
    this.byChannel.delete(rec.channel);
    const id = sessionIDOf(rec.channel);
    if (id !== null) this.channels.removeSession(id);
    this.channels.removeSession(rec.sessionID);
    this.publish({
      channel: ROOT_CHANNEL,
      action: { type: ActionType.RootActiveSessionsChanged, activeSessions: this.sessions.size },
    });
    this.notifyRoot("root/sessionRemoved", { channel: ROOT_CHANNEL, session: rec.channel });
    // Re-sync the opencode tool union when this
    // session's clients' tools leave the cross-session set (or any
    // in-flight call was failed — the facade union is unchanged, but the
    // session's execute gate must not linger).
    if (hadClients || failedTools) void this.syncClientToolsToOpencode();
  }
}
