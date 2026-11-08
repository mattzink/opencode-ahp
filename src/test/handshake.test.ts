import { describe, expect, it } from "vitest";
import { SUPPORTED_PROTOCOL_VERSIONS, type Snapshot } from "@microsoft/agent-host-protocol";
import {
  ERROR_INVALID_PARAMS,
  ERROR_UNSUPPORTED_PROTOCOL_VERSION,
  handleInitialize,
  type InitializeRequest,
} from "../handshake.js";
import { ROOT_CHANNEL } from "../channels.js";

const serverInfo = { name: "opencode-ahp", version: "0.1.0", title: "OpenCode" };

function req(params: unknown, extra: Partial<InitializeRequest> = {}): InitializeRequest {
  return {
    params,
    serverInfo,
    serverSeq: 42,
    snapshotFor: () => null,
    ...extra,
  };
}

const okParams = (protocolVersions: string[] = ["1.0.0"]) => ({
  channel: ROOT_CHANNEL,
  clientId: "client-1",
  protocolVersions,
});

/** The negotiated version, or undefined when the handshake rejected. */
async function negotiated(versions: string[]): Promise<string | undefined> {
  const out = await handleInitialize(req(okParams(versions)));
  return out.ok ? out.result.protocolVersion : undefined;
}

describe("handleInitialize: param validation", () => {
  it("rejects a non-object params", () => {
    return Promise.all([
      expect(handleInitialize(req(null))).resolves.toMatchObject({
        ok: false,
        error: { code: ERROR_INVALID_PARAMS },
      }),
      expect(handleInitialize(req("x"))).resolves.toMatchObject({
        ok: false,
        error: { code: ERROR_INVALID_PARAMS },
      }),
    ]);
  });

  it("rejects a wrong channel", () => {
    const out = handleInitialize(req({ ...okParams(), channel: "ahp-session:/s1" }));
    return expect(out).resolves.toMatchObject({ ok: false, error: { code: ERROR_INVALID_PARAMS } });
  });

  it("rejects a missing or empty clientId", () => {
    const missing = handleInitialize(req({ channel: ROOT_CHANNEL, protocolVersions: ["1.0.0"] }));
    const empty = handleInitialize(req({ ...okParams(), clientId: "" }));
    return Promise.all([
      expect(missing).resolves.toMatchObject({ ok: false, error: { code: ERROR_INVALID_PARAMS } }),
      expect(empty).resolves.toMatchObject({ ok: false, error: { code: ERROR_INVALID_PARAMS } }),
    ]);
  });

  it("rejects an empty or malformed protocolVersions", () => {
    const cases: unknown[] = [
      { ...okParams([]) },
      { ...okParams(["1.0", "1.0.0"]) },
      { ...okParams(["banana"]) },
      { channel: ROOT_CHANNEL, clientId: "c", protocolVersions: [1] },
    ];
    return Promise.all(
      cases.map((params) =>
        expect(handleInitialize(req(params))).resolves.toMatchObject({
          ok: false,
          error: { code: ERROR_INVALID_PARAMS },
        }),
      ),
    );
  });
});

describe("handleInitialize: version negotiation", () => {
  it("accepts 1.0.0", () => expect(negotiated(["1.0.0"])).resolves.toBe("1.0.0"));

  it("echoes a newer 1.x offer (caret-compatible with the 1.0.0 baseline)", () =>
    Promise.all([
      expect(negotiated(["1.0.1", "1.0.0"])).resolves.toBe("1.0.1"),
      expect(negotiated(["1.9.0"])).resolves.toBe("1.9.0"),
    ]));

  it("accepts the 0.9.x baseline", () => expect(negotiated(["0.9.5"])).resolves.toBe("0.9.5"));

  it("picks the highest compatible offer", () =>
    expect(negotiated(["0.9.5", "1.0.0"])).resolves.toBe("1.0.0"));

  it("rejects unsupported versions with the supported list (-32005)", async () => {
    for (const versions of [["2.0.0"], ["0.8.0"], ["3.1.4"]]) {
      expect(await negotiated(versions), JSON.stringify(versions)).toBeUndefined();
      const out = await handleInitialize(req(okParams(versions)));
      expect(out, JSON.stringify(versions)).toMatchObject({
        ok: false,
        error: {
          code: ERROR_UNSUPPORTED_PROTOCOL_VERSION,
          data: { supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS] },
        },
      });
    }
    expect([...SUPPORTED_PROTOCOL_VERSIONS]).toEqual(["1.0.0", "0.9.0"]);
  });
});

describe("handleInitialize: result shape", () => {
  it("stamps serverSeq and serverInfo, carries defaultDirectory", async () => {
    const out = await handleInitialize(req(okParams(), { serverSeq: 7, defaultDirectory: "/home/x/proj" }));
    expect(out).toMatchObject({
      ok: true,
      result: {
        serverSeq: 7,
        serverInfo,
        defaultDirectory: "/home/x/proj",
        snapshots: [],
      },
    });
  });

  it("does not set defaultDirectory when unknown", async () => {
    const out = await handleInitialize(req(okParams()));
    if (out.ok) {
      expect(out.result.defaultDirectory).toBeUndefined();
    } else {
      expect.fail("expected ok");
    }
  });

  it("resolves initialSubscriptions via snapshotFor and drops unresolvable ones", async () => {
    const snapshots: Snapshot[] = [
      { resource: "ahp-root://", state: { agents: [] }, fromSeq: 0 },
      { resource: "ahp-session:/s1", state: { agents: [] }, fromSeq: 0 },
    ];
    const out = await handleInitialize(
      req(
        { ...okParams(), initialSubscriptions: ["ahp-root://", "ahp-session:/s1", "bogus://x"] },
        {
          snapshotFor: async (uri) =>
            uri === "ahp-root://" ? snapshots[0]! : uri === "ahp-session:/s1" ? snapshots[1]! : null,
        },
      ),
    );
    expect(out).toMatchObject({
      ok: true,
      result: { snapshots: [{ resource: "ahp-root://" }, { resource: "ahp-session:/s1" }] },
    });
  });
});
