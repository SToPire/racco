import { readFile, access } from "node:fs/promises";
import { build } from "../../scripts/build.mjs";
import { buildInfo } from "../../scripts/lib/build-info.mjs";
export default async function setup() {
  const source = await buildInfo();
  try {
    const current = JSON.parse(
      await readFile(".tmp/check-build/build-info.json", "utf8"),
    );
    await Promise.all([
      access(".tmp/check-build/web/index.html"),
      access(".tmp/check-build/server/server.js"),
    ]);
    if (
      current.schema === 1 &&
      current.sourceDigest === source.sourceDigest &&
      current.sourceRevision === source.sourceRevision
    )
      return;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  await build({ target: "check" });
}
