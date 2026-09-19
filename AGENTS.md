# Racco Engineering Rules

## No backward compatibility — non-negotiable

Racco is pre-release and has no backward-compatibility obligations. Never preserve an old behavior solely to keep existing callers, state, configuration, tests, or deployments working.

- Do not add legacy routes, payload fields, command aliases, deprecated options, compatibility flags, shims, adapters, dual-read/dual-write paths, or old/new format branches.
- Do not migrate or reinterpret obsolete database schemas, persisted state, config shapes, Provider IDs, or client messages. Reject them immediately or delete and recreate the state when the change permits destructive replacement.
- When a contract changes, update every producer, consumer, test, script, fixture, and current document in the same change, then delete the old contract completely.
- Keep one current schema, one current protocol, and one current behavior. Fail fast when an input or stored version is not current.
- Do not retain historical implementation documents or tests as executable compatibility requirements. Git history is the archive.
- Do not add compatibility code preemptively. It is allowed only when the user explicitly requests a specific compatibility requirement in the current task.

Robustness for the current contract is still required. Input validation, crash recovery, idempotency, reconnect handling, and normalization between the currently supported Codex and Claude providers are not backward compatibility.

## Supported platform — Linux only

Racco currently targets Linux desktops only. The production process is a systemd user service. Project directories are selected in the WebUI through the daemon's filesystem listing API.

- Do not add Windows, macOS, WSL, container, headless, or init-system abstractions unless the user explicitly expands the supported platform.
- Use one web directory browser for local and remote clients. Do not add native directory dialogs, platform detection, browser filesystem APIs, or optional compatibility branches.
- Require systemd user services. Directory browsing reads the daemon host filesystem on explicit user navigation; it must not require a desktop portal or recursively scan for projects.

<!-- agent-notes:start -->
## Agent Notes

Every non-trivial change adds or updates an [Agent Note](.agents/notes/README.md) in the same PR; purely mechanical or local edits without a decision change are exempt. Use [agent-notes-write](.agents/skills/agent-notes-write/SKILL.md) to record proposals and decisions. Every new note includes a scoped supersession check through [agent-notes-maintain](.agents/skills/agent-notes-maintain/SKILL.md).

Keep implemented records current with code in the same change. Review decision/implementation agreement with [agent-notes-review](.agents/skills/agent-notes-review/SKILL.md). Archived notes are frozen historical snapshots, never current authority.

Run `python3 scripts/agent_notes.py check` before submitting changes to the Notes tree. Repair inbound links whenever a note moves or is deleted. CI archive checks use a trusted pre-change commit through `AGENT_NOTES_BASE_REF`.
<!-- agent-notes:end -->
