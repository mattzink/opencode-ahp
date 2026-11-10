/**
 * Client-provided tools: the pure helpers the host uses for the
 * client-tool surface — wire validation
 * of AHP `ToolDefinition`s, the cross-session definition union the model
 * sees (first-registered wins per name), and the per-session provider
 * lookup used to attribute the tool-call contributor and route execution.
 *
 * Everything here is a pure function over wire-shaped data: no sockets, no
 * opencode, no timers (house pattern — see the other pure modules).
 */
import type { ToolDefinition } from "@microsoft/agent-host-protocol";

/**
 * The per-invocation tracking record the host keeps for a client-executed
 * tool call (keyed by the opencode tool-call id, which the client sees as
 * `toolCallId` on the chat channel).
 *
 * Lifecycle: created at `tool.input.started` (the contributor is known —
 * the session's active client providing the tool), the `result` is set
 * when the execution settles (the client's `toolCallComplete`, the
 * result-confirmation reply, or a disconnect eviction), and the record is
 * removed at the opencode-side terminal (`tool.success`/`tool.failed`),
 * which always follows the settlement (the settlement is what unblocks
 * the opencode tool's `execute`).
 */
export interface ClientToolInvocation {
  /** The active client that provides the tool (the contributor's clientId). */
  clientId: string;
  /** The AHP turn the call belongs to. */
  turnId: string;
  /**
   * The client's `toolCallComplete` result, held while a
   * `requiresResultConfirmation` awaits `toolCallResultConfirmed`.
   */
  pendingResult?: unknown;
  /** The settled execution result (undefined until settled). */
  result?: { ok: true; pastTenseMessage: string; content?: string; structuredContent?: Record<string, unknown> } | { ok: false; error: string };
  /** The opencode-side waiter, or null once it was settled. */
  waiter?: ((result: NonNullable<ClientToolInvocation["result"]>) => void) | null;
}

/**
 * Wire-validate an `activeClient.tools` array: keep the entries that are
 * real `ToolDefinition`s (a non-empty `name` string), drop the rest. The
 * AHP contract makes every other field optional, so no deeper validation
 * is needed — the opencode side only reads `name`/`description`/
 * `inputSchema`, and the AHP state mirror stores the rest verbatim.
 */
export function normalizeToolDefinitions(raw: unknown): ToolDefinition[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolDefinition[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const name = (item as Record<string, unknown>)["name"];
    if (typeof name !== "string" || name.length === 0) continue;
    out.push(item as ToolDefinition);
  }
  return out;
}

/**
 * The cross-session tool union the model sees: first-registered wins per
 * name (iteration order = the caller's session order, which the host
 * fixes to the live-session insertion order — deterministic per host
 * lifetime).
 */
export function toolUnion(clients: ReadonlyArray<{ tools: readonly ToolDefinition[] }>): ToolDefinition[] {
  const seen = new Map<string, ToolDefinition>();
  for (const client of clients) {
    for (const tool of client.tools ?? []) {
      if (typeof tool.name !== "string" || tool.name.length === 0) continue;
      if (!seen.has(tool.name)) seen.set(tool.name, tool);
    }
  }
  return [...seen.values()];
}

/** opencode's `normalizedName` (core `tool/runtime.ts`) — the tool id. */
export function normalizedName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * The active client providing `toolName` for a session (the contributor's
 * clientId), or null. Matches on the raw name or on the opencode-
 * normalized name (a tool named "my tool" registers under `my_tool`, so
 * the pump's event name and the wire name can differ only by that
 * sanitization).
 */
export function findProvider(
  clients: ReadonlyArray<{ clientId: string; tools: readonly ToolDefinition[] }>,
  toolName: string,
): string | null {
  if (typeof toolName !== "string" || toolName.length === 0) return null;
  const needle = normalizedName(toolName);
  for (const client of clients) {
    for (const tool of client.tools ?? []) {
      if (tool.name === toolName || normalizedName(tool.name) === needle) return client.clientId;
    }
  }
  return null;
}

/**
 * The input JSON Schema for an opencode tool registration: the client's
 * `inputSchema` verbatim when present (it is a JSON Schema — opencode's
 * `inputJsonSchema` passes raw schemas through untouched), otherwise the
 * lenient "any object" schema.
 */
export function inputSchemaFor(tool: ToolDefinition): Record<string, unknown> {
  const s = tool.inputSchema;
  if (
    typeof s === "object" &&
    s !== null &&
    (s as Record<string, unknown>)["type"] === "object"
  ) {
    return s as Record<string, unknown>;
  }
  return { type: "object" };
}

/** The description an opencode tool registration carries for a client tool. */
export function descriptionFor(tool: ToolDefinition): string {
  if (typeof tool.description === "string" && tool.description.length > 0) return tool.description;
  if (typeof tool.title === "string" && tool.title.length > 0) return tool.title;
  return tool.name;
}
