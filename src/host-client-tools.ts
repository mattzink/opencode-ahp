/**
 * Client-tool section (design §10): tool-call ready/tracking state, the location-global tool union sync, and the `execute` bridge (public — called from the plugin registration in index.ts).
 */

import { HostTurns } from "./host-turns.js";
import { ActionType, ResponsePartKind, ToolCallConfirmationReason, ToolCallStatus, SessionActiveClient, SessionToolConfirmationRequest, ToolCallConfirmationState, ToolCallState } from "@microsoft/agent-host-protocol";
import { invocationMessageFor, FacadeClientTool, FacadeClientToolResult } from "./bridge.js";
import { descriptionFor, findProvider, inputSchemaFor, toolUnion, ClientToolInvocation } from "./client-tools.js";
import { ChatRuntime, SessionRecord } from "./host-types.js";
import { errorMessage } from "./host-util.js";

export class HostClientTools extends HostTurns {
  /**
   * Lazily publish `chat/toolCallReady` for a tool call (first of
   * progress/success/failed/permission.asked):
   *  - permission trigger → no `confirmed` → the reducer parks it in
   *    `pending-confirmation` (the caller then raises `inputNeededSet`);
   *  - otherwise → `confirmed: "not-needed"` → straight to `running`
   *    (opencode auto-approved).
   */
  protected ensureToolReady(chat: ChatRuntime, toolCallId: string, permission: boolean): void {
    if (chat.toolReady.has(toolCallId) || chat.currentTurnId === null) return;
    chat.toolReady.add(toolCallId);
    const name = chat.toolName.get(toolCallId) ?? "tool";
    const input = chat.toolInput.get(toolCallId);
    this.publish({
      channel: chat.uri,
      action: {
        type: ActionType.ChatToolCallReady,
        turnId: chat.currentTurnId,
        toolCallId,
        invocationMessage: invocationMessageFor(name, input),
        toolInput: input,
        ...(permission ? {} : { confirmed: ToolCallConfirmationReason.NotNeeded }),
      },
    });
  }

  /** The live tool-call state in the chat's current turn, or null when absent. */
  protected toolCallState(chat: ChatRuntime, toolCallId: string): ToolCallState | null {
    const turn = chat.chatStore.state.activeTurn;
    if (turn === undefined) return null;
    for (const part of turn.responseParts) {
      if (part.kind === ResponsePartKind.ToolCall && part.toolCall.toolCallId === toolCallId) {
        return part.toolCall;
      }
    }
    return null;
  }

  /**
   * The tool call's state when it is awaiting confirmation (the
   * `SessionToolConfirmationRequest.toolCall` shape), or null otherwise.
   */
  protected pendingToolCall(chat: ChatRuntime, toolCallId: string): ToolCallConfirmationState | null {
    const tc = this.toolCallState(chat, toolCallId);
    if (tc === null) return null;
    if (tc.status === ToolCallStatus.PendingConfirmation || tc.status === ToolCallStatus.PendingResultConfirmation) {
      return tc;
    }
    return null;
  }

  /** True when the tool call already left the ready states (completed/cancelled). */
  protected toolCallTerminal(chat: ChatRuntime, toolCallId: string): boolean {
    const tc = this.toolCallState(chat, toolCallId);
    return tc !== null && (tc.status === ToolCallStatus.Completed || tc.status === ToolCallStatus.Cancelled);
  }

  protected clearToolTracking(chat: ChatRuntime, toolCallId: string): void {
    chat.toolInput.delete(toolCallId);
    chat.toolName.delete(toolCallId);
    chat.toolReady.delete(toolCallId);
    chat.clientToolCalls.delete(toolCallId);
  }

  /**
   * The session's active client providing `toolName` (the tool-call
   * contributor), or null when no active client provides it (a
   * server-executed call — the normal path).
   */
  // ── client-tool helpers ─────────────────────────────────────────────────
  protected clientToolContributor(rec: SessionRecord, toolName: string): string | null {
    return findProvider(rec.sessionStore.state.activeClients, toolName);
  }

  /**
   * Re-sync the location-global opencode tool registry with the
   * cross-session union of every live session's active-client tools
   * (first-registered wins per name). Location-global by design —
   * opencode's tool state is per-location, not per-session: the
   * `execute` bridge re-checks per-session ownership at
   * runtime.
   */
  protected async syncClientToolsToOpencode(): Promise<void> {
    const clients: SessionActiveClient[] = [];
    for (const rec of this.sessions.values()) {
      for (const client of rec.sessionStore.state.activeClients) clients.push(client);
    }
    const tools = toolUnion(clients).map(
      (t): FacadeClientTool => ({
        name: t.name,
        description: descriptionFor(t),
        inputSchema: inputSchemaFor(t),
      }),
    );
    try {
      await this.opts.facade.syncClientTools(tools);
    } catch (err) {
      // R2: a tool-registry failure must not break the AHP surface —
      // the active-client state stays authoritative on the AHP side.
      this.log(`client tool sync failed: ${errorMessage(err)}`);
    }
  }

  /**
   * Settle a client-tool invocation with its final result: the
   * opencode-side `execute` (blocked on the waiter) unblocks and
   * returns/throws, which drives the pump's `tool.success`/
   * `tool.failed` terminal (the AHP state is already terminal — the
   * pump's `toolCallTerminal` check suppresses a duplicate echo and
   * clears the tracking). Settling twice is a no-op.
   *
   * `result` may be omitted when the invocation's `result` was already
   * set by the caller (the eviction / session-removal paths set it
   * first and then settle to deliver it).
   */
  protected settleClientTool(invocation: ClientToolInvocation, result?: FacadeClientToolResult): void {
    if (invocation.result === undefined) {
      if (result === undefined) return; // nothing to settle
      invocation.result = result;
    }
    if (invocation.waiter !== undefined && invocation.waiter !== null) {
      invocation.waiter(invocation.result);
      invocation.waiter = null;
    }
  }

  /**
   * The opencode tool `execute` bridge (called from the
   * `ctx.tool.transform` registration in src/index.ts): route one
   * client-tool invocation to the owning AHP client and wait for its
   * result.
   *
   * Per-session scoping: the tool is visible location-
   * globally, but execution only resolves when *this* session is an
   * AHP session with an active client providing the tool — otherwise
   * the opencode tool fails (a `Tool.Error` the model sees), so e.g. a
   * TUI session can see the tool but not execute it.
   */
  executeClientTool(input: {
    sessionID: string;
    toolCallId: string;
    name: string;
    signal: AbortSignal;
  }): Promise<FacadeClientToolResult> {
    // The opencode session id joins to the (record, chat) that owns it —
    // every chat has its own backend session.
    const binding = this.byOpencode.get(input.sessionID);
    if (binding === undefined) {
      return Promise.resolve({
        ok: false,
        error: `no AHP session for tool "${input.name}" (session ${input.sessionID} is not an AHP session)`,
      });
    }
    const { rec, chat } = binding;
    const invocation = chat.clientToolCalls.get(input.toolCallId);
    if (invocation === undefined) {
      return Promise.resolve({
        ok: false,
        error: `no client-executed call in flight for tool "${input.name}" (it was not registered by this session's active client)`,
      });
    }
    if (findProvider(rec.sessionStore.state.activeClients, input.name) !== invocation.clientId) {
      return Promise.resolve({
        ok: false,
        error: `session ${rec.sessionID} has no active client providing tool "${input.name}"`,
      });
    }
    if (input.signal.aborted) {
      const result: FacadeClientToolResult = { ok: false, error: `execution of "${input.name}" was cancelled` };
      this.settleClientTool(invocation, result);
      return Promise.resolve(result);
    }
    // The invocation may already be settled (the client completed before
    // opencode started the execute — possible: the client only needs the
    // pump's ready/inputNeeded actions, not our execute). Deliver the
    // settled result; otherwise register the waiter.
    const settled = invocation.result;
    if (settled !== undefined) return Promise.resolve(settled);
    return new Promise<FacadeClientToolResult>((resolve) => {
      invocation.waiter = resolve;
      const onAbort = () => {
        if (invocation.result === undefined) {
          this.settleClientTool(invocation, {
            ok: false,
            error: `execution of "${input.name}" was cancelled (turn interrupted)`,
          });
        }
        // If already settled, the waiter is gone — the abort is a no-op.
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
