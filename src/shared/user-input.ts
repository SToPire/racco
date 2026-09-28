import { z } from "zod";

export const MAX_INPUT_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_INPUT_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const MAX_CLIENT_MESSAGE_BYTES = 20 * 1024 * 1024;
export const IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export function imageByteLength(data: string): number {
  return (
    (data.length / 4) * 3 -
    (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)
  );
}

const ImageInputSchema = z.strictObject({
  type: z.literal("image"),
  mediaType: z.enum(IMAGE_MEDIA_TYPES),
  data: z
    .string()
    .min(4)
    .max(4 * Math.ceil(MAX_IMAGE_BYTES / 3))
    .refine(
      (data) =>
        data.length % 4 === 0 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(data) &&
        imageByteLength(data) <= MAX_IMAGE_BYTES,
      "图片 base64 或大小无效",
    ),
});

export const UserInputPartSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("text"),
    text: z.string().trim().min(1),
  }),
  ImageInputSchema,
]);
export const UserInputSchema = z
  .array(UserInputPartSchema)
  .min(1)
  .max(MAX_INPUT_IMAGES + 1)
  .refine(
    (parts) =>
      parts.filter((part) => part.type === "image").length <=
        MAX_INPUT_IMAGES && inputImageBytes(parts) <= MAX_INPUT_IMAGE_BYTES,
    "图片数量或合计大小超限",
  );
export type UserInputPart = z.infer<typeof UserInputPartSchema>;
export type UserInput = UserInputPart[];
export type ImageInput = Extract<UserInputPart, { type: "image" }>;

export function inputText(content: UserInput): string {
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}
export function inputImageCount(content: UserInput): number {
  return content.filter((part) => part.type === "image").length;
}
export function inputImageBytes(content: UserInput): number {
  return content.reduce(
    (sum, part) =>
      sum + (part.type === "image" ? imageByteLength(part.data) : 0),
    0,
  );
}
export function textInput(text: string): UserInput {
  return [{ type: "text", text }];
}
