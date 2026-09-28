import { fixtureModelSettings } from "../../test/model-catalog.js";
import assert from "node:assert/strict";
import test from "node:test";
import { ClientCommandSchema, InteractionResponseSchema } from "./protocol.js";

test("rejects commands with empty identifiers", () => {
  const result = ClientCommandSchema.safeParse({
    type: "session.subscribe",
    requestId: "",
    sessionId: "",
  });

  assert.equal(result.success, false);
});

test("requires an imported project ID when creating a session", () => {
  const accepted = ClientCommandSchema.safeParse({
    type: "session.create",
    requestId: "create-1",
    provider: "codex",
    projectId: "project-1",
    path: "/work/project-1",
    content: [{ type: "text", text: "hello" }],
    modelSettings: fixtureModelSettings,
  });
  const missingProject = ClientCommandSchema.safeParse({
    type: "session.create",
    requestId: "create-2",
    provider: "codex",
    path: "/work/project-2",
    content: [{ type: "text", text: "hello" }],
    modelSettings: fixtureModelSettings,
  });

  assert.equal(accepted.success, true);
  assert.equal(missingProject.success, false);
});

test("accepts question answers with multiple selections", () => {
  const response = InteractionResponseSchema.parse({
    decision: "answer",
    answers: { approach: ["A", "B"] },
  });

  assert(response.decision === "answer");
  assert.deepEqual(response.answers.approach, ["A", "B"]);
});

test("every task requires the complete current model settings contract", () => {
  for (const type of ["session.create", "turn.start"]) {
    const base = {
      type,
      requestId: "request",
      content: [{ type: "text", text: "hello" }],
      ...(type === "session.create"
        ? { provider: "codex", projectId: "project", path: "/work/project" }
        : { sessionId: "session" }),
    };
    assert.equal(ClientCommandSchema.safeParse(base).success, false);
    assert.equal(
      ClientCommandSchema.safeParse({
        ...base,
        modelSettings: { modelId: "model" },
      }).success,
      false,
    );
    assert.equal(
      ClientCommandSchema.safeParse({
        ...base,
        modelSettings: { ...fixtureModelSettings, effort: "high" },
      }).success,
      false,
    );
    assert.equal(
      ClientCommandSchema.safeParse({
        ...base,
        modelSettings: fixtureModelSettings,
      }).success,
      true,
    );
  }
});

test("rejects unknown command and interaction response fields", () => {
  assert.equal(
    ClientCommandSchema.safeParse({
      type: "session.create",
      requestId: "create-1",
      provider: "codex",
      projectId: "project-1",
      path: "/work/project-1",
      cwd: "/work/project",
      content: [{ type: "text", text: "hello" }],
      modelSettings: fixtureModelSettings,
    }).success,
    false,
  );
  assert.equal(
    ClientCommandSchema.safeParse({
      type: "interaction.resolve",
      requestId: "answer-1",
      interactionId: "question-1",
      response: { decision: "answer", answers: {}, extra: true },
    }).success,
    false,
  );
});

test("interaction responses accept answers or cancellation only", () => {
  assert.equal(
    InteractionResponseSchema.safeParse({ decision: "answer", answers: {} })
      .success,
    true,
  );
  assert.equal(
    InteractionResponseSchema.safeParse({
      decision: "deny",
      message: "Cancelled",
    }).success,
    true,
  );
  assert.equal(
    InteractionResponseSchema.safeParse({ decision: "allow" }).success,
    false,
  );
});

test("image-only commands use the current content contract and reject legacy prompt fields", () => {
  const base = {
    type: "turn.start",
    requestId: "image",
    sessionId: "session",
    modelSettings: fixtureModelSettings,
  };
  assert.equal(
    ClientCommandSchema.safeParse({
      ...base,
      content: [{ type: "image", mediaType: "image/png", data: "aW1hZ2U=" }],
    }).success,
    true,
  );
  assert.equal(
    ClientCommandSchema.safeParse({ ...base, prompt: "legacy" }).success,
    false,
  );
  assert.equal(
    ClientCommandSchema.safeParse({
      ...base,
      content: [{ type: "text", text: "valid" }],
      prompt: "legacy",
    }).success,
    false,
  );
  assert.equal(
    ClientCommandSchema.safeParse({ ...base, content: [] }).success,
    false,
  );
});

test("image support does not impose a separate character limit on text input", () => {
  const command = {
    type: "turn.start",
    requestId: "long-text",
    sessionId: "session",
    modelSettings: fixtureModelSettings,
    content: [{ type: "text", text: "x".repeat(1024 * 1024) }],
  };
  assert.equal(ClientCommandSchema.safeParse(command).success, true);
});
