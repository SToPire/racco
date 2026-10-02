import type {
  ClientCommand,
  InteractionResponse,
} from "../../src/shared/protocol";
import { test, expect } from "./fixtures";

for (const finalSingle of ["option", "other"] as const) {
  test(`other answers preserve multiple choices and submit the visible single ${finalSingle}`, async ({
    page,
    racco,
  }) => {
    const responses: InteractionResponse[] = [];
    page.on("websocket", (socket) =>
      socket.on("framesent", ({ payload }) => {
        const command = JSON.parse(String(payload)) as ClientCommand;
        if (command.type === "interaction.resolve")
          responses.push(command.response);
      }),
    );
    await page.goto(`/session/${racco.sessions[0].sessionId}`);
    await page.getByRole("button", { name: "模型", exact: true }).click();
    await page.getByRole("option", { name: /Fixture Primary/ }).click();
    await page
      .getByRole("textbox", { name: "发送给 Racco" })
      .fill("question-other");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const alpha = page.getByRole("checkbox", { name: "Alpha", exact: true });
    const beta = page.getByRole("checkbox", { name: "Beta", exact: true });
    const multipleText = page.getByRole("textbox", {
      name: "选择多个选项 的文本回答",
    });
    await alpha.check();
    await beta.check();
    await multipleText.fill("custom initial");
    await expect(alpha).toBeChecked();
    await expect(beta).toBeChecked();
    await beta.uncheck();
    await multipleText.fill("custom final");
    await expect(alpha).toBeChecked();
    await expect(beta).not.toBeChecked();
    const singleText = page.getByRole("textbox", {
      name: "选择一个选项 的文本回答",
    });
    const gamma = page.getByRole("radio", { name: "Gamma", exact: true });
    await singleText.fill("stale other");
    await gamma.check();
    await expect(singleText).toHaveValue("");
    if (finalSingle === "other") {
      await singleText.fill("visible other");
      await expect(gamma).not.toBeChecked();
    }
    await page.getByRole("button", { name: "Trajectory", exact: true }).click();
    await expect(multipleText).toHaveValue("custom final");
    await expect(alpha).toBeChecked();
    await page.getByRole("button", { name: "提交回答", exact: true }).click();
    await expect(
      page.locator(".session-view:not([hidden]) .run-state"),
    ).toHaveText("空闲");
    expect(responses).toEqual([
      {
        decision: "answer",
        answers: {
          multiple: ["Alpha", "custom final"],
          single: [finalSingle === "option" ? "Gamma" : "visible other"],
        },
      },
    ]);
  });
}
