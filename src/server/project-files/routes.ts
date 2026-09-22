import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ProjectFileError,
  listProjectFiles,
  readProjectFile,
} from "./files.js";

type Options = { worktreeIsAvailable: (path: string) => Promise<boolean> };
const TreeQuery = z.strictObject({
  path: z.string().min(1).max(4096),
  dir: z.string().max(4096).default(""),
});
const FileQuery = z.strictObject({
  path: z.string().min(1).max(4096),
  file: z.string().min(1).max(4096),
});

/**
 * File browsing is rooted at a worktree, not a project: the worktree is the
 * directory the user is actually looking at, and the project directory is just
 * its primary worktree. `path` names the root; `dir`/`file` are relative to it.
 */
export async function projectFileRoutes(
  app: FastifyInstance,
  options: Options,
): Promise<void> {
  for (const operation of ["tree", "file"] as const) {
    app.get<{ Querystring: unknown }>(
      `/api/worktrees/${operation}`,
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        if (request.headers["sec-fetch-site"] === "cross-site")
          return reply.code(403).send({ message: "不允许跨站读取项目文件。" });
        if (request.headers.origin !== undefined) {
          try {
            if (new URL(request.headers.origin).host !== request.headers.host)
              throw new Error();
          } catch {
            return reply
              .code(403)
              .send({ message: "不允许跨站读取项目文件。" });
          }
        }
        const query = (operation === "tree" ? TreeQuery : FileQuery).safeParse(
          request.query,
        );
        if (!query.success)
          return reply.code(400).send({ message: "文件查询参数无效。" });
        if (!(await options.worktreeIsAvailable(query.data.path)))
          return reply.code(404).send({ message: "Worktree 目录不可用。" });
        try {
          if (operation === "tree") {
            return await listProjectFiles(
              query.data.path,
              "dir" in query.data ? query.data.dir : "",
            );
          }
          if (!("file" in query.data))
            return reply.code(400).send({ message: "文件查询参数无效。" });
          return await readProjectFile(query.data.path, query.data.file);
        } catch (error) {
          if (error instanceof ProjectFileError)
            return reply
              .code(error.statusCode)
              .send({ message: error.message });
          const code = (error as NodeJS.ErrnoException).code;
          if (["ENOENT", "ENOTDIR", "ELOOP"].includes(code ?? ""))
            return reply
              .code(404)
              .send({ message: "文件或目录不存在，请刷新。" });
          if (["EACCES", "EPERM"].includes(code ?? ""))
            return reply
              .code(403)
              .send({ message: "没有权限读取这个文件或目录。" });
          request.log.error({ error }, "Project file read failed");
          return reply.code(500).send({ message: "读取失败，请重试。" });
        }
      },
    );
  }
}
