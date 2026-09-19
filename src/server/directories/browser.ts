import { opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type {
  DirectoryEntry,
  DirectoryListing,
} from "../../shared/protocol.js";

const MAX_ENTRIES = 1_000;

export class DirectoryBrowseError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export async function listDirectories(
  path = homedir(),
): Promise<DirectoryListing> {
  if (!isAbsolute(path) || path.includes("\0") || path.length > 4_096) {
    throw new DirectoryBrowseError("请输入有效的绝对目录路径。", 400);
  }
  try {
    const currentPath = await realpath(path);
    const entries: DirectoryEntry[] = [];
    let truncated = false;
    const directory = await opendir(currentPath);
    for await (const entry of directory) {
      const entryPath = join(currentPath, entry.name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDirectory = (await stat(entryPath)).isDirectory();
        } catch (error) {
          // A broken, inaccessible or concurrently removed link cannot be entered.
          const code = (error as NodeJS.ErrnoException).code;
          if (
            !["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(
              code ?? "",
            )
          )
            throw error;
        }
      }
      if (!isDirectory) continue;
      if (entries.length === MAX_ENTRIES) {
        truncated = true;
        break;
      }
      entries.push({
        name: entry.name,
        path: entryPath,
        hidden: entry.name.startsWith("."),
      });
    }
    entries.sort((a, b) =>
      a.name.localeCompare(b.name, "en", { numeric: true }),
    );
    const parent = dirname(currentPath);
    return {
      path: currentPath,
      parentPath: parent === currentPath ? null : parent,
      homePath: homedir(),
      entries,
      truncated,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new DirectoryBrowseError("目录不存在或路径不是文件夹。", 404);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new DirectoryBrowseError(
        "没有权限读取这个目录，请选择其他文件夹。",
        403,
      );
    }
    throw error;
  }
}
