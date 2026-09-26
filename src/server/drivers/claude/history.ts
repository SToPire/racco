import {
  getSessionMessages,
  getSubagentMessages,
  importSessionToStore,
  InMemorySessionStore,
  listSubagents,
  type SessionKey,
  type SessionMessage,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeHistoryMessage,
  ClaudeSubagentHistory,
} from "./event-mapper.js";

type DisplayMessage = { role: "user" | "assistant"; content: string };

function localCommandMessage(
  entry: SessionStoreEntry,
): DisplayMessage | undefined {
  if (
    entry.type !== "system" ||
    entry.subtype !== "local_command" ||
    entry.isMeta ||
    entry.isSidechain ||
    entry.teamName
  )
    return undefined;
  if (
    typeof entry.content !== "string" ||
    typeof entry.uuid !== "string" ||
    entry.uuid.length === 0
  ) {
    throw new Error("Invalid Claude local command transcript entry");
  }
  const output =
    /^<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>$/.exec(
      entry.content,
    );
  return output
    ? { role: "assistant", content: output[2]!.trimEnd() }
    : {
        role: entry.content.startsWith("/") ? "user" : "assistant",
        content: entry.content,
      };
}

/** A display-only projection. Never write these entries back or use them to resume Claude. */
export function projectClaudeHistory(
  entries: SessionStoreEntry[],
): SessionStoreEntry[] {
  const lastIndex = new Map(
    entries.flatMap((entry, index) =>
      entry.uuid ? [[entry.uuid, index] as const] : [],
    ),
  );
  const unique = entries.filter(
    (entry, index) => !entry.uuid || lastIndex.get(entry.uuid) === index,
  );
  return unique.map((entry) => {
    const message = localCommandMessage(entry);
    if (message) return { ...entry, type: message.role, message };
    const original = entry.message as { content?: unknown } | undefined;
    const command =
      entry.type === "user" && typeof original?.content === "string"
        ? /^<command-name>(\/[^<\n]+)<\/command-name>\s*<command-message>[^<]*<\/command-message>\s*<command-args>([\s\S]*)<\/command-args>$/.exec(
            original.content,
          )
        : null;
    return {
      ...entry,
      ...(command
        ? {
            message: {
              ...original,
              content: [command[1], command[2]!.trim()]
                .filter(Boolean)
                .join(" "),
            },
          }
        : {}),
    };
  });
}

/** Restore display metadata omitted by the SDK only for selected messages. */
function restoreUserMetadata(
  message: SessionMessage,
  recorded: Map<string, SessionStoreEntry>,
): ClaudeHistoryMessage {
  if (message.type !== "user") return message;
  const original = recorded.get(message.uuid);
  return {
    ...message,
    ...(original?.toolUseResult === undefined
      ? {}
      : { toolUseResult: original.toolUseResult }),
    ...(original?.origin === undefined ? {} : { origin: original.origin }),
  };
}

/** Keep the SDK's branch/compaction selection, then attach local output siblings
 * only to messages retained in that selection. This also works when compaction
 * rewrites the selected chain's parent links. */
export async function selectClaudeHistory(
  entries: SessionStoreEntry[],
  key: SessionKey,
  cwd: string,
) {
  const projected = projectClaudeHistory(entries);
  const recorded = new Map(
    projected.flatMap((entry) =>
      entry.uuid ? [[entry.uuid, entry] as const] : [],
    ),
  );
  const store = new InMemorySessionStore();
  await store.append(key, projected);
  const selected = await getSessionMessages(key.sessionId, {
    dir: cwd,
    sessionStore: store,
  });
  const outputs = new Map<string, SessionMessage[]>();
  for (const entry of projected) {
    if (
      entry.subtype !== "local_command" ||
      entry.type !== "assistant" ||
      entry.isMeta ||
      entry.isSidechain ||
      entry.teamName ||
      !entry.uuid ||
      typeof entry.parentUuid !== "string"
    )
      continue;
    const siblings = outputs.get(entry.parentUuid) ?? [];
    siblings.push({
      type: "assistant",
      uuid: entry.uuid,
      session_id: key.sessionId,
      message: entry.message,
      parent_tool_use_id: null,
      parent_agent_id: null,
    });
    outputs.set(entry.parentUuid, siblings);
  }
  const result: ClaudeHistoryMessage[] = [];
  const seen = new Set<string>();
  for (const message of selected) {
    const pending = [message];
    while (pending.length) {
      const next = pending.pop()!;
      if (seen.has(next.uuid)) continue;
      seen.add(next.uuid);
      result.push(restoreUserMetadata(next, recorded));
      const children = outputs.get(next.uuid) ?? [];
      for (let index = children.length - 1; index >= 0; index--)
        pending.push(children[index]!);
    }
  }
  return result;
}

export async function selectClaudeSubagentHistory(
  store: InMemorySessionStore,
  key: SessionKey,
  cwd: string,
): Promise<ClaudeSubagentHistory[]> {
  const subkeys = await store.listSubkeys(key);
  const native = new Map<string, SessionStoreEntry>();
  const metadataByMessage = new Map<string, SessionStoreEntry>();
  for (const subpath of subkeys) {
    const entries = store.getEntries({ ...key, subpath });
    const metadata = entries.findLast(
      (entry) => entry.type === "agent_metadata",
    );
    for (const entry of entries) {
      if (!entry.uuid) continue;
      native.set(entry.uuid, entry);
      if (metadata !== undefined) metadataByMessage.set(entry.uuid, metadata);
    }
  }
  const agentIds = await listSubagents(key.sessionId, {
    dir: cwd,
    sessionStore: store,
  });
  return Promise.all(
    agentIds.map(async (agentId) => {
      const selected = await getSubagentMessages(key.sessionId, agentId, {
        dir: cwd,
        sessionStore: store,
      });
      const messages = selected.map((message) =>
        restoreUserMetadata(message, native),
      );
      const directoryMessage = selected.findLast((message) => {
        const directory = native.get(message.uuid)?.cwd;
        return typeof directory === "string" && directory.length > 0;
      });
      const metadata = selected
        .map((message) => metadataByMessage.get(message.uuid))
        .find((entry) => entry !== undefined);
      const childCwd = [
        metadata?.cwd,
        metadata?.worktreePath,
        directoryMessage === undefined
          ? undefined
          : native.get(directoryMessage.uuid)?.cwd,
      ].find(
        (directory): directory is string =>
          typeof directory === "string" && directory.length > 0,
      );
      return {
        agentId,
        messages,
        ...(typeof childCwd === "string" ? { cwd: childCwd } : {}),
      };
    }),
  );
}

export async function readClaudeHistory(
  sessionId: string,
  cwd: string,
): Promise<{
  messages: ClaudeHistoryMessage[];
  subagents: ClaudeSubagentHistory[];
}> {
  // The ordinary SDK history projection drops local command bodies (top-level
  // `content`, not `message`) and siblings. Read via SDK-managed paths, project
  // only this in-memory copy, then let the SDK select the conversation branch
  // and apply its compaction/sidechain rules as usual.
  const store = new InMemorySessionStore();
  let transcriptKey: SessionKey | undefined;
  await importSessionToStore(
    sessionId,
    {
      async append(key, entries) {
        if (
          key.sessionId !== sessionId ||
          (transcriptKey && transcriptKey.projectKey !== key.projectKey)
        ) {
          throw new Error(
            "Claude history import returned an unexpected transcript",
          );
        }
        transcriptKey = {
          projectKey: key.projectKey,
          sessionId: key.sessionId,
        };
        await store.append(key, entries);
      },
      load: (key) => store.load(key),
    },
    { dir: cwd, includeSubagents: true },
  );
  if (!transcriptKey) return { messages: [], subagents: [] };
  const [messages, subagents] = await Promise.all([
    selectClaudeHistory(store.getEntries(transcriptKey), transcriptKey, cwd),
    selectClaudeSubagentHistory(store, transcriptKey, cwd),
  ]);
  return { messages, subagents };
}
