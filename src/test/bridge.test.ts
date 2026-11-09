import { describe, expect, it } from "vitest";
import {
  ChangesetOperationScope,
  ChangesetOperationStatus,
  type AgentCustomization,
  type DirectoryCustomization,
} from "@microsoft/agent-host-protocol";
import {
  agentDirectoryCustomization,
  agentUri,
  buildTurnChangesetFiles,
  buildWorkingChangesetFiles,
  chatChangesetCatalog,
  computeLineDiffStats,
  DISCARD_OPERATION_ID,
  discardOperation,
  fileUri,
  headContentRef,
  mapAgentCustomizations,
  mapCatalog,
  mapV2Event,
  parseContentRef,
  sessionChangesetCatalog,
  snapContentRef,
  type FacadeAgent,
  type FacadeProvider,
} from "../bridge.js";

const provider = (over: Partial<FacadeProvider> = {}): FacadeProvider => ({
  providerID: "gpuz",
  name: "gpuz",
  activation: "auto",
  models: [
    {
      providerID: "gpuz",
      modelID: "qwen3.8-27b-q5xl",
      name: "Qwen 3.8",
      enabled: true,
      limit: { context: 262144, output: 32768, input: 229376 },
      inputModalities: ["text", "image"],
    },
  ],
  ...over,
});

const facadeAgent = (over: Partial<FacadeAgent> = {}): FacadeAgent => ({
  id: "build",
  name: "Build",
  mode: "primary",
  hidden: false,
  ...over,
});

describe("mapCatalog", () => {
  it("maps a provider to an AgentInfo with the model ref and limits", () => {
    const agents = mapCatalog([provider()]);
    expect(agents).toEqual([
      {
        provider: "gpuz",
        displayName: "gpuz",
        description: "gpuz", // falls back to the name
        models: [
          {
            id: "gpuz/qwen3.8-27b-q5xl",
            provider: "gpuz",
            name: "Qwen 3.8",
            supportsVision: true,
            maxContextWindow: 262144,
            maxOutputTokens: 32768,
            maxPromptTokens: 229376,
          },
        ],
        capabilities: { multipleChats: {} },
      },
    ]);
  });

  it("advertises plain multi-chat (no fork/sideChat sub-caps — plan §14.13)", () => {
    const agents = mapCatalog([provider()]);
    // Empty object = multi-chat without source-based creation; conformant
    // clients (VS Code gates its fork UI on `multipleChats.fork`) never
    // attempt the unsupported forms.
    expect(agents[0]!.capabilities).toEqual({ multipleChats: {} });
    expect(agents[0]!.capabilities?.multipleChats?.fork).toBeUndefined();
    expect(agents[0]!.capabilities?.multipleChats?.sideChat).toBeUndefined();
    expect(agents[0]!.capabilities?.multipleWorkingDirectories).toBeUndefined();
  });

  it("uses an explicit description when present", () => {
    const agents = mapCatalog([provider({ description: "GP.UZ local LLM box" })]);
    expect(agents[0]!.description).toBe("GP.UZ local LLM box");
  });

  it("omits limit fields the model does not declare", () => {
    const agents = mapCatalog([
      provider({
        models: [
          {
            providerID: "gpuz",
            modelID: "m",
            name: "m",
            enabled: true,
            limit: {},
            inputModalities: ["text"],
          },
        ],
      }),
    ]);
    expect(agents[0]!.models).toEqual([
      { id: "gpuz/m", provider: "gpuz", name: "m", supportsVision: false },
    ]);
  });

  it("excludes models with enabled: false", () => {
    const agents = mapCatalog([
      provider({
        models: [
          {
            providerID: "gpuz",
            modelID: "off",
            name: "Off",
            enabled: false,
            limit: {},
            inputModalities: ["text"],
          },
          {
            providerID: "gpuz",
            modelID: "on",
            name: "On",
            enabled: true,
            limit: {},
            inputModalities: ["text"],
          },
        ],
      }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.models.map((m) => m.id)).toEqual(["gpuz/on"]);
  });

  it("excludes providers with activation: disabled (auto and enabled stay)", () => {
    const agents = mapCatalog([
      provider({ providerID: "a", name: "a", activation: "auto" }),
      provider({ providerID: "b", name: "b", activation: "enabled" }),
      provider({ providerID: "c", name: "c", activation: "disabled" }),
    ]);
    expect(agents.map((a) => a.provider)).toEqual(["a", "b"]);
  });

  it("keeps a provider with no surviving models (visible, empty picker)", () => {
    const agents = mapCatalog([
      provider({
        models: [
          {
            providerID: "gpuz",
            modelID: "off",
            name: "Off",
            enabled: false,
            limit: {},
            inputModalities: ["text"],
          },
        ],
      }),
    ]);
    expect(agents.map((a) => [a.provider, a.models])).toEqual([["gpuz", []]]);
  });

  it("returns an empty list for an empty catalog", () => {
    expect(mapCatalog([])).toEqual([]);
  });

  it("supportsVision requires 'image' in the input modalities", () => {
    const agents = mapCatalog([
      provider({
        models: [
          {
            providerID: "gpuz",
            modelID: "txt",
            name: "txt",
            enabled: true,
            limit: {},
            inputModalities: ["text"],
          },
          {
            providerID: "gpuz",
            modelID: "img",
            name: "img",
            enabled: true,
            limit: {},
            inputModalities: ["text", "image"],
          },
        ],
      }),
    ]);
    expect(agents[0]!.models[0]!.supportsVision).toBe(false);
    expect(agents[0]!.models[1]!.supportsVision).toBe(true);
  });

  it("attaches the workspace agent container to every provider when agents exist", () => {
    const agents = mapCatalog(
      [provider({ providerID: "a", name: "a" }), provider({ providerID: "b", name: "b" })],
      [facadeAgent()],
      "/tmp/opencode/ahp-scratch/project-lan",
    );
    expect(agents).toHaveLength(2);
    for (const agent of agents) {
      expect(agent.customizations).toHaveLength(1);
      const container = agent.customizations?.[0] as DirectoryCustomization;
      expect(container.type).toBe("directory");
      expect(container.children?.map((c) => c.name)).toEqual(["Build"]);
    }
    // The same container instance is shared across providers.
    expect(agents[0]!.customizations).toBe(agents[1]!.customizations);
  });

  it("omits customizations when there are no visible agents or no workspace", () => {
    const hiddenOnly = mapCatalog(
      [provider()],
      [facadeAgent({ id: "title", name: "Title", hidden: true })],
      "/tmp/project-lan",
    );
    expect(hiddenOnly[0]!.customizations).toBeUndefined();

    const noWorkspace = mapCatalog([provider()], [facadeAgent()]);
    expect(noWorkspace[0]!.customizations).toBeUndefined();

    const noAgents = mapCatalog([provider()], [], "/tmp/project-lan");
    expect(noAgents[0]!.customizations).toBeUndefined();
  });
});

describe("mapAgentCustomizations", () => {
  it("maps the plan §14.7 fields (name, description, pinned model ref)", () => {
    const child = mapAgentCustomizations([
      facadeAgent({
        description: "Default build agent",
        model: { providerID: "gpuz", modelID: "qwen3.8-27b-q5xl" },
      }),
    ])[0]!;
    expect(child).toEqual({
      type: "agent",
      id: agentUri("build"),
      uri: agentUri("build"),
      name: "Build",
      description: "Default build agent",
      model: "gpuz/qwen3.8-27b-q5xl",
    });
  });

  it("leaves description and model absent when the agent declares none", () => {
    const child = mapAgentCustomizations([facadeAgent({ id: "plan", name: "Plan" })])[0]!;
    expect(child).toEqual({ type: "agent", id: agentUri("plan"), uri: agentUri("plan"), name: "Plan" });
    expect("description" in child).toBe(false);
    expect("model" in child).toBe(false);
  });

  it("omits hidden (internal) agents", () => {
    const out = mapAgentCustomizations([
      facadeAgent(),
      facadeAgent({ id: "title", name: "Title", hidden: true }),
      facadeAgent({ id: "compaction", name: "Compaction", hidden: true }),
    ]);
    expect(out.map((c) => c.name)).toEqual(["Build"]);
  });

  it("marks subagent-mode agents as non-user-selectable", () => {
    const [sub, all, primary] = mapAgentCustomizations([
      facadeAgent({ id: "explore", name: "Explore", mode: "subagent" }),
      facadeAgent({ id: "both", name: "Both", mode: "all" }),
      facadeAgent(),
    ]) as [AgentCustomization, AgentCustomization, AgentCustomization];
    expect(sub.disableUserInvocation).toBe(true);
    expect("disableUserInvocation" in all).toBe(false);
    expect("disableUserInvocation" in primary).toBe(false);
  });

  it("returns an empty list for an empty input", () => {
    expect(mapAgentCustomizations([])).toEqual([]);
  });
});

describe("agentDirectoryCustomization", () => {
  it("builds a read-only, loaded directory container with agent children", () => {
    const dir = agentDirectoryCustomization("/tmp/opencode/ahp-scratch/project-lan", [
      facadeAgent(),
      facadeAgent({ id: "title", name: "Title", hidden: true }),
    ]);
    expect(dir).toEqual({
      type: "directory",
      id: "opencode:directory:/tmp/opencode/ahp-scratch/project-lan",
      uri: "file:///tmp/opencode/ahp-scratch/project-lan",
      name: "project-lan",
      enabled: true,
      contents: "agent",
      writable: false,
      load: { kind: "loaded" },
      children: [
        { type: "agent", id: agentUri("build"), uri: agentUri("build"), name: "Build" },
      ],
    });
  });

  it("falls back to 'workspace' for a directory without a basename", () => {
    const dir = agentDirectoryCustomization("", [facadeAgent()]);
    expect(dir.name).toBe("workspace");
  });
});

// ── mapV2Event ─────────────────────────────────────────────────────────────

/** A raw V2 event in the fixture shape, defaulting sessionID to "ses_test". */
const v2 = (type: string, data: Record<string, unknown> = {}): unknown => ({
  id: "evt_test",
  created: 1794098337876,
  type,
  location: { directory: "/tmp/project" },
  data: { sessionID: "ses_test", ...data },
});

describe("mapV2Event", () => {
  describe("session lifecycle", () => {
    it("maps session.created with title, agent, and pinned model", () => {
      expect(
        mapV2Event(
          v2("session.created", {
            title: "My session",
            agent: "build",
            model: { id: "qwen3.8", providerID: "gpuz" },
          }),
        ),
      ).toEqual({
        type: "session.created",
        sessionID: "ses_test",
        title: "My session",
        agent: "build",
        model: { providerID: "gpuz", modelID: "qwen3.8" },
      });
    });

    it("maps a sparse session.created with the optional fields undefined", () => {
      const ev = mapV2Event(v2("session.created"));
      expect(ev).toEqual({ type: "session.created", sessionID: "ses_test" });
      expect(ev?.type === "session.created" && ev.title).toBeUndefined();
      expect(ev?.type === "session.created" && ev.agent).toBeUndefined();
      expect(ev?.type === "session.created" && ev.model).toBeUndefined();
    });

    it("maps session.deleted", () => {
      expect(mapV2Event(v2("session.deleted"))).toEqual({
        type: "session.deleted",
        sessionID: "ses_test",
      });
    });

    it("maps session.renamed, and drops it without a title", () => {
      expect(mapV2Event(v2("session.renamed", { title: "New name" }))).toEqual({
        type: "session.renamed",
        sessionID: "ses_test",
        title: "New name",
      });
      expect(mapV2Event(v2("session.renamed"))).toBeNull();
    });
  });

  describe("inbox", () => {
    it("maps inbox.enqueued with a top-level delivery", () => {
      expect(
        mapV2Event(
          v2("session.inbox.enqueued", {
            inboxID: "msg_1",
            item: { type: "user", payload: { text: "hello" }, delivery: "queue" },
            delivery: "steer",
          }),
        ),
      ).toEqual({
        type: "inbox.enqueued",
        sessionID: "ses_test",
        inboxID: "msg_1",
        text: "hello",
        delivery: "steer",
      });
    });

    it("falls back to the item's delivery, then to default", () => {
      const fromItem = mapV2Event(
        v2("session.inbox.enqueued", {
          inboxID: "msg_2",
          item: { type: "user", payload: { text: "hi" }, delivery: "queue" },
        }),
      );
      expect(fromItem).toMatchObject({ delivery: "queue" });

      const dflt = mapV2Event(
        v2("session.inbox.enqueued", {
          inboxID: "msg_3",
          item: { type: "user", payload: { text: "hi" } },
        }),
      );
      expect(dflt).toMatchObject({ delivery: "default" });
    });

    it("drops inbox.enqueued without an inboxID or a payload text", () => {
      expect(
        mapV2Event(
          v2("session.inbox.enqueued", {
            item: { type: "user", payload: { text: "no id" } },
          }),
        ),
      ).toBeNull();
      expect(
        mapV2Event(
          v2("session.inbox.enqueued", {
            inboxID: "msg_4",
            item: { type: "user", payload: {} },
          }),
        ),
      ).toBeNull();
    });

    it("maps inbox.delivered, and drops it without an inboxID", () => {
      expect(mapV2Event(v2("session.inbox.delivered", { inboxID: "msg_5" }))).toEqual({
        type: "inbox.delivered",
        sessionID: "ses_test",
        inboxID: "msg_5",
      });
      expect(mapV2Event(v2("session.inbox.delivered"))).toBeNull();
    });
  });

  describe("execution terminals", () => {
    it("maps execution.started and execution.succeeded", () => {
      expect(mapV2Event(v2("session.execution.started"))).toEqual({
        type: "execution.started",
        sessionID: "ses_test",
      });
      expect(mapV2Event(v2("session.execution.succeeded"))).toEqual({
        type: "execution.succeeded",
        sessionID: "ses_test",
      });
    });

    it("maps execution.failed with the error object, defaulting absent fields", () => {
      expect(
        mapV2Event(v2("session.execution.failed", { error: { type: "api", message: "boom" } })),
      ).toEqual({
        type: "execution.failed",
        sessionID: "ses_test",
        error: { type: "api", message: "boom" },
      });
      expect(mapV2Event(v2("session.execution.failed"))).toEqual({
        type: "execution.failed",
        sessionID: "ses_test",
        error: { type: "error", message: "" },
      });
    });

    it("maps execution.interrupted, defaulting the reason to 'user'", () => {
      expect(
        mapV2Event(v2("session.execution.interrupted", { reason: "interrupted" })),
      ).toEqual({ type: "execution.interrupted", sessionID: "ses_test", reason: "interrupted" });
      expect(mapV2Event(v2("session.execution.interrupted"))).toEqual({
        type: "execution.interrupted",
        sessionID: "ses_test",
        reason: "user",
      });
    });
  });

  describe("steps and parts", () => {
    it("maps step.started with the model ref (including a variant)", () => {
      expect(
        mapV2Event(
          v2("session.step.started", {
            assistantMessageID: "msg_a1",
            agent: "plan",
            model: { id: "qwen3.8", providerID: "gpuz", variant: "high" },
          }),
        ),
      ).toEqual({
        type: "step.started",
        sessionID: "ses_test",
        assistantMessageID: "msg_a1",
        agent: "plan",
        model: { providerID: "gpuz", modelID: "qwen3.8", variant: "high" },
      });
    });

    it("defaults the step agent to 'build' when absent", () => {
      const ev = mapV2Event(
        v2("session.step.started", {
          assistantMessageID: "msg_a2",
          model: { id: "m", providerID: "gpuz" },
        }),
      );
      expect(ev).toMatchObject({ agent: "build" });
    });

    it("drops step.started without an assistantMessageID or a usable model", () => {
      expect(
        mapV2Event(v2("session.step.started", { model: { id: "m", providerID: "gpuz" } })),
      ).toBeNull();
      expect(
        mapV2Event(v2("session.step.started", { assistantMessageID: "msg_a3" })),
      ).toBeNull();
      expect(
        mapV2Event(
          v2("session.step.started", {
            assistantMessageID: "msg_a4",
            model: { id: "m" }, // no providerID
          }),
        ),
      ).toBeNull();
    });

    it("maps text and reasoning deltas with the ordinal", () => {
      expect(
        mapV2Event(
          v2("session.text.delta", { assistantMessageID: "msg_a1", ordinal: 0, delta: "Hel" }),
        ),
      ).toEqual({
        type: "text.delta",
        sessionID: "ses_test",
        assistantMessageID: "msg_a1",
        ordinal: 0,
        delta: "Hel",
      });
      expect(
        mapV2Event(
          v2("session.reasoning.delta", { assistantMessageID: "msg_a1", ordinal: 1, delta: "th" }),
        ),
      ).toEqual({
        type: "reasoning.delta",
        sessionID: "ses_test",
        assistantMessageID: "msg_a1",
        ordinal: 1,
        delta: "th",
      });
    });

    it("drops deltas missing the message id, the delta, or the ordinal", () => {
      expect(mapV2Event(v2("session.text.delta", { ordinal: 0, delta: "x" }))).toBeNull();
      expect(mapV2Event(v2("session.text.delta", { assistantMessageID: "m", ordinal: 0 }))).toBeNull();
      expect(
        mapV2Event(v2("session.text.delta", { assistantMessageID: "m", delta: "x" })),
      ).toBeNull();
    });

    it("maps text and reasoning ended with the full text", () => {
      expect(
        mapV2Event(
          v2("session.text.ended", { assistantMessageID: "msg_a1", ordinal: 0, text: "Hello" }),
        ),
      ).toEqual({
        type: "text.ended",
        sessionID: "ses_test",
        assistantMessageID: "msg_a1",
        ordinal: 0,
        text: "Hello",
      });
      expect(
        mapV2Event(
          v2("session.reasoning.ended", { assistantMessageID: "msg_a1", ordinal: 1, text: "thoughts" }),
        ),
      ).toEqual({
        type: "reasoning.ended",
        sessionID: "ses_test",
        assistantMessageID: "msg_a1",
        ordinal: 1,
        text: "thoughts",
      });
    });

    it("drops ended parts missing the message id, the text, or the ordinal", () => {
      expect(mapV2Event(v2("session.text.ended", { ordinal: 0, text: "x" }))).toBeNull();
      expect(mapV2Event(v2("session.text.ended", { assistantMessageID: "m", ordinal: 0 }))).toBeNull();
      expect(
        mapV2Event(v2("session.reasoning.ended", { assistantMessageID: "m", text: "x" })),
      ).toBeNull();
    });
  });

  describe("tools", () => {
    it("maps tool.input.started, requiring id, name, and the message id", () => {
      expect(
        mapV2Event(
          v2("session.tool.input.started", {
            assistantMessageID: "msg_a1",
            id: "tc1",
            name: "shell",
          }),
        ),
      ).toEqual({
        type: "tool.input.started",
        sessionID: "ses_test",
        assistantMessageID: "msg_a1",
        id: "tc1",
        name: "shell",
      });
      expect(
        mapV2Event(v2("session.tool.input.started", { assistantMessageID: "m", id: "tc1" })),
      ).toBeNull();
      expect(
        mapV2Event(v2("session.tool.input.started", { id: "tc1", name: "shell" })),
      ).toBeNull();
    });

    it("maps tool.input.ended, requiring id, text, and the message id", () => {
      expect(
        mapV2Event(
          v2("session.tool.input.ended", {
            assistantMessageID: "msg_a1",
            id: "tc1",
            text: '{"command":"echo hi"}',
          }),
        ),
      ).toEqual({
        type: "tool.input.ended",
        sessionID: "ses_test",
        assistantMessageID: "msg_a1",
        id: "tc1",
        text: '{"command":"echo hi"}',
      });
      expect(
        mapV2Event(v2("session.tool.input.ended", { assistantMessageID: "m", id: "tc1" })),
      ).toBeNull();
    });

    it("maps tool.progress, requiring the id", () => {
      expect(mapV2Event(v2("session.tool.progress", { id: "tc1" }))).toEqual({
        type: "tool.progress",
        sessionID: "ses_test",
        id: "tc1",
      });
      expect(mapV2Event(v2("session.tool.progress"))).toBeNull();
    });

    it("maps tool.success with the toolable content entries only", () => {
      const ev = mapV2Event(
        v2("session.tool.success", {
          id: "tc1",
          executed: true,
          content: [
            { type: "text", text: "hello-ahp\n" },
            { type: "file", patch: "diff --git a/x b/x" },
            { type: "patch", text: "diff --git a/y b/y" },
            { type: "notebook", text: "ignored" }, // not a toolable content type
            "not-an-object",
          ],
        }),
      );
      expect(ev).toEqual({
        type: "tool.success",
        sessionID: "ses_test",
        id: "tc1",
        content: [
          { type: "text", text: "hello-ahp\n" },
          { type: "file", text: "diff --git a/x b/x" },
          { type: "patch", text: "diff --git a/y b/y" },
        ],
        executed: true,
      });
    });

    it("treats tool.success without executed as executed: false and content: []", () => {
      expect(mapV2Event(v2("session.tool.success", { id: "tc1" }))).toEqual({
        type: "tool.success",
        sessionID: "ses_test",
        id: "tc1",
        content: [],
        executed: false,
      });
    });

    it("maps tool.failed, defaulting a missing error object", () => {
      expect(
        mapV2Event(v2("session.tool.failed", { id: "tc1", error: { type: "cancelled", message: "denied" } })),
      ).toEqual({
        type: "tool.failed",
        sessionID: "ses_test",
        id: "tc1",
        error: { type: "cancelled", message: "denied" },
        executed: false,
      });
      expect(mapV2Event(v2("session.tool.failed", { id: "tc1", executed: true }))).toEqual({
        type: "tool.failed",
        sessionID: "ses_test",
        id: "tc1",
        error: { type: "error", message: "" },
        executed: true,
      });
      expect(mapV2Event(v2("session.tool.failed"))).toBeNull();
    });
  });

  describe("usage", () => {
    it("maps usage.updated with the full token breakdown", () => {
      expect(
        mapV2Event(
          v2("session.usage.updated", {
            tokens: { input: 6463, output: 53, reasoning: 7, cache: { read: 6516, write: 2 } },
          }),
        ),
      ).toEqual({
        type: "usage.updated",
        sessionID: "ses_test",
        tokens: { input: 6463, output: 53, reasoning: 7, cache: { read: 6516, write: 2 } },
      });
    });

    it("defaults missing token fields (and a missing cache object) to zero", () => {
      expect(
        mapV2Event(v2("session.usage.updated", { tokens: { input: 10 } })),
      ).toEqual({
        type: "usage.updated",
        sessionID: "ses_test",
        tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      });
    });

    it("drops usage.updated without a tokens object", () => {
      expect(mapV2Event(v2("session.usage.updated"))).toBeNull();
      expect(mapV2Event(v2("session.usage.updated", { tokens: "nonsense" }))).toBeNull();
    });
  });

  describe("permissions", () => {
    it("maps permission.asked with a tool source", () => {
      expect(
        mapV2Event(
          v2("permission.asked", {
            id: "perm_1",
            action: "shell",
            message: "Run shell command",
            source: { type: "tool", messageID: "msg_a1", id: "tc1" },
          }),
        ),
      ).toEqual({
        type: "permission.asked",
        sessionID: "ses_test",
        id: "perm_1",
        action: "shell",
        message: "Run shell command",
        source: { type: "tool", messageID: "msg_a1", id: "tc1" },
      });
    });

    it("drops a non-tool source and defaults the action to ''", () => {
      const ev = mapV2Event(
        v2("permission.asked", { id: "perm_2", source: { type: "other", id: "x" } }),
      );
      expect(ev).toEqual({
        type: "permission.asked",
        sessionID: "ses_test",
        id: "perm_2",
        action: "",
        message: undefined,
        source: undefined,
      });
    });

    it("drops permission.asked without an id", () => {
      expect(mapV2Event(v2("permission.asked", { action: "shell" }))).toBeNull();
    });

    it("maps permission.replied, requiring the requestID and the reply", () => {
      expect(
        mapV2Event(v2("permission.replied", { requestID: "perm_1", reply: "once" })),
      ).toEqual({
        type: "permission.replied",
        sessionID: "ses_test",
        requestID: "perm_1",
        reply: "once",
      });
      expect(
        mapV2Event(v2("permission.replied", { requestID: "perm_1" })),
      ).toBeNull();
      expect(mapV2Event(v2("permission.replied", { reply: "once" }))).toBeNull();
    });
  });

  describe("unknown and malformed input", () => {
    it("returns null for types the host does not consume", () => {
      expect(mapV2Event(v2("server.connected"))).toBeNull();
      expect(mapV2Event(v2("session.message.updated"))).toBeNull();
    });

    it("returns null when the event has no sessionID in its data", () => {
      expect(mapV2Event({ id: "e", type: "session.deleted", data: {} })).toBeNull();
      expect(mapV2Event({ id: "e", type: "session.deleted" })).toBeNull();
    });

    it("returns null for non-object raw values and missing/unknown types", () => {
      expect(mapV2Event(null)).toBeNull();
      expect(mapV2Event("session.deleted")).toBeNull();
      expect(mapV2Event(42)).toBeNull();
      expect(mapV2Event({ id: "e" })).toBeNull();
      expect(mapV2Event({ id: "e", type: 7, data: { sessionID: "s" } })).toBeNull();
    });
  });
});

// ── Phase 2: changesets ───────────────────────────────────────────────────

describe("changeset catalogues", () => {
  it("session catalog: the session-wide changeset only (owner: the session channel)", () => {
    const catalog = sessionChangesetCatalog("ahp-session:/s-1");
    expect(catalog).toEqual([
      {
        label: "Session Changes",
        uriTemplate: "ahp-session:/s-1/changeset/session",
        changeKind: "session",
        capabilities: { review: {} },
      },
    ]);
  });

  it("chat catalog: uncommitted + session + the per-turn template (owner-aware URIs)", () => {
    const catalog = chatChangesetCatalog("ahp-chat:/s-1", "ahp-session:/s-1");
    expect(catalog.map((c) => [c.label, c.uriTemplate, c.changeKind])).toEqual([
      ["Uncommitted Changes", "ahp-chat:/s-1/changeset/uncommitted", "uncommitted"],
      ["Session Changes", "ahp-session:/s-1/changeset/session", "session"],
      ["Turn Changes", "ahp-chat:/s-1/changeset/turn/{turnId}", "turn"],
    ]);
    for (const c of catalog) expect(c.capabilities).toEqual({ review: {} });
  });

  it("chat catalog: a peer chat's uncommitted/turn changesets key off its own URI", () => {
    const catalog = chatChangesetCatalog("ahp-chat:/peer-1", "ahp-session:/s-1");
    expect(catalog.map((c) => [c.label, c.uriTemplate, c.changeKind])).toEqual([
      ["Uncommitted Changes", "ahp-chat:/peer-1/changeset/uncommitted", "uncommitted"],
      ["Session Changes", "ahp-session:/s-1/changeset/session", "session"],
      ["Turn Changes", "ahp-chat:/peer-1/changeset/turn/{turnId}", "turn"],
    ]);
  });
});

describe("content refs", () => {
  it("builds file:// URIs for the ChangesetFile id / live-disk side", () => {
    expect(fileUri("/tmp/opencode/ahp-scratch/project-lan/a.txt")).toBe(
      "file:///tmp/opencode/ahp-scratch/project-lan/a.txt",
    );
  });

  it("head + snap refs round-trip through parseContentRef", () => {
    const head = headContentRef("/tmp/repo/a.txt");
    expect(head).toMatch(/^ahp-content:\/\/head\//);
    expect(parseContentRef(head)).toEqual({ kind: "head", path: "/tmp/repo/a.txt" });

    for (const part of ["before", "after"] as const) {
      const snap = snapContentRef("ses_1", "turn-9", "/tmp/repo/deep/dir/a file.txt", part);
      expect(snap).toMatch(new RegExp(`^ahp-content://snap/.*${part}$`));
      expect(parseContentRef(snap)).toEqual({
        kind: "snap",
        sessionID: "ses_1",
        turnId: "turn-9",
        path: "/tmp/repo/deep/dir/a file.txt",
        part,
      });
    }
  });

  it("snap ref segments are opaque (no raw path separators leak in)", () => {
    const ref = snapContentRef("ses/1", "turn/9", "/a/b/c.txt", "before");
    // only the four intended segments + the marker — slashes inside the
    // encoded values must not add segments
    const segments = ref.slice("ahp-content://snap/".length).split("/");
    expect(segments).toHaveLength(4);
    expect(parseContentRef(ref)).not.toBeNull();
  });

  it("rejects junk refs", () => {
    expect(parseContentRef("ahp-content://head/")).toBeNull();
    expect(parseContentRef("ahp-content://head/../../etc/passwd")).toBeNull();
    expect(parseContentRef("ahp-content://snap/abc/def/ghi")).toBeNull(); // 3 segments
    expect(parseContentRef("ahp-content://snap/abc/def/ghi/jkl/mno")).toBeNull(); // 5
    expect(parseContentRef("ahp-content://snap/abc/def/ghi/both")).toBeNull(); // bad part
    expect(parseContentRef("ahp-content://head/a/../b")).toBeNull(); // raw separator in segment
    expect(parseContentRef("file:///x")).toBeNull();
    expect(parseContentRef("https://x")).toBeNull();
  });
});

describe("computeLineDiffStats", () => {
  it("null/empty sides are pure adds/removes", () => {
    expect(computeLineDiffStats(null, "a\nb\nc")).toEqual({ added: 3, removed: 0 });
    expect(computeLineDiffStats("", "a\nb")).toEqual({ added: 2, removed: 0 });
    expect(computeLineDiffStats("a\nb\nc", null)).toEqual({ added: 0, removed: 3 });
    expect(computeLineDiffStats(null, null)).toEqual({ added: 0, removed: 0 });
  });

  it("counts changed lines in the middle (prefix/suffix preserved)", () => {
    const old = "a\nb\nOLD\nd\ne";
    const next = "a\nb\nNEW\nNEW2\nd\ne";
    expect(computeLineDiffStats(old, next)).toEqual({ added: 2, removed: 1 });
  });

  it("normalizes CRLF and ignores the trailing newline", () => {
    const old = "a\r\nb\r\nc";
    const next = "a\nb\nc\n";
    expect(computeLineDiffStats(old, next)).toEqual({ added: 0, removed: 0 });
  });

  it("falls back to whole-middle counting above the 40 000-cell cap", () => {
    // 300 distinct old lines vs 300 distinct new lines → 90 000 > 40 000
    const old = Array.from({ length: 300 }, (_, i) => `o${i}`).join("\n");
    const next = Array.from({ length: 300 }, (_, i) => `n${i}`).join("\n");
    expect(computeLineDiffStats(old, next)).toEqual({ added: 300, removed: 300 });
  });
});

describe("discard operation", () => {
  it("has the gateway-identical shape (resource-scoped, idle)", () => {
    expect(discardOperation()).toEqual({
      id: DISCARD_OPERATION_ID,
      label: "Discard Changes",
      confirmation: "Are you sure you want to discard changes to this file?",
      icon: "discard",
      scopes: [ChangesetOperationScope.Resource],
      status: ChangesetOperationStatus.Idle,
    });
    expect(DISCARD_OPERATION_ID).toBe("discard-changes");
  });
});

describe("buildWorkingChangesetFiles", () => {
  const diff = (d: Partial<import("../bridge.js").FacadeDiffFile> & { path: string; status: "added" | "deleted" | "modified" }) => ({
    path: d.path,
    additions: d.additions ?? 0,
    deletions: d.deletions ?? 0,
    status: d.status,
  });

  it("added files: after only (live disk ref), no before", () => {
    const files = buildWorkingChangesetFiles({ diffs: [diff({ path: "/r/new.txt", status: "added", additions: 4 })], reviewedById: new Map() });
    expect(files).toEqual([
      {
        id: "file:///r/new.txt",
        edit: {
          after: { uri: "file:///r/new.txt", content: { uri: "file:///r/new.txt" } },
          diff: { added: 4, removed: 0 },
        },
      },
    ]);
  });

  it("deleted files: before only (HEAD ref), no after", () => {
    const files = buildWorkingChangesetFiles({ diffs: [diff({ path: "/r/gone.txt", status: "deleted", deletions: 7 })], reviewedById: new Map() });
    expect(files).toEqual([
      {
        id: "file:///r/gone.txt",
        edit: {
          before: { uri: "file:///r/gone.txt", content: { uri: headContentRef("/r/gone.txt") } },
          diff: { added: 0, removed: 7 },
        },
      },
    ]);
  });

  it("modified files: live disk after + HEAD before, with the diff stats", () => {
    const files = buildWorkingChangesetFiles({ diffs: [diff({ path: "/r/mod.txt", status: "modified", additions: 2, deletions: 1 })], reviewedById: new Map() });
    expect(files).toEqual([
      {
        id: "file:///r/mod.txt",
        edit: {
          before: { uri: "file:///r/mod.txt", content: { uri: headContentRef("/r/mod.txt") } },
          after: { uri: "file:///r/mod.txt", content: { uri: "file:///r/mod.txt" } },
          diff: { added: 2, removed: 1 },
        },
      },
    ]);
  });

  it("preserves the reviewed flag by file id and skips empty paths", () => {
    const reviewedById = new Map([["file:///r/mod.txt", true]]);
    const files = buildWorkingChangesetFiles({
      diffs: [diff({ path: "", status: "added" }), diff({ path: "/r/mod.txt", status: "modified" })],
      reviewedById,
    });
    expect(files).toEqual([
      {
        id: "file:///r/mod.txt",
        reviewed: true,
        edit: {
          before: { uri: "file:///r/mod.txt", content: { uri: headContentRef("/r/mod.txt") } },
          after: { uri: "file:///r/mod.txt", content: { uri: "file:///r/mod.txt" } },
          diff: { added: 0, removed: 0 },
        },
      },
    ]);
  });
});

describe("buildTurnChangesetFiles", () => {
  const snap = (files: Record<string, { before: string | null; after: string | null }>) =>
    new Map(Object.entries(files));

  it("drops before === after (no net change in the turn)", () => {
    const files = buildTurnChangesetFiles({
      sessionID: "s",
      turnId: "t1",
      files: snap({ "/r/same.txt": { before: "x", after: "x" } }),
      reviewedById: new Map(),
    });
    expect(files).toEqual([]);
  });

  it("added in the turn: after only, with the snap refs and line stats", () => {
    const files = buildTurnChangesetFiles({
      sessionID: "s",
      turnId: "t1",
      files: snap({ "/r/new.txt": { before: null, after: "a\nb\n" } }),
      reviewedById: new Map(),
    });
    expect(files).toEqual([
      {
        id: "file:///r/new.txt",
        edit: {
          after: { uri: "file:///r/new.txt", content: { uri: snapContentRef("s", "t1", "/r/new.txt", "after") } },
          diff: { added: 2, removed: 0 },
        },
      },
    ]);
  });

  it("deleted in the turn: before only", () => {
    const files = buildTurnChangesetFiles({
      sessionID: "s",
      turnId: "t1",
      files: snap({ "/r/gone.txt": { before: "a\nb", after: null } }),
      reviewedById: new Map(),
    });
    expect(files).toEqual([
      {
        id: "file:///r/gone.txt",
        edit: {
          before: { uri: "file:///r/gone.txt", content: { uri: snapContentRef("s", "t1", "/r/gone.txt", "before") } },
          diff: { added: 0, removed: 2 },
        },
      },
    ]);
  });

  it("modified in the turn: both snap refs + line stats, reviewed preserved", () => {
    const files = buildTurnChangesetFiles({
      sessionID: "s",
      turnId: "t1",
      files: snap({ "/r/mod.txt": { before: "a\nOLD\nc", after: "a\nNEW\nc" } }),
      reviewedById: new Map([["file:///r/mod.txt", true]]),
    });
    expect(files).toEqual([
      {
        id: "file:///r/mod.txt",
        reviewed: true,
        edit: {
          before: { uri: "file:///r/mod.txt", content: { uri: snapContentRef("s", "t1", "/r/mod.txt", "before") } },
          after: { uri: "file:///r/mod.txt", content: { uri: snapContentRef("s", "t1", "/r/mod.txt", "after") } },
          diff: { added: 1, removed: 1 },
        },
      },
    ]);
  });
});
