/**
 * Event pump section (design §8): the opencode event → AHP action translation (streaming, tool-call lifecycle, permissions, usage, terminals, client-tool handoff) and pump control.
 */

import { HostDispatch } from "./host-dispatch.js";
import { ActionType, ResponsePartKind, SessionInputRequestKind, ToolCallContributorKind, ToolCallStatus, ErrorResponsePart, SessionToolClientExecutionRequest, SessionToolConfirmationRequest } from "@microsoft/agent-host-protocol";
import { displayNameFor, pastTenseMessageFor, userMessage, FacadeEvent } from "./bridge.js";
import { EXTERNAL_REGISTER_GRACE_MS, errorMessage, mapToolResultContent } from "./host-util.js";

export class HostEvents extends HostDispatch {
  /**
   * Start the opencode event → AHP action pump. Idempotent. The pump is a
   * single sequential async loop, so event handling and client-dispatch
   * handling (same event loop) interleave without races on the per-turn
   * join state.
   */
  // ── event pump ─────────────────────────────────────────────────────────
  startEventPump(): void {
    if (this.pumpController !== null) return;
    const controller = new AbortController();
    this.pumpController = controller;
    void (async () => {
      try {
        for await (const event of this.opts.facade.events(controller.signal)) {
          if (controller.signal.aborted) break;
          await this.handleEvent(event);
        }
      } catch (err) {
        this.log(`event pump failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      } finally {
        if (this.pumpController === controller) this.pumpController = null;
      }
    })();
  }

  /** Stop the event pump (teardown). Idempotent. */
  stopEventPump(): void {
    this.pumpController?.abort();
    this.pumpController = null;
  }

  // ── opencode event pump handlers ───────────────────────────────────────
  private async handleEvent(ev: FacadeEvent): Promise<void> {
    if (ev.type === "session.created") {
      // Every live chat has its own opencode session, so a
      // created event for an already-bound id is ours (a createChat
      // backend) and never an external session.
      if (this.sessions.has(ev.sessionID) || this.byOpencode.has(ev.sessionID)) return;
      // Deferred registration: a concurrent `createSession` may still be
      // resolving for this opencode session under a client-chosen channel;
      // the grace + existence check avoids the double registration, and
      // the delete+recreate remap in `handleCreateSession` heals the slow
      // path.
      const sessionID = ev.sessionID;
      setTimeout(() => {
        void this.registerExternalDeferred(sessionID).catch((err) =>
          this.log(`external session registration failed: ${errorMessage(err)}`),
        );
      }, EXTERNAL_REGISTER_GRACE_MS);
      return;
    }

    // The opencode session id joins to (record, chat) — every chat has
    // its own backend session, and per-turn state lives on the chat.
    // Only session.created registers sessions.
    const binding = this.byOpencode.get(ev.sessionID);
    if (binding === undefined) return;
    const { rec, chat } = binding;
    const chatURI = chat.uri;
    switch (ev.type) {
      case "session.deleted":
        if (chat.uri === rec.defaultChatURI) {
          this.removeRecord(rec);
        } else {
          // Peer-chat backend gone (deleted in the TUI or by another
          // surface): drop the AHP chat only — the record and its other
          // chats stay.
          this.removeChat(rec, chat);
          this.publish({ channel: rec.channel, action: { type: ActionType.SessionChatRemoved, chat: chat.uri } });
        }
        return;
      case "session.renamed":
        if (chat.uri === rec.defaultChatURI) {
          this.publish({ channel: rec.channel, action: { type: ActionType.SessionTitleChanged, title: ev.title } });
        } else {
          // No chat-title session action exists; the chat summary carries
          // the title (the chat store's own title stays original — same
          // pre-existing behavior as the default chat's titleChanged).
          this.publish({
            channel: rec.channel,
            action: { type: ActionType.SessionChatUpdated, chat: chat.uri, changes: { title: ev.title } },
          });
        }
        return;
      case "inbox.enqueued":
        chat.lastInbox = { text: ev.text, delivery: ev.delivery };
        return;
      case "inbox.delivered":
        // Steering consumption is handled at turn end (finishTurn).
        return;
      case "execution.started":
        if (chat.currentTurnId !== null) return; // write-ahead already claimed the turn
        // Orphan turn (an external TUI prompt, or a handoff this host did
        // not initiate): start it with the last-seen inbox message.
        this.startTurn(chat, chat.lastInbox !== null ? userMessage(chat.lastInbox.text) : userMessage(""));
        return;
      case "execution.succeeded":
        if (chat.currentTurnId === null) return;
        this.publish({
          channel: chatURI,
          action: { type: ActionType.ChatTurnComplete, turnId: chat.currentTurnId, duration: this.turnDuration(chat) },
        });
        await this.finishTurn(chat);
        return;
      case "execution.failed":
        if (chat.currentTurnId === null) return;
        const part: ErrorResponsePart = {
          kind: ResponsePartKind.Error,
          error: { errorType: ev.error.type, message: ev.error.message },
        };
        this.publish({
          channel: chatURI,
          action: { type: ActionType.ChatError, turnId: chat.currentTurnId, duration: this.turnDuration(chat), part },
        });
        await this.finishTurn(chat);
        return;
      case "execution.interrupted":
        // Skipped when the client's own `chat/turnCancelled` echo already
        // finalized the turn (currentTurnId is null).
        if (chat.currentTurnId === null) return;
        this.publish({
          channel: chatURI,
          action: { type: ActionType.ChatTurnCancelled, turnId: chat.currentTurnId, duration: this.turnDuration(chat) },
        });
        await this.finishTurn(chat);
        return;
      case "step.started":
        chat.turnModelRef = `${ev.model.providerID}/${ev.model.modelID}`;
        return;
      case "text.delta":
      case "reasoning.delta": {
        if (chat.currentTurnId === null) return;
        const kind = ev.type === "text.delta" ? ResponsePartKind.Markdown : ResponsePartKind.Reasoning;
        const key = `${ev.assistantMessageID}:${kind}:${ev.ordinal}`;
        const first = !chat.parts.has(key);
        chat.parts.add(key);
        const partId = `part-${key}`;
        if (first) {
          // Lazily emit the part on the first delta; it carries the
          // initial content.
          this.publish({
            channel: chatURI,
            action: {
              type: ActionType.ChatResponsePart,
              turnId: chat.currentTurnId,
              part: { kind, id: partId, content: ev.delta },
            },
          });
        } else {
          this.publish({
            channel: chatURI,
            action:
              kind === ResponsePartKind.Markdown
                ? { type: ActionType.ChatDelta, turnId: chat.currentTurnId, partId, content: ev.delta }
                : { type: ActionType.ChatReasoning, turnId: chat.currentTurnId, partId, content: ev.delta },
          });
        }
        return;
      }
      case "text.ended":
      case "reasoning.ended": {
        if (chat.currentTurnId === null) return;
        // Fallback for non-streaming providers that emit only the final
        // text: if no delta opened the part, emit it now with the full text.
        const kind = ev.type === "text.ended" ? ResponsePartKind.Markdown : ResponsePartKind.Reasoning;
        const key = `${ev.assistantMessageID}:${kind}:${ev.ordinal}`;
        if (!chat.parts.has(key)) {
          chat.parts.add(key);
          this.publish({
            channel: chatURI,
            action: {
              type: ActionType.ChatResponsePart,
              turnId: chat.currentTurnId,
              part: { kind, id: `part-${key}`, content: ev.text },
            },
          });
        }
        return;
      }
      case "tool.input.started": {
        if (chat.currentTurnId === null) {
          this.log(`tool.input.started outside a turn (session ${chat.sessionID}, tool ${ev.name}); ignored`);
          return;
        }
        chat.toolName.set(ev.id, ev.name);
        // When the session's active clients provide
        // this tool, the call is client-executed — the client
        // `contributor` must be established at start (the official
        // reducer ignores a late one), and the call is tracked for the
        // `execute` bridge + the client's dispatchable actions.
        // (Active clients are session-level; the chat tracks the call.)
        const clientTool = this.clientToolContributor(rec, ev.name);
        if (clientTool !== null) {
          chat.clientToolCalls.set(ev.id, { clientId: clientTool, turnId: chat.currentTurnId });
        }
        this.publish({
          channel: chatURI,
          action: {
            type: ActionType.ChatToolCallStart,
            turnId: chat.currentTurnId,
            toolCallId: ev.id,
            toolName: ev.name,
            displayName: displayNameFor(ev.name),
            ...(clientTool !== null
              ? { contributor: { kind: ToolCallContributorKind.Client, clientId: clientTool } }
              : {}),
          },
        });
        return;
      }
      case "tool.input.ended": {
        chat.toolInput.set(ev.id, ev.text);
        // For file-mutating tools, capture the pre-edit file
        // content now (the event fires before execution — the last safe
        // point). Awaited in the sequential pump so the capture is
        // complete before `execution.*` can end the turn.
        if (this.opts.changesets) await this.captureTurnBefore(chat, ev.id, ev.text);
        // A foreground `shell`-tool call opens its
        // synthetic terminal channel here — the command line is only
        // known at input.ended.
        this.openTerminalForToolCall(rec, chat, ev.id, ev.text);
        // A client-executed call clears its
        // confirmation gate here (no opencode permission can fire for
        // it) — ready straight to running, then surface the execution
        // request so the owning client picks up the work.
        if (chat.clientToolCalls.has(ev.id)) {
          this.ensureToolReady(chat, ev.id, false);
          const invocation = chat.clientToolCalls.get(ev.id);
          const running = this.toolCallState(chat, ev.id);
          if (invocation !== undefined && running !== null && running.status === ToolCallStatus.Running && chat.currentTurnId !== null) {
            const request: SessionToolClientExecutionRequest = {
              id: ev.id,
              chat: chatURI,
              kind: SessionInputRequestKind.ToolClientExecution,
              turnId: chat.currentTurnId,
              clientId: invocation.clientId,
              toolCall: running,
            };
            this.publish({
              channel: rec.channel,
              action: { type: ActionType.SessionInputNeededSet, request },
            });
          }
        }
        return;
      }
      case "tool.progress":
        // First sign the tool is actually running (opencode auto-approved):
        // finalize the tool call as running.
        this.ensureToolReady(chat, ev.id, false);
        return;
      case "tool.success": {
        // The synthetic terminal completes on the
        // tool's terminal event (before the turn guard — a command that
        // finishes after its turn was torn down still exits its
        // terminal; no-op when the call never opened one).
        this.finishTerminal(chat, ev.id, { ok: true, content: ev.content });
        if (chat.currentTurnId === null) return;
        this.ensureToolReady(chat, ev.id, false);
        if (this.toolCallTerminal(chat, ev.id)) {
          // e.g. denied → already cancelled, or a client-executed call
          // the client already completed: no echo, but the tracking
          // (including the client-tool record) must still be cleared.
          this.clearToolTracking(chat, ev.id);
          return;
        }
        const name = chat.toolName.get(ev.id) ?? "tool";
        const input = chat.toolInput.get(ev.id);
        this.publish({
          channel: chatURI,
          action: {
            type: ActionType.ChatToolCallComplete,
            turnId: chat.currentTurnId,
            toolCallId: ev.id,
            result: {
              success: true,
              pastTenseMessage: pastTenseMessageFor(name, input),
              content: mapToolResultContent(ev.content),
            },
          },
        });
        this.clearToolTracking(chat, ev.id);
        return;
      }
      case "tool.failed": {
        this.finishTerminal(chat, ev.id, { ok: false, message: ev.error.message });
        if (chat.currentTurnId === null) return;
        this.ensureToolReady(chat, ev.id, false);
        if (this.toolCallTerminal(chat, ev.id)) {
          // Already terminal (client-executed call completed by the
          // client, or a call cancelled upstream) — clear the tracking.
          this.clearToolTracking(chat, ev.id);
          return;
        }
        const name = chat.toolName.get(ev.id) ?? "tool";
        const input = chat.toolInput.get(ev.id);
        this.publish({
          channel: chatURI,
          action: {
            type: ActionType.ChatToolCallComplete,
            turnId: chat.currentTurnId,
            toolCallId: ev.id,
            result: {
              success: false,
              pastTenseMessage: pastTenseMessageFor(name, input),
              error: { message: ev.error.message },
            },
          },
        });
        this.clearToolTracking(chat, ev.id);
        return;
      }
      case "usage.updated":
        // Session-cumulative tokens; the chat reducer replaces the turn's
        // usage, so the latest cumulative values are the turn's view.
        if (chat.currentTurnId === null) return;
        this.publish({
          channel: chatURI,
          action: {
            type: ActionType.ChatUsage,
            turnId: chat.currentTurnId,
            usage: {
              inputTokens: ev.tokens.input,
              outputTokens: ev.tokens.output,
              cacheReadTokens: ev.tokens.cache.read,
              ...(chat.turnModelRef !== null ? { model: chat.turnModelRef } : {}),
            },
          },
        });
        return;
      case "permission.asked":
        // Only tool-sourced permissions map to a tool confirmation;
        // anything else has no AHP counterpart (gap).
        if (ev.source === undefined) {
          this.log(`ignoring non-tool permission.asked ${ev.id} (action: ${ev.action})`);
          return;
        }
        const toolCallId = ev.source.id;
        chat.permissionForTool.set(toolCallId, ev.id);
        chat.toolForPermission.set(ev.id, toolCallId);
        this.ensureToolReady(chat, toolCallId, true);
        const pending = this.pendingToolCall(chat, toolCallId);
        if (pending !== null && chat.currentTurnId !== null) {
          const request: SessionToolConfirmationRequest = {
            id: toolCallId,
            chat: chatURI,
            kind: SessionInputRequestKind.ToolConfirmation,
            turnId: chat.currentTurnId,
            toolCall: pending,
          };
          this.publish({
            channel: rec.channel,
            action: { type: ActionType.SessionInputNeededSet, request },
          });
        }
        return;
      case "permission.replied": {
        const toolCallId = chat.toolForPermission.get(ev.requestID);
        chat.toolForPermission.delete(ev.requestID);
        if (toolCallId !== undefined) {
          chat.permissionForTool.delete(toolCallId);
          // Safety net: the client's `chat/toolCallConfirmed` normally
          // removes the input request first; this covers the reply
          // arriving without (or before) the echo.
          this.publish({
            channel: rec.channel,
            action: { type: ActionType.SessionInputNeededRemoved, id: toolCallId },
          });
        }
        return;
      }
      default:
        return;
    }
  }
}
