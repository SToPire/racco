export type ProjectFileLocation = { path: string; line?: number };

export type FileOpenRequest = ProjectFileLocation & {
  worktreePath: string;
  requestId: number;
};

export type FileReferenceResolution =
  | ({ kind: "file" } & ProjectFileLocation)
  | { kind: "external" }
  | { kind: "unavailable"; reason: string };

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function pathSegments(path: string): string[] | undefined {
  const segments: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments;
}

export function resolveProjectFilePath(
  path: string,
  projectRoot: string,
  baseDirectory: string | undefined,
): FileReferenceResolution {
  if (path.length === 0 || hasControlCharacters(path)) {
    return { kind: "unavailable", reason: "文件路径包含无效字符" };
  }
  const root = projectRoot.startsWith("/")
    ? pathSegments(projectRoot)
    : undefined;
  if (!path.startsWith("/") && !baseDirectory?.startsWith("/")) {
    return {
      kind: "unavailable",
      reason: "Agent 工作目录未知，无法定位相对路径",
    };
  }
  const parts = pathSegments(
    path.startsWith("/") ? path : `${baseDirectory}/${path}`,
  );
  if (root === undefined || parts === undefined) {
    return { kind: "unavailable", reason: "文件不在当前项目内" };
  }
  if (root.some((part, index) => parts[index] !== part)) {
    return { kind: "unavailable", reason: "文件不在当前项目内" };
  }
  parts.splice(0, root.length);
  if (parts.length === 0 || path.endsWith("/")) {
    return { kind: "unavailable", reason: "请选择项目内的文件" };
  }
  return { kind: "file", path: parts.join("/") };
}

export function resolveFileReference(
  reference: string,
  projectRoot: string,
  baseDirectory: string | undefined,
): FileReferenceResolution {
  const unavailable = (reason: string): FileReferenceResolution => ({
    kind: "unavailable",
    reason,
  });
  const value = reference.trim();
  if (value.length === 0 || hasControlCharacters(value)) {
    return unavailable("没有可用的文件路径");
  }
  if (
    /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(value) ||
    /^(?:mailto|tel|sms):/i.test(value) ||
    value.startsWith("#") ||
    value.startsWith("?")
  ) {
    return { kind: "external" };
  }

  const fragmentLine = /^(.*?)#L(\d+)$/.exec(value);
  const colonLine = /^(.*?):(\d+)(?::\d+)?$/.exec(value);
  const location = fragmentLine ?? colonLine;
  let path = location?.[1] ?? value;
  const line = location === null ? undefined : Number(location[2]);
  if (/^[a-z][a-z\d+.-]*:/i.test(path)) return { kind: "external" };
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) {
    return unavailable("文件行号必须是正整数");
  }
  if (path.includes("#") || path.includes("?")) {
    return unavailable("文件引用只支持 #L行号 或 :行号");
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    return unavailable("文件路径编码无效");
  }
  const target = resolveProjectFilePath(path, projectRoot, baseDirectory);
  if (target.kind !== "file") return target;
  return {
    ...target,
    ...(line === undefined ? {} : { line }),
  };
}
