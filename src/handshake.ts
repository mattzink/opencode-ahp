/**
 * AHP 1.0.0 handshake (plan §6.1 handshake.ts): the `initialize` command
 * — semver capability negotiation via the official package's
 * `negotiateProtocolVersion`.
 *
 * Version semantics (AHP versioning spec): the server picks the highest
 * client-offered version inside its supported caret baselines and echoes
 * that exact string back. The package we pin (1.0.0) supports the 1.0.0
 * and 0.9.0 baselines, so a client offering any 1.x (or 0.9.x) version
 * negotiates the 1.0 wire protocol; anything else gets -32005 with the
 * `supportedVersions` data.
 */
import {
  negotiateProtocolVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
  type Implementation,
  type InitializeResult,
  type Snapshot,
} from "@microsoft/agent-host-protocol";
import { ROOT_CHANNEL } from "./channels.js";
import { isRecord } from "./options.js";

export const ERROR_INVALID_PARAMS = -32602;
export const ERROR_UNSUPPORTED_PROTOCOL_VERSION = -32005;

export interface HandshakeError {
  code: number;
  message: string;
  /** Required on -32005 (UnsupportedProtocolVersionErrorData). */
  data?: { supportedVersions: string[] };
}

export interface InitializeRequest {
  params: unknown;
  serverInfo: Implementation;
  /** Current global serverSeq (stamped onto the result). */
  serverSeq: number;
  /** The opencode instance's working directory, when known. */
  defaultDirectory?: string;
  /**
   * Resolve a snapshot for an `initialSubscriptions` entry; null when the
   * channel is not subscribable (it is simply omitted from the result).
   */
  snapshotFor: (uri: string) => Snapshot | null | Promise<Snapshot | null>;
}

export type InitializeOutcome =
  | { ok: true; result: InitializeResult }
  | { ok: false; error: HandshakeError };

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export async function handleInitialize(req: InitializeRequest): Promise<InitializeOutcome> {
  const params = req.params;
  if (!isRecord(params)) {
    return { ok: false, error: { code: ERROR_INVALID_PARAMS, message: "params must be an object" } };
  }
  if (params["channel"] !== ROOT_CHANNEL) {
    return {
      ok: false,
      error: { code: ERROR_INVALID_PARAMS, message: `initialize must target ${ROOT_CHANNEL}` },
    };
  }
  if (!isNonEmptyString(params["clientId"])) {
    return {
      ok: false,
      error: { code: ERROR_INVALID_PARAMS, message: "clientId must be a non-empty string" },
    };
  }
  const offered = params["protocolVersions"];
  if (!Array.isArray(offered) || offered.length === 0 || !offered.every(isNonEmptyString)) {
    return {
      ok: false,
      error: {
        code: ERROR_INVALID_PARAMS,
        message: "protocolVersions must be a non-empty array of SemVer strings",
      },
    };
  }

  let version: string | undefined;
  try {
    version = negotiateProtocolVersion(offered);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: ERROR_INVALID_PARAMS,
        message: `invalid protocol version: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  if (version === undefined) {
    return {
      ok: false,
      error: {
        code: ERROR_UNSUPPORTED_PROTOCOL_VERSION,
        message: "unsupported protocol version",
        data: { supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS] },
      },
    };
  }

  const initial = Array.isArray(params["initialSubscriptions"])
    ? params["initialSubscriptions"]
    : [];
  const snapshots: Snapshot[] = [];
  for (const uri of initial) {
    if (!isNonEmptyString(uri)) continue;
    const snap = await req.snapshotFor(uri);
    if (snap) snapshots.push(snap);
  }

  return {
    ok: true,
    result: {
      protocolVersion: version,
      serverSeq: req.serverSeq,
      serverInfo: req.serverInfo,
      snapshots,
      ...(req.defaultDirectory ? { defaultDirectory: req.defaultDirectory } : {}),
    },
  };
}
