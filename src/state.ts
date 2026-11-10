/**
 * Channel state stores, all maintained by the official reducers from
 * @microsoft/agent-host-protocol — the host never hand-rolls state
 * transitions (state is computed by the official reducers).
 *
 *  - root channel: `rootReducer`;
 *  - session channels: `sessionReducer`;
 *  - chat channels: `chatReducer`;
 *  - changeset channels: `changesetReducer`;
 *  - terminal channels: `terminalReducer`.
 */
import {
  chatReducer,
  changesetReducer,
  rootReducer,
  sessionReducer,
  terminalReducer,
  type ChatAction,
  type ChatState,
  type ChangesetAction,
  type ChangesetState,
  type RootAction,
  type RootState,
  type SessionAction,
  type SessionState,
  type TerminalAction,
  type TerminalState,
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

export interface TerminalStateStore {
  /** Current terminal state (the `ahp-terminal:/…` snapshot payload). */
  readonly state: TerminalState;
  /** Apply a terminal-channel action through the official reducer. */
  apply(action: TerminalAction): TerminalState;
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

export function createTerminalStateStore(initial: TerminalState): TerminalStateStore {
  let state: TerminalState = initial;
  return {
    get state(): TerminalState {
      return state;
    },
    apply(action: TerminalAction): TerminalState {
      state = terminalReducer(state, action);
      return state;
    },
  };
}
