export type DiffLine = {
  text: string;
  kind: "added" | "removed" | "hunk" | "context";
};

/** Only hunk bodies contain changed lines; header-looking source remains source. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  let oldRemaining = 0;
  let newRemaining = 0;
  return diff.split("\n").map((text): DiffLine => {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?:.*)$/.exec(text);
    if (hunk) {
      oldRemaining = Number(hunk[1] ?? 1);
      newRemaining = Number(hunk[2] ?? 1);
      return { text, kind: "hunk" };
    }
    if (oldRemaining > 0 && text.startsWith("-")) {
      oldRemaining -= 1;
      return { text, kind: "removed" };
    }
    if (newRemaining > 0 && text.startsWith("+")) {
      newRemaining -= 1;
      return { text, kind: "added" };
    }
    if (text.startsWith(" ")) {
      oldRemaining = Math.max(0, oldRemaining - 1);
      newRemaining = Math.max(0, newRemaining - 1);
    }
    return { text, kind: "context" };
  });
}
