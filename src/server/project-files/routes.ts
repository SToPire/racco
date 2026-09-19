import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ProjectFileError,
  listProjectFiles,
  readProjectFile,
} from "./files.js";

type Options = { getProject: (id: string) => { path: string } | undefined };
const TreeQuery = z.strictObject({ path: z.string().max(4096).default("") });
const FileQuery = z.strictObject({ path: z.string().min(1).max(4096) });

export async function projectFileRoutes(
  app: FastifyInstance,
  options: Options,
): Promise<void> {
  for (const operation of ["tree", "file"] as const) {
    app.get<{ Params: { projectId: string }; Querystring: unknown }>(
      `/api/projects/:projectId/${operation}`,
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
        const project = options.getProject(request.params.projectId);
        if (!project)
          return reply.code(404).send({ message: "项目不存在或已删除。" });
        const query = (operation === "tree" ? TreeQuery : FileQuery).safeParse(
          request.query,
        );
        if (!query.success)
          return reply.code(400).send({ message: "文件查询参数无效。" });
        try {
          return operation === "tree"
            ? await listProjectFiles(project.path, query.data.path)
            : await readProjectFile(project.path, query.data.path);
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
