/**
 * The host core — first link of the section-class chain (host.ts composes the rest): the shared state (socket/client/session/chat/terminal maps, sequencer, root store, channel registry), the constructor, and the publish/notify plumbing every section builds on. Section classes may only call members declared at or below them in the chain.
 */

import { ActionType, ChangesetStatus, ActionEnvelope, ActionOrigin, ChatAction, ChatSummary, ChangesetAction, RootAction, SessionAction, SessionSummary, StateAction, TerminalAction } from "@microsoft/agent-host-protocol";
import { buildSessionSummary, chatSummaryOf, directoryUri, FacadeSession } from "./bridge.js";
import { ChannelRegistry, ChannelKind, ROOT_CHANNEL, channelKind, parseChangesetChannel, sessionIDOf } from "./channels.js";
import { Sequencer } from "./seq.js";
import { createChangesetStateStore, createRootStateStore, ChangesetStateStore, RootStateStore } from "./state.js";
import { SocketState, ClientRecord, ChatRuntime, SessionRecord, TerminalRecord, HostOptions } from "./host-types.js";

export class HostBase {
  protected readonly seq: Sequencer;

  protected readonly channels = new ChannelRegistry();

  protected readonly state: RootStateStore;

  protected readonly sockets = new Map<number, SocketState>();

  protected readonly clients = new Map<string, ClientRecord>();

  /**
   * Live sessions, keyed by opencode session id (the event-pump join key).
   * `byChannel` maps a session/chat channel URI to the same record for the
   * client-facing lookups — the channel suffix is not always the opencode id
   * (client-chosen suffixes), so the two keyings differ.
   */
  protected readonly sessions = new Map<string, SessionRecord>();

  protected readonly byChannel = new Map<string, SessionRecord>();

  /**
   * opencode session id → the (record, chat) the id backs. The event
   * pump's join key — every chat has its own opencode session, and the
   * pump must land on the owning chat, not just the record.
   */
  protected readonly byOpencode = new Map<string, { rec: SessionRecord; chat: ChatRuntime }>();

  /**
   * Durability: marked peer backends whose owner
   * AHP session is not registered yet, keyed by the marker's `owner`
   * (opencode session id). A peer can be listed before its owner in the
   * same synchronous `listSessions` pass, and after a restart the owner
   * record does not exist until it is listed (there is no boot-time
   * event replay). Drained when the owner registers; an entry whose
   * owner is gone from opencode falls back to standalone registration
   * after the grace window.
   */
  protected readonly pendingChatBindings = new Map<string, { fs: FacadeSession; chatURI: string }[]>();

  /**
   * Terminal channels keyed by URI: synthetic `ahp-terminal:/<toolCallId>`
   * records (created at the `shell`-tool call's `tool.input.ended`,
   * retained until the owning chat/record is removed) and pty terminal
   * records (client-chosen URIs from `createTerminal`, retained until the
   * client disposes them or the location tears down).
   */
  protected readonly terminals = new Map<string, TerminalRecord>();

  protected readonly opts: HostOptions;

  protected readonly log: (message: string) => void;

  protected turnCounter = 0;

  protected pumpController: AbortController | null = null;

  constructor(opts: HostOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.seq = new Sequencer(opts.replayWindow);
    this.state = createRootStateStore({ agents: [] });
  }

  protected sendFrame(socketId: number, message: unknown): void {
    this.opts.send(socketId, message);
  }

  protected sendError(socketId: number, id: unknown, code: number, message: string): void {
    this.sendFrame(socketId, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  }

  /**
   * Channel kind with live-terminal awareness: client-chosen pty terminal
   * URIs (from `createTerminal`) classify "unknown" by prefix alone —
   * they classify "terminal" while their record is live.
   */
  protected kindOf(uri: string): ChannelKind {
    const kind = channelKind(uri);
    if (kind !== "unknown") return kind;
    return this.terminals.has(uri) ? "terminal" : kind;
  }

  /**
   * Assign a global seq, update state for accepted actions, retain for
   * replay. Session/chat actions apply to the per-session stores through
   * the official reducers; a changed chat summary is propagated to the
   * session store via `session/chatUpdated`, and any summary-level change
   * is announced on the root channel (notification).
   */
  protected publish(draft: {
    channel: string;
    action: StateAction;
    origin?: ActionOrigin;
    rejectionReason?: string;
  }): ActionEnvelope {
    const envelope = this.seq.publish(draft);
    if (draft.rejectionReason === undefined) {
      const kind = this.kindOf(draft.channel);
      if (kind === "root") {
        this.state.apply(draft.action as RootAction);
      } else if (kind === "changeset") {
        // Changeset stores are owner-keyed (session-kind on the record,
        // chat-kind on the chat). Non-creating: a publish
        // targets a store someone created (subscribe/refresh); a missing
        // owner means the changeset is already torn down.
        const parsed = parseChangesetChannel(draft.channel);
        const rec = parsed !== null ? this.byChannel.get(parsed.ownerUri) : undefined;
        const store = rec !== undefined ? this.changesetStoreOf(rec, draft.channel) : undefined;
        if (store !== undefined) store.apply(draft.action as ChangesetAction);
      } else if (kind === "terminal") {
        // Synthetic shell-command terminals.
        // Non-creating: a publish targets a record that exists (opened at
        // `tool.input.ended`); a missing record means the channel was
        // already torn down — the notification still goes out.
        const t = this.terminals.get(draft.channel);
        if (t !== undefined) t.store.apply(draft.action as TerminalAction);
      } else {
        // byChannel, not sessions.get(sessionIDOf(…)): the channel suffix
        // is not always the opencode session id (client-chosen suffixes).
        const rec = this.byChannel.get(draft.channel);
        if (rec !== undefined) {
          const before = this.sessionSummary(rec);
          if (kind === "session") {
            rec.sessionStore.apply(draft.action as SessionAction);
          } else {
            const chat = rec.chats.get(draft.channel);
            if (chat !== undefined) chat.chatStore.apply(draft.action as ChatAction);
          }
          if (kind === "chat") this.syncChatSummary(rec, draft.channel);
          const after = this.sessionSummary(rec);
          this.maybeNotifySummaryChanged(rec, before, after);
        }
      }
    }
    // Every published action — accepted and rejected alike — is an
    // `action` notification on its channel to the subscribers.
    this.notifyAction(envelope);
    return envelope;
  }

  /**
   * Propagate a changed chat summary into the session store's chat catalog
   * (`session/chatUpdated`) — the session status itself is only
   * reducer-reachable for read/archive/input-needed bits, so the chat
   * summary is the activity source of truth.
   */
  private syncChatSummary(rec: SessionRecord, chatURI: string): void {
    const chat = rec.chats.get(chatURI)?.chatStore.state;
    if (chat === undefined) return;
    const entry = rec.sessionStore.state.chats.find((c) => c.resource === chat.resource);
    if (entry === undefined) return;
    const next = chatSummaryOf(chat);
    const changes: Record<string, unknown> = {};
    let changed = false;
    for (const key of ["title", "status", "activity", "modifiedAt"] as const) {
      if (entry[key] !== next[key]) {
        changes[key] = next[key];
        changed = true;
      }
    }
    if (changed) {
      this.publish({
        channel: rec.channel,
        action: { type: ActionType.SessionChatUpdated, chat: chat.resource, changes: changes as Partial<ChatSummary> },
      });
    }
  }

  /**
   * Announce summary-level changes on the root channel (`root/
   * sessionSummaryChanged` notification — ephemeral, not replayed).
   * Identity fields (resource/provider/createdAt) never change.
   */
  private maybeNotifySummaryChanged(rec: SessionRecord, before: SessionSummary, after: SessionSummary): void {
    const changes: Record<string, unknown> = {};
    for (const key of ["title", "status", "activity", "modifiedAt", "chats", "defaultChat"] as const) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        changes[key] = after[key];
      }
    }
    if (Object.keys(changes).length === 0) return;
    if (after.modifiedAt > rec.modifiedAt) rec.modifiedAt = after.modifiedAt;
    this.notifyRoot("root/sessionSummaryChanged", {
      channel: ROOT_CHANNEL,
      session: rec.channel,
      changes,
    });
  }

  /**
   * The AHP `workingDirectories` every session of this host carries
   * (`SessionMetadata.workingDirectories`): the single location directory —
   * the session's agent has tool access exactly there. VS Code groups its
   * session list by this workspace (the folder name, host-suffixed for
   * remote hosts); sessions without it fall into the "Unknown" bucket.
   * `undefined` when the location directory is unknown.
   */
  protected workingDirectories(): string[] | undefined {
    return this.opts.defaultDirectory !== undefined ? [directoryUri(this.opts.defaultDirectory)] : undefined;
  }

  /** The denormalized `SessionSummary` view of a record. */
  protected sessionSummary(rec: SessionRecord): SessionSummary {
    const s = rec.sessionStore.state;
    // Authoritative chat order: default first, then insertion order
    // (the default chat is bound first).
    const chats = [...rec.chats.values()].map((c) => chatSummaryOf(c.chatStore.state));
    let modifiedAt = rec.modifiedAt;
    for (const c of rec.chats.values()) {
      if (c.chatStore.state.modifiedAt > modifiedAt) modifiedAt = c.chatStore.state.modifiedAt;
    }
    return buildSessionSummary({
      channel: rec.channel,
      provider: rec.provider,
      title: s.title,
      status: s.status,
      activity: s.activity,
      createdAt: rec.createdAt,
      modifiedAt,
      chats,
      defaultChat: rec.defaultChatURI,
      workingDirectories: this.workingDirectories(),
    });
  }

  /** Send a root-channel notification frame to every root subscriber. */
  protected notifyRoot(method: string, params: unknown): void {
    const frame = { jsonrpc: "2.0", method, params };
    for (const socketId of this.channels.socketsSubscribedTo(ROOT_CHANNEL)) {
      this.opts.send(socketId, frame);
    }
  }

  /** Send an `action` notification to every socket subscribed to the channel. */
  private notifyAction(envelope: ActionEnvelope): void {
    const frame = { jsonrpc: "2.0", method: "action", params: envelope };
    for (const socketId of this.channels.socketsSubscribedTo(envelope.channel)) {
      this.opts.send(socketId, frame);
    }
  }

  /** The socket currently bound to a clientId (rejection delivery target). */
  protected socketIdForClient(clientId: string): number | undefined {
    for (const [socketId, socket] of this.sockets) {
      if (socket.clientId === clientId) return socketId;
    }
    return undefined;
  }

  /**
   * Publish an accepted echo (or a rejection) on the action stream. A
   * rejection must reach the dispatching socket even when it is not
   * subscribed to the channel (write-ahead dispatch: the client applied
   * the action optimistically and needs the rejection to roll it back).
   */
  protected echo(
    channel: string,
    action: StateAction,
    origin: ActionOrigin | undefined,
    rejectionReason?: string,
  ): void {
    const envelope = this.publish({
      channel,
      action,
      origin,
      ...(rejectionReason !== undefined ? { rejectionReason } : {}),
    });
    if (rejectionReason !== undefined && origin !== undefined) {
      const socketId = this.socketIdForClient(origin.clientId);
      if (socketId !== undefined && !this.channels.socketsSubscribedTo(channel).includes(socketId)) {
        this.opts.send(socketId, { jsonrpc: "2.0", method: "action", params: envelope });
      }
    }
  }

  /**
   * The changeset store's owner: session-kind changesets
   * live on the record (the session channel owns them); uncommitted/turn
   * changesets live on the owning chat. Null when the owner is gone
   * (a disposed chat's changesets are un-subscribable).
   */
  private changesetOwner(rec: SessionRecord, uri: string): { kind: "session" } | { kind: "chat"; chat: ChatRuntime } | null {
    const parsed = parseChangesetChannel(uri);
    if (parsed === null) return null;
    if (parsed.kind === "session") return { kind: "session" };
    const chat = rec.chats.get(parsed.ownerUri);
    return chat === undefined ? null : { kind: "chat", chat };
  }

  /**
   * Get-or-create the changeset store for a URI (fresh stores start
   * computing). Owner-aware — see `changesetOwner`; null when the owner
   * is gone.
   */
  protected changesetStore(rec: SessionRecord, uri: string): ChangesetStateStore | null {
    const owner = this.changesetOwner(rec, uri);
    if (owner === null) return null;
    const map = owner.kind === "chat" ? owner.chat.changesets : rec.sessionChangesets;
    let store = map.get(uri);
    if (store === undefined) {
      store = createChangesetStateStore({ status: ChangesetStatus.Computing, files: [] });
      map.set(uri, store);
    }
    return store;
  }

  /** The live store for a URI, or undefined when it has never been created. */
  protected changesetStoreOf(rec: SessionRecord, uri: string): ChangesetStateStore | undefined {
    const owner = this.changesetOwner(rec, uri);
    if (owner === null) return undefined;
    const map = owner.kind === "chat" ? owner.chat.changesets : rec.sessionChangesets;
    return map.get(uri);
  }

  /** The store's current per-file review flags, keyed by file id. */
  protected reviewedById(store: ChangesetStateStore): Map<string, boolean> {
    const out = new Map<string, boolean>();
    for (const f of store.state.files) {
      if (typeof f.reviewed === "boolean") out.set(f.id, f.reviewed);
    }
    return out;
  }
}
