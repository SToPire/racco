import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DirectoryBrowseError, listDirectories } from "./browser.js";

const QuerySchema = z.strictObject({
  path: z.string().min(1).max(4_096).optional(),
});

export async function directoryRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: unknown }>(
    "/api/directories",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (request.headers["sec-fetch-site"] === "cross-site") {
        return reply.code(403).send({ message: "不允许跨站浏览目录。" });
      }
      if (request.headers.origin !== undefined) {
        try {
          if (new URL(request.headers.origin).host !== request.headers.host)
            throw new Error();
        } catch {
          return reply.code(403).send({ message: "不允许跨站浏览目录。" });
        }
      }
      const parsed = QuerySchema.safeParse(request.query);
      if (!parsed.success)
        return reply.code(400).send({ message: "目录查询参数无效。" });
      try {
        return await listDirectories(parsed.data.path);
      } catch (error) {
        if (error instanceof DirectoryBrowseError) {
          return reply.code(error.statusCode).send({ message: error.message });
        }
        request.log.error({ error }, "Directory listing failed");
        return reply.code(500).send({ message: "无法读取目录，请重试。" });
      }
    },
  );
}
