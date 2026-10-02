import { compose } from "node:stream";
import { spec } from "node:test/reporters";
import { writeFile } from "node:fs/promises";

// Preserve Node's normal console report, and record actual case counts for check.
export default async function* report(source) {
  let counts;
  async function* observe() {
    for await (const event of source) {
      if (event.type === "test:summary" && event.data.file === undefined)
        counts = event.data.counts;
      yield event;
    }
  }
  yield* compose(observe(), spec());
  if (process.env.RACCO_TEST_REPORT) {
    if (!counts || counts.tests === 0)
      throw new Error("No test cases reported");
    await writeFile(
      process.env.RACCO_TEST_REPORT,
      JSON.stringify(counts) + "\n",
    );
  }
}
