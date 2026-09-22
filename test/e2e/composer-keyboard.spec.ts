import { test, expect } from "./fixtures";

for (const view of ["home", "conversation"] as const) {
  test(`${view} sends with Enter, inserts a newline with Shift+Enter and preserves IME confirmation`, async ({
    page,
    racco,
  }) => {
    await page.goto(
      view === "home" ? "/" : `/session/${racco.sessions[0]!.sessionId}`,
    );
    const input = page.getByRole("textbox", {
      name: view === "home" ? "首条任务" : "发送给 Racco",
    });
    const send = page.getByRole("button", {
      name: view === "home" ? "新建并发送" : "发送",
      exact: true,
    });
    await expect(input).toBeEnabled();
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await expect(send).toBeDisabled();

    await input.fill("第一行");
    if (view === "conversation") {
      await input.press("Enter");
      await expect(input).toHaveValue("第一行");
      await expect(send).toBeDisabled();
      await page.getByRole("button", { name: "模型", exact: true }).click();
      await page.getByRole("option", { name: /Fixture Primary/ }).click();
    }
    await expect(send).toBeEnabled();
    await input.press("Shift+Enter");
    await input.pressSequentially("second line");
    const prompt = "第一行\nsecond line";
    await expect(input).toHaveValue(prompt);

    const composition = await input.evaluate((textarea) => {
      const form = textarea.closest("form")!;
      let submitted = false;
      const onSubmit = () => {
        submitted = true;
      };
      form.addEventListener("submit", onSubmit);
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      textarea.dispatchEvent(event);
      form.removeEventListener("submit", onSubmit);
      return { submitted, prevented: event.defaultPrevented };
    });
    expect(composition).toEqual({ submitted: false, prevented: false });
    await expect(input).toHaveValue(prompt);

    await input.press("Enter");
    await expect(page).toHaveURL(/\/session\//);
    await expect(
      page.locator(".session-view:not([hidden]) .message-user").last(),
    ).toHaveText(prompt);
    await expect(
      page.getByText(`Fixture: ${prompt}`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "发送给 Racco" }),
    ).toHaveValue("");
  });
}
