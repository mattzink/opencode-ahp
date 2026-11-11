/**
 * Free-function helpers for the host section classes — wire normalizers, result mappers, path confinement, AHP-marker parsing, shell exit-code extraction — plus the two tuning constants (AHP metadata key, external-register grace window).
 */

import { resolve as resolvePath } from "node:path";
import { ToolResultContentType, SessionActiveClient, StringOrMarkdown, ToolCallResult, ToolResultContent } from "@microsoft/agent-host-protocol";
import { FacadeClientToolResult, FacadeModelRef, FacadeToolContent } from "./bridge.js";
import { normalizeToolDefinitions } from "./client-tools.js";
import { channelKind } from "./channels.js";
import { isRecord } from "./options.js";

/**
 * Grace before the pump registers an externally created session
 * (`session.created`): a concurrent `createSession` may still be resolving
 * for the same opencode session under a client-chosen channel; the slower
 * path is healed by the delete+recreate remap in `handleCreateSession`.
 */
export const EXTERNAL_REGISTER_GRACE_MS = 250;

/**
 * The exit code of a successful `shell`-tool result, read from its LAST
 * text content part. opencode's shell tool
 * appends a trailing `Exit code: N` notice part only for non-zero exits
 * and signals (`Exit code: 137 (SIGKILL)` — the 128+signum convention
 * parses as the numeric status); a zero exit carries no notice.
 * Spawn failures arrive as `tool.failed` instead (no code available
 * there). `null` when the last part carries an `Exit code:` line with a
 * non-numeric value (e.g. `Exit code: unknown`) — the actions then
 * omit the field.
 */
export function shellExitCodeOf(content: FacadeToolContent[]): number | null {
  const last = content
    .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : null))
    .filter((t): t is string => t !== null)
    .pop();
  if (last === undefined) return 0; // no output, no notice — clean zero exit
  const numeric = /Exit code: (-?\d+)\b/.exec(last);
  if (numeric !== null) return Number.parseInt(numeric[1]!, 10);
  return /Exit code:/.test(last) ? null : 0;
}

/**
 * Durability: the opencode session-metadata key carrying the AHP
 * markers. Two shapes, same key:
 *   - on a peer-chat backend:
 *     `{ chat: <chat channel URI>, owner: <the opencode session id of
 *     the owning AHP session> }` — `owner` is the opencode id, not the
 *     channel suffix (a client-chosen suffix differs from the minted
 *     opencode id);
 *   - on the default backend of a minted-id session:
 *     `{ channel: <session channel URI> }` — the client-chosen session
 *     channel (a "ses" suffix is its own opencode id and needs none).
 * (The keep-alive anchor uses the same key with a STRING value —
 * `parseAhpMarker` ignores non-record markers.)
 */
export const AHP_METADATA_KEY = "opencode-ahp";

/**
 * Parse the AHP markers from an opencode session's durable metadata.
 * Defensive: a malformed shape (missing key, non-record marker — e.g.
 * the keep-alive anchor — or wrong-kind fields) means "no marker" —
 * standalone registration under the opencode id.
 */
export function parseAhpMarker(metadata: unknown): { chat?: string; owner?: string; channel?: string } | null {
  if (!isRecord(metadata)) return null;
  const marker = metadata[AHP_METADATA_KEY];
  if (!isRecord(marker)) return null;
  const out: { chat?: string; owner?: string; channel?: string } = {};
  const chat = marker["chat"];
  if (typeof chat === "string" && channelKind(chat) === "chat") out.chat = chat;
  const owner = marker["owner"];
  if (typeof owner === "string" && owner.startsWith("ses")) out.owner = owner;
  const channel = marker["channel"];
  if (typeof channel === "string" && channelKind(channel) === "session") out.channel = channel;
  return Object.keys(out).length > 0 ? out : null;
}

export function sameAgents(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Short, stable description of untrusted params for log lines. */
export function describeParams(params: unknown): string {
  if (!isRecord(params)) return String(typeof params);
  try {
    const raw = JSON.stringify(Object.keys(params));
    return raw.length > 120 ? raw.slice(0, 120) + "…" : raw;
  } catch {
    return "unserializable";
  }
}

/** The first enabled model of a provider, as a FacadeModelRef. */
export function firstEnabledModelRef(models: readonly { providerID: string; modelID: string; enabled: boolean }[]): FacadeModelRef | undefined {
  const m = models.find((x) => x.enabled);
  return m !== undefined ? { providerID: m.providerID, modelID: m.modelID } : undefined;
}

/** Normalize an untrusted `activeClient` payload (untrusted JSON-RPC). */
export function normalizeActiveClient(ac: Record<string, unknown>): SessionActiveClient {
  return {
    clientId: ac["clientId"] as string,
    tools: normalizeToolDefinitions(ac["tools"]),
    ...(typeof ac["displayName"] === "string" ? { displayName: ac["displayName"] as string } : {}),
  };
}

/**
 * Wire-validate a client-dispatched `toolCallComplete` result:
 * `success` is the one field the host depends on (it decides
 * the facade result + the Tool.Error path); the rest is stored
 * verbatim for the AHP state mirror.
 */
export function normalizeToolCallResult(raw: unknown): ToolCallResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["success"] !== "boolean") return null;
  const pastTense = r["pastTenseMessage"];
  return {
    success: r["success"],
    pastTenseMessage:
      typeof pastTense === "string"
        ? pastTense
        : (isRecord(pastTense) && typeof pastTense["markdown"] === "string"
            ? (pastTense["markdown"] as string)
            : ""),
    ...(Array.isArray(r["content"]) ? { content: r["content"] as ToolResultContent[] } : {}),
    ...(isRecord(r["structuredContent"]) ? { structuredContent: r["structuredContent"] as Record<string, unknown> } : {}),
    ...(isRecord(r["error"]) ? { error: r["error"] as { message: string; code?: string } } : {}),
  };
}

/** StringOrMarkdown → plain string (the facade result carries text). */
function stringOrMarkdownToText(v: StringOrMarkdown | undefined): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  return typeof v.markdown === "string" ? v.markdown : "";
}

/**
 * A validated client `ToolCallResult` → the opencode-side result:
 * success:false → the `Tool.Error` message (the model sees the
 * failure); success → the text content blocks joined (non-text blocks
 * stay in the AHP state for the client's UI; the model gets the text +
 * the past-tense message).
 */
export function clientResultToFacade(result: ToolCallResult): FacadeClientToolResult {
  if (!result.success) {
    return { ok: false, error: result.error?.message ?? "the client reported a tool failure" };
  }
  const texts: string[] = [];
  for (const c of result.content ?? []) {
    // The content came from the wire (untrusted) — guard the shape.
    if (c.type === ToolResultContentType.Text && typeof c.text === "string") texts.push(c.text);
  }
  const content = texts.join("\n\n");
  return {
    ok: true,
    pastTenseMessage: stringOrMarkdownToText(result.pastTenseMessage),
    ...(content.length > 0 ? { content } : {}),
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
  };
}

/**
 * Map opencode tool result content blocks to AHP `ToolResultContent`
 * (only text blocks are representable; file/patch text is
 * carried as text).
 */
export function mapToolResultContent(content: readonly { type: string; text?: string }[]): ToolResultContent[] {
  const out: ToolResultContent[] = [];
  for (const c of content) {
    if (c.type === "text" || c.type === "file" || c.type === "patch") {
      out.push({ type: ToolResultContentType.Text, text: c.text ?? "" });
    }
  }
  return out;
}

/**
 * True when `child` is `parent` itself or strictly inside it (both resolved
 * first, so relative segments and `..` cannot escape the comparison). Used
 * to confine turn-snapshot paths and `resourceRead`/`invokeChangesetOperation`
 * targets to the location directory.
 */
export function isPathInside(child: string, parent: string): boolean {
  const a = resolvePath(child);
  const b = resolvePath(parent);
  return a === b || a.startsWith(b + "/");
}
