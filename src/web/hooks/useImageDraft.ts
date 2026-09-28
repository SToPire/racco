import { useEffect, useRef, useState } from "react";
import {
  IMAGE_MEDIA_TYPES,
  MAX_IMAGE_BYTES,
  MAX_INPUT_IMAGE_BYTES,
  MAX_INPUT_IMAGES,
  type ImageInput,
  type UserInput,
} from "../../shared/user-input";

export type DraftImage = {
  id: string;
  name: string;
  url: string;
  size: number;
  content: ImageInput;
};
function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]!);
    reader.onerror = () => reject(new Error("图片读取失败，请重新选择"));
    reader.onabort = () => reject(new Error("图片读取已取消"));
    reader.readAsDataURL(file);
  });
}

export function useImageDraft(scope: string) {
  const [state, setState] = useState<{ scope: string; images: DraftImage[] }>({
    scope,
    images: [],
  });
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string>();
  const current = useRef(scope);
  current.current = scope;
  const imagesRef = useRef<DraftImage[]>([]);
  const generation = useRef(0);
  const busy = useRef(false);

  useEffect(() => {
    generation.current++;
    busy.current = false;
    setPreparing(false);
    setError(undefined);
    for (const image of imagesRef.current) URL.revokeObjectURL(image.url);
    imagesRef.current = [];
    setState({ scope, images: [] });
    return () => {
      generation.current++;
      for (const image of imagesRef.current) URL.revokeObjectURL(image.url);
      imagesRef.current = [];
    };
  }, [scope]);

  function clear() {
    if (current.current !== scope) return;
    generation.current++;
    for (const image of imagesRef.current) URL.revokeObjectURL(image.url);
    imagesRef.current = [];
    setState({ scope: current.current, images: [] });
    setError(undefined);
  }

  async function add(files: File[]) {
    if (busy.current || files.length === 0) return;
    const expectedScope = scope;
    const expectedGeneration = generation.current;
    let total = imagesRef.current.reduce((sum, image) => sum + image.size, 0);
    if (imagesRef.current.length + files.length > MAX_INPUT_IMAGES) {
      setError(`每条消息最多 ${MAX_INPUT_IMAGES} 张图片`);
      return;
    }
    for (const file of files) {
      if (!IMAGE_MEDIA_TYPES.includes(file.type as ImageInput["mediaType"])) {
        setError("仅支持静态 PNG、JPEG、WebP 图片");
        return;
      }
      if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
        setError("每张图片必须非空且不超过 5 MiB");
        return;
      }
      total += file.size;
    }
    if (total > MAX_INPUT_IMAGE_BYTES) {
      setError("图片合计不能超过 12 MiB");
      return;
    }
    busy.current = true;
    setPreparing(true);
    setError(undefined);
    const added: DraftImage[] = [];
    try {
      for (const file of files) {
        const data = await readImage(file);
        if (
          current.current !== expectedScope ||
          generation.current !== expectedGeneration
        )
          return;
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
      const next = [...imagesRef.current, ...added];
      imagesRef.current = next;
      setState({ scope: expectedScope, images: next });
    } catch (reason) {
      if (
        current.current === expectedScope &&
        generation.current === expectedGeneration
      )
        setError(reason instanceof Error ? reason.message : "图片读取失败");
    } finally {
      for (const image of added)
        if (!imagesRef.current.includes(image)) URL.revokeObjectURL(image.url);
      if (
        current.current === expectedScope &&
        generation.current === expectedGeneration
      ) {
        busy.current = false;
        setPreparing(false);
      }
    }
  }

  function remove(id: string) {
    const image = imagesRef.current.find((candidate) => candidate.id === id);
    if (!image) return;
    URL.revokeObjectURL(image.url);
    const next = imagesRef.current.filter((candidate) => candidate.id !== id);
    imagesRef.current = next;
    setState({ scope, images: next });
    setError(undefined);
  }

  const images = state.scope === scope ? state.images : [];
  function content(text: string): UserInput {
    return [
      ...(text.trim() ? [{ type: "text" as const, text: text.trim() }] : []),
      ...images.map((image) => image.content),
    ];
  }
  return { images, preparing, error, add, remove, clear, content };
}
