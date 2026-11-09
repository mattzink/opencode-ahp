/**
 * AHP channel registry (plan §6.1 channels.ts): URI parsing/formatting,
 * per-socket subscription bookkeeping, and the set of live opencode
 * sessions. Pure in-memory — no runtime dependencies.
 *
 * Phase 0 only the root channel is live; session/chat URI handling and
 * the session registry land with Phase 1 (session support). Phase 2 adds
 * the changeset channel kind (`<owner>/changeset/{uncommitted|session|
 * turn/<turnId>}` — plan §11).
 */

export const ROOT_CHANNEL = "ahp-root://";
const SESSION_PREFIX = "ahp-session:/";
const CHAT_PREFIX = "ahp-chat:/";
const CHANGASET_MARKER = "/changeset/";

export type ChannelKind = "root" | "session" | "chat" | "changeset" | "unknown";

export function channelKind(uri: string): ChannelKind {
  if (uri === ROOT_CHANNEL) return "root";
  // A changeset URI is an owner session/chat URI plus `/changeset/<kind>`.
  // Checked before the owner prefixes so `<sessionURI>/changeset/session`
  // is not misread as a session channel whose suffix contains the marker
  // (createSession rejects such suffixes, so no live session channel can
  // contain the marker — plan §14).
  if (uri.lastIndexOf(CHANGASET_MARKER) > 0) return "changeset";
  if (uri.startsWith(SESSION_PREFIX) && uri.length > SESSION_PREFIX.length) return "session";
  if (uri.startsWith(CHAT_PREFIX) && uri.length > CHAT_PREFIX.length) return "chat";
  return "unknown";
}

/** Channel URI of a session. */
export function sessionChannelURI(sessionID: string): string {
  return SESSION_PREFIX + sessionID;
}

/**
 * Channel URI of a session's default chat. The default chat reuses the
 * session's opencode id as its suffix (the single-chat zero-wire-change
 * mapping); peer chats created via `createChat` carry client-chosen
 * suffixes instead (plan §14.13).
 */
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

/**
 * The three changeset kinds this host advertises (plan §11 Phase 2):
 *  - `uncommitted`: working tree vs HEAD (owner: the chat channel);
 *  - `session`: session-wide changes, same approximation (owner: the
 *    session channel — the protocol's "session" changeKind);
 *  - `turn`: the files a single turn captured before its edits
 *    (owner: the chat channel; `turnId` is the AHP turn id).
 */
export type ChangesetKind = "uncommitted" | "session" | "turn";

export interface ParsedChangesetChannel {
  /** The owner session/chat channel URI (valid — see `sessionIDOf`). */
  ownerUri: string;
  /** The owner's opencode session id. */
  sessionID: string;
  kind: ChangesetKind;
  /** Present iff `kind === "turn"`. */
  turnId?: string;
}

/**
 * Parse a changeset channel URI of the shape
 * `<owner session|chat URI>/changeset/{uncommitted|session|turn/<turnId>}`,
 * or null when the URI is not one. `lastIndexOf` splits on the LAST marker,
 * and the owner must classify as a session/chat channel — so a URI whose
 * owner itself contains the marker fails (no live session channel ever
 * contains it: createSession rejects such suffixes).
 */
export function parseChangesetChannel(uri: string): ParsedChangesetChannel | null {
  const index = uri.lastIndexOf(CHANGASET_MARKER);
  if (index <= 0) return null;
  const ownerUri = uri.slice(0, index);
  const sessionID = sessionIDOf(ownerUri);
  if (sessionID === null) return null;
  const rest = uri.slice(index + CHANGASET_MARKER.length);
  if (rest === "uncommitted" || rest === "session") {
    return { ownerUri, sessionID, kind: rest };
  }
  if (rest.startsWith("turn/")) {
    const turnId = rest.slice("turn/".length);
    // Non-empty, no slashes: an AHP turn id (host-minted `turn-…`).
    if (turnId.length > 0 && !turnId.includes("/")) return { ownerUri, sessionID, kind: "turn", turnId };
  }
  return null;
}

/**
 * Changeset URI of one chat's uncommitted (working-tree) changes. The
 * owner is the chat channel itself (multi-chat: every chat has its own
 * uncommitted changeset — plan §14.13).
 */
export function uncommittedChangesetURI(chatChannel: string): string {
  return `${chatChannel}/changeset/uncommitted`;
}

/** Changeset URI of a session's session-wide changes (owner: the session channel). */
export function sessionChangesetURI(sessionChannel: string): string {
  return `${sessionChannel}/changeset/session`;
}

/** Changeset URI of one turn's captured file changes (owner: the chat channel). */
export function turnChangesetURI(chatChannel: string, turnId: string): string {
  return `${chatChannel}/changeset/turn/${turnId}`;
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
      let id: string | null;
      if (kind === "changeset") {
        const parsed = parseChangesetChannel(uri);
        if (parsed === null) return { ok: false, reason: "unknown-uri" };
        id = parsed.sessionID;
      } else {
        id = sessionIDOf(uri);
      }
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
