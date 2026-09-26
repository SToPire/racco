import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./fixtures";

for (const provider of ["codex", "claude"] as const) {
  test(`${provider} opens the tail, prepends history without jumping and reloads stale cursors`, async ({
    page,
    racco,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const session = racco.sessions.find(
      (entry) => entry.provider === provider,
    )!;
    const file = join(
      racco.directory,
      "providers",
      provider,
      `fixture-${provider}.json`,
    );
    const history = JSON.parse(await readFile(file, "utf8"));
    history.events = Array.from({ length: 35 }, (_, index) => [
      { type: "user.message", id: `u${index}`, text: `Request ${index}` },
      {
        type: "assistant.message",
        id: `a${index}`,
        text: `Answer ${index}\n\n${"A detailed reply. ".repeat(40)}`,
      },
    ]).flat();
    await writeFile(file, JSON.stringify(history));
    if (provider === "claude") {
      const response = await page.request.get(
        `/api/sessions/${session.sessionId}/history?refresh=true`,
      );
      expect(response.ok()).toBe(true);
    }
    await page.goto(`/session/${session.sessionId}`);
    const conversation = page.locator(".conversation");
    await expect(conversation).toHaveAttribute("aria-busy", "false");
    await expect(conversation.locator(".message-user")).toHaveCount(10);
    await expect(
      conversation.getByText("Request 34", { exact: true }),
    ).toBeAttached();
    await expect(
      conversation.getByText("Request 0", { exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        conversation.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThan(5);

    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    await page.route(
      "**/history?*cursor*",
      async (route) => {
        entered();
        await gate;
        await route.continue();
      },
      { times: 1 },
    );
    await conversation.evaluate((element) => {
      element.scrollTop = 60;
    });
    await requested;
    await expect(conversation).toHaveAttribute("aria-busy", "true");
    const anchor = conversation.locator('[data-timeline-row="u25"]');
    const before = await anchor.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    release();
    await expect(conversation.locator(".message-user")).toHaveCount(20);
    await expect
      .poll(() =>
        anchor.evaluate((element) => element.getBoundingClientRect().top),
      )
      .toBeCloseTo(before, 0);
    await expect(
      conversation.getByText("Request 15", { exact: true }),
    ).toBeAttached();
    await expect(
      conversation.getByText("Request 0", { exact: true }),
    ).toHaveCount(0);

    // Another client rebuilt Claude's history. The old cursor must cause a
    // fresh tail read, rather than merging pages from two different histories.
    if (provider === "claude") {
      const refreshed = await page.request.get(
        `/api/sessions/${session.sessionId}/history?refresh=true`,
      );
      expect(refreshed.ok()).toBe(true);
      await conversation.evaluate((element) => {
        element.scrollTop = 60;
      });
      await expect(conversation.locator(".message-user")).toHaveCount(10);
      await expect(conversation).toHaveAttribute("aria-busy", "false");
      await expect(
        conversation.getByText("Request 34", { exact: true }),
      ).toBeAttached();
    }
    await page.reload();
    await expect(conversation).toHaveAttribute("aria-busy", "false");
    await expect(conversation.locator(".message-user")).toHaveCount(10);
  });
}
