import type { Locator, WebSocketRoute } from "@playwright/test";
import type {
  ServerMessage,
  SessionState,
  TimelineEvent,
} from "../../src/shared/protocol";
import { test, expect } from "./fixtures";

async function textContrast(locator: Locator) {
  const colors = await locator.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const ancestors: Element[] = [];
    for (let node: Element | null = element; node; node = node.parentElement)
      ancestors.unshift(node);
    // Composite the actual computed backgrounds, including translucent pills.
    for (const node of ancestors) {
      context.fillStyle = getComputedStyle(node).backgroundColor;
      context.fillRect(0, 0, 1, 1);
    }
    const background = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = getComputedStyle(element).color;
    context.fillRect(0, 0, 1, 1);
    const foreground = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    return { background, foreground };
  });
  const luminance = (color: number[]) =>
    color.reduce((sum, value, index) => {
      const channel = value / 255;
      return (
        sum +
        [0.2126, 0.7152, 0.0722][index]! *
          (channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4)
      );
    }, 0);
  const values = [luminance(colors.foreground), luminance(colors.background)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`${colorScheme} session states share labels and readable colors while child state stays independent`, async ({
    page,
    racco,
  }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    const session = racco.sessions[0]!;
    let socket: WebSocketRoute;
    await page.routeWebSocket("**/api/ws", (route) => {
      socket = route;
      route.connectToServer();
    });
    const emit = (event: TimelineEvent) =>
      socket.send(
        JSON.stringify({
          type: "timeline.event",
          session: { sessionId: session.sessionId },
          event,
        } satisfies ServerMessage),
      );
    await page.goto(`/session/${session.sessionId}`);
    await expect(page.locator(".message-assistant")).toBeVisible();
    emit({
      type: "subagent.started",
      id: "review-start",
      agentId: "review",
      name: "Reviewer",
    });
    emit({
      type: "subagent.state",
      id: "review-done",
      agentId: "review",
      state: "completed",
    });
    const badge = page.getByRole("status", { name: "会话状态", exact: true });
    const sidebar = page.locator(".history-row.active");
    const switcher = page.locator(".agent-switcher-trigger");
    for (const state of [
      "idle",
      "running",
      "waiting_interaction",
      "interrupted",
      "error",
    ] satisfies SessionState[]) {
      socket!.send(
        JSON.stringify({
          type: "session.upserted",
          session: { ...session, state },
        } satisfies ServerMessage),
      );
      await expect(badge).toHaveClass(new RegExp(`state-${state}`));
      const label = await badge.innerText();
      await expect(sidebar.locator("small")).toContainText(label);
      expect(
        await textContrast(sidebar.locator("small")),
      ).toBeGreaterThanOrEqual(4.5);
      await expect(switcher).toHaveAttribute("title", `Main Agent · ${label}`);
      const color = await badge.evaluate(
        (element) => getComputedStyle(element).color,
      );
      await expect(sidebar.locator(".state-dot")).toHaveCSS(
        "background-color",
        color,
      );
      await expect(switcher.locator(".state-dot")).toHaveCSS(
        "background-color",
        color,
      );
      expect(await textContrast(badge)).toBeGreaterThanOrEqual(4.5);
    }
    socket!.send(
      JSON.stringify({
        type: "session.upserted",
        session: { ...session, state: "running", compacting: true },
      } satisfies ServerMessage),
    );
    await expect(badge).toHaveText("压缩中");
    await expect(sidebar.locator("small")).toContainText("压缩中");
    await expect(switcher).toHaveAttribute("title", "Main Agent · 压缩中");
    await switcher.click();
    expect(
      await textContrast(
        page
          .getByRole("option")
          .filter({ hasText: "Main Agent" })
          .locator("small"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
    await page.getByRole("option").filter({ hasText: "Reviewer" }).click();
    await expect(switcher).toHaveAttribute("title", "Reviewer · 已完成");
    await expect(badge).toHaveText("压缩中");
    emit({
      type: "subagent.state",
      id: "review-error",
      agentId: "review",
      state: "error",
    });
    socket!.send(
      JSON.stringify({
        type: "session.upserted",
        session: { ...session, state: "error" },
      } satisfies ServerMessage),
    );
    await expect(badge).toHaveText("出错");
    await expect(switcher).toHaveAttribute("title", "Reviewer · 出错");
    expect(await badge.ariaSnapshot()).toContain("出错");
    await switcher.click();
    await expect(
      page.getByRole("option").filter({ hasText: "Main Agent" }),
    ).toContainText("出错");
    await expect(
      page.getByRole("option").filter({ hasText: "Reviewer" }),
    ).toContainText("出错");
    await page.keyboard.press("Escape");
    for (const item of racco.sessions) {
      await page.goto(`/session/${item.sessionId}`);
      await expect(page.locator(".provider-label")).toBeVisible();
      expect(
        await textContrast(page.locator(".provider-label")),
      ).toBeGreaterThanOrEqual(4.5);
    }
    socket!.close({ code: 4000, reason: "test disconnect" });
    await expect(
      page.getByRole("status", { name: "连接状态", exact: true }),
    ).toContainText("连接已断开");
  });
}

test("trajectory labels fit narrow and scaled panels with readable category colors", async ({
  page,
  racco,
}) => {
  const session = racco.sessions[0]!;
  let socket: WebSocketRoute;
  await page.routeWebSocket("**/api/ws", (route) => {
    socket = route;
    route.connectToServer();
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/session/${session.sessionId}`);
  await expect(page.locator(".message-assistant")).toBeVisible();
  socket!.send(
    JSON.stringify({
      type: "timeline.event",
      session: { sessionId: session.sessionId },
      event: {
        type: "subagent.started",
        id: "trajectory-child",
        agentId: "trajectory-review",
        name: "Reviewer",
      },
    } satisfies ServerMessage),
  );
  for (let turn = 2; turn <= 128; turn += 1) {
    socket!.send(
      JSON.stringify({
        type: "timeline.event",
        session: { sessionId: session.sessionId },
        event: {
          type: "user.message",
          id: `trajectory-turn-${turn}`,
          text: `第 ${turn} 轮任务`,
          imageCount: 0,
        },
      } satisfies ServerMessage),
    );
  }
  await page.getByRole("button", { name: "Trajectory", exact: true }).click();
  const childLabel = page
    .locator(".trajectory-turn-label")
    .filter({ hasText: "子任务" })
    .first();
  await expect(childLabel).toBeVisible();
  await expect(
    page.locator('.trajectory-turn-label[title="Turn 128"]'),
  ).toBeVisible();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const fontSize of [16, 20]) {
      await page.evaluate((size) => {
        document.documentElement.style.fontSize = `${size}px`;
      }, fontSize);
      for (const width of [320, 760, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        const search = (await page
          .getByRole("searchbox", { name: "搜索交互" })
          .boundingBox())!;
        expect(search.x + search.width).toBeLessThanOrEqual(width);
        for (const label of [
          childLabel,
          page.locator('.trajectory-turn-label[title="Turn 12"]'),
          page.locator('.trajectory-turn-label[title="Turn 128"]'),
        ]) {
          const metrics = await label.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return {
              lines: [...range.getClientRects()].filter(
                (rect) => rect.width > 0,
              ).length,
              clipped: element.scrollWidth > element.clientWidth,
            };
          });
          expect(metrics).toEqual({ lines: 1, clipped: false });
        }
        for (const kind of ["user", "assistant", "tool", "subagent"])
          expect(
            await textContrast(
              page.locator(`.trajectory-kind.kind-${kind}`).first(),
            ),
          ).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});

test("message edges align with the composer through narrow panes, overflow and larger text", async ({
  page,
  racco,
}) => {
  const session = racco.sessions[0]!;
  let socket: WebSocketRoute;
  await page.routeWebSocket("**/api/ws", (route) => {
    socket = route;
    route.connectToServer();
  });
  await page.goto(`/session/${session.sessionId}`);
  await expect(page.locator(".message-assistant")).toBeVisible();
  for (const event of [
    {
      type: "subagent.started",
      id: "layout-child",
      agentId: "layout-review",
      name: "Layout Reviewer",
    },
    {
      type: "user.message",
      id: "second-request",
      text: "检查窄屏导航",
      imageCount: 0,
    },
  ] satisfies TimelineEvent[]) {
    socket!.send(
      JSON.stringify({
        type: "timeline.event",
        session: { sessionId: session.sessionId },
        event,
      } satisfies ServerMessage),
    );
  }
  await expect(page.locator(".turn-navigator-trigger")).toBeVisible();
  for (const long of [false, true]) {
    if (long) {
      socket!.send(
        JSON.stringify({
          type: "timeline.event",
          session: { sessionId: session.sessionId },
          event: {
            type: "assistant.message",
            id: "long-reply",
            text: "检查正文对齐与滚动条。\n\n".repeat(100),
          },
        } satisfies ServerMessage),
      );
      await expect(
        page.locator('[data-timeline-row="long-reply"]'),
      ).toBeAttached();
    }
    for (const fontSize of [16, 20]) {
      await page.evaluate((size) => {
        document.documentElement.style.fontSize = `${size}px`;
      }, fontSize);
      for (const width of [320, 600, 780, 1028, 1108, 1136, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await expect
          .poll(async () => {
            const message = (await page
              .locator(".message-assistant")
              .first()
              .boundingBox())!;
            const composer = (await page
              .locator(".composer-stack")
              .boundingBox())!;
            return Math.max(
              Math.abs(message.x - composer.x),
              Math.abs(message.x + message.width - composer.x - composer.width),
            );
          })
          .toBeLessThan(1);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width);
        await expect(
          page.getByRole("button", { name: "发送", exact: true }),
        ).toBeInViewport();
        if (long && width === 320) {
          await page.locator(".conversation").evaluate((element) =>
            element.scrollTo({
              top: element.scrollHeight,
              behavior: "instant",
            }),
          );
          const lastMessage = (await page
            .locator(".message-assistant")
            .last()
            .boundingBox())!;
          const navigator = (await page
            .locator(".turn-navigator-trigger")
            .boundingBox())!;
          expect(lastMessage.y + lastMessage.height).toBeLessThanOrEqual(
            navigator.y,
          );
        }
      }
    }
  }
  // A larger, two-line offline header must not put the latest-message control
  // over the tabs; its position belongs to the actual conversation viewport.
  await page.setViewportSize({ width: 320, height: 900 });
  socket!.close({ code: 4000, reason: "test disconnect" });
  await expect(
    page.getByRole("status", { name: "连接状态", exact: true }),
  ).toContainText("连接已断开");
  const conversation = page.locator(".conversation");
  await conversation.evaluate((element) =>
    element.scrollTo({ top: 0, behavior: "instant" }),
  );
  const followLatest = page.getByRole("button", { name: "回到最新内容 ↓" });
  await expect(followLatest).toBeVisible();
  const controlBox = (await followLatest.boundingBox())!;
  const contentBox = (await conversation.boundingBox())!;
  expect(controlBox.y).toBeGreaterThanOrEqual(contentBox.y);
  const switcherBox = (await page
    .locator(".agent-switcher-trigger")
    .boundingBox())!;
  const headingBox = (await page
    .locator(".session-heading-copy")
    .boundingBox())!;
  const statusesBox = (await page.locator(".session-statuses").boundingBox())!;
  expect(switcherBox.x + switcherBox.width).toBeLessThanOrEqual(
    headingBox.x + headingBox.width,
  );
  expect(statusesBox.y).toBeGreaterThanOrEqual(
    headingBox.y + headingBox.height,
  );
  const send = page.getByRole("button", { name: "发送", exact: true });
  expect(
    await send.evaluate((button) => {
      const box = button.getBoundingClientRect();
      return button.contains(
        document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        ),
      );
    }),
  ).toBe(true);
});

test("reduced motion disables animated feedback and explicit turn navigation honors live preference changes", async ({
  page,
  racco,
}) => {
  const session = racco.sessions[0]!;
  let socket: WebSocketRoute;
  await page.routeWebSocket("**/api/ws", (route) => {
    socket = route;
    route.connectToServer();
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/session/${session.sessionId}`);
  await expect(page.locator(".message-assistant")).toBeVisible();
  socket!.send(
    JSON.stringify({
      type: "timeline.event",
      session: { sessionId: session.sessionId },
      event: {
        type: "user.message",
        id: "second-turn",
        text: "第二轮",
        imageCount: 0,
      },
    } satisfies ServerMessage),
  );
  await page.locator(".tool-card").first().click();
  await expect(page.locator(".tool-inspector")).toHaveCSS(
    "animation-name",
    "none",
  );
  await page.getByRole("button", { name: "关闭工具详情" }).click();
  await page.evaluate(() => {
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (options) {
      if (typeof options === "object")
        document.documentElement.dataset.scrollBehavior = options.behavior;
      original.call(this, options);
    };
  });
  for (const reducedMotion of ["reduce", "no-preference", "reduce"] as const) {
    await page.emulateMedia({ reducedMotion });
    await page.locator(".turn-navigator-trigger").click();
    await page.getByRole("menuitem").first().click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-scroll-behavior",
      reducedMotion === "reduce" ? "instant" : "smooth",
    );
  }
});
