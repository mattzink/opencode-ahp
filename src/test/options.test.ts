import { describe, expect, it } from "vitest";
import { BUILTIN_OPTIONS, resolveOptions, stripJsonc } from "../options.js";

const FILE = `
{
  // a line comment with "quotes" and /* nothing */ inside
  "port": 9000,               // trailing comment
  "host": "0.0.0.0",
  "path": "/ws",
  "allowedOrigins": ["vscode://vscode"],
  "tls": { "keyPath": "/k.pem", "certPath": "/c.pem" },
  /* block
     comment */
  "capabilities": { "terminals": true },
}
`;

describe("stripJsonc", () => {
  it("removes line comments, block comments and trailing commas", () => {
    const out = stripJsonc(FILE);
    expect(JSON.parse(out)).toMatchObject({ port: 9000, host: "0.0.0.0", path: "/ws" });
  });

  it("keeps // and /* inside string literals", () => {
    const parsed = JSON.parse(stripJsonc(FILE)) as Record<string, unknown>;
    expect(parsed["allowedOrigins"]).toEqual(["vscode://vscode"]);
    expect(JSON.parse(stripJsonc(`{ "a": "x / not comment" }`))).toEqual({ a: "x / not comment" });
    expect(JSON.parse(stripJsonc(`{ "a": "say \\"hi\\" // still string" }`))).toEqual({
      a: 'say "hi" // still string',
    });
  });
});

describe("resolveOptions: precedence ctx ▸ file ▸ built-in", () => {
  it("starts from built-in defaults when nothing is provided", () => {
    expect(resolveOptions(undefined, null)).toEqual(BUILTIN_OPTIONS);
    expect(resolveOptions({}, "")).toEqual(BUILTIN_OPTIONS);
  });

  it("file values beat built-ins; ctx beats file (per top-level key)", () => {
    const o = resolveOptions({ port: 1234 }, FILE);
    expect(o.port).toBe(1234); // ctx
    expect(o.host).toBe("0.0.0.0"); // file
    expect(o.path).toBe("/ws"); // file
    expect(o.healthPath).toBe(BUILTIN_OPTIONS.healthPath); // built-in
    expect(o.replayWindow).toBe(BUILTIN_OPTIONS.replayWindow); // built-in
  });

  it("ctx wins for every scalar key", () => {
    const ctx: Record<string, unknown> = {
      enabled: false,
      port: 1,
      host: "127.0.0.1",
      path: "/a",
      token: "t",
      allowedOrigins: ["x"],
      healthPath: "/h",
      keepAlive: false,
      keepAliveIntervalMinutes: 2,
      replayWindow: 7,
    };
    const o = resolveOptions(ctx, FILE);
    expect(o.enabled).toBe(false);
    expect(o.port).toBe(1);
    expect(o.host).toBe("127.0.0.1");
    expect(o.path).toBe("/a");
    expect(o.token).toBe("t");
    expect(o.allowedOrigins).toEqual(["x"]);
    expect(o.healthPath).toBe("/h");
    expect(o.keepAlive).toBe(false);
    expect(o.keepAliveIntervalMinutes).toBe(2);
    expect(o.replayWindow).toBe(7);
  });

  it("keep-alive defaults to on with a 10-minute interval", () => {
    expect(resolveOptions(undefined, null).keepAlive).toBe(true);
    expect(resolveOptions(undefined, null).keepAliveIntervalMinutes).toBe(10);
  });
});

describe("resolveOptions: validation and fallback (no throw)", () => {
  it("invalid ctx value falls back to the file value", () => {
    expect(resolveOptions({ port: "soon" }, FILE).port).toBe(9000);
    expect(resolveOptions({ port: -3 }, FILE).port).toBe(9000);
    expect(resolveOptions({ port: 70000 }, FILE).port).toBe(9000);
    expect(resolveOptions({ port: 8080.5 }, FILE).port).toBe(9000);
  });

  it("invalid ctx and file values fall back to built-in", () => {
    expect(resolveOptions({ replayWindow: 0 }, JSON.stringify({ replayWindow: -1 })).replayWindow).toBe(
      BUILTIN_OPTIONS.replayWindow,
    );
    expect(resolveOptions({ keepAlive: "yes" }, null).keepAlive).toBe(BUILTIN_OPTIONS.keepAlive);
    expect(resolveOptions({ keepAliveIntervalMinutes: 0 }, JSON.stringify({ keepAliveIntervalMinutes: -1 })).keepAliveIntervalMinutes).toBe(
      BUILTIN_OPTIONS.keepAliveIntervalMinutes,
    );
    expect(resolveOptions({ keepAliveIntervalMinutes: "soon" }, null).keepAliveIntervalMinutes).toBe(
      BUILTIN_OPTIONS.keepAliveIntervalMinutes,
    );
  });

  it("path must be an absolute path without a trailing slash", () => {
    expect(resolveOptions({ path: "/" }, null).path).toBe(BUILTIN_OPTIONS.path);
    expect(resolveOptions({ path: "" }, null).path).toBe(BUILTIN_OPTIONS.path);
    expect(resolveOptions({ path: "ahp" }, null).path).toBe(BUILTIN_OPTIONS.path);
    expect(resolveOptions({ path: "/ahp/" }, null).path).toBe(BUILTIN_OPTIONS.path);
    expect(resolveOptions({ path: "/ok" }, null).path).toBe("/ok");
    expect(resolveOptions({ healthPath: "//" }, null).healthPath).toBe(BUILTIN_OPTIONS.healthPath);
  });

  it("token: empty string is invalid and falls back (null built-in)", () => {
    expect(resolveOptions({ token: "" }, null).token).toBeNull();
    expect(resolveOptions({ token: "x" }, null).token).toBe("x");
  });

  it("allowedOrigins accepts '*' or a non-empty string array", () => {
    expect(resolveOptions({ allowedOrigins: "*" }, null).allowedOrigins).toBe("*");
    expect(resolveOptions({ allowedOrigins: [] }, FILE).allowedOrigins).toEqual([
      "vscode://vscode",
    ]);
    expect(resolveOptions({ allowedOrigins: [1, 2] }, null).allowedOrigins).toBe(
      BUILTIN_OPTIONS.allowedOrigins,
    );
    expect(resolveOptions({}, FILE).allowedOrigins).toEqual(["vscode://vscode"]);
  });

  it("tls requires both keyPath and certPath strings", () => {
    expect(resolveOptions({ tls: { keyPath: "/k", certPath: "/c" } }, null).tls).toEqual({
      keyPath: "/k",
      certPath: "/c",
    });
    expect(resolveOptions({ tls: { keyPath: "/k" } }, FILE).tls).toEqual({
      keyPath: "/k.pem",
      certPath: "/c.pem",
    });
    expect(resolveOptions({ tls: "nope" }, null).tls).toBeNull();
  });

  it("capabilities merge per leaf (ctx ▸ file ▸ built-in per key)", () => {
    // file sets terminals; ctx sets changesets; automations stays built-in
    expect(resolveOptions({ capabilities: { changesets: true } }, FILE).capabilities).toEqual({
      changesets: true,
      terminals: true,
      automations: false,
    });
    // ctx partial entry does not clobber the other file flags
    // (changesets falls back to the built-in — true by default)
    expect(resolveOptions({ capabilities: { terminals: false } }, FILE).capabilities).toEqual({
      changesets: true,
      terminals: false,
      automations: false,
    });
    // invalid leaf values are dropped per leaf
    expect(resolveOptions({ capabilities: { changesets: "yes" } }, FILE).capabilities).toEqual({
      changesets: true,
      terminals: true,
      automations: false,
    });
  });
});

describe("resolveOptions: malformed file throws so the caller can degrade", () => {
  it("invalid JSON text throws", () => {
    expect(() => resolveOptions({}, "{ not json")).toThrow();
  });

  it("a non-object top level throws", () => {
    expect(() => resolveOptions({}, "[1,2,3]")).toThrow();
    expect(() => resolveOptions({}, '"str"')).toThrow();
  });
});
