import assert from "node:assert/strict";
import test from "node:test";
import { claudeModelCatalog, codexModelCatalog } from "./model-options.js";

test("Codex retains native names and model-specific effort strings", () => {
  const row = {
    model: "test-model",
    displayName: "Provider NAME",
    description: "native description",
    hidden: false,
    inputModalities: ["text"],
    isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: "xhigh", description: "native effort description" },
      { reasoningEffort: "ultra", description: "" },
    ],
    defaultReasoningEffort: "xhigh",
  };
  const catalog = codexModelCatalog([
    row,
    { ...row, model: "hidden", hidden: true },
    { ...row, model: "audio-only", inputModalities: ["audio"] },
  ]);
  assert.equal(catalog.suggestedModelId, "test-model");
  assert.deepEqual(catalog.models, [
    {
      id: "test-model",
      displayName: "Provider NAME",
      description: "native description",
      reasoningEffort: {
        status: "supported",
        options: [
          { value: "xhigh", description: "native effort description" },
          { value: "ultra", description: "" },
        ],
        suggestedValue: "xhigh",
      },
    },
  ]);
  assert.equal(
    codexModelCatalog([{ ...row, defaultReasoningEffort: "missing" }]).models[0]
      .reasoningEffort.status,
    "unavailable",
  );
});

test("Claude distinguishes unsupported, incomplete and valid effort capabilities", () => {
  const base = {
    value: "native-alias",
    displayName: "Native model",
    description: "",
  };
  const model = (extra: object) =>
    claudeModelCatalog([{ ...base, ...extra }]).models[0];
  assert.deepEqual(model({ supportsEffort: false }).reasoningEffort, {
    status: "unsupported",
  });
  assert.equal(model({}).reasoningEffort.status, "unavailable");
  assert.equal(
    model({ supportsEffort: true }).reasoningEffort.status,
    "unavailable",
  );
  assert.equal(
    model({ supportsEffort: false, supportedEffortLevels: ["high"] })
      .reasoningEffort.status,
    "unavailable",
  );
  assert.equal(
    model({
      supportsEffort: true,
      supportedEffortLevels: ["not-an-sdk-effort"],
    }).reasoningEffort.status,
    "unavailable",
  );
  const result = model({
    supportsEffort: true,
    supportedEffortLevels: ["high", "max"],
  });
  assert.equal(result.id, "native-alias");
  assert.deepEqual(result.reasoningEffort, {
    status: "supported",
    options: [
      { value: "high", description: "" },
      { value: "max", description: "" },
    ],
    suggestedValue: "high",
  });
});
