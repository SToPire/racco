import { test, expect } from "./fixtures";

test("Racco identity and the composer appear directly on the home screen in both themes", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page).toHaveTitle("Racco");
  const sidebarLogo = page
    .locator(".project-sidebar-header")
    .getByRole("img", { name: "Racco", exact: true });
  await expect(sidebarLogo).toBeVisible();
  const hero = page.locator(".new-session-brand");
  await expect(hero.getByRole("heading", { name: "Racco" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "首条任务" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "选择一个对话" })).toHaveCount(
    0,
  );
  await expect(
    page
      .locator(".workspace")
      .getByRole("button", { name: "新建对话", exact: true }),
  ).toHaveCount(0);
  const favicon = await page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!;
    return (await fetch(link.href)).text();
  });
  expect(favicon).toContain("<svg");
  expect(favicon).toContain("Racco");
  await expect
    .poll(() =>
      sidebarLogo.evaluate(
        (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
      ),
    )
    .toBe(true);
  const lightSource = await sidebarLogo.evaluate(
    (img: HTMLImageElement) => img.currentSrc,
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(() => sidebarLogo.evaluate((img: HTMLImageElement) => img.currentSrc))
    .not.toBe(lightSource);
  await expect
    .poll(() =>
      sidebarLogo.evaluate(
        (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
      ),
    )
    .toBe(true);
  await expect(
    hero.getByRole("img", { name: "Racco", exact: true }),
  ).toBeVisible();
});

test("Racco branding leaves mobile project and composer controls accessible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  const hero = page.locator(".new-session-brand");
  await expect(hero).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "项目", exact: true }),
  ).toBeInViewport();
  await expect(
    page.getByRole("textbox", { name: "首条任务" }),
  ).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "新建并发送" }),
  ).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
  await page.getByRole("button", { name: "返回对话历史" }).click();
  await expect(
    page.locator(".sidebar").getByRole("img", { name: "Racco", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "在项目 beta 中新建对话" }).click();
  await expect(
    page.getByRole("button", { name: "项目", exact: true }),
  ).toHaveText("beta");
  await expect(
    page.getByRole("textbox", { name: "首条任务" }),
  ).toBeInViewport();
});
