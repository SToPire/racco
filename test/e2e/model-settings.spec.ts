import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

async function openEffort(page: Page) {
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("button", { name: "推理强度", exact: true }).click();
}

async function expectEffort(page: Page, value: string) {
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "推理强度", exact: true }),
  ).toContainText(value);
  await page.keyboard.press("Escape");
}

test("a rejected turn keeps its text and selections for correction", async ({
  page,
  racco,
}) => {
  await page.route("**/api/providers/*/models?*", async (route) => {
    const response = await route.fetch();
    const catalog = await response.json();
    catalog.models.push({
      ...catalog.models[0],
      id: "browser-only",
      displayName: "Unavailable Model",
    });
    await route.fulfill({ response, json: catalog });
  });
  await page.goto(`/session/${racco.sessions[0].sessionId}`);
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("option", { name: /Unavailable Model/ }).click();
  await page
    .getByRole("textbox", { name: "发送给 Racco" })
    .fill("do not lose this task");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.locator(".session-view:not([hidden]) .conversation .error-banner"),
  ).toContainText("browser-only 当前不可选");
  await expect(page.getByRole("textbox", { name: "发送给 Racco" })).toHaveValue(
    "do not lose this task",
  );
  await expect(
    page.getByRole("button", { name: "模型", exact: true }),
  ).toHaveText("Unavailable Model");
  await expectEffort(page, "high");
});

test("native model/effort selections are submitted, restored and synchronized as a pair", async ({
  page,
  context,
  racco,
}) => {
  await page.goto(`/session/${racco.sessions[0].sessionId}`);
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("option", { name: /Fixture Primary/ }).click();
  await openEffort(page);
  await page.getByRole("option", { name: "xhigh", exact: true }).click();
  await page
    .getByRole("textbox", { name: "发送给 Racco" })
    .fill("chosen-settings");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("Fixture: chosen-settings", { exact: true }),
  ).toBeVisible();
  const summary = await (
    await page.request.get(`/api/sessions/${racco.sessions[0].sessionId}`)
  ).json();
  expect(summary.session.selectedModelSettings).toEqual({
    modelId: "fixture-primary",
    reasoningEffort: "xhigh",
  });
  await page.reload();
  await expectEffort(page, "xhigh");
  const other = await context.newPage();
  await other.goto(page.url());
  await expectEffort(other, "xhigh");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("option", { name: /Fixture Fast/ }).click();
  await expectEffort(page, "low");
  await expect(page.getByRole("status")).toContainText("推理强度已调整为 low");
  await page
    .getByRole("textbox", { name: "发送给 Racco" })
    .fill("switched-model");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("Fixture: switched-model", { exact: true }),
  ).toBeVisible();
  await expect(
    other.getByRole("button", { name: "模型", exact: true }),
  ).toHaveText("Fixture Fast");
  await expectEffort(other, "low");
  await openEffort(other);
  await other.getByRole("option", { name: "medium", exact: true }).click();
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("option", { name: /Fixture Fixed/ }).click();
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "推理强度", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "发送给 Racco" }).fill("fixed-model");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("Fixture: fixed-model", { exact: true }),
  ).toBeVisible();
  await expect(
    other.getByRole("button", { name: "模型", exact: true }),
  ).toHaveText("Fixture Fast");
  await expectEffort(other, "medium");
  await expect(other.getByRole("status")).toContainText("保留本地选择");
});

test("model menus fit a narrow screen and keyboard selection never submits the prompt", async ({
  page,
  racco,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto(`/session/${racco.sessions[1].sessionId}`);
  await page
    .getByRole("textbox", { name: "发送给 Racco" })
    .fill("keep this draft");
  const model = page.getByRole("button", { name: "模型", exact: true });
  await model.click();
  const box = await page.getByRole("listbox", { name: "模型" }).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "推理强度", exact: true }),
  ).toHaveCount(0);
  await model.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "推理强度", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expectEffort(page, "xhigh");
  await expect(page.getByRole("textbox", { name: "发送给 Racco" })).toHaveValue(
    "keep this draft",
  );
  await openEffort(page);
  const effortBox = await page
    .getByRole("listbox", { name: "推理强度" })
    .boundingBox();
  expect(effortBox!.x).toBeGreaterThanOrEqual(0);
  expect(effortBox!.x + effortBox!.width).toBeLessThanOrEqual(360);
  await page.getByRole("button", { name: "返回模型列表" }).click();
  await expect(page.getByRole("listbox", { name: "模型" })).toBeVisible();
  await page.getByRole("button", { name: "推理强度", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "模型" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(model).toBeFocused();
  const snapshot = await (
    await page.request.get(`/api/sessions/${racco.sessions[1].sessionId}`)
  ).json();
  expect(snapshot.session.selectedModelSettings).toBeNull();
});

test("catalog failures preserve the draft and loading the page again restores the catalog", async ({
  page,
  racco,
}) => {
  await page.route("**/api/providers/*/models?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "catalog unavailable" }),
    }),
  );
  await page.goto(`/session/${racco.sessions[0].sessionId}`);
  await page
    .getByRole("textbox", { name: "发送给 Racco" })
    .fill("preserved draft");
  await expect(page.getByRole("status")).toHaveText("catalog unavailable");
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "发送给 Racco" })).toHaveValue(
    "preserved draft",
  );
  await page.unroute("**/api/providers/*/models?*");
  await page.reload();
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("option", { name: /Fixture Primary/ }).click();
  await page
    .getByRole("textbox", { name: "发送给 Racco" })
    .fill("recovered task");
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeEnabled();
});
