import { spawn } from "node:child_process";

export class GitReadError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/** Binary stdout preserves filename bytes until the caller validates UTF-8. */
export function gitRead(
  cwd: string,
  args: string[],
  maxBytes = 8 * 1024 * 1024,
): Promise<Buffer> {
  const env = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of Object.keys(env)) {
    if (
      /^(GIT_DIR|GIT_COMMON_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CONFIG|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+)$/.test(
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
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
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
