export function userRequestAnchorId(id: string): string {
  return `user-request-${encodeURIComponent(id)}`;
}

export function userRequestPreview(text: string, maxLength = 56): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return "空请求";
  const characters = [...compact];
  if (characters.length <= maxLength) return compact;
  return `${characters.slice(0, Math.max(1, maxLength - 1)).join("")}…`;
}
