export type RequestId = string | number;

export type CodexFileChange = {
  path: string;
  kind:
    | { type: "add" }
    | { type: "delete" }
    | { type: "update"; move_path: string | null };
  // Native Add/Delete carry file content; Update carries a unified diff.
  diff: string;
};

export type JsonRpcRequest = {
  id: RequestId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  id: RequestId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type CodexThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: unknown[] };

type CommandAction =
  | {
      type: "read";
      command: string;
      name: string;
      path: string;
    }
  | {
      type: "listFiles";
      command: string;
      path: string | null;
    }
  | {
      type: "search";
      command: string;
      path: string | null;
      query: string | null;
    }
  | {
      type: "unknown";
      command: string;
    };

type CommandExecutionSource =
  "agent" | "userShell" | "unifiedExecStartup" | "unifiedExecInteraction";

export type CollabAgentStatus =
  | "pendingInit"
  | "running"
  | "interrupted"
  | "completed"
  | "errored"
  | "shutdown"
  | "notFound";

type CollabAgentTool =
  | "spawnAgent"
  | "sendInput"
  | "resumeAgent"
  | "wait"
  | "closeAgent"
  | "sendMessage"
  | "followupTask"
  | "interruptAgent"
  | "listAgents";

export type SubAgentActivityKind =
  "started" | "interacted" | "interrupted" | "completed";

export type CodexThreadItem =
  | {
      type: "userMessage";
      id: string;
      content: Array<{ type: string; text?: string }>;
    }
  | {
      type: "hookPrompt";
      id: string;
      fragments: Array<{ text: string; hookRunId: string }>;
    }
  | {
      type: "agentMessage";
      id: string;
      text: string;
      phase: "commentary" | "final_answer" | null;
    }
  | { type: "plan"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      status: "inProgress" | "completed" | "failed" | "declined";
      commandActions: CommandAction[];
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs: number | null;
      processId: string | null;
      source: CommandExecutionSource;
      pluginId: string | null;
      scriptPath: string | null;
    }
  | {
      type: "fileChange";
      id: string;
      changes: CodexFileChange[];
      status: "inProgress" | "completed" | "failed" | "declined";
    }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      status: "inProgress" | "completed" | "failed";
      arguments: unknown;
      result: unknown;
      error: unknown;
    }
  | {
      type: "dynamicToolCall";
      id: string;
      namespace: string | null;
      tool: string;
      arguments: unknown;
      status: "inProgress" | "completed" | "failed";
      contentItems: unknown[] | null;
      success: boolean | null;
    }
  | {
      type: "collabAgentToolCall";
      id: string;
      tool: CollabAgentTool;
      status: "inProgress" | "completed" | "failed" | "interrupted";
      senderThreadId: string;
      receiverThreadIds: string[];
      prompt: string | null;
      model: string | null;
      reasoningEffort: string | null;
      agentsStates: Record<
        string,
        { status: CollabAgentStatus; message: string | null } | undefined
      >;
    }
  | {
      type: "subAgentActivity";
      id: string;
      kind: SubAgentActivityKind;
      agentThreadId: string;
      agentPath: string;
    }
  | { type: "contextCompaction"; id: string };

export type CodexTurn = {
  id: string;
  items: CodexThreadItem[];
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: { message: string } | null;
};

export type CodexThread = {
  id: string;
  preview: string;
  name: string | null;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  status: CodexThreadStatus;
  parentThreadId: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  source:
    | "cli"
    | "vscode"
    | "exec"
    | "appServer"
    | "unknown"
    | { custom: string }
    | {
        subAgent:
          | "review"
          | "compact"
          | "memory_consolidation"
          | { other: string }
          | {
              thread_spawn: {
                parent_thread_id: string;
                depth: number;
                agent_path: string | null;
                agent_nickname: string | null;
                agent_role: string | null;
              };
            };
      };
  turns: CodexTurn[];
};

export type ThreadReadResponse = { thread: CodexThread };
export type ThreadStartResponse = { thread: CodexThread };
export type TurnStartResponse = { turn: CodexTurn };
export type ThreadListResponse = {
  data: CodexThread[];
  nextCursor: string | null;
};

export type ItemNotification = {
  threadId: string;
  turnId: string;
  item: CodexThreadItem;
};

export type DeltaNotification = {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
};

export type ReasoningSummaryDeltaNotification = DeltaNotification & {
  summaryIndex: number;
};

export type ReasoningSummaryPartNotification = {
  threadId: string;
  turnId: string;
  itemId: string;
  summaryIndex: number;
};

export type TurnPlanNotification = {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
};

export type TurnNotification = {
  threadId: string;
  turn: CodexTurn;
};

export type ErrorNotification = {
  error: { message: string };
  willRetry: boolean;
  threadId: string;
  turnId: string;
};

export type ThreadStatusNotification = {
  threadId: string;
  status: CodexThreadStatus;
};

export type TokenUsageNotification = {
  threadId: string;
  turnId: string;
  tokenUsage: {
    last: { totalTokens: number };
    modelContextWindow: number | null;
  };
};

export type ThreadStartedNotification = {
  thread: CodexThread;
};

type UserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
};

export type UserInputParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: UserInputQuestion[];
};
