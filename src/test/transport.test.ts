import { describe, expect, it } from "vitest";
import {
  createListener,
  extractToken,
  isLoopback,
  originAllowed,
  routePath,
  tokenValid,
} from "../transport.js";

describe("isLoopback", () => {
  it("accepts loopback forms", () => {
    for (const host of ["127.0.0.1", "127.5.6.7", "::1", "[::1]", "localhost", "LOCALHOST"]) {
      expect(isLoopback(host), host).toBe(true);
    }
  });

  it("rejects non-loopback forms", () => {
    for (const host of ["0.0.0.0", "::", "[::]", "192.168.1.5", "10.0.0.1", "example.com", ""]) {
      expect(isLoopback(host), host).toBe(false);
    }
  });
});

describe("extractToken", () => {
  const headers = (h: Record<string, string>) => h;

  it("reads the ?token= query param", () => {
    expect(extractToken(new URL("ws://h/ahp?token=abc"), {})).toBe("abc");
  });

  it("reads an Authorization: Bearer header (scheme case-insensitive)", () => {
    const url = new URL("ws://h/ahp");
    expect(extractToken(url, headers({ authorization: "Bearer abc" }))).toBe("abc");
    expect(extractToken(url, headers({ authorization: "bearer abc" }))).toBe("abc");
    expect(extractToken(url, headers({ Authorization: "BEARER abc" }))).toBe("abc");
  });

  it("query param wins over the Bearer header", () => {
    const url = new URL("ws://h/ahp?token=fromquery");
    expect(
      extractToken(url, headers({ authorization: "Bearer fromheader" })),
    ).toBe("fromquery");
  });

  it("is null when neither carries a value", () => {
    expect(extractToken(new URL("ws://h/ahp"), {})).toBeNull();
    expect(extractToken(new URL("ws://h/ahp?token="), {})).toBeNull();
    expect(extractToken(new URL("ws://h/ahp"), headers({ authorization: "Bearer" }))).toBeNull();
    expect(
      extractToken(new URL("ws://h/ahp"), headers({ authorization: "Basic abc" })),
    ).toBeNull();
    expect(
      extractToken(new URL("ws://h/ahp"), headers({ authorization: "Bearer abc def" })),
    ).toBeNull();
  });
});

describe("tokenValid", () => {
  it("accepts an exact match and rejects everything else", () => {
    expect(tokenValid("secret", "secret")).toBe(true);
    expect(tokenValid("secret", "secrex")).toBe(false);
    expect(tokenValid("secret", "secr")).toBe(false);
    expect(tokenValid("secret", "secret extra")).toBe(false);
    expect(tokenValid("secret", null)).toBe(false);
    expect(tokenValid("", "x")).toBe(false);
    expect(tokenValid("", null)).toBe(false);
  });
});

describe("originAllowed", () => {
  it("a null Origin (non-browser clients) always passes", () => {
    expect(originAllowed("*", null)).toBe(true);
    expect(originAllowed(["vscode://vscode"], null)).toBe(true);
    expect(originAllowed(["vscode://vscode"], undefined)).toBe(true);
  });

  it('"*" allows every browser Origin', () => {
    expect(originAllowed("*", "https://vscode.dev")).toBe(true);
    expect(originAllowed("*", "http://anything")).toBe(true);
  });

  it("a list is an exact match", () => {
    expect(originAllowed(["vscode://vscode"], "vscode://vscode")).toBe(true);
    expect(originAllowed(["vscode://vscode"], "https://evil.example")).toBe(false);
    expect(originAllowed(["vscode://vscode"], "vscode://vscode/extra")).toBe(false);
  });
});

describe("routePath", () => {
  const paths = { ahp: "/ahp", health: "/healthz" };

  it("routes the AHP and health paths exactly", () => {
    expect(routePath(new URL("http://h/ahp?token=x"), paths)).toBe("ahp");
    expect(routePath(new URL("http://h/healthz"), paths)).toBe("health");
  });

  it("anything else is 'other' (404), including trailing slashes", () => {
    expect(routePath(new URL("http://h/"), paths)).toBe("other");
    expect(routePath(new URL("http://h/ahp/"), paths)).toBe("other");
    expect(routePath(new URL("http://h/nope"), paths)).toBe("other");
  });
});

describe("createListener", () => {
  const noop = {
    onOpen: () => {},
    onMessage: () => {},
    onClose: () => {},
  };

  it("refuses a non-loopback bind without a token (R4)", () => {
    expect(() =>
      createListener({ host: "0.0.0.0", port: 1, path: "/ahp", healthPath: "/healthz", token: null, allowedOrigins: "*" }, noop),
    ).toThrow(/non-loopback/);
    expect(() =>
      createListener({ host: "192.168.1.5", port: 1, path: "/ahp", healthPath: "/healthz", token: null, allowedOrigins: "*" }, noop),
    ).toThrow(/non-loopback/);
  });

  it("allows a loopback bind without a token", () => {
    // No throw before the runtime check: under vitest (Node, no Bun) the
    // failure is the R6 runtime error, not the R4 refusal.
    expect(() =>
      createListener({ host: "127.0.0.1", port: 1, path: "/ahp", healthPath: "/healthz", token: null, allowedOrigins: "*" }, noop),
    ).toThrow(/Bun\.serve/);
    // Same for a loopback bind with a token.
    expect(() =>
      createListener({ host: "127.0.0.1", port: 1, path: "/ahp", healthPath: "/healthz", token: "x", allowedOrigins: "*" }, noop),
    ).toThrow(/Bun\.serve/);
  });

  it("refuses a non-loopback bind with a token only when the runtime lacks Bun.serve (R6)", () => {
    expect(() =>
      createListener({ host: "0.0.0.0", port: 1, path: "/ahp", healthPath: "/healthz", token: "x", allowedOrigins: "*" }, noop),
    ).toThrow(/Bun\.serve/);
  });

  it("passes the PEM contents to Bun.serve when tls is set, and omits tls otherwise (Phase 3)", () => {
    // The transport reads Bun from globalThis (no @types/bun dependency),
    // so a stubbed serve() is enough to observe the options it receives —
    // no network, no disk.
    interface Served {
      tls?: { key: string; cert: string };
    }
    const seen: Served[] = [];
    const fakeBun = {
      serve: (options: Served) => {
        seen.push(options);
        return { port: 1, stop: () => {}, upgrade: () => ({ success: true }) };
      },
    };
    const g = globalThis as { Bun?: unknown };
    const prev = g.Bun;
    g.Bun = fakeBun;
    try {
      createListener(
        {
          host: "127.0.0.1",
          port: 1,
          path: "/ahp",
          healthPath: "/healthz",
          token: "t",
          allowedOrigins: "*",
          tls: { key: "KEY-PEM", cert: "CERT-PEM" },
        },
        noop,
      );
      createListener(
        { host: "127.0.0.1", port: 1, path: "/ahp", healthPath: "/healthz", token: "t", allowedOrigins: "*" },
        noop,
      );
    } finally {
      g.Bun = prev;
    }
    const [withTls, withoutTls] = seen;
    expect(withTls?.tls).toEqual({ key: "KEY-PEM", cert: "CERT-PEM" });
    expect("tls" in (withoutTls ?? {})).toBe(false);
  });
});
