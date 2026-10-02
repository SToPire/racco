import {
  IMAGE_MEDIA_TYPES,
  MAX_IMAGE_BYTES,
  MAX_INPUT_IMAGE_BYTES,
  MAX_INPUT_IMAGES,
  type ImageInput,
} from "../shared/user-input";

export type DraftImage = {
  id: string;
  name: string;
  url: string;
  size: number;
  content: ImageInput;
};

type Draft = {
  text: string;
  images: DraftImage[];
  preparing: boolean;
  error?: string;
};

const EMPTY_DRAFT: Draft = { text: "", images: [], preparing: false };

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]!);
    reader.onerror = () => reject(new Error("图片读取失败，请重新选择"));
    reader.onabort = () => reject(new Error("图片读取已取消"));
    reader.readAsDataURL(file);
  });
}

/** Page-owned unsent input; evicting a conversation's DOM never evicts its draft. */
export class ComposerDrafts {
  readonly #drafts = new Map<string, Draft>();
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #reads = new Map<string, object>();

  get(scope: string): Draft {
    return this.#drafts.get(scope) ?? EMPTY_DRAFT;
  }

  subscribe(scope: string, listener: () => void) {
    const listeners = this.#listeners.get(scope) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(scope, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(scope);
    };
  }

  #set(scope: string, draft: Draft) {
    if (
      !draft.text &&
      draft.images.length === 0 &&
      !draft.preparing &&
      !draft.error
    )
      this.#drafts.delete(scope);
    else this.#drafts.set(scope, draft);
    for (const listener of this.#listeners.get(scope) ?? []) listener();
  }

  setText(scope: string, text: string) {
    this.#set(scope, { ...this.get(scope), text });
  }

  clearImages(scope: string) {
    this.#reads.delete(scope);
    const draft = this.get(scope);
    for (const image of draft.images) URL.revokeObjectURL(image.url);
    this.#set(scope, { text: draft.text, images: [], preparing: false });
  }

  removeImage(scope: string, id: string) {
    const draft = this.get(scope);
    const image = draft.images.find((candidate) => candidate.id === id);
    if (!image) return;
    URL.revokeObjectURL(image.url);
    this.#set(scope, {
      ...draft,
      images: draft.images.filter((candidate) => candidate !== image),
      error: undefined,
    });
  }

  async addImages(scope: string, files: File[]) {
    const draft = this.get(scope);
    if (draft.preparing || files.length === 0) return;
    let total = draft.images.reduce((sum, image) => sum + image.size, 0);
    const fail = (error: string) =>
      this.#set(scope, { ...this.get(scope), error });
    if (draft.images.length + files.length > MAX_INPUT_IMAGES) {
      fail(`每条消息最多 ${MAX_INPUT_IMAGES} 张图片`);
      return;
    }
    for (const file of files) {
      if (!IMAGE_MEDIA_TYPES.includes(file.type as ImageInput["mediaType"])) {
        fail("仅支持静态 PNG、JPEG、WebP 图片");
        return;
      }
      if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
        fail("每张图片必须非空且不超过 5 MiB");
        return;
      }
      total += file.size;
    }
    if (total > MAX_INPUT_IMAGE_BYTES) {
      fail("图片合计不能超过 12 MiB");
      return;
    }
    const read = {};
    this.#reads.set(scope, read);
    this.#set(scope, { ...draft, preparing: true, error: undefined });
    const added: DraftImage[] = [];
    try {
      for (const file of files) {
        const data = await readImage(file);
        if (this.#reads.get(scope) !== read) return;
        added.push({
          id: crypto.randomUUID(),
          name: file.name || "粘贴的图片",
          url: URL.createObjectURL(file),
          size: file.size,
          content: {
            type: "image",
            mediaType: file.type as ImageInput["mediaType"],
            data,
          },
        });
      }
      this.#set(scope, {
        ...this.get(scope),
        images: [...this.get(scope).images, ...added],
        preparing: false,
      });
    } catch (reason) {
      if (this.#reads.get(scope) === read)
        fail(reason instanceof Error ? reason.message : "图片读取失败");
    } finally {
      for (const image of added)
        if (!this.get(scope).images.includes(image))
          URL.revokeObjectURL(image.url);
      if (this.#reads.get(scope) === read) {
        this.#reads.delete(scope);
        this.#set(scope, { ...this.get(scope), preparing: false });
      }
    }
  }

  discardWhere(remove: (scope: string) => boolean) {
    for (const scope of this.#drafts.keys()) {
      if (!remove(scope)) continue;
      this.clearImages(scope);
      this.#set(scope, EMPTY_DRAFT);
    }
  }
}
