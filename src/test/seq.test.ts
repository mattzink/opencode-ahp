import { describe, expect, it } from "vitest";
import { ActionType } from "@microsoft/agent-host-protocol";
import { Sequencer, type ActionDraft } from "../seq.js";

const draft = (n: number): ActionDraft => ({
  channel: "ahp-root://",
  action: { type: ActionType.RootAgentsChanged, agents: [] },
});

describe("Sequencer", () => {
  it("starts at 0 with no envelopes", () => {
    const s = new Sequencer(10);
    expect(s.seq).toBe(0);
    expect(s.oldest).toBe(1);
    expect(s.since(0)).toEqual([]);
  });

  it("assigns strictly increasing global seqs", () => {
    const s = new Sequencer(10);
    const envs = [1, 2, 3].map((n) => s.publish(draft(n)));
    expect(envs.map((e) => e.serverSeq)).toEqual([1, 2, 3]);
    expect(s.seq).toBe(3);
  });

  it("since(s) returns envelopes with serverSeq > s, in order", () => {
    const s = new Sequencer(10);
    for (let i = 0; i < 5; i++) s.publish(draft(i));
    expect(s.since(0)!.map((e) => e.serverSeq)).toEqual([1, 2, 3, 4, 5]);
    expect(s.since(2)!.map((e) => e.serverSeq)).toEqual([3, 4, 5]);
    expect(s.since(4)!.map((e) => e.serverSeq)).toEqual([5]);
    expect(s.since(5)).toEqual([]);
    expect(s.since(100)).toEqual([]);
  });

  it("clamps a negative since to 0", () => {
    const s = new Sequencer(10);
    s.publish(draft(0));
    expect(s.since(-5)!.map((e) => e.serverSeq)).toEqual([1]);
  });

  it("bounds the replay window: evicted ranges are null (snapshot fallback)", () => {
    const s = new Sequencer(3);
    for (let i = 0; i < 5; i++) s.publish(draft(i));
    // buffer holds 3,4,5
    expect(s.seq).toBe(5);
    expect(s.oldest).toBe(3);
    expect(s.since(2)!.map((e) => e.serverSeq)).toEqual([3, 4, 5]);
    expect(s.since(1)).toBeNull(); // gap before the window
    expect(s.since(-1)).toBeNull(); // clamped to 0, still before the window
  });

  it("stamps origin and rejectionReason when present", () => {
    const s = new Sequencer(10);
    const a = s.publish({
      ...draft(0),
      origin: { clientId: "c1", clientSeq: 9 },
      rejectionReason: "unsupported action (Phase 0)",
    });
    expect(a.origin).toEqual({ clientId: "c1", clientSeq: 9 });
    expect(a.rejectionReason).toBe("unsupported action (Phase 0)");
    const b = s.publish(draft(1));
    expect(b.origin).toBeUndefined();
    expect(b.rejectionReason).toBeUndefined();
  });

  it("rejects an invalid window size", () => {
    expect(() => new Sequencer(0)).toThrow();
    expect(() => new Sequencer(-1)).toThrow();
    expect(() => new Sequencer(1.5)).toThrow();
  });
});
