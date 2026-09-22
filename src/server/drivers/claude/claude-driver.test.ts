import assert from "node:assert/strict";
import test from "node:test";
import { deleteSession, query, startup } from "@anthropic-ai/claude-agent-sdk";
import type { TimelineEvent, SessionState } from "../../../shared/protocol.js";
import { buildTimeline } from "../../../web/store.js";
import { buildTrajectory } from "../../../web/trajectory.js";
import { ClaudeDriver } from "./claude-driver.js";
import type { DriverContext } from "../driver.js";

test("Claude discovers without a prompt and passes each model/effort pair into first and resumed queries", async (t) => {
  const oldEffort = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  process.env.CLAUDE_CODE_EFFORT_LEVEL = "low";
  t.after(() => {
    if (oldEffort === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = oldEffort;
  });
  const calls: Array<Parameters<typeof query>[0]> = [];
  let closes = 0;
  const sdk = {
    async listSessions() {
      return [];
    },
    async deleteSession() {
      throw new Error("deleteSession not expected");
    },
    startup: (async () => ({ close() {} })) as unknown as typeof startup,
    query: ((input: Parameters<typeof query>[0]) => {
      calls.push(input);
      const sessionId = input.options?.sessionId ?? input.options?.resume;
      return {
        close() {
          closes++;
        },
        async supportedModels() {
          return [
            {
              value: "sonnet",
              displayName: "Native Sonnet",
              description: "",
              supportsEffort: true,
              supportedEffortLevels: ["high", "xhigh"],
            },
          ];
        },
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init", session_id: sessionId };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "done",
          };
        },
      };
    }) as unknown as typeof query,
  };
  const driver = new ClaudeDriver({ warn() {} }, sdk);
  const context: DriverContext = {
    emit() {},
    setState() {},
    markProviderMaterialized() {},
    async requestInteraction() {
      throw new Error("Unexpected user input request");
    },
  };
  try {
    await driver.start();
    const catalog = await driver.listModels({
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    assert.equal(catalog.models[0].displayName, "Native Sonnet");
    assert.equal(calls[0].options?.persistSession, false);
    assert.notEqual(typeof calls[0].prompt, "string");
    assert.equal(closes, 1);
    const messages = [];
    for await (const message of calls[0].prompt) messages.push(message);
    assert.deepEqual(messages, []);
    const handle = await driver.createSession({
      raccoSessionId: "racco",
      cwd: process.cwd(),
      modelSettings: { modelId: "sonnet", reasoningEffort: "xhigh" },
    });
    await driver.runTurn({
      handle,
      mode: "first",
      prompt: "first",
      context,
      signal: new AbortController().signal,
      modelSettings: { modelId: "sonnet", reasoningEffort: "xhigh" },
    });
    await driver.runTurn({
      handle,
      mode: "resume",
      prompt: "next",
      context,
      signal: new AbortController().signal,
      modelSettings: { modelId: "opus", reasoningEffort: "high" },
    });
    assert.equal(calls[1].options?.sessionId, handle.providerSessionId);
    assert.equal(calls[2].options?.resume, handle.providerSessionId);
    assert.deepEqual(
      calls
        .slice(1)
        .map(({ options }) => [
          options?.model,
          options?.effort,
          options?.env?.CLAUDE_CODE_EFFORT_LEVEL,
        ]),
      [
        ["sonnet", "xhigh", undefined],
        ["opus", "high", undefined],
      ],
    );
    assert.equal(calls[1].options?.thinking, undefined);
    assert.equal(calls[1].options?.maxThinkingTokens, undefined);
    assert.equal(process.env.CLAUDE_CODE_EFFORT_LEVEL, "low");
    const options = calls[1].options!;
    assert.equal(options.permissionMode, "bypassPermissions");
    assert.equal(options.allowDangerouslySkipPermissions, true);
    assert.equal(options.agentProgressSummaries, undefined);
    assert.equal(options.forwardSubagentText, true);
    const canUseTool = options.canUseTool!;
    const permissionOptions = {
      signal: new AbortController().signal,
      toolUseID: "tool-permission",
      requestId: "request-permission",
    };
    context.requestInteraction = async () => {
      assert.fail("Ordinary tools must not request approval");
    };
    for (const tool of ["ExitPlanMode", "EnterPlanMode", "Bash", "Edit"]) {
      const input = { example: tool };
      assert.deepEqual(await canUseTool(tool, input, permissionOptions), {
        behavior: "allow",
        updatedInput: input,
      });
    }
    let questions = 0;
    context.requestInteraction = async (interaction) => {
      assert.equal(interaction.questions[0]?.text, "Choose?");
      questions++;
      return { decision: "answer", answers: { "0": ["A"] } };
    };
    const questionInput = {
      questions: [
        {
          question: "Choose?",
          options: [
            { label: "A", description: "First" },
            { label: "B", description: "Second" },
          ],
          multiSelect: false,
        },
      ],
    };
    assert.deepEqual(
      await canUseTool("AskUserQuestion", questionInput, permissionOptions),
      {
        behavior: "allow",
        updatedInput: { ...questionInput, answers: { "Choose?": "A" } },
      },
    );
    assert.equal(questions, 1);
    context.requestInteraction = async () => ({
      decision: "deny",
      message: "Cancelled",
    });
    assert.deepEqual(
      await canUseTool("AskUserQuestion", questionInput, permissionOptions),
      {
        behavior: "deny",
        message: "Cancelled",
      },
    );
  } finally {
    await driver.close();
  }
});

test("Claude emits partial text before completion and isolates interrupted and resumed queries", async () => {
  const events: TimelineEvent[] = [];
  const states: SessionState[] = [];
  let turnAbort = new AbortController();
  const sdk = {
    async listSessions() {
      return [];
    },
    async deleteSession() {
      throw new Error("deleteSession not expected");
    },
    startup: (async () => ({ close() {} })) as unknown as typeof startup,
    query: (({ prompt, options }: Parameters<typeof query>[0]) => {
      assert.equal(options?.includePartialMessages, true);
      const messageId = `api-${prompt}`;
      const sessionId = options?.sessionId ?? options?.resume;
      let sequence = 0;
      const stream = (event: unknown) => ({
        type: "stream_event",
        uuid: `${messageId}-stream-${sequence++}`,
        session_id: sessionId,
        parent_tool_use_id: null,
        event,
      });
      return {
        close() {},
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init", session_id: sessionId };
          yield stream({
            type: "message_start",
            message: { id: messageId, content: [] },
          });
          yield stream({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          });
          yield stream({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: String(prompt) },
          });
          assert.deepEqual(
            events.at(-1),
            {
              type: "assistant.message",
              id: `${messageId}:text:0`,
              text: prompt,
              partial: true,
            },
            "text must be emitted while the SDK is still generating",
          );
          if (prompt === "interrupt") {
            turnAbort.abort();
            throw new Error("query interrupted");
          }
          if (prompt === "interrupt-end") {
            turnAbort.abort();
            return;
          }
          if (prompt === "failure") throw new Error("stream failed");
          if (prompt === "eof") return;
          yield {
            type: "assistant",
            uuid: `${messageId}-complete`,
            parent_tool_use_id: null,
            message: {
              id: messageId,
              content: [{ type: "text", text: `${prompt}!` }],
            },
          };
          yield stream({ type: "content_block_stop", index: 0 });
          yield stream({ type: "message_stop" });
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: `${prompt}!`,
          };
        },
      };
    }) as unknown as typeof query,
  };
  const driver = new ClaudeDriver({ warn() {} }, sdk);
  const context: DriverContext = {
    emit(event) {
      events.push(event);
    },
    setState(state) {
      states.push(state);
    },
    markProviderMaterialized() {},
    async requestInteraction() {
      throw new Error("Unexpected user input request");
    },
  };
  try {
    await driver.start();
    for (const prompt of [
      "first",
      "interrupt",
      "interrupt-end",
      "failure",
      "eof",
      "resumed",
    ]) {
      turnAbort = new AbortController();
      const task = driver.runTurn({
        handle: { cwd: process.cwd(), providerSessionId: "session-1" },
        mode: prompt === "first" ? "first" : "resume",
        prompt,
        context,
        signal: turnAbort.signal,
        modelSettings: { modelId: "sonnet", reasoningEffort: null },
      });
      if (prompt === "failure" || prompt === "eof") {
        await assert.rejects(task, /stream failed|ended without a turn result/);
      } else {
        await task;
      }
    }
    assert.deepEqual(states, ["idle", "interrupted", "interrupted", "idle"]);
    assert.deepEqual(buildTimeline(events), [
      { type: "assistant.message", id: "api-first:text:0", text: "first!" },
      {
        type: "assistant.message",
        id: "api-interrupt:text:0",
        text: "interrupt",
        stopReason: "interrupted",
      },
      {
        type: "assistant.message",
        id: "api-interrupt-end:text:0",
        text: "interrupt-end",
        stopReason: "interrupted",
      },
      {
        type: "assistant.message",
        id: "api-failure:text:0",
        text: "failure",
        stopReason: "error",
      },
      {
        type: "assistant.message",
        id: "api-eof:text:0",
        text: "eof",
        stopReason: "error",
      },
      { type: "assistant.message", id: "api-resumed:text:0", text: "resumed!" },
    ]);
    assert.deepEqual(
      buildTrajectory(buildTimeline(events)).map((entry) => entry.status),
      [
        "Completed",
        "Interrupted",
        "Interrupted",
        "Failed",
        "Failed",
        "Completed",
      ],
    );
  } finally {
    await driver.close();
  }
});

test("Claude deleteSession delegates to the SDK scoped to the project directory", async () => {
  const calls: Array<Parameters<typeof deleteSession>> = [];
  const sdk = {
    async listSessions() {
      return [];
    },
    startup: (async () => ({ close() {} })) as unknown as typeof startup,
    query: (() => {
      throw new Error("deleteSession must not execute a query");
    }) as unknown as typeof query,
    deleteSession: (async (sessionId: string, options?: { dir?: string }) => {
      calls.push([sessionId, options] as Parameters<typeof deleteSession>);
    }) as unknown as typeof deleteSession,
  };
  const driver = new ClaudeDriver({ warn() {} }, sdk);
  try {
    await driver.start();
    const cwd = process.cwd();
    await driver.deleteSession({
      providerSessionId: "11111111-2222-4333-8444-555555555555",
      cwd,
    });
    assert.deepEqual(calls, [
      ["11111111-2222-4333-8444-555555555555", { dir: cwd }],
    ]);
  } finally {
    await driver.close();
  }
});

test("Claude settles unanswered tools using the actual query end reason", async () => {
  let abort = new AbortController();
  const events: TimelineEvent[] = [];
  const sdk = {
    async listSessions() {
      return [];
    },
    async deleteSession() {},
    startup: (async () => ({ close() {} })) as unknown as typeof startup,
    query: (({ prompt }: Parameters<typeof query>[0]) => ({
      close() {},
      async *[Symbol.asyncIterator]() {
        yield {
          type: "assistant",
          uuid: `assistant-${prompt}`,
          session_id: "session-1",
          parent_tool_use_id: null,
          message: {
            id: `message-${prompt}`,
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: `pending-${prompt}`,
                name: "Bash",
                input: { command: "sleep 30" },
              },
              {
                type: "tool_use",
                id: `done-${prompt}`,
                name: "Read",
                input: { file_path: "app.ts" },
              },
            ],
          },
        };
        yield {
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: `done-${prompt}`,
                content: "source",
              },
            ],
          },
        };
        if (prompt === "failed") throw new Error("query failed");
        if (prompt === "interrupted") {
          abort.abort();
          return;
        }
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "done",
        };
      },
    })) as unknown as typeof query,
  };
  const driver = new ClaudeDriver({ warn() {} }, sdk);
  const context: DriverContext = {
    emit: (event) => events.push(event),
    setState() {},
    markProviderMaterialized() {},
    async requestInteraction() {
      throw new Error("Unexpected interaction");
    },
  };
  await driver.start();
  try {
    for (const prompt of ["completed", "failed", "interrupted"]) {
      abort = new AbortController();
      const turn = driver.runTurn({
        handle: { cwd: process.cwd(), providerSessionId: "session-1" },
        mode: "resume",
        prompt,
        modelSettings: { modelId: "sonnet", reasoningEffort: null },
        context,
        signal: abort.signal,
      });
      if (prompt === "failed") await assert.rejects(turn, /query failed/);
      else await turn;
    }
    const rows = buildTimeline(events);
    assert.deepEqual(
      rows
        .filter((row) => row.id.startsWith("pending-"))
        .map((row) => row.type === "tool" && row.status),
      ["incomplete", "failed", "interrupted"],
    );
    assert(
      rows
        .filter((row) => row.id.startsWith("done-"))
        .every(
          (row) =>
            row.type === "tool" &&
            row.status === "completed" &&
            row.output === "source",
        ),
    );
  } finally {
    await driver.close();
  }
});
