import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { gitReadSignal, aborted } from "./coordinator.js";

export class GitReadError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Binary stdout preserves filename bytes until the caller validates UTF-8. */
export function gitRead(
  cwd: string,
  args: string[],
  maxBytes = 8 * 1024 * 1024,
  options: { signal?: AbortSignal; input?: string } = {},
): Promise<Buffer> {
  const signal = options.signal ?? gitReadSignal.getStore();
  if (signal?.aborted) return Promise.reject(aborted());
  const env = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
  };
  for (const key of Object.keys(env)) {
    if (
      /^(GIT_DIR|GIT_COMMON_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CONFIG|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_SHALLOW_FILE|GIT_NAMESPACE|GIT_REPLACE_REF_BASE)$/.test(
        key,
      )
    )
      delete env[key as keyof typeof env];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "--no-pager",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        ...args,
      ],
      { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let failure: GitReadError | undefined;
    let size = 0;
    let stderrSize = 0;
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    const stop = (error: GitReadError) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const cancel = () => stop(aborted());
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
    const timer = setTimeout(
      () => stop(new GitReadError("Git 读取超时，请重试。", 504)),
      15_000,
    );
    child.stdout.on("data", (buffer: Buffer) => {
      size += buffer.length;
      if (size > maxBytes)
        stop(new GitReadError("Git 输出超过容量上限。", 413));
      else output.push(buffer);
    });
    child.stderr.on("data", (buffer: Buffer) => {
      stderrSize += buffer.length;
      if (stderrSize > 64 * 1024)
        stop(new GitReadError("Git 错误输出超过容量上限。", 413));
      else errors.push(buffer);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      failure = new GitReadError(
        error.code === "ENOENT"
          ? "Git 或 Worktree 目录不可用。"
          : "无法启动 Git 读取。",
        503,
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new GitReadError(
            Buffer.concat(errors).toString("utf8").trim() || "Git 读取失败。",
            422,
          ),
        );
      else resolve(Buffer.concat(output));
    });
  });
}

export function strictText(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new GitReadError(
      "Git 输出包含非 UTF-8 文件名或文本，无法展示。",
      422,
    );
  }
}

/** Resolve once, then reject subdirectories and bare repositories. */
export async function gitRoot(path: string): Promise<string> {
  const root = await realpath(path);
  const top = strictText(
    await gitRead(root, ["rev-parse", "--show-toplevel"]),
  ).replace(/\n$/, "");
  if ((await realpath(top)) !== root)
    throw new GitReadError(
      "所选目录不是 Git 工作区根目录，请导入仓库根目录。",
      422,
    );
  return root;
}
