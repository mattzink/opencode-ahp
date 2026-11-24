/**
 * Host tests — the base surface: `initialize` (handshake/catalog
 * regression through the host: version negotiation, defaultDirectory,
 * the root snapshot).
 */
import { describe, expect, it } from "vitest";
import { type AgentCustomization } from "@microsoft/agent-host-protocol";
import { ROOT_CHANNEL } from "../channels.js";
import { waitFor, makeHarness, waitInit } from "./host-fakes.js";

// ── handshake / catalog (regression through the host) ─────────────

describe("initialize", () => {
  it("negotiates 1.0.0, reports defaultDirectory, and snapshots the root catalog", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    const result = await waitInit(h, 1);
    expect(result.protocolVersion).toBe("1.0.0");
    expect(result.serverInfo).toEqual({ name: "opencode-ahp-test", version: "0.1.0" });
    expect(result.defaultDirectory).toBe("file:///tmp/opencode/ahp-scratch/project-lan/");
    const root = result.snapshots.find((s: Record<string, any>) => s.resource === ROOT_CHANNEL);
    expect(root).toBeDefined();
    const gpuz = root.state.agents.find((a: Record<string, any>) => a.provider === "gpuz");
    expect(gpuz.models).toHaveLength(1);
    expect(gpuz.customizations).toHaveLength(1);
    const children = gpuz.customizations[0].children as AgentCustomization[];
    expect(children.map((c: AgentCustomization) => c.name)).toEqual(["Build", "Plan", "Explore"]);
    h.stop();
  });

  it("answers ping before initialize", async () => {
    const h = makeHarness();
    h.host.onOpen(1);
    h.send(1, "ping", {}, 7);
    await waitFor(() => h.frames.some((f) => f.message.id === 7), "ping response");
    expect(h.frames.find((f) => f.message.id === 7)!.message.result).toBeNull();
    h.stop();
  });
});
