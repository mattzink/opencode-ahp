/**
 * The AHP host: the JSON-RPC 2.0 router over transport connections that
 * ties the sequencer, channel registry, root state store, and bridge
 * together.
 *
 * The router that wires the pure modules to sockets is extracted here
 * (a `Host` class) so the whole protocol layer is unit-testable and
 * exercisable by the spike client without a WebSocket runtime.
 *
 * Connection model (AHP 1.0.0 lifecycle spec):
 *  - the first request on a socket is `initialize` (new client) or
 *    `reconnect` (known clientId — the host keeps a per-clientId registry
 *    across sockets);
 *  - `ping` is answered even before initialize;
 *  - `serverSeq` is a single host-wide sequence (seq.ts);
 *  - `dispatchAction` and `unsubscribe` are notifications (no id); a
 *    dispatched action comes back on the `action` notification stream
 *    (write-ahead reconciliation; rejections carry `rejectionReason`).
 *
 * Session surface: `createSession` + `listSessions`, session/chat
 * snapshots, the opencode event pump (streaming text/reasoning, tool-call
 * lifecycle, permission prompts, usage, turn terminals + steering/queue
 * handoff), and the client-dispatchable actions VS Code sends
 * (`chat/turnStarted`, `chat/pendingMessageSet`, `chat/toolCallConfirmed`,
 * `chat/turnCancelled`, drafts/read/title/activeClient echoes, …).
 *
 * Session model: one AHP session = one opencode location session record
 * holding a chat catalog; one AHP chat = one opencode session. The
 * default chat reuses the record's opencode session, so
 * single-chat clients see zero wire change; peer chats created via
 * `createChat` bind fresh opencode sessions to client-chosen chat URIs.
 * Channel suffixes are opaque; opencode session ids start with "ses"
 * and double as suffixes for externally created sessions.
 *
 * Root session lifecycle events (`root/sessionAdded`,
 * `root/sessionRemoved`, `root/sessionSummaryChanged`) are JSON-RPC
 * *notifications* in AHP 1.0.0 (ephemeral, not replayed) — only
 * `root/activeSessionsChanged` is a sequencer action.
 *
 * Module layout: this file only composes the host — the section classes
 * (host-base.ts → host-changesets.ts → host-terminals.ts → host-turns.ts →
 * host-client-tools.ts → host-chats.ts → host-sessions.ts → host-dispatch.ts →
 * host-events.ts → host-rpc.ts) form a linear chain, each extending the
 * previous one; shared state lives in HostBase, and a section may only
 * call members declared at or below it in the chain (that is what keeps
 * the split type-safe).
 */

import { HostRpc } from "./host-rpc.js";

export { ERROR_PARSE, ERROR_INVALID_REQUEST, ERROR_METHOD_NOT_FOUND, ERROR_INTERNAL, ERROR_SESSION_NOT_FOUND, ERROR_NO_PROVIDER, ERROR_SESSION_EXISTS, ERROR_NOT_FOUND, ERROR_PERMISSION_DENIED, ERROR_ALREADY_EXISTS } from "./host-errors.js";
export type { HostOptions } from "./host-types.js";

export class Host extends HostRpc {}
