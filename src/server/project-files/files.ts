import { constants } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ProjectFileEntry,
  ProjectFilePreview,
  ProjectTreeListing,
} from "../../shared/protocol.js";

const MAX_ENTRIES = 1_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export class ProjectFileError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function locate(projectRoot: string, path: string) {
  if (isAbsolute(path) || path.includes("\0") || path.length > 4096) {
    throw new ProjectFileError("文件路径必须相对于项目目录。", 400);
  }
  const root = await realpath(projectRoot);
  const logicalPath = resolve(root, path);
  if (!within(root, logicalPath))
    throw new ProjectFileError("不能访问项目目录以外的文件。", 403);
  const target = await realpath(logicalPath);
  if (!within(root, target))
    throw new ProjectFileError("这个链接指向项目目录之外。", 403);
  return { root, target, path: relative(root, logicalPath) };
}

export async function listProjectFiles(
  projectRoot: string,
  path = "",
): Promise<ProjectTreeListing> {
  const location = await locate(projectRoot, path);
  const entries: ProjectFileEntry[] = [];
  let truncated = false;
  const directory = await opendir(location.target);
  for await (const entry of directory) {
    let kind: ProjectFileEntry["kind"] = entry.isDirectory()
      ? "directory"
      : entry.isFile()
        ? "file"
        : "unavailable";
    let reason: string | undefined;
    if (entry.isSymbolicLink()) {
      try {
        const target = await realpath(join(location.target, entry.name));
        if (!within(location.root, target)) {
          reason = "链接指向项目目录之外";
        } else {
          const info = await stat(target);
          kind = info.isDirectory()
            ? "directory"
            : info.isFile()
              ? "file"
              : "unavailable";
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          !["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP"].includes(
            code ?? "",
          )
        )
          throw error;
        reason = "链接不可访问";
      }
    } else if (kind === "unavailable") continue;
    if (entries.length === MAX_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push({
      name: entry.name,
      path: join(location.path, entry.name),
      kind,
      symlink: entry.isSymbolicLink(),
      ...(reason ? { reason } : {}),
    });
  }
  entries.sort(
    (a, b) =>
      Number(b.kind === "directory") - Number(a.kind === "directory") ||
      a.name.localeCompare(b.name, "en", { numeric: true }),
  );
  return { path: location.path, entries, truncated };
}

function imageType(buffer: Buffer): string | undefined {
  if (
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)
    return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6)))
    return "image/gif";
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return undefined;
}

export async function readProjectFile(
  projectRoot: string,
  path: string,
): Promise<ProjectFilePreview> {
  const location = await locate(projectRoot, path);
  // Nonblocking open prevents a concurrently substituted FIFO from hanging a request.
  const handle = await open(
    location.target,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    // Validate the opened file as well as the input path; parent links can change during open.
    const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
    if (!within(location.root, openedPath))
      throw new ProjectFileError("不能访问项目目录以外的文件。", 403);
    const info = await handle.stat();
    if (!info.isFile())
      throw new ProjectFileError("所选路径不是普通文件。", 400);
    const metadata = {
      path: location.path,
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
    };
    const tooLarge = (): ProjectFilePreview => ({
      ...metadata,
      kind: "unavailable",
      reason: "文件超过 2 MiB，暂不支持预览。",
    });
    if (info.size > MAX_FILE_BYTES) return tooLarge();
    const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_FILE_BYTES + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > info.size)
      throw new ProjectFileError("文件正在变化，请刷新后重试。", 409);
    const contents = buffer.subarray(0, length);
    const mimeType = imageType(contents);
    if (mimeType)
      return {
        ...metadata,
        kind: "image",
        dataUrl: `data:${mimeType};base64,${contents.toString("base64")}`,
      };
    try {
      if (contents.includes(0)) throw new Error("Binary file");
      const content = new TextDecoder("utf-8", { fatal: true }).decode(
        contents,
      );
      if (content.split("\n").length > 20_000)
        return {
          ...metadata,
          kind: "unavailable",
          reason: "文件超过 20000 行，暂不支持预览。",
        };
      return { ...metadata, kind: "text", content };
    } catch {
      return {
        ...metadata,
        kind: "unavailable",
        reason: "这是二进制文件或非 UTF-8 文本，暂不支持预览。",
      };
    }
  } finally {
    await handle.close();
  }
}
