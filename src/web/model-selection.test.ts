import assert from "node:assert/strict";
import test from "node:test";
import { fixtureModelCatalog } from "../../test/model-catalog.js";
import { modelSettingsError } from "../shared/model-settings.js";
import { selectModel } from "./model-selection.js";

test("model changes preserve a supported effort or select a concrete suggestion", () => {
  const { models } = fixtureModelCatalog();
  assert.deepEqual(selectModel(models[0], "xhigh"), {
    modelId: "fixture-primary",
    reasoningEffort: "xhigh",
  });
  assert.deepEqual(selectModel(models[1], "xhigh"), {
    modelId: "fixture-fast",
    reasoningEffort: "low",
  });
  assert.deepEqual(selectModel(models[1], "medium"), {
    modelId: "fixture-fast",
    reasoningEffort: "medium",
  });
  assert.deepEqual(selectModel(models[2], "high"), {
    modelId: "fixture-fixed",
    reasoningEffort: null,
  });
});

test("validation never interprets null as a default for an adjustable model", () => {
  const catalog = fixtureModelCatalog();
  assert(
    modelSettingsError(catalog, {
      modelId: "fixture-primary",
      reasoningEffort: null,
    }),
  );
  assert(
    modelSettingsError(catalog, {
      modelId: "fixture-fast",
      reasoningEffort: "xhigh",
    }),
  );
  assert(
    modelSettingsError(catalog, {
      modelId: "fixture-fixed",
      reasoningEffort: "high",
    }),
  );
  assert.equal(
    modelSettingsError(catalog, {
      modelId: "fixture-fixed",
      reasoningEffort: null,
    }),
    undefined,
  );
});
