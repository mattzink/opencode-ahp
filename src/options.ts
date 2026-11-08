/**
 * Plugin option resolution (plan §8.2): ctx.options ▸ options.jsonc
 * sibling file ▸ built-in defaults.
 *
 * Resolution is per top-level key (shallow): a key's value comes from
 * the highest-priority source that provides a valid value for it. Invalid
 * values fall back to the next source (no throw), except a malformed JSONC
 * file, which throws so the caller can log and re-resolve without it.
 * `capabilities` merges per leaf (ctx ▸ file ▸ built-in per key) so a
 * partial user entry does not clobber the other flags.
 */

export interface TlsOptions {
  keyPath: string;
  certPath: string;
}

/** What `initialize` advertises — never advertise what we don't implement. */
export interface CapabilityFlags {
  changesets: boolean;
  terminals: boolean;
  automations: boolean;
}

export interface Options {
  /** Master switch; false → no listener, the plugin is fully inert. */
  enabled: boolean;
  /** WS listen port. */
  port: number;
  /** Bind address; a non-loopback bind requires a token (R4). */
  host: string;
  /** WS path — VS Code's remoteAgentHosts URL carries it verbatim. */
  path: string;
  /** Auth token; null → auto-generate on first start and persist it. */
  token: string | null;
  /** Origin allowlist; the token is always required regardless (R5). */
  allowedOrigins: string[] | "*";
  /** Native TLS via Bun.serve (post-MVP; off-LAN transports only, D3). */
  tls: TlsOptions | null;
  /** Plain-HTTP health endpoint (no auth). */
  healthPath: string;
  /**
   * Keep the opencode location loaded against the idle timeout (default
   * `experimental.location_idle_timeout`, 60 minutes) via a periodic durable
   * touch of an internal anchor session (plan §15). With this on, the
   * `location_idle_timeout: false` config entry is not needed. The anchor
   * shows in the TUI session list as "opencode-ahp (keep-alive)"; AHP
   * clients never see it.
   */
  keepAlive: boolean;
  /**
   * Minutes between keep-alive touches; must be well below the effective
   * idle timeout. 10 leaves sixfold headroom under the 60-minute default.
   */
  keepAliveIntervalMinutes: number;
  /** Global actions kept for reconnect replay; older gaps → snapshot. */
  replayWindow: number;
  /** Advertised in `initialize` (plan §8.2). */
  capabilities: CapabilityFlags;
}

export const BUILTIN_OPTIONS: Options = {
  enabled: true,
  port: 8765,
  host: "127.0.0.1",
  path: "/ahp",
  token: null,
  allowedOrigins: "*",
  tls: null,
  healthPath: "/healthz",
  keepAlive: true,
  keepAliveIntervalMinutes: 10,
  replayWindow: 1000,
  capabilities: { changesets: false, terminals: false, automations: false },
};

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isPosInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;
const isHttpPort = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 65535;
/** Absolute URL path: "/ahp" ok; "/", "", "ahp", "/ahp/" rejected. */
const isUrlPath = (v: unknown): v is string =>
  typeof v === "string" && v.startsWith("/") && v.length > 1 && !v.endsWith("/");
const isNonEmptyStrArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.length > 0);

function validateAllowedOrigins(v: unknown): string[] | "*" | null {
  if (v === "*") return "*";
  if (isNonEmptyStrArray(v)) return [...v];
  return null;
}

function validateTls(v: unknown): TlsOptions | null {
  if (!isRecord(v) || !isString(v["keyPath"]) || !isString(v["certPath"])) return null;
  return { keyPath: v["keyPath"], certPath: v["certPath"] };
}

/** Per-leaf merge of the capability flags: ctx ▸ file ▸ built-in per key. */
function resolveCapabilities(
  fileV: unknown,
  ctxV: unknown,
): CapabilityFlags {
  const out: CapabilityFlags = { ...BUILTIN_OPTIONS.capabilities };
  for (const key of ["changesets", "terminals", "automations"] as const) {
    const cv = isRecord(ctxV) ? ctxV[key] : undefined;
    if (isBool(cv)) {
      out[key] = cv;
      continue;
    }
    const fv = isRecord(fileV) ? fileV[key] : undefined;
    if (isBool(fv)) out[key] = fv;
  }
  return out;
}

/**
 * Tiny JSONC stripper: removes // and block comments (string-aware) and
 * trailing commas before } / ]. No dependency; sufficient for a
 * hand-written options file. (House pattern, copied from llama-sync.)
 */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const n = text[i + 1];
    if (lineComment) {
      if (c === "\n") {
        lineComment = false;
        out += c;
      }
      continue;
    }
    if (blockComment) {
      if (c === "*" && n === "/") {
        blockComment = false;
        i++;
      } else if (c === "\n") {
        out += c;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        if (i + 1 < text.length) {
          out += n!;
          i++;
        }
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      blockComment = true;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * @param ctxOptions options object from the object-form `plugins` entry
 * @param fileText raw text of the `options.jsonc` sibling of src/index.ts,
 *   or null when the file is absent. Throws on malformed JSONC.
 */
export function resolveOptions(
  ctxOptions: Readonly<Record<string, unknown>> | null | undefined,
  fileText: string | null | undefined,
): Options {
  let file: Record<string, unknown> = {};
  if (fileText != null && fileText.trim() !== "") {
    const parsed: unknown = JSON.parse(stripJsonc(fileText));
    if (!isRecord(parsed)) throw new Error("options file must contain a JSON object");
    file = parsed;
  }
  const ctx = isRecord(ctxOptions) ? ctxOptions : {};
  const pick = <T>(key: string, valid: (v: unknown) => v is T, fallback: T): T => {
    const cv = ctx[key];
    if (cv !== undefined && valid(cv)) return cv;
    const fv = file[key];
    if (fv !== undefined && valid(fv)) return fv;
    return fallback;
  };
  const pickNullable = <T>(
    key: string,
    valid: (v: unknown) => T | null,
    fallback: T | null,
  ): T | null => {
    const cv = ctx[key];
    if (cv !== undefined) {
      const r = valid(cv);
      if (r !== null) return r;
    }
    const fv = file[key];
    if (fv !== undefined) {
      const r = valid(fv);
      if (r !== null) return r;
    }
    return fallback;
  };

  return {
    enabled: pick("enabled", isBool, BUILTIN_OPTIONS.enabled),
    port: pick("port", isHttpPort, BUILTIN_OPTIONS.port),
    host: pick("host", isString, BUILTIN_OPTIONS.host),
    path: pick("path", isUrlPath, BUILTIN_OPTIONS.path),
    token: pickNullable(
      "token",
      (v): string | null => (isString(v) ? v : null),
      BUILTIN_OPTIONS.token,
    ),
    // Non-nullable in Options. pickNullable is typed `T | null` for the
    // nullable keys; here the fallback (the built-in) is never null, so the
    // branch below is unreachable and only exists to narrow the type.
    allowedOrigins:
      pickNullable("allowedOrigins", validateAllowedOrigins, BUILTIN_OPTIONS.allowedOrigins) ??
      BUILTIN_OPTIONS.allowedOrigins,
    tls: pickNullable("tls", validateTls, BUILTIN_OPTIONS.tls),
    healthPath: pick("healthPath", isUrlPath, BUILTIN_OPTIONS.healthPath),
    keepAlive: pick("keepAlive", isBool, BUILTIN_OPTIONS.keepAlive),
    keepAliveIntervalMinutes: pick(
      "keepAliveIntervalMinutes",
      isPosInt,
      BUILTIN_OPTIONS.keepAliveIntervalMinutes,
    ),
    replayWindow: pick("replayWindow", isPosInt, BUILTIN_OPTIONS.replayWindow),
    capabilities: resolveCapabilities(file["capabilities"], ctx["capabilities"]),
  };
}
