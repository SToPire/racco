import sharp from "sharp";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

async function image(name = "red.png", color = "red") {
  return {
    name,
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 32, height: 32, channels: 3, background: color },
    })
      .png()
      .toBuffer(),
  };
}
async function selectPrimary(page: Page) {
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("option", { name: /Fixture Primary/ }).click();
}

for (const provider of ["codex", "claude"] as const) {
  test(`${provider} accepts a pure-image first turn and keeps only a placeholder on reload`, async ({
    page,
  }) => {
    const received: string[] = [];
    page.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) =>
        received.push(String(payload)),
      ),
    );
    await page.goto("/");
    if (provider === "claude")
      await page.getByRole("button", { name: "Claude", exact: true }).click();
    const png = await image();
    await page.getByLabel("选择图片文件").setInputFiles(png);
    await expect(
      page.getByRole("img", { name: "图片 1：red.png" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "新建并发送", exact: true }).click();
    await expect(page).toHaveURL(/\/session\//);
    await expect(
      page.locator(".session-view:not([hidden]) .message-image-placeholder"),
    ).toHaveText("图片 × 1 · 未保留预览");
    await expect(
      page.locator(".session-view:not([hidden]) .message-assistant"),
    ).toContainText("Fixture:");
    expect(
      received.every(
        (message) => !message.includes(png.buffer.toString("base64")),
      ),
    ).toBe(true);
    await page.reload();
    await expect(
      page.locator(".session-view:not([hidden]) .message-image-placeholder"),
    ).toHaveText("图片 × 1 · 未保留预览");
    await expect(page.locator(".message-user img")).toHaveCount(0);
    await expect(page.getByLabel("待发送图片")).toHaveCount(0);
    await page.getByRole("textbox", { name: "发送给 Racco" }).fill("continue");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(
      page.getByText("Fixture: continue", { exact: true }),
    ).toBeVisible();
  });
}

test("existing conversation supports pasted and dropped images, removal and ordered multi-image sends", async ({
  page,
  racco,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const sent: {
    content: Array<{ type: string; text?: string; data?: string }>;
  }[] = [];
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      const command = JSON.parse(String(payload));
      if (command.type === "turn.start") sent.push(command);
    }),
  );
  await page.goto(`/session/${racco.sessions[0].sessionId}`);
  await selectPrimary(page);
  const red = await image(),
    blue = await image("blue.png", "blue");
  for (const [kind, png] of [
    ["paste", red],
    ["drop", blue],
  ] as const) {
    await page.locator(".session-view:not([hidden]) .composer").evaluate(
      (form, { kind, data, name }) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File(
            [Uint8Array.from(atob(data), (char) => char.charCodeAt(0))],
            name,
            { type: "image/png" },
          ),
        );
        form.dispatchEvent(
          kind === "paste"
            ? new ClipboardEvent("paste", {
                clipboardData: transfer,
                bubbles: true,
                cancelable: true,
              })
            : new DragEvent("drop", {
                dataTransfer: transfer,
                bubbles: true,
                cancelable: true,
              }),
        );
      },
      { kind, data: png.buffer.toString("base64"), name: png.name },
    );
    await expect(page.getByLabel("待发送图片").locator("img")).toHaveCount(
      kind === "paste" ? 1 : 2,
    );
  }
  await page.getByRole("button", { name: "移除图片 1" }).click();
  await expect(
    page.getByRole("img", { name: "图片 1：blue.png" }),
  ).toBeVisible();
  await page.getByLabel("选择图片文件").setInputFiles(red);
  await expect(page.getByLabel("待发送图片").locator("img")).toHaveCount(2);
  await page.getByRole("textbox", { name: "发送给 Racco" }).fill("compare");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("Fixture: compare", { exact: true }),
  ).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(sent[0].content.map((part) => part.type)).toEqual([
    "text",
    "image",
    "image",
  ]);
  expect(sent[0].content[1].data).toBe(blue.buffer.toString("base64"));
  expect(sent[0].content[2].data).toBe(red.buffer.toString("base64"));
  await expect(page.getByLabel("待发送图片")).toHaveCount(0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});

test("a server-rejected image keeps the draft and does not allocate a first session", async ({
  page,
}) => {
  await page.goto("/");
  const before = await (await page.request.get("/api/sessions")).json();
  await page.getByLabel("选择图片文件").setInputFiles({
    name: "broken.png",
    mimeType: "image/png",
    buffer: Buffer.from("not a PNG image"),
  });
  await expect(page.getByLabel("待发送图片").locator("img")).toHaveCount(1);
  await page.getByRole("textbox", { name: "首条任务" }).fill("keep this draft");
  await page.getByRole("button", { name: "新建并发送", exact: true }).click();
  await expect(
    page.locator(".new-session-composer .error-banner"),
  ).toContainText("图片解码失败");
  await expect(page.getByRole("textbox", { name: "首条任务" })).toHaveValue(
    "keep this draft",
  );
  await expect(page.getByLabel("待发送图片").locator("img")).toHaveCount(1);
  expect(await (await page.request.get("/api/sessions")).json()).toHaveLength(
    before.length,
  );
});

test("images stay out of a different home worktree draft and unsupported models block image submission", async ({
  page,
}) => {
  await page.route("**/api/providers/*/models?*", async (route) => {
    const response = await route.fetch();
    const catalog = await response.json();
    catalog.models.find(
      (model: { id: string }) => model.id === "fixture-fast",
    ).imageInput = "unsupported";
    await route.fulfill({ response, json: catalog });
  });
  await page.goto("/");
  await page.getByLabel("选择图片文件").setInputFiles(await image());
  await expect(page.getByLabel("待发送图片").locator("img")).toHaveCount(1);
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("option", { name: /Fixture Fast/ }).click();
  await expect(page.getByRole("alert")).toContainText("不支持图片");
  await expect(
    page.getByRole("button", { name: "新建并发送", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("option", { name: "beta", exact: true }).click();
  await expect(page.getByLabel("待发送图片")).toHaveCount(0);
});
