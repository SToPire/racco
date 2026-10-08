import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  GitChangeGroupSchema,
  GitChangesSchema,
  GitChangeDiffSchema,
} from "../../shared/git-changes.js";
import { GitChangesReader } from "./changes.js";
import { GitReadError } from "./git.js";

const PathSchema = z.string().min(1).max(4096);
const ListQuery = z.strictObject({ path: PathSchema });
const DiffQuery = z.strictObject({
  path: PathSchema,
  file: PathSchema,
  group: GitChangeGroupSchema,
});

export async function gitChangeRoutes(
  app: FastifyInstance,
  options: { worktreeIsAvailable: (path: string) => Promise<boolean> },
): Promise<void> {
  const reader = new GitChangesReader();
  for (const resource of ["changes", "change-diff"] as const) {
    app.get<{ Querystring: unknown }>(
      `/api/worktrees/${resource}`,
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        if (request.headers["sec-fetch-site"] === "cross-site")
          return reply.code(403).send({ message: "不允许跨站读取 Git 修改。" });
        if (request.headers.origin !== undefined) {
          try {
            if (new URL(request.headers.origin).host !== request.headers.host)
              throw new Error();
          } catch {
            return reply
              .code(403)
              .send({ message: "不允许跨站读取 Git 修改。" });
          }
        }
        const query = (
          resource === "changes" ? ListQuery : DiffQuery
        ).safeParse(request.query);
        if (!query.success)
          return reply.code(400).send({ message: "Git 查询参数无效。" });
        if (!(await options.worktreeIsAvailable(query.data.path)))
          return reply.code(404).send({ message: "Worktree 目录不可用。" });
        try {
          if (!("file" in query.data))
            return GitChangesSchema.parse(await reader.list(query.data.path));
          const detail = DiffQuery.parse(request.query);
          return GitChangeDiffSchema.parse(
            await reader.diff(detail.path, detail.file, detail.group),
          );
        } catch (error) {
          if (error instanceof GitReadError)
            return reply
              .code(error.statusCode)
              .send({ message: error.message });
          const code = (error as NodeJS.ErrnoException).code;
          if (["ENOENT", "ENOTDIR", "ELOOP"].includes(code ?? ""))
            return reply
              .code(404)
              .send({ message: "目录或文件已不可用，请刷新。" });
          if (["EACCES", "EPERM"].includes(code ?? ""))
            return reply.code(403).send({ message: "没有权限读取 Git 修改。" });
          request.log.error({ error }, "Git changes read failed");
          return reply
            .code(500)
            .send({ message: "读取 Git 修改失败，请重试。" });
        }
      },
    );
  }
}
