/**
 * Turn lifecycle section (design §8): host-minted turn ids, turn start/claim, and the turn-terminal handoff (steering/queue, changeset + terminal catalog refresh).
 */

import { HostTerminals } from "./host-terminals.js";
import { ActionType, PendingMessageKind, Message } from "@microsoft/agent-host-protocol";
import { userMessage } from "./bridge.js";
import { ChatRuntime } from "./host-types.js";

export class HostTurns extends HostTerminals {
  // ── turn helpers ───────────────────────────────────────────────────────
  protected mintTurnId(): string {
    this.turnCounter += 1;
    return `turn_${Date.now().toString(36)}_${this.turnCounter.toString(36)}`;
  }

  protected turnDuration(chat: ChatRuntime): number {
    return Math.max(0, Date.now() - (chat.turnStartedAt ?? Date.now()));
  }

  /** Claim a turn (write-ahead) and publish `chat/turnStarted`. */
  protected startTurn(chat: ChatRuntime, message: Message, queuedMessageId?: string): void {
    const turnId = this.mintTurnId();
    chat.currentTurnId = turnId;
    chat.turnStartedAt = Date.now();
    this.publish({
      channel: chat.uri,
      action: {
        type: ActionType.ChatTurnStarted,
        turnId,
        startedAt: new Date().toISOString(),
        message,
        ...(queuedMessageId !== undefined ? { queuedMessageId } : {}),
      },
    });
  }

  /**
   * After a turn terminal: clear the steering message opencode consumed
   * during the turn, and auto-start the next turn from the queue (the
   * queued prompt was already sent with `delivery: "queue"` — opencode
   * starts it automatically; this only updates the AHP state).
   *
   * Then refresh the session's changesets — the turn's captured
   * "after" content is read from disk here, and the uncommitted/session/
   * turn changesets recompute (async: awaits the facade).
   */
  protected async finishTurn(chat: ChatRuntime): Promise<void> {
    const endedTurnId = chat.currentTurnId;
    chat.currentTurnId = null;
    chat.turnStartedAt = null;
    const state = chat.chatStore.state;
    if (state.steeringMessage !== undefined) {
      this.publish({
        channel: chat.uri,
        action: {
          type: ActionType.ChatPendingMessageRemoved,
          kind: PendingMessageKind.Steering,
          id: state.steeringMessage.id,
        },
      });
    }
    const queued = state.queuedMessages;
    if (queued !== undefined && queued.length > 0) {
      const next = queued[0]!;
      this.startTurn(chat, next.message, next.id);
    } else if (chat.lastInbox !== null && chat.lastInbox.delivery === "queue") {
      // A queued prompt from outside AHP (e.g. the TUI).
      this.startTurn(chat, userMessage(chat.lastInbox.text));
    }
    // The ended turn's command terminals leave the
    // root catalog now (retention — their state stays subscribable until
    // the chat/record is removed). Runs after the possible
    // chained startTurn so the published list is the post-handoff one.
    if (this.opts.terminals && endedTurnId !== null && this.terminals.size > 0) {
      this.refreshTerminals();
    }
    if (this.opts.changesets && endedTurnId !== null) {
      await this.refreshTurnChangesets(this.byChannel.get(chat.uri)!, chat, endedTurnId);
    }
  }
}
