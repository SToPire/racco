import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { ImageInputs, inputFingerprint } from "./input.js";
import {
  UserInputSchema,
  MAX_IMAGE_BYTES,
  type ImageInput,
} from "../../shared/user-input.js";

async function png(): Promise<ImageInput> {
  const bytes = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  return {
    type: "image",
    mediaType: "image/png",
    data: bytes.toString("base64"),
  };
}

test("validates real PNG, JPEG and WebP inputs while preserving the original bytes and order", async () => {
  const inputs = new ImageInputs();
  for (const format of ["png", "jpeg", "webp"] as const) {
    const bytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "red" },
    })
      .toFormat(format)
      .toBuffer();
    const image: ImageInput = {
      type: "image",
      mediaType: `image/${format}`,
      data: bytes.toString("base64"),
    };
    const lease = await inputs.prepare([
      image,
      { type: "text", text: "question" },
      image,
    ]);
    assert.deepEqual(lease.content, [
      image,
      { type: "text", text: "question" },
      image,
    ]);
    const fingerprint = JSON.stringify(inputFingerprint(lease.content));
    assert(!fingerprint.includes(image.data));
    assert.notDeepEqual(
      inputFingerprint([image, { type: "text", text: "question" }]),
      inputFingerprint([{ type: "text", text: "question" }, image]),
    );
    lease.release();
    lease.release();
  }
});

test("rejects malformed, mislabeled, oversized and animated images before execution", async () => {
  const inputs = new ImageInputs(),
    image = await png();
  assert(!UserInputSchema.safeParse([{ ...image, data: "bad" }]).success);
  assert(
    !UserInputSchema.safeParse([
      { ...image, data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64") },
    ]).success,
  );
  assert(!UserInputSchema.safeParse(Array(5).fill(image)).success);
  assert(!UserInputSchema.safeParse([]).success);
  await assert.rejects(
    inputs.prepare([{ ...image, mediaType: "image/jpeg" }]),
    /解码失败/,
  );
  await assert.rejects(
    inputs.prepare([
      { ...image, data: Buffer.from("not an image").toString("base64") },
    ]),
    /解码失败/,
  );
  const bytes = Buffer.from(image.data, "base64");
  await assert.rejects(
    inputs.prepare([
      { ...image, data: bytes.subarray(0, 40).toString("base64") },
    ]),
    /不完整|解码失败/,
  );
  const oversized = Buffer.from(bytes);
  oversized.writeUInt32BE(100_000, 16);
  await assert.rejects(
    inputs.prepare([{ ...image, data: oversized.toString("base64") }]),
    /解码失败/,
  );
  const acTL = Buffer.alloc(20);
  acTL.writeUInt32BE(8, 0);
  acTL.write("acTL", 4);
  await assert.rejects(
    inputs.prepare([
      {
        ...image,
        data: Buffer.concat([
          bytes.subarray(0, 33),
          acTL,
          bytes.subarray(33),
        ]).toString("base64"),
      },
    ]),
    /动态图片/,
  );
  const lease = await inputs.prepare([image]);
  lease.release();
});

test("bounds concurrent decoding and releases validation slots after rejection", async () => {
  const inputs = new ImageInputs(),
    image = await png();
  const first = inputs.prepare([image]);
  const second = inputs.prepare([image]);
  await assert.rejects(inputs.prepare([image]), /容量已满/);
  for (const lease of await Promise.all([first, second])) lease.release();
  const again = await inputs.prepare([image]);
  again.release();
});

test("checks combined image bytes and rejects a valid image beyond the pixel limit", async () => {
  const data = Buffer.alloc(4 * 1024 * 1024).toString("base64");
  const part = {
    type: "image" as const,
    mediaType: "image/png" as const,
    data,
  };
  assert(UserInputSchema.safeParse([part, part, part]).success);
  assert(
    !UserInputSchema.safeParse([
      part,
      part,
      { ...part, data: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") },
    ]).success,
  );
  const oversized = await sharp({
    create: { width: 4100, height: 4000, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  await assert.rejects(
    new ImageInputs().prepare([
      { ...part, data: oversized.toString("base64") },
    ]),
    /解码失败/,
  );
});
