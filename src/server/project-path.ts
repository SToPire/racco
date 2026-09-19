import { realpath, stat } from "node:fs/promises";
import { isAbsolute, parse } from "node:path";

export async function resolveProjectDirectory(
  path: string,
): Promise<string | undefined> {
  if (!isAbsolute(path)) return undefined;
  try {
    const canonicalPath = await realpath(path);
    if (canonicalPath === parse(canonicalPath).root) return undefined;
    const metadata = await stat(canonicalPath);
    return metadata.isDirectory() ? canonicalPath : undefined;
  } catch {
    return undefined;
  }
}
