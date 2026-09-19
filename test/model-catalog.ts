import type {
  ModelSettings,
  ProviderModelCatalog,
} from "../src/shared/model-settings.js";

export const fixtureModelSettings: ModelSettings = {
  modelId: "fixture-primary",
  reasoningEffort: "high",
};
export function fixtureModelCatalog(): ProviderModelCatalog {
  return {
    models: [
      {
        id: "fixture-primary",
        displayName: "Fixture Primary",
        description: "Full reasoning range",
        reasoningEffort: {
          status: "supported",
          options: ["low", "medium", "high", "xhigh"].map((value) => ({
            value,
            description: "",
          })),
          suggestedValue: "high",
        },
      },
      {
        id: "fixture-fast",
        displayName: "Fixture Fast",
        description: "Limited reasoning range",
        reasoningEffort: {
          status: "supported",
          options: ["low", "medium"].map((value) => ({
            value,
            description: "",
          })),
          suggestedValue: "low",
        },
      },
      {
        id: "fixture-fixed",
        displayName: "Fixture Fixed",
        description: "No effort control",
        reasoningEffort: { status: "unsupported" },
      },
    ],
    suggestedModelId: "fixture-primary",
  };
}
