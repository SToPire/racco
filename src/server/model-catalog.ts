import { ProviderModelCatalogSchema } from "../shared/model-settings.js";
import type { Provider, ProviderModelCatalog } from "../shared/protocol.js";
import type { AgentDriver } from "./drivers/driver.js";

type Entry = {
  controller: AbortController;
  promise: Promise<ProviderModelCatalog>;
  expires: number;
};

/** Catalogs are scoped to the daemon's provider and canonical project directory. */
export class ModelCatalogCache {
  readonly #entries = new Map<string, Entry>();
  constructor(
    private readonly timeoutMs = 15_000,
    private readonly ttlMs = 60_000,
  ) {}

  get(
    driver: Pick<AgentDriver, "provider" | "listModels">,
    cwd: string,
  ): Promise<ProviderModelCatalog> {
    const key = JSON.stringify([driver.provider, cwd]);
    const existing = this.#entries.get(key);
    if (existing && existing.expires > Date.now()) return existing.promise;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("模型列表读取超时，请重试")),
      this.timeoutMs,
    );
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(controller.signal.reason),
        { once: true },
      );
    });
    const entry: Entry = {
      controller,
      expires: Infinity,
      promise: Promise.resolve({ models: [], suggestedModelId: null }),
    };
    entry.promise = Promise.race([
      driver.listModels({ cwd, signal: controller.signal }),
      cancelled,
    ])
      .then((value) => {
        const catalog = ProviderModelCatalogSchema.parse(value);
        entry.expires = Date.now() + this.ttlMs;
        return catalog;
      })
      .catch((error: unknown) => {
        if (this.#entries.get(key) === entry) this.#entries.delete(key);
        throw error;
      })
      .finally(() => clearTimeout(timer));
    this.#entries.set(key, entry);
    return entry.promise;
  }

  invalidate(provider: Provider, cwd: string): void {
    const key = JSON.stringify([provider, cwd]);
    this.#entries
      .get(key)
      ?.controller.abort(new Error("模型目录已失效，请重试"));
    this.#entries.delete(key);
  }

  close(): void {
    for (const entry of this.#entries.values())
      entry.controller.abort(new Error("Racco closed"));
    this.#entries.clear();
  }
}
