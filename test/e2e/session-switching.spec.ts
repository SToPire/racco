import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./fixtures";

test("returning to a long conversation reuses its DOM, draft and reading position before history refresh", async ({
  page,
  racco,
}) => {
  const file = join(
    racco.directory,
    "providers",
    "codex",
    "fixture-codex.json",
  );
  const history = JSON.parse(await readFile(file, "utf8"));
  history.events = Array.from({ length: 120 }, (_, index) => [
    { type: "user.message", id: `user-${index}`, text: `Request ${index}` },
    {
      type: "assistant.message",
      id: `reply-${index}`,
      text: `## Reply ${index}\n\nA paragraph with **formatting** and inline \\(x^2\\).\n\n\`\`\`ts\nconst answer = ${index};\n\`\`\``,
    },
  ]).flat();
  await writeFile(file, JSON.stringify(history));
  const models: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/models?")) models.push(request.url());
  });
  let hold = false;
  const held: Array<() => void> = [];
  await page.routeWebSocket("**/api/ws", (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      const data = JSON.parse(message.toString());
      if (
        hold &&
        data.type === "session.snapshot" &&
        data.session.sessionId === racco.sessions[0].sessionId
      )
        held.push(() => socket.send(message));
      else socket.send(message);
    });
  });
  await page.goto(`/session/${racco.sessions[0].sessionId}`);
  const conversation = page.locator(
    ".session-view:not([hidden]) .conversation",
  );
  await expect(conversation).toHaveAttribute("aria-busy", "false");
  await expect
    .poll(() =>
      conversation.evaluate(
        (element) =>
          element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThan(2);
  await page
    .getByRole("textbox", { name: "发送给 Racco" })
    .fill("keep this draft");
  const position = await conversation.evaluate((element) => {
    element.setAttribute("data-retained", "true");
    element.scrollTop = 4000;
    return element.scrollTop;
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  await page
    .locator(".history-row")
    .filter({ hasText: racco.sessions[1].title! })
    .click();
  await expect(
    page.locator(".session-view:not([hidden]) .session-title-line h1"),
  ).toHaveText(racco.sessions[1].title!);
  await expect(conversation).toHaveAttribute("aria-busy", "false");
  history.events.push({
    type: "assistant.message",
    id: "external",
    text: "external update",
  });
  await writeFile(file, JSON.stringify(history));
  hold = true;
  await page
    .locator(".history-row")
    .filter({ hasText: racco.sessions[0].title! })
    .click();
  await expect(conversation).toHaveAttribute("data-retained", "true");
  await expect(page.getByRole("textbox", { name: "发送给 Racco" })).toHaveValue(
    "keep this draft",
  );
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollTop))
    .toBeCloseTo(position, 0);
  await expect.poll(() => held.length).toBe(1);
  expect(
    models.filter(
      (url) => new URL(url).searchParams.get("path") === racco.projects[0].path,
    ),
  ).toHaveLength(1);
  hold = false;
  held.splice(0).forEach((release) => release());
  await expect(
    conversation.getByText("external update", { exact: true }),
  ).toBeAttached();
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollTop))
    .toBeCloseTo(position, 0);
  await page.goBack();
  await expect(
    page.locator(".session-view:not([hidden]) .session-title-line h1"),
  ).toHaveText(racco.sessions[1].title!);
  await page.goForward();
  await expect(conversation).toHaveAttribute("data-retained", "true");
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollTop))
    .toBeCloseTo(position, 0);
});

test("switching back to a bottom reader follows new output and deleted sessions leave the cache", async ({
  page,
  racco,
}) => {
  await page.goto(`/session/${racco.sessions[0].sessionId}`);
  const active = page.locator(".session-view:not([hidden])");
  await expect(active.locator(".conversation")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await page
    .locator(".history-row")
    .filter({ hasText: racco.sessions[1].title! })
    .click();
  await expect(active.locator(".conversation")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.locator(".session-view")).toHaveCount(2);
  const file = join(
    racco.directory,
    "providers",
    "codex",
    "fixture-codex.json",
  );
  const history = JSON.parse(await readFile(file, "utf8"));
  history.events.push({
    type: "assistant.message",
    id: "long-update",
    text: "New output\n\n".repeat(100),
  });
  await writeFile(file, JSON.stringify(history));
  await page
    .locator(".history-row")
    .filter({ hasText: racco.sessions[0].title! })
    .click();
  await expect(active.getByText("New output", { exact: true })).toHaveCount(
    100,
  );
  await expect
    .poll(() =>
      active
        .locator(".conversation")
        .evaluate(
          (element) =>
            element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
    )
    .toBeLessThan(2);
  await page.request.delete(`/api/sessions/${racco.sessions[0].sessionId}`);
  await expect(page).toHaveURL("/");
  await expect(
    page.locator(
      `.session-view[data-session-id="${racco.sessions[0].sessionId}"]`,
    ),
  ).toHaveCount(0);
});
