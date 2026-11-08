/**
 * Location keep-alive (plan §15).
 *
 * opencode v2 unloads idle locations after `experimental.location_idle_timeout`
 * (default 60 minutes). `LocationActivity` (packages/core/src/location-activity.ts)
 * "touches" a location on every **durable** session event and evicts it on a
 * one-minute sweep only when it is past its TTL, unoccupied, and unretained.
 * `Session.setMetadata` publishes the durable `session.metadata.updated` event
 * unconditionally, so periodically updating the metadata of a dedicated anchor
 * session keeps the location — and with it the AHP listener — loaded without
 * any user config (`location_idle_timeout: false` is no longer required).
 *
 * The anchor session is visible in the opencode TUI session list (the plugin
 * surface cannot archive it — plan §15); the AHP host filters it out by its
 * deterministic ID from every client-facing surface.
 *
 * Cold boot is an architectural limit, not a keep-alive problem: plugins load
 * per location (`Node.makeLocationNode`) and cannot run before the location
 * boots, and no config boots a location at server start. The anchor session's
 * first touch therefore only helps once the location is up — the one-time boot
 * step stays (README "Remote access").
 *
 * Pure module: session access and the timer are dependency-injected, so this
 * is unit-tested without an OpenCode runtime (house pattern).
 */

import { errorMessage } from "./error.js";

/**
 * Deterministic anchor-session ID. Valid per the `Session.ID` schema (any
 * `ses`-prefixed string); deterministic so reloads reuse the same session
 * instead of accumulating one per boot cycle, and so the AHP facade can
 * filter it by a constant (no metadata reads, no list scans).
 */
export const KEEPALIVE_SESSION_ID = "ses_ahp_keepalive";

export interface KeepAliveDeps {
  /**
   * Get-or-create the anchor session. Resolves when the session is usable;
   * rejects (→ keep-alive stays off, logged) when it is not.
   */
  readonly ensureSession: () => Promise<void>;
  /** One durable touch of the anchor session (`session.metadata.updated`). */
  readonly touch: () => Promise<void>;
  /**
   * Interval between touches in ms. Must be well below the effective
   * `location_idle_timeout` (default 60 minutes) — the default 10 minutes
   * leaves sixfold headroom.
   */
  readonly intervalMs: number;
  readonly log: (msg: string) => void;
  /** Injectable for tests; defaults to `setInterval`. */
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  /** Injectable for tests; defaults to `clearInterval`. */
  readonly unschedule?: (handle: unknown) => void;
}

/**
 * Periodic durable touch of the anchor session. Every failure path logs and
 * stays up (R2): a failing touch retries on the next tick, a failing anchor
 * setup leaves the keep-alive off (opencode's idle timeout applies as before).
 */
export class KeepAlive {
  private timer: unknown = null;
  private inFlight = false;
  private stopped = false;
  private ready = false;

  constructor(private readonly deps: KeepAliveDeps) {}

  /**
   * Ensures the anchor session and starts ticking. Never throws.
   * @returns true when the keep-alive is active.
   */
  async start(): Promise<boolean> {
    try {
      await this.deps.ensureSession();
    } catch (e) {
      this.deps.log(
        `keep-alive could not prepare its anchor session (${errorMessage(e)}); ` +
          `opencode's idle timeout applies (experimental.location_idle_timeout)`,
      );
      return false;
    }
    this.ready = true;
    this.startTicking();
    this.deps.log(
      `keep-alive active: the anchor session is touched every ${Math.round(this.deps.intervalMs / 60_000)} min, ` +
        `holding the location against the idle timeout`,
    );
    return true;
  }

  /** Starts the periodic touch. Idempotent; a no-op before a ready session. */
  startTicking(): void {
    if (!this.ready || this.timer !== null || this.stopped) return;
    const schedule = this.deps.schedule ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    this.timer = schedule(() => {
      void this.tick();
    }, this.deps.intervalMs);
  }

  /** One touch. Guarded against overlap; never throws. */
  async tick(): Promise<void> {
    if (!this.ready || this.stopped || this.inFlight) return;
    this.inFlight = true;
    try {
      await this.deps.touch();
    } catch (e) {
      this.deps.log(`keep-alive touch failed (${errorMessage(e)}); retrying on the next tick`);
    } finally {
      this.inFlight = false;
    }
  }

  /** Stops the periodic touch (location teardown). Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      const unschedule = this.deps.unschedule ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
      unschedule(this.timer);
      this.timer = null;
    }
  }
}
