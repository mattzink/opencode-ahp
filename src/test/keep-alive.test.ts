import { describe, expect, it, vi } from "vitest";
import { KeepAlive, type KeepAliveDeps } from "../keep-alive.js";

interface Harness {
  ka: KeepAlive;
  ensureSession: ReturnType<typeof vi.fn>;
  touch: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  scheduled: { fn: () => void; ms: number }[];
  unscheduled: unknown[];
}

/** KeepAlive with an injected (capturing) timer — no real interval in tests. */
function make(overrides: Partial<KeepAliveDeps> = {}): Harness {
  const scheduled: { fn: () => void; ms: number }[] = [];
  const unscheduled: unknown[] = [];
  // The returned mocks are the effective deps (overrides included), so
  // assertions observe exactly what the KeepAlive used.
  const deps: KeepAliveDeps = {
    ensureSession: vi.fn().mockResolvedValue(undefined),
    touch: vi.fn().mockResolvedValue(undefined),
    intervalMs: 600_000,
    log: vi.fn(),
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
      return scheduled.length;
    },
    unschedule: (h) => {
      unscheduled.push(h);
    },
    ...overrides,
  };
  const ka = new KeepAlive(deps);
  return {
    ka,
    ensureSession: deps.ensureSession as ReturnType<typeof vi.fn>,
    touch: deps.touch as ReturnType<typeof vi.fn>,
    log: deps.log as ReturnType<typeof vi.fn>,
    scheduled,
    unscheduled,
  };
}

describe("KeepAlive.start", () => {
  it("ensures the anchor session and starts ticking at the configured interval", async () => {
    const h = make({ intervalMs: 600_000 });
    await expect(h.ka.start()).resolves.toBe(true);
    expect(h.ensureSession).toHaveBeenCalledTimes(1);
    expect(h.scheduled).toHaveLength(1);
    expect(h.scheduled[0]?.ms).toBe(600_000);
  });

  it("stays off (logged, no tick) when the anchor session cannot be prepared", async () => {
    const h = make({ ensureSession: vi.fn().mockRejectedValue(new Error("db down")) });
    await expect(h.ka.start()).resolves.toBe(false);
    expect(h.log).toHaveBeenCalledWith(
      expect.stringContaining("anchor session (db down)"),
    );
    expect(h.scheduled).toHaveLength(0);
    await h.ka.tick();
    expect(h.touch).not.toHaveBeenCalled();
  });

  it("startTicking is idempotent", async () => {
    const h = make();
    await h.ka.start();
    h.ka.startTicking();
    h.ka.startTicking();
    expect(h.scheduled).toHaveLength(1);
  });
});

describe("KeepAlive.tick", () => {
  it("touches the anchor session once per tick", async () => {
    const h = make();
    await h.ka.start();
    await h.ka.tick();
    expect(h.touch).toHaveBeenCalledTimes(1);
    await h.ka.tick();
    expect(h.touch).toHaveBeenCalledTimes(2);
  });

  it("coalesces overlapping ticks (no concurrent touch)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = make({ touch: vi.fn().mockReturnValue(gate) });
    await h.ka.start();
    const first = h.ka.tick();
    const second = h.ka.tick();
    release();
    await Promise.all([first, second]);
    expect(h.touch).toHaveBeenCalledTimes(1);
  });

  it("is a no-op before start and after stop", async () => {
    const h = make();
    await h.ka.tick();
    expect(h.touch).not.toHaveBeenCalled();
    await h.ka.start();
    h.ka.stop();
    await h.ka.tick();
    expect(h.touch).not.toHaveBeenCalled();
  });

  it("a failed touch logs and the next tick retries", async () => {
    const h = make({
      touch: vi
        .fn()
        .mockRejectedValueOnce(new Error("busy"))
        .mockResolvedValueOnce(undefined),
    });
    await h.ka.start();
    await h.ka.tick();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("touch failed (busy)"));
    await h.ka.tick();
    expect(h.touch).toHaveBeenCalledTimes(2);
  });

  it("the scheduled callback drives ticks", async () => {
    const h = make();
    await h.ka.start();
    h.scheduled[0]?.fn();
    await new Promise((r) => setTimeout(r, 0)); // let the voided tick settle
    expect(h.touch).toHaveBeenCalledTimes(1);
  });
});

describe("KeepAlive.stop", () => {
  it("unschedules the timer; a second stop is a no-op", async () => {
    const h = make();
    await h.ka.start();
    h.ka.stop();
    expect(h.unscheduled).toEqual([1]);
    h.ka.stop();
    expect(h.unscheduled).toEqual([1]);
  });
});
