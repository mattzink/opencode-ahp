/**
 * Dispatch section (design §9): `dispatchAction` routing for the client-dispatchable actions (turns, steering/queue, tool confirmations, renames, active-client echoes) with write-ahead rejections.
 */

import { HostSessions } from "./host-sessions.js";
import { ActionType, SessionInputRequestKind, SessionStatus, ToolCallStatus, isClientDispatchable, ActionOrigin, ChatToolCallCompleteAction, ChatToolCallConfirmedAction, ChatToolCallContentChangedAction, ChatToolCallResultConfirmedAction, ChatTurnCancelledAction, ChatTurnStartedAction, ChangesetFilesReviewChangedAction, Message, SessionActiveClient, SessionToolConfirmationRequest, StateAction, ToolCallResult } from "@microsoft/agent-host-protocol";
import { FacadeDelivery } from "./bridge.js";
import { normalizeToolDefinitions } from "./client-tools.js";
import { channelKind, parseChangesetChannel } from "./channels.js";
import { isRecord } from "./options.js";
import { RpcMessage, ChatRuntime, SessionRecord } from "./host-types.js";
import { errorMessage, normalizeToolCallResult, clientResultToFacade } from "./host-util.js";

export class HostDispatch extends HostSessions {
  /**
   * `dispatchAction` is a notification — the response is the `action`
   * notification stream itself. The host routes the client-dispatchable
   * actions VS Code sends; everything else is acknowledged with a
   * rejection on that stream.
   */
  // ── client-dispatchable actions ──────────────────────────────
  protected async handleDispatchAction(socketId: number, msg: RpcMessage): Promise<void> {
    const params = isRecord(msg.params) ? msg.params : {};
    const channel = params["channel"];
    const clientSeq = params["clientSeq"];
    const action = params["action"];
    if (
      typeof channel !== "string" ||
      channel.length === 0 ||
      !Number.isInteger(clientSeq) ||
      !isRecord(action) ||
      typeof action["type"] !== "string"
    ) {
      this.log(`malformed dispatchAction on socket ${socketId} (dropped)`);
      return;
    }

    const socket = this.sockets.get(socketId);
    const clientId = socket?.clientId ?? null;
    const origin: ActionOrigin | undefined =
      clientId !== null ? { clientId, clientSeq: clientSeq as number } : undefined;

    const stateAction = action as unknown as StateAction;
    const rejectionReason = this.dispatchRejectionReason(channel, stateAction, clientId);
    if (rejectionReason !== null) {
      this.echo(channel, stateAction, origin, rejectionReason);
      return;
    }

    // kindOf, not channelKind: a live pty terminal's client-chosen URI
    // classifies "unknown" by prefix alone.
    const kind = this.kindOf(channel);
    if (kind === "changeset") {
      // The only client-dispatchable changeset action is the per-file
      // review toggle — echo it through the official reducer.
      if (stateAction.type === ActionType.ChangesetFilesReviewChanged) {
        this.dispatchChangesetFilesReviewChanged(channel, stateAction, origin);
      } else {
        this.echo(channel, stateAction, origin, `unsupported action on changeset channel: ${String(action.type)}`);
      }
      return;
    }
    if (kind === "terminal") {
      const t = this.terminals.get(channel);
      if (t === undefined) {
        // A synthetic channel whose record is gone (the chat was
        // removed). A disposed pty terminal's client-chosen URI never
        // reaches here — without its record it classifies "unknown" in
        // the pre-check above.
        this.echo(channel, stateAction, origin, `no such terminal: ${channel}`);
        return;
      }
      if (t.kind === "synthetic") {
        // The synthetic terminals are read-only
        // renderings of shell-tool calls — every client-dispatchable
        // action (`input`, `resized`, `claimed`, `titleChanged`,
        // `cleared`) has no pty to act on, so each gets an explicit
        // rejection (write-ahead clients roll back on the reason).
        this.echo(
          channel,
          stateAction,
          origin,
          "read-only terminal: this host's shell-tool terminals render tool calls and accept no input, resize, claim, title, or clear",
        );
        return;
      }
      // A live pty terminal: input/resize drive the process, claim/
      // title/clear apply through the official reducer.
      this.dispatchPtyTerminal(t, stateAction, origin);
      return;
    }
    if (kind !== "session" && kind !== "chat") {
      this.echo(channel, stateAction, origin, `unsupported action on ${channelKind(channel)} channel: ${String(action.type)}`);
      return;
    }
    const rec = this.byChannel.get(channel);
    if (rec === undefined) {
      this.echo(
        channel,
        stateAction,
        origin,
        kind === "chat" ? `no such chat: ${channel}` : `no such session: ${channel}`,
      );
      return;
    }
    if (kind === "chat" && !rec.chats.has(channel)) {
      this.echo(channel, stateAction, origin, `no such chat: ${channel}`);
      return;
    }
    // Chat actions run against the owning chat runtime;
    // a chat action on a session channel is rejected (a session no
    // longer identifies a single chat once multi-chat is on).
    const chat = rec.chats.get(channel);
    const noChat = () => this.echo(channel, stateAction, origin, `chat actions require a chat channel: ${channel}`);

    // From here on every branch either echoes (accepted or rejected).
    switch (stateAction.type) {
      case ActionType.ChatTurnStarted:
        if (chat === undefined) { noChat(); return; }
        await this.dispatchTurnStarted(chat, stateAction, origin);
        return;
      case ActionType.ChatPendingMessageSet:
        if (chat === undefined) { noChat(); return; }
        await this.dispatchPendingMessageSet(chat, stateAction, origin);
        return;
      case ActionType.ChatToolCallConfirmed:
        if (chat === undefined) { noChat(); return; }
        await this.dispatchToolCallConfirmed(chat, stateAction, origin);
        return;
      case ActionType.ChatToolCallComplete:
        if (chat === undefined) { noChat(); return; }
        await this.dispatchToolCallComplete(chat, stateAction, origin);
        return;
      case ActionType.ChatToolCallContentChanged:
        if (chat === undefined) { noChat(); return; }
        this.dispatchToolCallContentChanged(chat, stateAction, origin);
        return;
      case ActionType.ChatToolCallResultConfirmed:
        if (chat === undefined) { noChat(); return; }
        this.dispatchToolCallResultConfirmed(chat, stateAction, origin);
        return;
      case ActionType.ChatTurnCancelled:
        if (chat === undefined) { noChat(); return; }
        await this.dispatchTurnCancelled(chat, stateAction, origin);
        return;
      case ActionType.SessionTitleChanged:
        await this.dispatchTitleChanged(rec, stateAction, origin);
        return;
      case ActionType.SessionActiveClientSet:
        this.dispatchActiveClientSet(rec, stateAction, origin, clientId);
        return;
      case ActionType.SessionActiveClientRemoved:
        this.dispatchActiveClientRemoved(rec, stateAction, origin, clientId);
        return;
      case ActionType.ChatPendingMessageRemoved:
        // Honest gap: the opencode plugin surface has no inbox cancel —
        // a pending (steer/queue) message cannot be withdrawn once sent.
        this.echo(channel, stateAction, origin, "cannot remove a pending message: opencode has no inbox cancel");
        return;
      case ActionType.ChatDraftChanged:
      case ActionType.ChatIsReadChanged:
      case ActionType.ChatIsArchivedChanged:
      case ActionType.SessionIsReadChanged:
      case ActionType.SessionIsArchivedChanged:
        this.echo(channel, stateAction, origin);
        return;
      default:
        this.echo(channel, stateAction, origin, `unsupported action: ${String(stateAction.type)}`);
    }
  }

  /**
   * Shared pre-checks for a dispatched action; null when the action may
   * proceed to per-type handling.
   */
  private dispatchRejectionReason(channel: string, action: StateAction, clientId: string | null): string | null {
    // kindOf: a live pty terminal's client-chosen URI is a known channel.
    if (this.kindOf(channel) === "unknown") return `unknown channel: ${channel}`;
    let dispatchable: boolean;
    try {
      dispatchable = isClientDispatchable(action as Parameters<typeof isClientDispatchable>[0]);
    } catch {
      dispatchable = false;
    }
    if (!dispatchable) return `action ${String(action.type)} is not client-dispatchable`;
    if (clientId === null) return "client is not initialized";
    return null;
  }

  // `echo` (accepted echoes + write-ahead rejections) lives on HostBase
  // so the terminal section below this one can reuse it.

  private async dispatchTurnStarted(chat: ChatRuntime, action: StateAction, origin: ActionOrigin | undefined): Promise<void> {
    const chatURI = chat.uri;
    const a = action as ChatTurnStartedAction;
    const turnId = typeof a.turnId === "string" && a.turnId.length > 0 ? a.turnId : null;
    const message =
      isRecord(a.message) && typeof a.message["text"] === "string"
        ? (a.message as unknown as Message)
        : null;
    if (turnId === null || message === null) {
      this.echo(chatURI, action, origin, "invalid chat/turnStarted params");
      return;
    }
    // `startedAt` is required on the wire (the reducer uses it for the
    // chat's `modifiedAt`); fall back to the host clock when the client
    // did not supply a parseable one.
    const normalized: ChatTurnStartedAction =
      typeof a.startedAt === "string" && !Number.isNaN(Date.parse(a.startedAt))
        ? a
        : { ...a, startedAt: new Date().toISOString() };
    if (chat.chatStore.state.activeTurn !== undefined) {
      this.echo(
        chatURI,
        action,
        origin,
        "a turn is already active; follow-up messages go via chat/pendingMessageSet",
      );
      return;
    }

    // Apply the message's model/agent selection to THIS chat's opencode
    // session before the prompt (per-chat isolation).
    const selectionError = await this.applyMessageSelection(chat, message);
    if (selectionError !== null) {
      this.echo(chatURI, action, origin, `failed to apply model/agent selection: ${selectionError}`);
      return;
    }

    // Write-ahead: claim the turn BEFORE the prompt so the
    // `session.execution.started` event joins it even when it races the
    // prompt's resolve; revert on failure.
    chat.currentTurnId = turnId;
    chat.turnStartedAt = Date.now();
    try {
      await this.opts.facade.prompt({ sessionID: chat.sessionID, text: message.text });
    } catch (err) {
      chat.currentTurnId = null;
      chat.turnStartedAt = null;
      this.echo(chatURI, action, origin, `prompt failed: ${errorMessage(err)}`);
      return;
    }
    this.echo(chatURI, normalized, origin);
  }

  private async dispatchPendingMessageSet(chat: ChatRuntime, action: StateAction, origin: ActionOrigin | undefined): Promise<void> {
    const chatURI = chat.uri;
    const a = action as { kind?: unknown; id?: unknown; message?: unknown };
    const kind = a.kind === "steering" || a.kind === "queued" ? a.kind : null;
    const id = typeof a.id === "string" && a.id.length > 0 ? a.id : null;
    const message =
      isRecord(a.message) && typeof a.message["text"] === "string"
        ? (a.message as unknown as Message)
        : null;
    if (kind === null || id === null || message === null) {
      this.echo(chatURI, action, origin, "invalid chat/pendingMessageSet params");
      return;
    }
    const hasActiveTurn = chat.chatStore.state.activeTurn !== undefined;
    // steer → delivery "steer" (only while a turn is active); queued →
    // delivery "queue"; a steering message with no active turn falls back
    // to a plain prompt (it becomes the next turn).
    const delivery: FacadeDelivery | undefined = hasActiveTurn
      ? kind === "steering"
        ? "steer"
        : "queue"
      : undefined;
    try {
      await this.opts.facade.prompt({ sessionID: chat.sessionID, text: message.text, delivery });
    } catch (err) {
      this.echo(chatURI, action, origin, `prompt failed: ${errorMessage(err)}`);
      return;
    }
    if (hasActiveTurn) {
      this.echo(chatURI, action, origin);
      return;
    }
    // No active turn: the message starts a turn right now. Echo the
    // pending-message first, then a host-minted turnStarted carrying
    // `queuedMessageId` — the reducer dequeues it.
    this.echo(chatURI, action, origin);
    const turnId = this.mintTurnId();
    chat.currentTurnId = turnId;
    chat.turnStartedAt = Date.now();
    this.publish({
      channel: chatURI,
      action: {
        type: ActionType.ChatTurnStarted,
        turnId,
        startedAt: new Date().toISOString(),
        message,
        queuedMessageId: id,
      },
    });
  }

  private async dispatchToolCallConfirmed(chat: ChatRuntime, action: StateAction, origin: ActionOrigin | undefined): Promise<void> {
    const chatURI = chat.uri;
    const rec = this.byChannel.get(chatURI)!;
    const a = action as ChatToolCallConfirmedAction;
    const toolCallId = typeof a.toolCallId === "string" ? a.toolCallId : null;
    if (toolCallId === null) {
      this.echo(chatURI, action, origin, "invalid chat/toolCallConfirmed params");
      return;
    }
    const permissionID = chat.permissionForTool.get(toolCallId);
    if (permissionID === undefined) {
      this.echo(chatURI, action, origin, `no pending permission for tool call ${toolCallId}`);
      return;
    }
    try {
      await this.opts.facade.replyPermission({
        sessionID: chat.sessionID,
        requestID: permissionID,
        decision: a.approved === true ? "once" : "reject",
      });
    } catch (err) {
      this.echo(chatURI, action, origin, `permission reply failed: ${errorMessage(err)}`);
      return;
    }
    // Echo the confirmation (reducer → running/cancelled), then clear the
    // session-level input request. The `permission.replied` event is a
    // safety net (its tracking is already gone → no-op).
    this.echo(chatURI, action, origin);
    this.publish({
      channel: rec.channel,
      action: { type: ActionType.SessionInputNeededRemoved, id: toolCallId },
    });
    chat.permissionForTool.delete(toolCallId);
    chat.toolForPermission.delete(permissionID);
  }

  /**
   * `chat/toolCallComplete` (client-dispatchable): the owning client
   * finished executing a delegated tool call. Only valid for
   * client-executed calls (the host emits its own complete for
   * server-executed ones); the dispatching client must be the
   * contributor. Echoes the action (reducer: running → completed, or
   * → pending-result-confirmation when `requiresResultConfirmation`),
   * clears the execution input request, and settles the opencode-side
   * waiter with the client's result.
   */
  // ── client-executed tool calls ───────────────────
  private async dispatchToolCallComplete(chat: ChatRuntime, action: StateAction, origin: ActionOrigin | undefined): Promise<void> {
    const chatURI = chat.uri;
    const rec = this.byChannel.get(chatURI)!;
    const a = action as ChatToolCallCompleteAction;
    const toolCallId = typeof a.toolCallId === "string" ? a.toolCallId : null;
    const invocation = toolCallId !== null ? chat.clientToolCalls.get(toolCallId) : undefined;
    if (toolCallId === null || invocation === undefined) {
      this.echo(chatURI, action, origin, `tool call ${toolCallId ?? "?"} is not a client-executed call`);
      return;
    }
    if (origin !== undefined && invocation.clientId !== origin.clientId) {
      this.echo(chatURI, action, origin, `only the contributing client (${invocation.clientId}) may complete this call`);
      return;
    }
    const result = normalizeToolCallResult(a.result);
    if (result === null) {
      this.echo(chatURI, action, origin, "invalid chat/toolCallComplete params (result.success must be a boolean)");
      return;
    }
    const status = this.toolCallState(chat, toolCallId)?.status;
    if (status !== ToolCallStatus.Running && status !== ToolCallStatus.PendingConfirmation) {
      this.echo(chatURI, action, origin, `tool call ${toolCallId} is not ready to complete (status ${status ?? "absent"})`);
      return;
    }
    const requiresConfirmation = a.requiresResultConfirmation === true;
    // Echo first: the reducer moves running → completed (or
    // pending-result-confirmation); the settle below must observe the
    // new state for the confirmation input request.
    this.echo(chatURI, action, origin);
    if (requiresConfirmation) {
      // Hold the client's result until the approval reply; surface the
      // user-facing confirmation on the session channel (this variant,
      // unlike the execution request, raises SessionStatus.InputNeeded).
      invocation.pendingResult = result;
      const pending = this.pendingToolCall(chat, toolCallId);
      if (pending !== null && chat.currentTurnId !== null) {
        this.publish({
          channel: rec.channel,
          action: {
            type: ActionType.SessionInputNeededSet,
            request: {
              id: toolCallId,
              chat: chatURI,
              kind: SessionInputRequestKind.ToolConfirmation,
              turnId: chat.currentTurnId,
              toolCall: pending,
            } satisfies SessionToolConfirmationRequest,
          },
        });
      }
    } else {
      this.publish({
        channel: rec.channel,
        action: { type: ActionType.SessionInputNeededRemoved, id: toolCallId },
      });
      this.settleClientTool(invocation, clientResultToFacade(result));
    }
  }

  /**
   * `chat/toolCallContentChanged` (client-dispatchable): the owning
   * client streams partial content while executing (the reducer
   * replaces the running call's `content`). Echo-only — opencode needs
   * no counterpart; the spec says the server SHOULD reject dispatches
   * from a client that is not the contributor.
   */
  private dispatchToolCallContentChanged(chat: ChatRuntime, action: StateAction, origin: ActionOrigin | undefined): void {
    const chatURI = chat.uri;
    const a = action as ChatToolCallContentChangedAction;
    const toolCallId = typeof a.toolCallId === "string" ? a.toolCallId : null;
    const invocation = toolCallId !== null ? chat.clientToolCalls.get(toolCallId) : undefined;
    if (toolCallId === null || invocation === undefined) {
      this.echo(chatURI, action, origin, `tool call ${toolCallId ?? "?"} is not a client-executed call`);
      return;
    }
    if (origin !== undefined && invocation.clientId !== origin.clientId) {
      this.echo(chatURI, action, origin, `only the contributing client (${invocation.clientId}) may stream content for this call`);
      return;
    }
    if (!Array.isArray(a.content)) {
      this.echo(chatURI, action, origin, "invalid chat/toolCallContentChanged params (content must be an array)");
      return;
    }
    if (this.toolCallState(chat, toolCallId)?.status !== ToolCallStatus.Running) {
      this.echo(chatURI, action, origin, `tool call ${toolCallId} is not running`);
      return;
    }
    this.echo(chatURI, action, origin);
  }

  /**
   * `chat/toolCallResultConfirmed` (client-dispatchable): the user
   * approved or denied a client tool's result after a
   * `requiresResultConfirmation` completion. Echoes (reducer:
   * pending-result-confirmation → completed / cancelled with reason
   * `result-denied`), clears the confirmation input request, and
   * settles the opencode-side waiter (approved → the held client
   * result; denied → a Tool.Error the model sees).
   */
  private dispatchToolCallResultConfirmed(chat: ChatRuntime, action: StateAction, origin: ActionOrigin | undefined): void {
    const chatURI = chat.uri;
    const rec = this.byChannel.get(chatURI)!;
    const a = action as ChatToolCallResultConfirmedAction;
    const toolCallId = typeof a.toolCallId === "string" ? a.toolCallId : null;
    if (toolCallId === null || typeof a.approved !== "boolean") {
      this.echo(chatURI, action, origin, "invalid chat/toolCallResultConfirmed params");
      return;
    }
    const invocation = chat.clientToolCalls.get(toolCallId);
    if (invocation === undefined) {
      this.echo(chatURI, action, origin, `no pending result confirmation for tool call ${toolCallId}`);
      return;
    }
    if (origin !== undefined && invocation.clientId !== origin.clientId) {
      this.echo(chatURI, action, origin, `only the contributing client (${invocation.clientId}) may confirm this result`);
      return;
    }
    if (this.toolCallState(chat, toolCallId)?.status !== ToolCallStatus.PendingResultConfirmation) {
      this.echo(chatURI, action, origin, `tool call ${toolCallId} is not awaiting result confirmation`);
      return;
    }
    this.echo(chatURI, action, origin);
    this.publish({
      channel: rec.channel,
      action: { type: ActionType.SessionInputNeededRemoved, id: toolCallId },
    });
    const held = invocation.pendingResult;
    if (held === undefined) {
      // Unreachable in practice (the state only reaches
      // pending-result-confirmation through our complete path); fail
      // closed so the opencode tool cannot hang.
      this.settleClientTool(invocation, { ok: false, error: "no recorded result to confirm" });
      return;
    }
    if (a.approved) {
      this.settleClientTool(invocation, clientResultToFacade(held as ToolCallResult));
    } else {
      this.settleClientTool(invocation, { ok: false, error: "the client denied the tool result" });
    }
  }

  private async dispatchTurnCancelled(chat: ChatRuntime, action: StateAction, origin: ActionOrigin | undefined): Promise<void> {
    const chatURI = chat.uri;
    const a = action as ChatTurnCancelledAction;
    const turnId = typeof a.turnId === "string" && a.turnId.length > 0 ? a.turnId : null;
    const active = chat.chatStore.state.activeTurn;
    if (turnId === null || active === undefined || active.id !== turnId) {
      this.echo(chatURI, action, origin, "no active turn to cancel");
      return;
    }
    try {
      await this.opts.facade.interrupt({ sessionID: chat.sessionID });
    } catch (err) {
      this.echo(chatURI, action, origin, `interrupt failed: ${errorMessage(err)}`);
      return;
    }
    // `duration` is required on the wire (the reducer derives the final
    // `modifiedAt` from it); the host clock is authoritative when the
    // client did not supply one.
    const duration =
      typeof a.duration === "number" && Number.isFinite(a.duration) ? a.duration : this.turnDuration(chat);
    this.echo(chatURI, { ...a, duration }, origin);
    // The opencode `session.execution.interrupted` event finds no active
    // turn after the echo finalized it (skipped); run the queued/steering
    // handoff now, on the host side.
    await this.finishTurn(chat);
  }

  /**
   * `changeset/filesReviewChanged` (the only client-dispatchable changeset
   * action): validate the channel resolves to a live store, then echo —
   * the official reducer toggles `reviewed` per matched file id.
   */
  private dispatchChangesetFilesReviewChanged(channel: string, action: StateAction, origin: ActionOrigin | undefined): void {
    const a = action as ChangesetFilesReviewChangedAction;
    if (!Array.isArray(a.files) || !a.files.every((f) => typeof f === "string") || typeof a.reviewed !== "boolean") {
      this.echo(channel, action, origin, "invalid changeset/filesReviewChanged params");
      return;
    }
    const parsed = parseChangesetChannel(channel);
    const rec = parsed !== null ? this.byChannel.get(parsed.ownerUri) : undefined;
    const store = rec !== undefined ? this.changesetStoreOf(rec, channel) : undefined;
    if (rec === undefined || store === undefined) {
      this.echo(channel, action, origin, "no such changeset");
      return;
    }
    this.echo(channel, action, origin);
  }

  private async dispatchTitleChanged(rec: SessionRecord, action: StateAction, origin: ActionOrigin | undefined): Promise<void> {
    const a = action as { title?: unknown };
    const title = typeof a.title === "string" && a.title.length > 0 ? a.title : null;
    if (title === null) {
      this.echo(rec.channel, action, origin, "invalid session/titleChanged params");
      return;
    }
    try {
      await this.opts.facade.rename({ sessionID: rec.sessionID, title });
    } catch (err) {
      this.echo(rec.channel, action, origin, `rename failed: ${errorMessage(err)}`);
      return;
    }
    this.echo(rec.channel, action, origin);
  }

  private dispatchActiveClientSet(
    rec: SessionRecord,
    action: StateAction,
    origin: ActionOrigin | undefined,
    clientId: string | null,
  ): void {
    const a = action as { activeClient?: unknown };
    const ac = a.activeClient;
    if (!isRecord(ac) || typeof ac["clientId"] !== "string" || (clientId !== null && ac["clientId"] !== clientId)) {
      this.echo(rec.channel, action, origin, "activeClient.clientId must match the dispatching client");
      return;
    }
    const tools = normalizeToolDefinitions(ac["tools"]);
    const normalized: SessionActiveClient = {
      clientId: ac["clientId"] as string,
      tools,
      ...(typeof ac["displayName"] === "string" ? { displayName: ac["displayName"] as string } : {}),
    };
    this.publish({
      channel: rec.channel,
      action: { type: ActionType.SessionActiveClientSet, activeClient: normalized },
      origin,
    });
    // The session's tool contribution changed —
    // re-sync the location-global opencode tool union.
    void this.syncClientToolsToOpencode();
  }

  private dispatchActiveClientRemoved(
    rec: SessionRecord,
    action: StateAction,
    origin: ActionOrigin | undefined,
    clientId: string | null,
  ): void {
    const a = action as { clientId?: unknown };
    if (typeof a.clientId !== "string" || (clientId !== null && a.clientId !== clientId)) {
      this.echo(rec.channel, action, origin, "clientId must match the dispatching client");
      return;
    }
    this.echo(rec.channel, action, origin);
    // The session's tool contribution shrank —
    // re-sync the location-global opencode tool union.
    void this.syncClientToolsToOpencode();
  }
}
