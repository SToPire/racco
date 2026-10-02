import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { test, expect } from "./fixtures";

async function draftImage() {
  return {
    name: "draft.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 16, height: 16, channels: 3, background: "red" },
    })
      .png()
      .toBuffer(),
  };
}

const active = ".session-view:not([hidden])";

test("home text and image drafts survive opening a session without leaking into another worktree", async ({
  page,
  racco,
}) => {
  await page.goto("/");
  const text = page.getByRole("textbox", { name: "首条任务" });
  await text.fill("unsent home task");
  await page.getByLabel("选择图片文件").setInputFiles(await draftImage());
  const image = page.getByRole("img", { name: "图片 1：draft.png" });
  await expect(image).toBeVisible();
  const url = await image.getAttribute("src");
  await page
    .locator(".history-row")
    .filter({ hasText: racco.sessions[0].title! })
    .click();
  await expect(page.getByRole("textbox", { name: "发送给 Racco" })).toHaveValue(
    "",
  );
  await expect(page.getByLabel("待发送图片")).toHaveCount(0);
  await page.goBack();
  await expect(text).toHaveValue("unsent home task");
  await expect(image).toHaveAttribute("src", url!);
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBe(16);
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("option", { name: "beta", exact: true }).click();
  await expect(page.getByLabel("待发送图片")).toHaveCount(0);
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("option", { name: "alpha", exact: true }).click();
  await expect(image).toHaveAttribute("src", url!);
  expect(
    await page.evaluate(() => [localStorage.length, sessionStorage.length]),
  ).toEqual([0, 0]);
  await page.reload();
  await expect(text).toHaveValue("");
  await expect(page.getByLabel("待发送图片")).toHaveCount(0);
});

test("text and images outlive the eight-view LRU and are released after a confirmed send", async ({
  page,
  racco,
}) => {
  const directory = join(racco.directory, "providers", "codex");
  const snapshot = JSON.parse(
    await readFile(join(directory, "fixture-codex.json"), "utf8"),
  );
  for (let i = 0; i < 8; i++) {
    const providerSessionId = `draft-lru-${i}`;
    await writeFile(
      join(directory, `${providerSessionId}.json`),
      JSON.stringify({
        ...snapshot,
        metadata: { ...snapshot.metadata, title: `LRU target ${i}` },
      }),
    );
    const response = await page.request.post("/api/sessions/import", {
      data: {
        provider: "codex",
        providerSessionId,
        projectId: racco.projects[0].projectId,
        path: racco.projects[0].path,
      },
    });
    expect(response.ok()).toBe(true);
  }
  await page.goto(`/session/${racco.sessions[0].sessionId}`);
  const text = page.getByRole("textbox", { name: "发送给 Racco" });
  await text.fill("keep beyond view eviction");
  await page
    .locator(active)
    .getByLabel("选择图片文件")
    .setInputFiles(await draftImage());
  const image = page.getByRole("img", { name: "图片 1：draft.png" });
  await expect(image).toBeVisible();
  const url = await image.getAttribute("src");
  for (let i = 0; i < 8; i++) {
    await page
      .locator(".history-row")
      .filter({ hasText: `LRU target ${i}` })
      .click();
    await expect(page.locator(`${active} h1`)).toHaveText(`LRU target ${i}`);
  }
  await expect(
    page.locator(`[data-session-id="${racco.sessions[0].sessionId}"]`),
  ).toHaveCount(0);
  await page
    .locator(".history-row")
    .filter({ hasText: racco.sessions[0].title! })
    .click();
  await expect(text).toHaveValue("keep beyond view eviction");
  await expect(image).toHaveAttribute("src", url!);
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBe(16);
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("option", { name: /Fixture Primary/ }).click();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("Fixture: keep beyond view eviction", { exact: true }),
  ).toBeVisible();
  await expect(text).toHaveValue("");
  await expect(page.getByLabel("待发送图片")).toHaveCount(0);
  expect(
    await page.evaluate(
      async (src) =>
        fetch(src!).then(
          () => true,
          () => false,
        ),
      url,
    ),
  ).toBe(false);
});

test("deleting a session releases its draft images even while another session is open", async ({
  page,
  racco,
}) => {
  await page.goto(`/session/${racco.sessions[0].sessionId}`);
  await page
    .locator(active)
    .getByLabel("选择图片文件")
    .setInputFiles(await draftImage());
  const image = page.getByRole("img", { name: "图片 1：draft.png" });
  await expect(image).toBeVisible();
  const url = await image.getAttribute("src");
  await page
    .locator(".history-row")
    .filter({ hasText: racco.sessions[1].title! })
    .click();
  const response = await page.request.delete(
    `/api/sessions/${racco.sessions[0].sessionId}`,
  );
  expect(response.ok()).toBe(true);
  await expect(
    page.locator(`[data-session-id="${racco.sessions[0].sessionId}"]`),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        async (src) =>
          fetch(src!).then(
            () => true,
            () => false,
          ),
        url,
      ),
    )
    .toBe(false);
});
