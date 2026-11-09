/**
 * AHP transport (plan §6.1 transport.ts).
 *
 * Two layers:
 *
 *  1. **Pure policy functions** — token extraction/comparison, Origin
 *     policy, path routing, loopback check. Unit-tested without a runtime.
 *  2. **A thin listener** behind the `Listener` interface. The reference
 *     implementation uses `Bun.serve` (opencode v2 is Bun-based, so the
 *     in-process plugin runtime has it — verified by the Phase 0 spike,
 *     R6). If the plugin context ever forbids raw listeners, a `ws`-
 *     package implementation drops in here with no changes to the
 *     protocol layer.
 *
 * Authentication happens at the WebSocket **upgrade** (AHP transport
 * spec), not after it: a missing/invalid token or a disallowed Origin
 * never gets a socket. `?token=` query param first, then
 * `Authorization: Bearer <token>`.
 */

// ── pure policy ──────────────────────────────────────────────────────────

/** True for addresses that only reach this machine (127.0.0.0/8, ::1, localhost). */
export function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) return m[1] === "127";
  return false;
}

/**
 * The one header the token policy reads. A plain object so it is
 * unit-testable; HTTP header names are case-insensitive, so both casings
 * of `authorization` are accepted (the transport layer passes Bun's
 * `Headers.get("authorization")`, which already lowercases).
 */
export interface AuthorizationHeaders {
  authorization?: string | null;
  Authorization?: string | null;
}

/**
 * Extract the presented token: `?token=` query param first, then
 * `Authorization: Bearer <token>`. Null when neither carries a value.
 */
export function extractToken(url: URL, headers: AuthorizationHeaders | null | undefined): string | null {
  const q = url.searchParams.get("token");
  if (q) return q;
  const auth = headers?.authorization ?? headers?.Authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1];
  }
  return null;
}

/**
 * Constant-time token comparison (no early exit on the first differing
 * byte). A null or empty presentation is never valid.
 */
export function tokenValid(expected: string, presented: string | null): boolean {
  if (expected.length === 0 || presented === null) return false;
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(presented);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Origin policy (plan R5). The token is the only credential; this only
 * filters *which* browser origins may attempt a connection. A null Origin
 * (non-browser clients: VS Code's own connection, CLI clients) always
 * passes — browser-origin filtering is the real attack surface.
 */
export function originAllowed(
  allowed: string[] | "*",
  origin: string | null | undefined,
): boolean {
  if (origin === null || origin === undefined) return true;
  if (allowed === "*") return true;
  return allowed.includes(origin);
}

export type Route = "ahp" | "health" | "other";

/** Route an HTTP request against the AHP path and the health path. */
export function routePath(url: URL, paths: { ahp: string; health: string }): Route {
  if (url.pathname === paths.health) return "health";
  if (url.pathname === paths.ahp) return "ahp";
  return "other";
}

// ── listener ─────────────────────────────────────────────────────────────

export interface ListenerOptions {
  host: string;
  port: number;
  path: string;
  healthPath: string;
  /** When null, a non-loopback bind refuses to start (R4). */
  token: string | null;
  allowedOrigins: string[] | "*";
  /**
   * Native TLS termination → `wss://` (off-LAN transports, D3). The PEM
   * **contents** of the key and certificate — not paths: `Bun.serve`'s
   * `tls.key`/`tls.cert` take contents (string/Buffer/BunFile), and the
   * plugin entry reads the files (the transport stays filesystem-free so
   * its unit tests never touch the disk).
   */
  tls?: { key: string; cert: string } | null;
}

/** Transport-local connection identity. */
export interface ConnectionInfo {
  readonly id: number;
}

export interface TransportCallbacks {
  onOpen(info: ConnectionInfo): void;
  /** Text frames only; binary frames are decoded as UTF-8. */
  onMessage(info: ConnectionInfo, text: string): void;
  onClose(info: ConnectionInfo): void;
}

export interface Listener {
  /** Actual port (differs from the option only when port 0 was given). */
  readonly port: number;
  /** Send a frame to a connection. No-op once the socket is closed. */
  sendTo(info: ConnectionInfo, data: string): void;
  /** Close one connection (e.g. a superseded duplicate clientId). */
  closeConnection(info: ConnectionInfo, code?: number, reason?: string): void;
  /** Stop the listener and close every open connection. */
  stop(): void;
}

// ── minimal Bun surface (accessed via globalThis so Node typecheck and
//    vitest stay clean — no @types/bun dependency) ───────────────────────

interface BunWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  /** Data passed to server.upgrade(). */
  readonly data: unknown;
}
interface BunRequest {
  url: string;
  headers: { get(name: string): string | null };
}
interface BunUpgradeResult {
  success: boolean;
  response?: Response;
}
interface BunServer {
  port: number;
  stop(): void;
  upgrade(req: BunRequest, options?: { data?: unknown }): BunUpgradeResult;
}
interface BunServeOptions {
  hostname: string;
  port: number;
  tls?: { key: string; cert: string };
  fetch(req: BunRequest, server: BunServer): Response | Promise<Response> | undefined;
  websocket: {
    open(ws: BunWebSocket): void;
    /** Text frames arrive as strings, binary frames as ArrayBuffers. */
    message(ws: BunWebSocket, message: string | ArrayBuffer): void;
    close(ws: BunWebSocket): void;
  };
}
interface BunRuntime {
  serve(options: BunServeOptions): BunServer;
}

const bunOf = (): BunRuntime | undefined => (globalThis as { Bun?: BunRuntime }).Bun;

const textDecoder = new TextDecoder();

/**
 * Start the AHP listener. Throws before binding when a non-loopback
 * address is given without a token (R4) or when the runtime lacks
 * `Bun.serve` (R6 — the fallback implementation would be added here).
 */
export function createListener(opts: ListenerOptions, callbacks: TransportCallbacks): Listener {
  if (!isLoopback(opts.host) && !opts.token) {
    throw new Error(
      `refusing to bind ${opts.host} (non-loopback) without a token (R4); set options.token`,
    );
  }
  const bun = bunOf();
  if (!bun) {
    throw new Error(
      "Bun.serve is not available in this runtime (R6); expected inside the " +
        "Bun-based opencode v2 server — a `ws`-package fallback would go here",
    );
  }

  const openSockets = new Map<number, BunWebSocket>();
  let nextId = 1;

  const server = bun.serve({
    hostname: opts.host,
    port: opts.port,
    ...(opts.tls ? { tls: { key: opts.tls.key, cert: opts.tls.cert } } : {}),
    fetch(req, srv) {
      const url = new URL(req.url);
      switch (routePath(url, { ahp: opts.path, health: opts.healthPath })) {
        case "health":
          return new Response("ok\n", {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        case "ahp": {
          const expected = opts.token;
          if (
            expected !== null &&
            !tokenValid(expected, extractToken(url, { authorization: req.headers.get("authorization") }))
          ) {
            return new Response("unauthorized", { status: 401 });
          }
          if (!originAllowed(opts.allowedOrigins, req.headers.get("origin"))) {
            return new Response("origin not allowed", { status: 403 });
          }
          const info: ConnectionInfo = { id: nextId++ };
          const upgraded = srv.upgrade(req, { data: info });
          if (!upgraded.success) {
            return upgraded.response ?? new Response("upgrade failed", { status: 500 });
          }
          // Bun handles the 101 response itself.
          return undefined;
        }
        default:
          return new Response("not found", { status: 404 });
      }
    },
    websocket: {
      open(ws) {
        const info = ws.data as ConnectionInfo;
        openSockets.set(info.id, ws);
        callbacks.onOpen(info);
      },
      message(ws, message) {
        const info = ws.data as ConnectionInfo;
        const text = typeof message === "string" ? message : textDecoder.decode(message);
        callbacks.onMessage(info, text);
      },
      close(ws) {
        const info = ws.data as ConnectionInfo;
        openSockets.delete(info.id);
        callbacks.onClose(info);
      },
    },
  });

  return {
    get port() {
      return server.port;
    },
    sendTo(info, data) {
      const ws = openSockets.get(info.id);
      if (!ws || ws.readyState !== 1) return; // 1 = OPEN
      ws.send(data);
    },
    closeConnection(info, code, reason) {
      const ws = openSockets.get(info.id);
      if (ws && ws.readyState === 1) ws.close(code, reason);
    },
    stop() {
      server.stop();
      openSockets.clear();
    },
  };
}
