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
    prompt: "hello",
    modelSettings: fixtureModelSettings,
  });
  const missingProject = ClientCommandSchema.safeParse({
    type: "session.create",
    requestId: "create-2",
    provider: "codex",
    prompt: "hello",
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
      prompt: "hello",
      ...(type === "session.create"
        ? { provider: "codex", projectId: "project" }
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
      cwd: "/work/project",
      prompt: "hello",
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
