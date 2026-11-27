#!/usr/bin/env node
/**
 * opencode-ahp live verification: the session customization catalog
 * (design §7.5) — MCP servers, skills, and server tools in AHP session
 * state (the VS Code Customizations panel surface).
 *
 * Machine-independent: every expectation is cross-checked against the
 * test server's OWN HTTP surface at run time (the test server inherits
 * the user's real HOME, so its agents/skills/MCP are whatever this
 * machine configures — the probe never hardcodes names):
 *   - GET /api/agent → the non-hidden agent names (agent directory container)
 *   - GET /api/skill → the skill names (skills directory container)
 *   - GET /api/mcp   → the MCP server names + live status (top-level
 *                      mcpServer customizations, status → AHP state)
 *
 * Checks:
 *   1. initialize (root subscription)
 *   2. createSession with an activeClient tool → subscribe the session
 *      channel → the snapshot carries:
 *        - the agent directory container (names == /api/agent non-hidden)
 *        - the sibling skills directory container (names == /api/skill)
 *        - top-level MCP entries (== /api/mcp, mapped state)
 *        - serverTools: non-empty, shaped, and WITHOUT the client tool
 *          (the creating session's own activeClient pre-seed)
 *   3. an EXTERNALLY-created session (POST /api/session — the
 *      TUI/restart resurfacing path): after the root announcement the
 *      session converges on the catalog via the fire-and-forget change
 *      actions (snapshot poll), then DELETE /api/session removes it
 *   4. the MCP TOGGLE (design §7.5): `session/customizationToggled` on
 *      `opencode:mcp/<name>` (the panel's enable toggle) disables a
 *      connected server — accepted echo, re-pushed catalog with state
 *      `stopped` + the workspace disable `enablement`, /api/mcp agrees
 *      (status `disabled`); a non-MCP id (the agent directory) is
 *      rejected with the static-definition reason; `mcpServerStartRequested`
 *      re-enables — accepted, re-pushed `ready` without enablement,
 *      /api/mcp `connected` again
 *
 * Dependency-free: Node ≥ 22 global WebSocket + fetch.
 *
 * Usage:
 *   node scripts/ahp-customizations.mjs --token <ahp token> --pw <server pw> \
 *     [--base http://127.0.0.1:8767] [--path /ahp] \
 *     [--http-base http://127.0.0.1:4098] \
 *     [--channel ahp-session:/lan-custom-<rand>] [--provider opencode] \
 *     [--timeout-ms 30000]
 *
 * Exit codes: 0 success · 1 protocol/verification failure · 2 connection
 */
import { randomBytes } from "node:crypto";

const TAG = "[ahp-customizations]";
const fail = (code, msg) => {
  console.error(`${TAG} FAIL: ${msg}`);
  process.exit(code);
};

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};

const opts = {
  base: (arg("--base", "http://127.0.0.1:8767") ?? "").replace(/\/$/, ""),
  path: arg("--path", "/ahp"),
  token: arg("--token", null),
  httpBase: (arg("--http-base", "http://127.0.0.1:4098") ?? "").replace(/\/$/, ""),
  pw: arg("--pw", null),
  channel: arg("--channel", `ahp-session:/lan-custom-${randomBytes(3).toString("hex")}`),
  provider: arg("--provider", "opencode"),
  timeoutMs: Number(arg("--timeout-ms", "30000")),
};
if (!opts.token) fail(2, "--token is required");
if (!opts.pw) fail(2, "--pw (the opencode server Basic auth password) is required");

const wsUrl =
  opts.base.replace(/^http/, "ws") +
  opts.path +
  "?token=" +
  encodeURIComponent(opts.token);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${TAG} ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── the test server's own HTTP surface (the cross-check ground truth) ──

const basic = "Basic " + Buffer.from(`opencode:${opts.pw}`).toString("base64");
const httpGet = async (path) => {
  const res = await fetch(opts.httpBase + path, { headers: { authorization: basic } });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
};

// ── minimal AHP session (same idiom as ahp-turn-lifecycle.mjs) ────────

let nextId = 1;
const pending = new Map();
const rootNotifications = [];
const actionEvents = []; // `action` stream envelopes (dispatch echoes, change actions)

function dispatchFrame(msg) {
  const id = msg.id;
  if (id !== undefined && pending.has(id)) {
    const p = pending.get(id);
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(msg);
    return;
  }
  if (msg.method === "action") {
    actionEvents.push(msg.params);
  } else {
    rootNotifications.push(msg);
  }
}

const ws = new WebSocket(wsUrl);
ws.addEventListener("message", (ev) => {
  let text;
  const data = ev.data;
  if (typeof data === "string") text = data;
  else text = new TextDecoder().decode(data instanceof ArrayBuffer ? data : Buffer.from(data));
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    console.error(`${TAG} non-JSON frame: ${text.slice(0, 200)}`);
    return;
  }
  dispatchFrame(msg);
});

const openPromise = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("websocket open timeout")), opts.timeoutMs);
  ws.addEventListener("open", () => {
    clearTimeout(timer);
    resolve();
  });
  ws.addEventListener("error", (e) => {
    clearTimeout(timer);
    reject(new Error(`websocket error: ${e?.message ?? "unknown"}`));
  });
  ws.addEventListener("close", (e) => {
    clearTimeout(timer);
    reject(new Error(`websocket closed (code ${e.code})`));
  });
});

const request = (method, params) => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for "${method}" response`));
    }, opts.timeoutMs);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
};

const waitFor = async (cond, label, timeoutMs = opts.timeoutMs) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

const stateOf = (subResult, channel) => {
  const state = subResult.result?.snapshot?.state;
  if (subResult.error) throw new Error(`subscribe ${channel}: ${JSON.stringify(subResult.error)}`);
  if (state === undefined) throw new Error(`subscribe ${channel}: no snapshot state`);
  return state;
};

// The expected AHP MCP state kind for an opencode live status.
const MCP_STATUS_KIND = {
  connected: "ready",
  pending: "starting",
  disabled: "stopped",
  failed: "error",
  needs_auth: "error", // no RFC 9728 metadata in the opencode status → error
};

/** Assert one session's catalog snapshot against the /api ground truth. */
function assertCatalog(label, state, { expectedAgents, expectedSkills, expectedMcp, noClientTool }) {
  const customizations = state.customizations ?? [];
  const dirs = customizations.filter((c) => c.type === "directory");

  const agentDir = dirs.find((c) => c.contents === "agent");
  const agentNames = (agentDir?.children ?? []).map((c) => c.name);
  check(
    `${label}: agent directory container matches /api/agent`,
    agentDir !== undefined &&
      agentNames.length === expectedAgents.length &&
      expectedAgents.every((n) => agentNames.includes(n)),
    agentNames.join(", "),
  );

  const skillDir = dirs.find((c) => c.contents === "skill");
  const skillNames = (skillDir?.children ?? []).map((c) => c.name);
  check(
    `${label}: skills directory container matches /api/skill`,
    skillDir !== undefined &&
      skillDir.uri === agentDir?.uri &&
      skillNames.length === expectedSkills.length &&
      expectedSkills.every((n) => skillNames.includes(n)),
    skillNames.join(", "),
  );

  const mcpEntries = customizations.filter((c) => c.type === "mcpServer");
  check(
    `${label}: top-level MCP entries match /api/mcp (${expectedMcp.length} expected)`,
    mcpEntries.length === expectedMcp.length &&
      expectedMcp.every((m) => {
        const entry = mcpEntries.find((c) => c.id === `opencode:mcp/${m.name}`);
        return (
          entry !== undefined &&
          entry.name === (m.title ?? m.name) &&
          entry.state?.kind === MCP_STATUS_KIND[m.status]
        );
      }),
    mcpEntries.map((c) => `${c.id}:${c.state?.kind}`).join(", ") || "(none)",
  );

  const tools = state.serverTools ?? [];
  const shaped =
    tools.length > 0 &&
    tools.every((t) => {
      if (typeof t.name !== "string" || t.name.length === 0) return false;
      if (t.description !== undefined && typeof t.description !== "string") return false;
      if (t.inputSchema !== undefined) {
        if (typeof t.inputSchema !== "object" || t.inputSchema === null || t.inputSchema.type !== "object")
          return false;
        if (t.inputSchema.properties !== undefined && (typeof t.inputSchema.properties !== "object" || t.inputSchema.properties === null))
          return false;
        if (t.inputSchema.required !== undefined && (!Array.isArray(t.inputSchema.required) || t.inputSchema.required.some((r) => typeof r !== "string")))
          return false;
      }
      return true;
    });
  check(
    `${label}: serverTools non-empty and shaped`,
    shaped,
    `${tools.length} tools: ${tools.map((t) => t.name).slice(0, 8).join(", ")}${tools.length > 8 ? "…" : ""}`,
  );
  check(
    `${label}: no client-tool echo in serverTools`,
    !tools.some((t) => t.name === noClientTool),
    `activeClient tool "${noClientTool}" must not appear`,
  );
}

try {
  // 0. the HTTP ground truth (before the AHP session exists).
  const [agentData, skillData, mcpData] = await Promise.all([
    httpGet("/api/agent"),
    httpGet("/api/skill"),
    httpGet("/api/mcp"),
  ]);
  const expectedAgents = (agentData.data ?? []).filter((a) => a.hidden !== true).map((a) => a.name);
  const expectedSkills = (skillData.data ?? []).map((s) => s.name);
  const expectedMcp = (mcpData.data ?? []).map((m) => ({ name: m.name, title: m.title, status: m.status?.status }));
  console.log(
    `${TAG} ground truth: ${expectedAgents.length} agents, ${expectedSkills.length} skills, ${expectedMcp.length} MCP servers`,
  );

  await openPromise;
  console.log(`${TAG} connected ${wsUrl.replace(opts.token, "***")}`);

  // 1. initialize
  const clientId = "custom-" + randomBytes(4).toString("hex");
  const init = await request("initialize", {
    channel: "ahp-root://",
    clientId,
    protocolVersions: ["1.1.0", "1.0.0"],
    initialSubscriptions: ["ahp-root://"],
  });
  if (init.error) fail(1, `initialize: ${JSON.stringify(init.error)}`);
  check("initialize", init.result?.protocolVersion === "1.1.0", `v${init.result?.protocolVersion}`);

  // 2. createSession with an activeClient tool (the pre-seed exclusion
  //    path: the record does not exist while the snapshot runs).
  const clientToolName = "probe-client-tool";
  const create = await request("createSession", {
    channel: opts.channel,
    provider: opts.provider,
    activeClient: {
      clientId,
      tools: [{ name: clientToolName, description: "probe", inputSchema: { type: "object" } }],
    },
  });
  if (create.error) fail(1, `createSession: ${JSON.stringify(create.error)}`);
  check("createSession", create.result === null, `channel ${opts.channel} provider ${opts.provider}`);

  const sessState = stateOf(await request("subscribe", { channel: opts.channel }), opts.channel);
  check(
    "session snapshot has the default chat",
    typeof sessState.defaultChat === "string" && sessState.defaultChat.startsWith("ahp-chat:/"),
    String(sessState.defaultChat),
  );
  assertCatalog("createSession snapshot", sessState, {
    expectedAgents,
    expectedSkills,
    expectedMcp,
    noClientTool: clientToolName,
  });

  // 3. external registration: POST /api/session (the TUI/resurfacing
  //    path) — after the root announcement the catalog lands as
  //    fire-and-forget change actions; poll the snapshot for convergence.
  const extRes = await fetch(opts.httpBase + "/api/session", {
    method: "POST",
    headers: { authorization: basic, "content-type": "application/json" },
    body: "{}",
  });
  if (!extRes.ok) throw new Error(`POST /api/session → ${extRes.status}`);
  const extId = (await extRes.json()).data?.id;
  if (typeof extId !== "string") throw new Error("POST /api/session: no session id");
  const extChannel = `ahp-session:/${extId}`;

  await waitFor(
    () => rootNotifications.some((n) => n.method === "root/sessionAdded" && n.params?.summary?.resource === extChannel),
    `root/sessionAdded for ${extChannel}`,
  );
  check("external session announced on root", true, extChannel);

  // Convergence gate: the catalog lands as the fire-and-forget change
  // actions — it may already be baked into the first snapshot, or the
  // snapshot may update after (serverTools ride the same pass).
  let converged = stateOf(await request("subscribe", { channel: extChannel }), extChannel);
  const catalogNonEmpty = expectedMcp.length > 0 || expectedSkills.length > 0 || expectedAgents.length > 0;
  const catalogReady = (s) => !catalogNonEmpty || (s.customizations ?? []).length > 0;
  const convStart = Date.now();
  while (!catalogReady(converged) && Date.now() - convStart < opts.timeoutMs) {
    await new Promise((r) => setTimeout(r, 25));
    converged = stateOf(await request("subscribe", { channel: extChannel }), extChannel);
  }
  if (!catalogReady(converged)) throw new Error(`timeout: external session catalog convergence (${extChannel})`);
  check(
    "external session snapshot has the default chat",
    typeof converged.defaultChat === "string" && converged.defaultChat.startsWith("ahp-chat:/"),
    String(converged.defaultChat),
  );
  assertCatalog("external session snapshot", converged, {
    expectedAgents,
    expectedSkills,
    expectedMcp,
    noClientTool: clientToolName, // no active client on the external session — still absent
  });

  // Cleanup: remove the external session (also exercises the removal path).
  const del = await fetch(opts.httpBase + `/api/session/${extId}`, {
    method: "DELETE",
    headers: { authorization: basic },
  });
  check("external session removed (DELETE /api/session)", del.status === 204, `status ${del.status}`);
  await waitFor(
    () => rootNotifications.some((n) => n.method === "root/sessionRemoved" && n.params?.session === extChannel),
    `root/sessionRemoved for ${extChannel}`,
  ).catch(() => {});
  check(
    "root/sessionRemoved announced",
    rootNotifications.some((n) => n.method === "root/sessionRemoved" && n.params?.session === extChannel),
  );

  // 4. MCP toggle (design §7.5): the panel's enable toggle
  //    (`session/customizationToggled` on `opencode:mcp/<name>`) and the
  //    dedicated control actions must stick — accepted echo + re-pushed
  //    catalog carrying the new state and the workspace disable
  //    enablement. Cross-check against /api/mcp after each step (the
  //    opencode side of the toggle).
  const mcpTarget = expectedMcp.find((m) => m.status === "connected");
  if (mcpTarget === undefined) {
    console.log(
      `${TAG} skip toggle checks: no connected MCP server (ground truth: ${
        expectedMcp.map((m) => `${m.name}:${m.status}`).join(", ") || "(none)"
      })`,
    );
  } else {
    const targetId = `opencode:mcp/${mcpTarget.name}`;
    const findEntry = (env) => env.action?.customizations?.find((c) => c.id === targetId);
    const httpMcp = async () =>
      (await httpGet("/api/mcp")).data.map((m) => ({ name: m.name, status: m.status?.status }));

    // 4a. disable via the panel's enable toggle.
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "dispatchAction",
        params: {
          channel: opts.channel,
          clientSeq: 1,
          action: {
            type: "session/customizationToggled",
            id: targetId,
            enablement: [{ kind: "session", enabled: false }],
          },
        },
      }),
    );
    await waitFor(
      () =>
        actionEvents.some(
          (e) =>
            e.channel === opts.channel &&
            e.action?.type === "session/customizationToggled" &&
            e.action?.id === targetId &&
            e.rejectionReason === undefined,
        ),
      `accepted customizationToggled echo for ${targetId}`,
    );
    check("toggle off accepted (no rejection)", true, targetId);
    await waitFor(
      () =>
        actionEvents.some(
          (e) =>
            e.channel === opts.channel &&
            e.action?.type === "session/customizationsChanged" &&
            findEntry(e)?.state?.kind === "stopped",
        ),
      `re-pushed catalog with ${targetId} stopped`,
    );
    const stoppedEnv = actionEvents.find(
      (e) =>
        e.channel === opts.channel &&
        e.action?.type === "session/customizationsChanged" &&
        findEntry(e)?.state?.kind === "stopped",
    );
    const stopped = stoppedEnv === undefined ? undefined : findEntry(stoppedEnv);
    if (stopped === undefined) throw new Error(`re-pushed catalog without ${targetId} stopped`);
    check(
      "re-push carries the workspace disable enablement",
      stopped.enablement?.[0]?.kind === "workspace" &&
        stopped.enablement[0].uri === stopped.uri &&
        stopped.enablement[0].enabled === false,
      JSON.stringify(stopped.enablement),
    );
    const mcpAfterOff = await httpMcp();
    check(
      "opencode side: the server reports disabled",
      mcpAfterOff.find((m) => m.name === mcpTarget.name)?.status === "disabled",
      mcpAfterOff.map((m) => `${m.name}:${m.status}`).join(", "),
    );

    // 4b. non-MCP customizations (the agent directory) stay rejected.
    const agentDirId = (sessState.customizations ?? []).find(
      (c) => c.type === "directory" && c.contents === "agent",
    )?.id;
    if (agentDirId === undefined) {
      check("agent directory present (non-MCP rejection check)", false, "no agent directory container");
    } else {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "dispatchAction",
          params: {
            channel: opts.channel,
            clientSeq: 2,
            action: {
              type: "session/customizationToggled",
              id: agentDirId,
              enablement: [{ kind: "session", enabled: false }],
            },
          },
        }),
      );
      await waitFor(
        () =>
          actionEvents.some(
            (e) =>
              e.channel === opts.channel &&
              e.action?.type === "session/customizationToggled" &&
              e.action?.id === agentDirId &&
              e.rejectionReason !== undefined,
          ),
        `rejected toggle for ${agentDirId}`,
      );
      const rejected = actionEvents.find(
        (e) =>
          e.channel === opts.channel &&
          e.action?.type === "session/customizationToggled" &&
          e.action?.id === agentDirId &&
          e.rejectionReason !== undefined,
      );
      if (rejected === undefined) throw new Error(`rejected toggle for ${agentDirId} not found`);
      check(
        "toggle off rejected for the agent directory",
        /static file\/config definitions/.test(rejected.rejectionReason ?? ""),
        rejected.rejectionReason,
      );
    }

    // 4c. re-enable via the dedicated control action (always run: the
    //     test server must be left with the target server connected).
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "dispatchAction",
        params: {
          channel: opts.channel,
          clientSeq: 3,
          action: { type: "session/mcpServerStartRequested", id: targetId },
        },
      }),
    );
    await waitFor(
      () =>
        actionEvents.some(
          (e) =>
            e.channel === opts.channel &&
            e.action?.type === "session/mcpServerStartRequested" &&
            e.action?.id === targetId &&
            e.rejectionReason === undefined,
        ),
      `accepted mcpServerStartRequested for ${targetId}`,
    );
    check("toggle on accepted (no rejection)", true, targetId);
    await waitFor(
      () =>
        actionEvents.some(
          (e) =>
            e.channel === opts.channel &&
            e.action?.type === "session/customizationsChanged" &&
            findEntry(e)?.state?.kind === "ready" &&
            findEntry(e)?.enablement === undefined,
        ),
      `re-pushed catalog with ${targetId} ready`,
    );
    const mcpAfterOn = await httpMcp();
    check(
      "opencode side: the server is connected again",
      mcpAfterOn.find((m) => m.name === mcpTarget.name)?.status === "connected",
      mcpAfterOn.map((m) => `${m.name}:${m.status}`).join(", "),
    );
  }

  ws.close();
  if (failures > 0) {
    console.error(`${TAG} ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log(`${TAG} all checks passed`);
  process.exit(0);
} catch (err) {
  fail(1, err instanceof Error ? err.message : String(err));
}
