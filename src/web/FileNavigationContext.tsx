import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  resolveFileReference,
  resolveProjectFilePath,
  type ProjectFileLocation,
} from "./file-navigation";

export const FileNavigationContext = createContext<
  | {
      projectRoot: string;
      baseDirectory: string | undefined;
      available: boolean;
      onOpenFile: (location: ProjectFileLocation) => void;
    }
  | undefined
>(undefined);

export function FileNavigationProvider({
  projectRoot,
  available,
  onOpenFile,
  children,
}: {
  projectRoot: string | undefined;
  available: boolean;
  onOpenFile: (projectRoot: string, location: ProjectFileLocation) => void;
  children: ReactNode;
}) {
  const value = useMemo(
    () =>
      projectRoot === undefined
        ? undefined
        : {
            projectRoot,
            baseDirectory: projectRoot,
            available,
            onOpenFile: (location: ProjectFileLocation) =>
              onOpenFile(projectRoot, location),
          },
    [projectRoot, available, onOpenFile],
  );
  return (
    <FileNavigationContext.Provider value={value}>
      {children}
    </FileNavigationContext.Provider>
  );
}

/** Content may belong to another actor without expanding the project's read boundary. */
export function FileReferenceScope({
  baseDirectory,
  children,
}: {
  baseDirectory: string | undefined;
  children: ReactNode;
}) {
  const navigation = useContext(FileNavigationContext);
  const value = useMemo(
    () =>
      navigation === undefined ? undefined : { ...navigation, baseDirectory },
    [navigation, baseDirectory],
  );
  return (
    <FileNavigationContext.Provider value={value}>
      {children}
    </FileNavigationContext.Provider>
  );
}

export function FileReference({
  reference,
  children,
  externalLink = false,
  literalPath = false,
  title,
}: {
  reference: string;
  children: ReactNode;
  externalLink?: boolean;
  literalPath?: boolean;
  title?: string;
}) {
  const navigation = useContext(FileNavigationContext);
  const target =
    navigation &&
    (literalPath
      ? resolveProjectFilePath(
          reference,
          navigation.projectRoot,
          navigation.baseDirectory,
        )
      : resolveFileReference(
          reference,
          navigation.projectRoot,
          navigation.baseDirectory,
        ));
  if (target === undefined || target.kind === "external") {
    return externalLink ? (
      <a href={reference} title={title}>
        {children}
      </a>
    ) : (
      <>{children}</>
    );
  }
  if (target.kind === "unavailable" || !navigation?.available) {
    return (
      <span
        className="project-file-unavailable"
        aria-disabled="true"
        title={target.kind === "unavailable" ? target.reason : "当前项目不可用"}
      >
        {children}
      </span>
    );
  }
  return (
    <button
      className="project-file-link"
      title={
        title ??
        `在文件侧栏打开 ${target.path}${target.line === undefined ? "" : `，第 ${target.line} 行`}`
      }
      onClick={() => navigation.onOpenFile(target)}
      type="button"
    >
      {children}
    </button>
  );
}
