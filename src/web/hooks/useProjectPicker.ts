import { useState } from "react";
import type { ProjectEntry } from "../../shared/protocol";

export function useProjectPicker(
  projects: ProjectEntry[],
  projectId: string,
  selectProject: (id: string) => void,
  importProject: (path: string) => Promise<ProjectEntry>,
) {
  const [directoryPicker, setDirectoryPicker] = useState<{
    forSession: boolean;
    initialPath?: string;
  }>();
  function openProjectPicker(forSession: boolean) {
    setDirectoryPicker({
      forSession,
      initialPath: forSession
        ? projects.find((project) => project.projectId === projectId)?.path
        : undefined,
    });
  }
  async function importSelectedDirectory(path: string) {
    const project = await importProject(path);
    if (directoryPicker?.forSession) selectProject(project.projectId);
    setDirectoryPicker(undefined);
  }
  return {
    directoryPicker,
    setDirectoryPicker,
    openProjectPicker,
    importSelectedDirectory,
  };
}
