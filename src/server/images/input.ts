import sharp from "sharp";
import { createHash } from "node:crypto";
import {
  MAX_IMAGE_PIXELS,
  UserInputSchema,
  inputImageBytes,
  type UserInput,
} from "../../shared/user-input.js";

export const MAX_ACTIVE_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_PARALLEL_VALIDATIONS = 2;

export type InputLease = { content: UserInput; release(): void };

/** Only live input has a lease. No message content or per-turn state is persisted. */
export class ImageInputs {
  #bytes = 0;
  #validating = 0;

  async prepare(value: UserInput): Promise<InputLease> {
    const content = UserInputSchema.parse(value);
    const bytes = inputImageBytes(content);
    if (
      bytes > 0 &&
      (this.#validating >= MAX_PARALLEL_VALIDATIONS ||
        this.#bytes + bytes > MAX_ACTIVE_IMAGE_BYTES)
    ) {
      throw new Error("图片处理容量已满，请稍后重试");
    }
    this.#bytes += bytes;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#bytes -= bytes;
    };
    if (bytes === 0) return { content, release };
    this.#validating++;
    try {
      for (const part of content) {
        if (part.type !== "image") continue;
        const buffer = Buffer.from(part.data, "base64");
        if (buffer.toString("base64") !== part.data)
          throw new Error("图片 base64 编码无效");
        const signatureMatches =
          part.mediaType === "image/png"
            ? buffer
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : part.mediaType === "image/jpeg"
              ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
              : buffer.toString("ascii", 0, 4) === "RIFF" &&
                buffer.toString("ascii", 8, 12) === "WEBP";
        if (!signatureMatches)
          throw new Error("图片解码失败：文件格式与声明不符");
        rejectAnimatedPng(buffer);
        const decoder = sharp(buffer, {
          limitInputPixels: MAX_IMAGE_PIXELS,
          limitInputChannels: 4,
          ignoreIcc: true,
          failOn: "warning",
        });
        try {
          const metadata = await decoder.metadata();
          if (
            `image/${metadata.format}` !== part.mediaType ||
            !metadata.width ||
            !metadata.height ||
            metadata.width * metadata.height > MAX_IMAGE_PIXELS ||
            (metadata.pages ?? 1) !== 1
          ) {
            throw new Error(
              "图片格式、尺寸或帧数无效，仅支持静态 PNG、JPEG、WebP",
            );
          }
          await decoder.timeout({ seconds: 5 }).raw().toBuffer();
        } catch {
          throw new Error("图片解码失败或超出限制，仅支持静态 PNG、JPEG、WebP");
        } finally {
          decoder.destroy();
        }
      }
      return { content, release };
    } catch (error) {
      release();
      throw error;
    } finally {
      this.#validating--;
    }
  }
}

// libvips may decode only the first PNG frame. Reject APNG before pixel allocation.
function rejectAnimatedPng(buffer: Buffer): void {
  if (
    !buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return;
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const size = buffer.readUInt32BE(offset);
    const kind = buffer.toString("ascii", offset + 4, offset + 8);
    if (kind === "acTL") throw new Error("不支持动态图片");
    if (offset + size + 12 > buffer.length) throw new Error("PNG 图片不完整");
    if (kind === "IEND") return;
    offset += size + 12;
  }
}

export function inputFingerprint(content: UserInput): unknown[] {
  return content.map((part) =>
    part.type === "text"
      ? ["text", part.text]
      : [
          "image",
          part.mediaType,
          createHash("sha256")
            .update(Buffer.from(part.data, "base64"))
            .digest("hex"),
        ],
  );
}
