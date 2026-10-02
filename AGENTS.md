# Racco Engineering Rules

## AI-assisted commits

Every AI-assisted commit must include an `Assisted-by: <harness>:<model>` trailer in its commit message, using the actual harness and model names.

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

Record durable engineering decisions in [Agent Notes](.agents/notes/README.md): ownership, persistence and deletion boundaries, support constraints, and consequential alternatives. Routine fixes, local refactors, and tests that preserve those decisions do not require a new note or a no-information update.

Update an existing owner when its decision-relevant facts change. For a new decision, use [agent-notes-write](.agents/skills/agent-notes-write/SKILL.md), search related notes, and reconcile overlap with [agent-notes-maintain](.agents/skills/agent-notes-maintain/SKILL.md). Keep useful rationale current; Git retains removed and superseded history. Review agreement with [agent-notes-review](.agents/skills/agent-notes-review/SKILL.md).

Run `python3 scripts/agent_notes.py check` after Notes changes and repair links when moving or deleting records. Notes maintenance does not grant permission for unrelated edits, destructive operations, or publishing.
<!-- agent-notes:end -->
