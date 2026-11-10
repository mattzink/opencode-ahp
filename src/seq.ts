/**
 * Global action sequencer + replay window.
 *
 * AHP 1.0.0's `serverSeq` is a single host-wide sequence across all
 * channels (not per-channel) — the spec's lifecycle example numbers a
 * chat action 43 while a root snapshot is taken at 42. Consequences:
 *  - snapshots carry `fromSeq` = the current global seq;
 *  - reconnect replay is a *global* range (serverSeq > lastSeen) filtered
 *    by the client's subscriptions;
 *  - the replay window bounds the global buffer, not per-channel ones.
 */
import type {
  ActionEnvelope,
  ActionOrigin,
  StateAction,
  URI,
} from "@microsoft/agent-host-protocol";

export const DEFAULT_REPLAY_WINDOW = 1000;

/** A published action before the sequencer stamps it. */
export interface ActionDraft {
  channel: URI;
  action: StateAction;
  /** Present when the action came from a client dispatch (echo origin). */
  origin?: ActionOrigin;
  /** Present when the host rejected a client-dispatched action. */
  rejectionReason?: string;
}

export class Sequencer {
  private readonly size: number;
  private current = 0;
  private readonly buffer: ActionEnvelope[] = [];

  constructor(size: number = DEFAULT_REPLAY_WINDOW) {
    if (!Number.isInteger(size) || size <= 0) {
      throw new Error(`replayWindow must be a positive integer, got ${String(size)}`);
    }
    this.size = size;
  }

  /** Current (last assigned) global sequence number. 0 before any action. */
  get seq(): number {
    return this.current;
  }

  /** Oldest seq still held in the replay window (seq + 1 when empty). */
  get oldest(): number {
    return this.buffer.length > 0 ? this.buffer[0]!.serverSeq : this.current + 1;
  }

  /**
   * Assign the next global sequence number and retain the envelope for
   * replay. Returns the completed envelope.
   */
  publish(draft: ActionDraft): ActionEnvelope {
    const envelope: ActionEnvelope = {
      channel: draft.channel,
      action: draft.action,
      serverSeq: ++this.current,
      origin: draft.origin,
      ...(draft.rejectionReason !== undefined
        ? { rejectionReason: draft.rejectionReason }
        : {}),
    };
    this.buffer.push(envelope);
    if (this.buffer.length > this.size) this.buffer.shift();
    return envelope;
  }

  /**
   * All envelopes with serverSeq > since, in order. Null when the range
   * has been evicted from the replay window (the caller falls back to a
   * fresh snapshot).
   */
  since(since: number): ActionEnvelope[] | null {
    const s = Math.max(0, since);
    // The range (s, current] is replayable when it starts at or after the
    // envelope *before* the window's oldest — a client at lastSeen =
    // oldest - 1 has seen nothing that was evicted.
    if (this.buffer.length > 0 && s + 1 < this.buffer[0]!.serverSeq) return null;
    if (s >= this.current) return [];
    return this.buffer.filter((e) => e.serverSeq > s);
  }
}
