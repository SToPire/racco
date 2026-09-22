import { deriveWorktrees } from "./derive.js";
import type { DerivedCatalog } from "./derive.js";

type Entry = {
  promise?: Promise<DerivedCatalog>;
  pending: boolean;
  lastGood: DerivedCatalog | null;
};

/** Catalogs change only on first read, explicit refresh, or our own mutations. */
export class WorktreeCatalogCache {
  readonly #entries = new Map<string, Entry>();

  constructor(
    private readonly derive: typeof deriveWorktrees = deriveWorktrees,
  ) {}

  get(projectPath: string): Promise<DerivedCatalog> {
    return this.#entries.get(projectPath)?.promise ?? this.refresh(projectPath);
  }

  /** Coalesces concurrent refreshes while retaining the last complete catalog. */
  refresh(projectPath: string): Promise<DerivedCatalog> {
    const previous = this.#entries.get(projectPath);
    if (previous?.pending) return previous.promise!;
    const entry: Entry = {
      pending: true,
      lastGood: previous?.lastGood ?? null,
    };
    entry.promise = this.derive({ projectPath })
      .then((catalog) => {
        if (catalog.degradedReason === null) entry.lastGood = catalog;
        else if (entry.lastGood !== null) {
          return { ...entry.lastGood, degradedReason: catalog.degradedReason };
        }
        return catalog;
      })
      .catch((error: unknown): DerivedCatalog => {
        if (entry.lastGood === null) throw error;
        return {
          ...entry.lastGood,
          degradedReason:
            error instanceof Error ? error.message : String(error),
        };
      })
      .finally(() => {
        entry.pending = false;
      });
    this.#entries.set(projectPath, entry);
    return entry.promise;
  }

  /** Publishes the authoritative catalog returned by a successful mutation. */
  set(projectPath: string, catalog: DerivedCatalog): void {
    this.#entries.set(projectPath, {
      promise: Promise.resolve(catalog),
      pending: false,
      lastGood: catalog.degradedReason === null ? catalog : null,
    });
  }

  invalidate(projectPath: string): void {
    this.#entries.delete(projectPath);
  }

  close(): void {
    this.#entries.clear();
  }
}
