import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { inputImageBytes, type UserInput } from "../../shared/user-input.js";

export const MAX_TEMPORARY_IMAGE_BYTES = 128 * 1024 * 1024;
export type TemporaryImageBatch = { paths: string[]; dispose(): Promise<void> };

/** Owned by one daemon/state directory. Open only after the state lock, before providers. */
export class TemporaryImages {
  #bytes = 0;
  #closed = false;
  #garbage = new Set<() => Promise<void>>();
  #retrying?: Promise<void>;
  #timer: ReturnType<typeof setInterval>;

  private constructor(
    readonly directory: string,
    private readonly log: { warn(data: unknown, message: string): void },
  ) {
    this.#timer = setInterval(() => {
      void this.retryCleanup();
    }, 30_000);
    this.#timer.unref();
  }

  static async open(
    stateDir: string,
    log: { warn(data: unknown, message: string): void },
    runtimeDir = process.env.XDG_RUNTIME_DIR,
  ): Promise<TemporaryImages> {
    if (!runtimeDir || !isAbsolute(runtimeDir))
      throw new Error("XDG_RUNTIME_DIR is required for temporary image inputs");
    const parent = join(runtimeDir, "racco-images");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const info = await lstat(parent);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid!()
    )
      throw new Error("Unsafe temporary image directory");
    await chmod(parent, 0o700);
    const identity = createHash("sha256")
      .update(await realpath(stateDir))
      .digest("hex");
    const directory = join(parent, identity);
    // systemd KillMode=control-group stops the previous service's children before restart.
    // A cleanup failure fails startup: do not start accepting images over uncounted leftovers.
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { mode: 0o700 });
    return new TemporaryImages(directory, log);
  }

  async create(content: UserInput): Promise<TemporaryImageBatch> {
    if (this.#closed) throw new Error("Temporary image store is closed");
    const bytes = inputImageBytes(content);
    if (this.#bytes + bytes > MAX_TEMPORARY_IMAGE_BYTES)
      throw new Error(
        "临时图片空间已满；请等待轮次结束，或重启 Racco 清理未确认的输入",
      );
    this.#bytes += bytes;
    let directory: string;
    try {
      directory = await mkdtemp(join(this.directory, "turn-"));
    } catch (error) {
      this.#bytes -= bytes;
      throw error;
    }
    let disposed = false;
    let disposing: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      if (disposed) return Promise.resolve();
      if (disposing) return disposing;
      disposing = rm(directory, { recursive: true, force: true })
        .then(() => {
          disposed = true;
          this.#bytes -= bytes;
          this.#garbage.delete(dispose);
        })
        .catch(() => {
          this.#garbage.add(dispose);
          this.log.warn({}, "Temporary image cleanup failed; will retry");
        })
        .finally(() => {
          disposing = undefined;
        });
      return disposing;
    };
    const paths: string[] = [];
    try {
      for (const part of content) {
        if (part.type !== "image") continue;
        const extension =
          part.mediaType === "image/jpeg" ? "jpg" : part.mediaType.slice(6);
        const path = join(directory, `${paths.length}.${extension}`);
        await writeFile(path, Buffer.from(part.data, "base64"), {
          flag: "wx",
          mode: 0o600,
        });
        paths.push(path);
      }
      return { paths, dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  }

  retryCleanup(): Promise<void> {
    if (this.#retrying) return this.#retrying;
    this.#retrying = Promise.all([...this.#garbage].map((dispose) => dispose()))
      .then(() => {})
      .finally(() => {
        this.#retrying = undefined;
      });
    return this.#retrying;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    await this.retryCleanup();
    const remaining = await readdir(this.directory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    if (remaining.length === 0)
      await rm(this.directory, { recursive: true, force: true });
  }
}
