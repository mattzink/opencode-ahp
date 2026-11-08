/**
 * AHP channel registry (plan §6.1 channels.ts): URI parsing/formatting,
 * per-socket subscription bookkeeping, and the set of live opencode
 * sessions. Pure in-memory — no runtime dependencies.
 *
 * Phase 0 only the root channel is live; session/chat URI handling and
 * the session registry land with Phase 1 (session support).
 */

export const ROOT_CHANNEL = "ahp-root://";
const SESSION_PREFIX = "ahp-session:/";
const CHAT_PREFIX = "ahp-chat:/";

export type ChannelKind = "root" | "session" | "chat" | "unknown";

export function channelKind(uri: string): ChannelKind {
  if (uri === ROOT_CHANNEL) return "root";
  if (uri.startsWith(SESSION_PREFIX) && uri.length > SESSION_PREFIX.length) return "session";
  if (uri.startsWith(CHAT_PREFIX) && uri.length > CHAT_PREFIX.length) return "chat";
  return "unknown";
}

/**
 * Channel URI of a session. opencode has one chat per session (plan §3.2
 * gap, same as pi-ahp / ahp-acp-gateway), and the session's default chat
 * reuses the session id.
 */
export function sessionChannelURI(sessionID: string): string {
  return SESSION_PREFIX + sessionID;
}

/** Channel URI of a session's (single) default chat. */
export function chatChannelURI(sessionID: string): string {
  return CHAT_PREFIX + sessionID;
}

/** The session id behind a session/chat channel URI, or null. */
export function sessionIDOf(uri: string): string | null {
  const kind = channelKind(uri);
  if (kind === "session") return uri.slice(SESSION_PREFIX.length);
  if (kind === "chat") return uri.slice(CHAT_PREFIX.length);
  return null;
}

export interface SubscribeOutcome {
  ok: boolean;
  reason?: "unknown-uri" | "no-such-session";
}

/**
 * Subscription bookkeeping keyed by transport socket id, plus the set of
 * live session ids (Phase 1).
 */
export class ChannelRegistry {
  private readonly subs = new Map<number, Set<string>>();
  private readonly sessions = new Set<string>();

  /** Subscribe a socket to a channel; fails for unknown URIs or dead sessions. */
  subscribe(socketId: number, uri: string): SubscribeOutcome {
    const kind = channelKind(uri);
    if (kind === "unknown") return { ok: false, reason: "unknown-uri" };
    if (kind !== "root") {
      const id = sessionIDOf(uri);
      if (id === null || !this.sessions.has(id)) return { ok: false, reason: "no-such-session" };
    }
    let set = this.subs.get(socketId);
    if (!set) {
      set = new Set();
      this.subs.set(socketId, set);
    }
    set.add(uri);
    return { ok: true };
  }

  unsubscribe(socketId: number, uri: string): void {
    this.subs.get(socketId)?.delete(uri);
  }

  /** URIs a socket is subscribed to (idempotent re-subscribe keeps one entry). */
  subscriptionsOf(socketId: number): readonly string[] {
    return [...(this.subs.get(socketId) ?? [])];
  }

  /** Socket ids currently subscribed to uri — broadcast targets. */
  socketsSubscribedTo(uri: string): readonly number[] {
    const out: number[] = [];
    for (const [socketId, set] of this.subs) if (set.has(uri)) out.push(socketId);
    return out;
  }

  /** Drop a socket's subscriptions (connection closed). */
  removeSocket(socketId: number): void {
    this.subs.delete(socketId);
  }

  // ── live sessions (Phase 1: session/chat channels) ────────────────────

  addSession(sessionID: string): void {
    this.sessions.add(sessionID);
  }

  removeSession(sessionID: string): void {
    this.sessions.delete(sessionID);
  }

  hasSession(sessionID: string): boolean {
    return this.sessions.has(sessionID);
  }
}
