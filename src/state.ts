/**
 * Channel state stores, all maintained by the official reducers from
 * @microsoft/agent-host-protocol — the host never hand-rolls state
 * transitions (plan §6.1 state.ts: "state computed by the official
 * reducers").
 *
 *  - root channel: `rootReducer` (Phase 0);
 *  - session channels: `sessionReducer` (Phase 1);
 *  - chat channels: `chatReducer` (Phase 1);
 *  - changeset channels: `changesetReducer` (Phase 2).
 */
import {
  chatReducer,
  changesetReducer,
  rootReducer,
  sessionReducer,
  type ChatAction,
  type ChatState,
  type ChangesetAction,
  type ChangesetState,
  type RootAction,
  type RootState,
  type SessionAction,
  type SessionState,
} from "@microsoft/agent-host-protocol";

export interface RootStateStore {
  /** Current root state (the `ahp-root://` snapshot payload). */
  readonly state: RootState;
  /** Apply a root action through the official reducer; returns the new state. */
  apply(action: RootAction): RootState;
}

export interface SessionStateStore {
  /** Current session state (the `ahp-session:/…` snapshot payload). */
  readonly state: SessionState;
  /** Apply a session-channel action through the official reducer. */
  apply(action: SessionAction): SessionState;
}

export interface ChatStateStore {
  /** Current chat state (the `ahp-chat:/…` snapshot payload). */
  readonly state: ChatState;
  /** Apply a chat-channel action through the official reducer. */
  apply(action: ChatAction): ChatState;
}

export interface ChangesetStateStore {
  /** Current changeset state (the `…/changeset/…` snapshot payload). */
  readonly state: ChangesetState;
  /** Apply a changeset-channel action through the official reducer. */
  apply(action: ChangesetAction): ChangesetState;
}

export function createRootStateStore(initial: RootState): RootStateStore {
  let state: RootState = initial;
  return {
    get state(): RootState {
      return state;
    },
    apply(action: RootAction): RootState {
      state = rootReducer(state, action);
      return state;
    },
  };
}

export function createSessionStateStore(initial: SessionState): SessionStateStore {
  let state: SessionState = initial;
  return {
    get state(): SessionState {
      return state;
    },
    apply(action: SessionAction): SessionState {
      state = sessionReducer(state, action);
      return state;
    },
  };
}

export function createChatStateStore(initial: ChatState): ChatStateStore {
  let state: ChatState = initial;
  return {
    get state(): ChatState {
      return state;
    },
    apply(action: ChatAction): ChatState {
      state = chatReducer(state, action);
      return state;
    },
  };
}

export function createChangesetStateStore(initial: ChangesetState): ChangesetStateStore {
  let state: ChangesetState = initial;
  return {
    get state(): ChangesetState {
      return state;
    },
    apply(action: ChangesetAction): ChangesetState {
      state = changesetReducer(state, action);
      return state;
    },
  };
}
