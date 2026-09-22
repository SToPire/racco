type ProjectAccess = {
  users: Map<string, number>;
  deleting: boolean;
  deletingPaths: Set<string>;
};

/**
 * Reserves working directories before any asynchronous work. Deletion refuses
 * pending session operations, and new operations refuse a pending deletion.
 * Running turns are checked by the hub after taking the deletion reservation.
 */
export class WorktreeAccess {
  readonly #projects = new Map<string, ProjectAccess>();

  async use<T>(
    projectId: string,
    path: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const access = this.#get(projectId);
    if (access.deleting || access.deletingPaths.has(path)) {
      throw new Error("Worktree is busy with deletion");
    }
    access.users.set(path, (access.users.get(path) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const remaining = access.users.get(path)! - 1;
      if (remaining === 0) access.users.delete(path);
      else access.users.set(path, remaining);
      this.#release(projectId, access);
    }
  }

  async remove<T>(
    projectId: string,
    path: string | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const access = this.#get(projectId);
    if (
      access.deleting ||
      (path === undefined
        ? access.users.size > 0 || access.deletingPaths.size > 0
        : access.users.has(path) || access.deletingPaths.has(path))
    ) {
      throw new Error("Worktree is busy with a pending operation");
    }
    if (path === undefined) access.deleting = true;
    else access.deletingPaths.add(path);
    try {
      return await operation();
    } finally {
      if (path === undefined) access.deleting = false;
      else access.deletingPaths.delete(path);
      this.#release(projectId, access);
    }
  }

  #get(projectId: string): ProjectAccess {
    let access = this.#projects.get(projectId);
    if (access === undefined) {
      access = { users: new Map(), deleting: false, deletingPaths: new Set() };
      this.#projects.set(projectId, access);
    }
    return access;
  }

  #release(projectId: string, access: ProjectAccess): void {
    if (
      !access.deleting &&
      access.users.size === 0 &&
      access.deletingPaths.size === 0
    ) {
      this.#projects.delete(projectId);
    }
  }
}
