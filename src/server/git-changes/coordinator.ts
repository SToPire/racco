import { AsyncLocalStorage } from "node:async_hooks";
import { realpath } from "node:fs/promises";
import { GitReadError } from "./git.js";

export const gitReadSignal = new AsyncLocalStorage<AbortSignal>();
export function aborted(): GitReadError {
  return new GitReadError("Git 读取已取消。", 499, "GIT_ABORTED");
}

type Active = {
  key: string | null;
  controller: AbortController;
  consumers: Set<symbol>;
  task: Promise<unknown>;
};

/** One live operation per canonical worktree; cancellation releases it only on exit. */
export class GitReadCoordinator {
  readonly #active = new Map<string, Active>();

  async run<T>(
    path: string,
    key: string | null,
    operation: (root: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw aborted();
    const root = await realpath(path);
    if (signal?.aborted) throw aborted();
    let active = this.#active.get(root);
    if (
      active &&
      (key === null || active.key !== key || active.controller.signal.aborted)
    )
      throw new GitReadError("Git 读取繁忙，请稍后重试。", 409, "GIT_BUSY");
    if (!active) {
      const controller = new AbortController();
      const consumers = new Set<symbol>();
      const task = Promise.resolve().then(() =>
        gitReadSignal.run(controller.signal, () => operation(root)),
      );
      active = { key, controller, consumers, task };
      this.#active.set(root, active);
      void task
        .finally(() => {
          if (this.#active.get(root)?.task === task) this.#active.delete(root);
        })
        .catch(() => {});
    }
    const owned = active;
    const token = Symbol();
    owned.consumers.add(token);
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        signal?.removeEventListener("abort", cancel);
        owned.consumers.delete(token);
      };
      const cancel = () => {
        cleanup();
        if (!owned.consumers.size) owned.controller.abort();
        reject(aborted());
      };
      signal?.addEventListener("abort", cancel, { once: true });
      owned.task.then(
        (value) => {
          cleanup();
          resolve(value as T);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
      if (signal?.aborted) cancel();
    });
  }
}

export const gitReads = new GitReadCoordinator();
