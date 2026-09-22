import type { WorktreeCatalog, WorktreeEntry } from "../../shared/protocol.js";
import type {
  ManagedProject,
  ManagedSession,
} from "../state/session-repository.js";
import { WorktreeCatalogCache } from "./cache.js";
import { isMainWorkingTree } from "./derive.js";
import type { DerivedCatalog, DerivedWorktree } from "./derive.js";
import {
  createWorktree,
  removeAllLinkedWorktrees,
  removeWorktree,
  worktreeIsDirty,
} from "./manager.js";

export type ProjectRemovalReport = {
  projectId: string;
  removals: Array<{
    path: string;
    removed: boolean;
    skipped?: boolean;
    reason?: string;
  }>;
};

/**
 * Owns everything derived-from-Git about a project's worktrees: the cached
 * catalog, the create/remove lifecycle, the serialization that keeps a creation
 * from racing a removal, and the translation from what Git reports into the
 * protocol shape the UI reads.
 *
 * The domain rule that lives here and nowhere else: the project's own directory
 * is its main worktree, is synthesized rather than matched from Git's output, and
 * is never removable.
 */
export class WorktreeService {
  readonly #cache: WorktreeCatalogCache;
  /** Chains operations per project so a create cannot race a remove. */
  readonly #inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly worktreeRoot: string,
    private readonly projectSessions: (projectId: string) => ManagedSession[],
  ) {
    this.#cache = new WorktreeCatalogCache();
  }

  /** The catalog as the UI reads it: decorated with session counts. */
  async catalog(project: ManagedProject): Promise<WorktreeCatalog> {
    const derived = await this.#cache.get(project.path);
    return this.#toCatalog(project, derived);
  }

  /** Re-reads from Git, ignoring anything cached. */
  async refresh(project: ManagedProject): Promise<WorktreeCatalog> {
    const derived = await this.#cache.refresh(project.path);
    return this.#toCatalog(project, derived);
  }

  async create(
    project: ManagedProject,
    name: string,
    baseRef?: string,
  ): Promise<{ catalog: WorktreeCatalog; worktree: WorktreeEntry }> {
    return this.#serialize(project.path, async () => {
      const derived = await createWorktree({
        projectPath: project.path,
        worktreeRoot: this.worktreeRoot,
        name,
        baseRef,
      });
      this.#cache.set(project.path, derived);
      const catalog = await this.#toCatalog(project, derived);
      const created = catalog.worktrees.find(
        (entry) => entry.kind === "linked" && entry.branch === name,
      );
      if (created === undefined) {
        throw new Error(`创建后未能找到 Worktree：${name}`);
      }
      return { catalog, worktree: created };
    });
  }

  async remove(
    project: ManagedProject,
    path: string,
    force = false,
  ): Promise<{ catalog: WorktreeCatalog; removedSessionIds: string[] }> {
    return this.#serialize(project.path, async () => {
      // Sessions living in the worktree go with it; the caller refuses while any
      // of them has an active turn, so nothing is silently interrupted here.
      const removedSessionIds = this.projectSessions(project.projectId)
        .filter((session) => session.cwd === path)
        .map((session) => session.sessionId);
      const derived = await removeWorktree({
        projectPath: project.path,
        path,
        force,
      });
      this.#cache.set(project.path, derived);
      return {
        catalog: await this.#toCatalog(project, derived),
        removedSessionIds,
      };
    });
  }

  /**
   * Removes every linked worktree of a project, for a project deletion. Failures
   * are reported rather than thrown: a directory that cannot be removed must not
   * leave the user unable to delete the project. `skipPaths` names linked
   * worktrees whose directories are kept (live turns must not have their
   * directory force-removed underneath them).
   */
  async removeForProject(
    project: ManagedProject,
    skipPaths?: ReadonlySet<string>,
  ): Promise<ProjectRemovalReport> {
    const report = await this.#serialize(project.path, async () => ({
      projectId: project.projectId,
      removals: await removeAllLinkedWorktrees(project.path, skipPaths),
    }));
    this.#cache.invalidate(project.path);
    // Do not clear #inFlight here: a later operation may have queued behind this
    // one, and deleting the key would let a third operation race it. The chain
    // entry costs nothing once settled (a resolved promise's `.then` is a
    // microtask), so it stays as the serialization tail.
    return report;
  }

  /** Whether a directory is a main working tree Git can create worktrees in. */
  isCreatable(projectPath: string): Promise<boolean> {
    return isMainWorkingTree(projectPath);
  }

  isDirty(path: string): Promise<boolean> {
    return worktreeIsDirty(path);
  }

  async #toCatalog(
    project: ManagedProject,
    derived: DerivedCatalog,
  ): Promise<WorktreeCatalog> {
    const sessions = this.projectSessions(project.projectId);
    let degradedReason = derived.degradedReason;
    const worktrees = await Promise.all(
      derived.worktrees.map(async (entry) => {
        let dirty = false;
        if (entry.removable && entry.available) {
          try {
            dirty = await this.isDirty(entry.path);
          } catch (error) {
            degradedReason ??=
              error instanceof Error ? error.message : String(error);
          }
        }
        return this.#toEntry(project, entry, sessions, dirty);
      }),
    );
    return {
      projectId: project.projectId,
      worktrees,
      degradedReason,
    };
  }

  #toEntry(
    project: ManagedProject,
    entry: DerivedWorktree,
    sessions: ManagedSession[],
    dirty: boolean,
  ): WorktreeEntry {
    const matches = sessions.filter((session) => session.cwd === entry.path);
    return {
      projectId: project.projectId,
      path: entry.path,
      kind: entry.kind,
      name: entry.name,
      branch: entry.branch,
      head: entry.head,
      available: entry.available,
      locked: entry.locked,
      prunable: entry.prunable,
      removable: entry.removable,
      dirty,
      sessionCount: matches.length,
    };
  }

  #serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#inFlight.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.#inFlight.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  close(): void {
    this.#cache.close();
    this.#inFlight.clear();
  }
}
