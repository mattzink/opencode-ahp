/**
 * Chat section (design §7): per-chat runtimes (one AHP chat = one opencode session), `createChat`/`disposeChat`, and the message model/agent selection.
 */

import { HostClientTools } from "./host-client-tools.js";
import { ActionType, Message } from "@microsoft/agent-host-protocol";
import { agentIDFromUri, chatChangesetCatalog, chatSummaryOf, initialChatState } from "./bridge.js";
import { channelKind, sessionIDOf } from "./channels.js";
import { ERROR_INVALID_PARAMS } from "./handshake.js";
import { isRecord } from "./options.js";
import { createChatStateStore } from "./state.js";
import { ERROR_INTERNAL, ERROR_SESSION_NOT_FOUND, ERROR_SESSION_EXISTS } from "./host-errors.js";
import { RpcMessage, ChatRuntime, SessionRecord } from "./host-types.js";
import { AHP_METADATA_KEY, errorMessage, firstEnabledModelRef } from "./host-util.js";

export class HostChats extends HostClientTools {
  /**
   * Fresh per-chat runtime: one AHP chat = one opencode
   * session, with its own chat-state store and all the per-turn tracking
   * the event pump joins opencode events to.
   */
  // ── multi-chat ────────────────────────────────────
  protected newChatRuntime(uri: string, sessionID: string, title: string, modifiedAt: string): ChatRuntime {
    return {
      uri,
      sessionID,
      chatStore: createChatStateStore(initialChatState({ resource: uri, title, modifiedAt })),
      currentTurnId: null,
      turnStartedAt: null,
      turnModelRef: null,
      parts: new Set(),
      toolInput: new Map(),
      toolName: new Map(),
      toolReady: new Set(),
      permissionForTool: new Map(),
      toolForPermission: new Map(),
      clientToolCalls: new Map(),
      lastInbox: null,
      changesets: new Map(),
      turnSnapshots: new Map(),
    };
  }

  /**
   * Bind a chat runtime to its record: the record's catalog, the
   * channel→record lookup, and the opencode-id→(record, chat) reverse
   * binding (the event pump's join key). The channel registry gets the
   * chat URI's suffix — that is what makes the chat channel and its
   * changesets (whose owner is the chat channel) subscribable. The
   * default chat's suffix IS its opencode id, added by the
   * registration paths; a peer chat's opencode id gets no registry
   * entry (it has no subscribable session channel of its own).
   */
  protected bindChat(rec: SessionRecord, chat: ChatRuntime): void {
    rec.chats.set(chat.uri, chat);
    this.byChannel.set(chat.uri, rec);
    this.byOpencode.set(chat.sessionID, { rec, chat });
    const suffix = sessionIDOf(chat.uri);
    if (suffix !== null) this.channels.addSession(suffix);
  }

  /**
   * Unbind a chat runtime (dispose or record removal): clear its live
   * changesets (`changeset/cleared` — protocol case 2), fail its
   * in-flight client-tool executions (the waiters must not leak), and
   * drop every binding.
   */
  protected removeChat(rec: SessionRecord, chat: ChatRuntime, toolError = "chat removed before the client completed the tool call"): void {
    // The chat's terminal channels go with it
    // (running commands get a final `terminal/exited` first).
    this.teardownTerminalsForChat(chat);
    for (const uri of chat.changesets.keys()) {
      this.publish({ channel: uri, action: { type: ActionType.ChangesetCleared } });
    }
    chat.changesets.clear();
    chat.turnSnapshots.clear();
    for (const inv of chat.clientToolCalls.values()) {
      if (inv.result !== undefined) continue;
      inv.result = { ok: false, error: toolError };
      this.settleClientTool(inv);
    }
    chat.clientToolCalls.clear();
    rec.chats.delete(chat.uri);
    this.byChannel.delete(chat.uri);
    this.byOpencode.delete(chat.sessionID);
    const suffix = sessionIDOf(chat.uri);
    if (suffix !== null) this.channels.removeSession(suffix);
    this.channels.removeSession(chat.sessionID);
  }

  /**
   * `createChat` (AHP 1.0.0 chat command): create a new chat in an
   * existing session. The 1:1 mapping: mint a fresh
   * opencode session (same provider/model resolution as `createSession`)
   * and bind it to the client-chosen chat URI. Result: `null` (the
   * client waits for `session/chatAdded` on the session channel, and
   * rolls back with `disposeChat` when the chat never surfaces — so
   * everything below is published before the response). `source` and
   * `workingDirectories` are rejected with INVALID_PARAMS: the
   * capability is advertised without fork/sideChat/
   * multipleWorkingDirectories, so conformant clients never send them.
   *
   * Error codes: -32602 (invalid params, including `source`/
   * `workingDirectories`), -32001 (no such session), -32003 (chat URI
   * already exists), -32603 (backend session creation or initial
   * message failure — the chat is rolled back in that case).
   */
  protected async handleCreateChat(socketId: number, msg: RpcMessage): Promise<void> {
    const params = isRecord(msg.params) ? msg.params : {};
    const channel = params["channel"];
    const chatURI = params["chat"];
    if (typeof channel !== "string" || channelKind(channel) !== "session") {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "createChat requires an ahp-session:/… channel");
      return;
    }
    const rec = this.byChannel.get(channel);
    if (rec === undefined) {
      this.sendError(socketId, msg.id, ERROR_SESSION_NOT_FOUND, `no such session: ${channel}`);
      return;
    }
    if (typeof chatURI !== "string" || channelKind(chatURI) !== "chat") {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "createChat requires an ahp-chat:/… chat URI");
      return;
    }
    // A marker in the chat suffix would make the chat channel
    // string-identical to a changeset URI of the chat before the marker
    // (the same trap createSession rejects for session suffixes).
    if (chatURI.includes("/changeset/")) {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "chat URI must not contain \"/changeset/\"");
      return;
    }
    if (chatURI === rec.defaultChatURI || rec.chats.has(chatURI)) {
      this.sendError(socketId, msg.id, ERROR_SESSION_EXISTS, `chat already exists: ${chatURI}`);
      return;
    }
    if (params["source"] !== undefined) {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "createChat `source` is not supported (no fork/sideChat capability)");
      return;
    }
    if (params["workingDirectories"] !== undefined) {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "createChat `workingDirectories` is not supported (no multipleWorkingDirectories capability)");
      return;
    }

    // Same provider/model resolution as createSession's default path:
    // the first non-disabled provider's first enabled model.
    const providers = await this.opts.facade.listCatalog();
    const provider = providers.find((p) => p.activation !== "disabled");
    const model = provider !== undefined ? firstEnabledModelRef(provider.models) : undefined;
    const now = new Date().toISOString();
    let created;
    try {
      // Write the chat-binding marker atomically at
      // create — it is what re-attaches this backend to this session's
      // chat catalog after an opencode/plugin restart (opencode session
      // metadata is the only durable surface a plugin has).
      created = await this.opts.facade.createSession({
        model,
        metadata: { [AHP_METADATA_KEY]: { chat: chatURI, owner: rec.sessionID } },
      });
    } catch (err) {
      this.sendError(socketId, msg.id, ERROR_INTERNAL, `failed to create the chat's backend session: ${errorMessage(err)}`);
      return;
    }
    const chat = this.newChatRuntime(chatURI, created.sessionID, `Chat ${rec.chats.size + 1}`, now);
    this.bindChat(rec, chat);
    // Session-channel lifecycle (server-side, no origin): the catalog
    // mutation the client is waiting for, plus the changeset catalogue
    // on the new chat channel.
    this.publish({
      channel,
      action: { type: ActionType.SessionChatAdded, summary: chatSummaryOf(chat.chatStore.state) },
    });
    if (this.opts.changesets) {
      this.publish({
        channel: chatURI,
        action: { type: ActionType.ChatChangesetsChanged, changesets: chatChangesetCatalog(chatURI, rec.channel) },
      });
    }

    // initialMessage → the chat's first turn (write-ahead, same
    // claim-then-prompt semantics as dispatchTurnStarted). A failure
    // rolls the whole chat back — the client never sees a chat whose
    // promised first turn never happened.
    const initialParam = params["initialMessage"];
    if (initialParam !== undefined) {
      if (!isRecord(initialParam) || typeof initialParam["text"] !== "string" || (initialParam["text"] as string).length === 0) {
        await this.disposeChatBackend(rec, chat);
        this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "createChat `initialMessage` requires a message with non-empty text");
        return;
      }
      const message = initialParam as unknown as Message;
      const selectionError = await this.applyMessageSelection(chat, message);
      if (selectionError !== null) {
        await this.disposeChatBackend(rec, chat);
        this.sendError(socketId, msg.id, ERROR_INTERNAL, `failed to apply initial message model/agent selection: ${selectionError}`);
        return;
      }
      const turnId = this.mintTurnId();
      chat.currentTurnId = turnId;
      chat.turnStartedAt = Date.now();
      try {
        await this.opts.facade.prompt({ sessionID: chat.sessionID, text: message.text });
      } catch (err) {
        chat.currentTurnId = null;
        chat.turnStartedAt = null;
        await this.disposeChatBackend(rec, chat);
        this.sendError(socketId, msg.id, ERROR_INTERNAL, `initial message failed: ${errorMessage(err)}`);
        return;
      }
      this.publish({
        channel: chatURI,
        action: {
          type: ActionType.ChatTurnStarted,
          turnId,
          startedAt: new Date().toISOString(),
          message,
        },
      });
    }

    this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, result: null });
  }

  /**
   * `disposeChat` (AHP 1.0.0 chat command): remove a chat and its
   * opencode session from the session catalog. Result: `null`. The
   * default chat cannot be disposed — a session keeps its default chat
   * (there is no re-home mechanism; disposing it would leave the
   * `defaultChat` hint dangling). VS Code's createChat-rollback path
   * relies on `disposeChat` being answerable for any chat it created.
   */
  protected async handleDisposeChat(socketId: number, msg: RpcMessage): Promise<void> {
    const params = isRecord(msg.params) ? msg.params : {};
    const channel = params["channel"];
    if (typeof channel !== "string" || channelKind(channel) !== "chat") {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "disposeChat requires an ahp-chat:/… channel");
      return;
    }
    const rec = this.byChannel.get(channel);
    const chat = rec !== undefined ? rec.chats.get(channel) : undefined;
    if (rec === undefined || chat === undefined) {
      this.sendError(socketId, msg.id, ERROR_SESSION_NOT_FOUND, `no such chat: ${channel}`);
      return;
    }
    if (channel === rec.defaultChatURI) {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, "the default chat cannot be disposed");
      return;
    }
    await this.disposeChatBackend(rec, chat);
    this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, result: null });
  }

  /**
   * Remove a chat from the AHP surface, then its opencode session. The
   * AHP-side unbind goes FIRST: opencode's `session.deleted` event for
   * the backend races this call through the event pump, and the pump
   * must see the chat already unbound (its `byOpencode` guard) or it
   * would publish a duplicate `session/chatRemoved`. R2: a failed
   * removal still drops the AHP chat — the lingering opencode session
   * shows up in the TUI (and lazily in `listSessions`) until deleted
   * there.
   */
  private async disposeChatBackend(rec: SessionRecord, chat: ChatRuntime): Promise<void> {
    this.removeChat(rec, chat);
    try {
      await this.opts.facade.removeSession(chat.sessionID);
    } catch (err) {
      this.log(`failed to remove the chat's opencode session ${chat.sessionID}: ${errorMessage(err)}`);
    }
    this.publish({ channel: rec.channel, action: { type: ActionType.SessionChatRemoved, chat: chat.uri } });
  }

  /**
   * Apply a message's model/agent selection to a chat's opencode session
   * before its prompt (`SessionPromptInput` carries no model/agent
   * fields). Null on success, the error message on failure.
   */
  protected async applyMessageSelection(chat: ChatRuntime, message: Message): Promise<string | null> {
    try {
      if (message.model?.id !== undefined && message.model.id.includes("/")) {
        const sep = message.model.id.indexOf("/");
        const providerID = message.model.id.slice(0, sep);
        const modelID = message.model.id.slice(sep + 1);
        if (providerID.length > 0 && modelID.length > 0) {
          await this.opts.facade.switchModel({ sessionID: chat.sessionID, model: { providerID, modelID } });
        }
      }
      if (message.agent?.uri !== undefined) {
        const agentID = agentIDFromUri(message.agent.uri);
        if (agentID !== null) {
          await this.opts.facade.switchAgent({ sessionID: chat.sessionID, agent: agentID });
        }
      }
    } catch (err) {
      return errorMessage(err);
    }
    return null;
  }
}
