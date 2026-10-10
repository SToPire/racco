/** One running read and one latest pending intention per operation and Worktree. */
type Job = {
  kind: string;
  signal: AbortSignal;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  dispose: () => void;
};
type Queue = { active?: Job; pending: Map<string, Job> };
const queues = new Map<string, Queue>();
const aborted = () => new DOMException("读取已取消。", "AbortError");

function drain(path: string, queue: Queue) {
  if (queue.active) return;
  const job = queue.pending.values().next().value as Job | undefined;
  if (!job) {
    queues.delete(path);
    return;
  }
  queue.pending.delete(job.kind);
  queue.active = job;
  void job
    .run()
    .then(job.resolve, job.reject)
    .finally(() => {
      job.dispose();
      queue.active = undefined;
      drain(path, queue);
    });
}

export function scheduleGitRead<T>(
  path: string,
  kind: string,
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  let queue = queues.get(path);
  if (!queue) {
    queue = { pending: new Map() };
    queues.set(path, queue);
  }
  const currentQueue = queue;
  return new Promise<T>((resolve, reject) => {
    const previous = currentQueue.pending.get(kind);
    if (previous) {
      previous.dispose();
      previous.reject(aborted());
    }
    const cancel = () => {
      if (currentQueue.pending.get(kind) === job) {
        currentQueue.pending.delete(kind);
        job.dispose();
        reject(aborted());
        if (!currentQueue.active) drain(path, currentQueue);
      }
    };
    const job: Job = {
      kind,
      signal,
      run,
      resolve: (value) =>
        signal.aborted ? reject(aborted()) : resolve(value as T),
      reject,
      dispose: () => signal.removeEventListener("abort", cancel),
    };
    currentQueue.pending.set(kind, job);
    signal.addEventListener("abort", cancel, { once: true });
    drain(path, currentQueue);
  });
}

export class GitApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function gitResource(
  name: string,
  query: URLSearchParams,
  signal: AbortSignal,
): Promise<unknown> {
  return scheduleGitRead(query.get("path")!, name, signal, async () => {
    const response = await fetch(`/api/worktrees/${name}?${query}`, { signal });
    const data = (await response.json()) as unknown;
    if (!response.ok) {
      const record =
        typeof data === "object" && data !== null
          ? (data as Record<string, unknown>)
          : {};
      throw new GitApiError(
        typeof record.message === "string"
          ? record.message
          : "无法读取 Git 数据。",
        response.status,
        typeof record.code === "string" ? record.code : undefined,
      );
    }
    return data;
  });
}
