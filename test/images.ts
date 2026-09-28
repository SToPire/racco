import { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TemporaryImages } from "../src/server/images/temporary.js";

export async function temporaryImages() {
  const root = await mkdtemp(join(tmpdir(), "racco-image-test-"));
  const images = await TemporaryImages.open(root, { warn() {} }, root);
  after(async () => {
    await images.close();
    await rm(root, { recursive: true, force: true });
  });
  return images;
}
