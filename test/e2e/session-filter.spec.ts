import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WebSocketRoute } from "@playwright/test";
import { test, expect } from "./fixtures";

test("local history filters titles and projects and groups in-progress conversations without duplicates", async ({
  page,
  racco,
}) => {
  const directory = join(racco.directory, "providers", "codex");
  const snapshot = JSON.parse(
    await readFile(join(directory, "fixture-codex.json"), "utf8"),
  );
  for (let i = 0; i < 24; i++) {
    const nativeId = `search-${i}`;
    await writeFile(
      join(directory, `${nativeId}.json`),
      JSON.stringify({
        ...snapshot,
        metadata: { ...snapshot.metadata, title: `Review ${i}` },
      }),
    );
    const response = await page.request.post("/api/sessions/import", {
      data: {
        provider: "codex",
        providerSessionId: nativeId,
        projectId: racco.projects[0]!.projectId,
        path: racco.projects[0]!.path,
      },
    });
    expect(response.ok()).toBe(true);
  }
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws", (route) => {
    socket = route;
    route.connectToServer();
  });
  await page.goto(`/session/${racco.sessions[0]!.sessionId}`);
  await expect(page.locator(".history-row")).toHaveCount(26);
  const filter = page.getByRole("searchbox", { name: "筛选对话或项目" });
  await filter.fill("Review 19");
  await expect(page.locator(".history-row")).toHaveCount(1);
  await expect(page.locator(".history-row")).toContainText("Review 19");
  await filter.fill("BETA");
  await expect(page.locator(".history-row")).toHaveCount(1);
  await expect(
    page.getByRole("region", { name: "项目 beta", exact: true }),
  ).toBeVisible();
  await filter.fill("no matching conversation");
  await expect(page.getByText("没有匹配的对话或项目")).toBeVisible();
  await filter.fill("");
  socket!.send(
    JSON.stringify({
      type: "session.upserted",
      session: { ...racco.sessions[0], state: "waiting_interaction" },
    }),
  );
  const ongoing = page.getByRole("region", { name: "进行中的对话" });
  await expect(ongoing.locator(".history-row")).toHaveCount(1);
  await expect(ongoing).toContainText("等待操作");
  await expect(page.locator(".history-row")).toHaveCount(26);
  socket!.send(
    JSON.stringify({
      type: "session.upserted",
      session: { ...racco.sessions[0], state: "idle" },
    }),
  );
  await expect(ongoing).toHaveCount(0);
  await expect(page.locator(".history-row")).toHaveCount(26);
});
