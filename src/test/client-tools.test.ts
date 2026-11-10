/**
 * Client-tools pure helper tests:
 * wire validation of AHP `ToolDefinition`s, the cross-session union
 * (first-registered wins per name), the per-session provider lookup,
 * and the opencode-registration field derivation.
 */
import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@microsoft/agent-host-protocol";
import {
  descriptionFor,
  findProvider,
  inputSchemaFor,
  normalizeToolDefinitions,
  normalizedName,
  toolUnion,
} from "../client-tools.js";

const tool = (name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name,
  ...extra,
});

describe("normalizeToolDefinitions", () => {
  it("keeps real ToolDefinitions and drops malformed entries", () => {
    const good = tool("ping", { description: "Pong" });
    const out = normalizeToolDefinitions([
      good,
      { name: "" },
      { name: 42 },
      { title: "no name" },
      null,
      7,
      "ping",
    ]);
    expect(out).toEqual([good]);
  });

  it("returns [] for non-array input", () => {
    expect(normalizeToolDefinitions(undefined)).toEqual([]);
    expect(normalizeToolDefinitions({ tools: [] })).toEqual([]);
    expect(normalizeToolDefinitions("nope")).toEqual([]);
  });
});

describe("toolUnion", () => {
  it("unions across clients, first-registered wins per raw name", () => {
    const a = tool("ping", { description: "from A" });
    const b = tool("ping", { description: "from B" });
    const c = tool("pong");
    const out = toolUnion([{ tools: [a, c] }, { tools: [b] }]);
    expect(out).toEqual([a, c]);
  });

  it("skips entries without a usable name", () => {
    const out = toolUnion([{ tools: [tool("x"), { name: "" } as ToolDefinition] }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("x");
  });

  it("is empty when no client provides tools", () => {
    expect(toolUnion([])).toEqual([]);
    expect(toolUnion([{ tools: [] }])).toEqual([]);
  });
});

describe("normalizedName", () => {
  it("sanitizes like opencode's tool id derivation", () => {
    expect(normalizedName("my tool")).toBe("my_tool");
    expect(normalizedName("a.b/c:d")).toBe("a_b_c_d");
    expect(normalizedName("keeps-already_fine")).toBe("keeps-already_fine");
  });
});

describe("findProvider", () => {
  const clients = [
    { clientId: "c1", tools: [tool("my tool"), tool("exact")] },
    { clientId: "c2", tools: [tool("other")] },
  ];

  it("matches on the raw name", () => {
    expect(findProvider(clients, "my tool")).toBe("c1");
    expect(findProvider(clients, "other")).toBe("c2");
    expect(findProvider(clients, "exact")).toBe("c1");
  });

  it("matches on the normalized name (event names can differ by sanitization)", () => {
    expect(findProvider(clients, "my_tool")).toBe("c1");
  });

  it("is null for unknown tools and empty input", () => {
    expect(findProvider(clients, "unknown")).toBeNull();
    expect(findProvider(clients, "")).toBeNull();
    expect(findProvider([], "my tool")).toBeNull();
  });
});

describe("inputSchemaFor", () => {
  it("passes a present object schema through verbatim", () => {
    const schema = { type: "object" as const, properties: { x: { type: "string" } }, required: ["x"] };
    expect(inputSchemaFor(tool("t", { inputSchema: schema }))).toBe(schema);
  });

  it("falls back to {type:object} when absent or not an object schema", () => {
    expect(inputSchemaFor(tool("t"))).toEqual({ type: "object" });
    expect(inputSchemaFor(tool("t", { inputSchema: { type: "string" } as never }))).toEqual({ type: "object" });
    expect(inputSchemaFor(tool("t", { inputSchema: { properties: {} } as never }))).toEqual({ type: "object" });
  });
});

describe("descriptionFor", () => {
  it("prefers description, then title, then the name", () => {
    expect(descriptionFor(tool("t", { description: "does things", title: "T" }))).toBe("does things");
    expect(descriptionFor(tool("t", { title: "T" }))).toBe("T");
    expect(descriptionFor(tool("t"))).toBe("t");
    expect(descriptionFor(tool("t", { description: "" }))).toBe("t");
  });
});
