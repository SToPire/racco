# AGENTS.md — Agent Notes

Follow the [Agent Note rules](README.md) for layout, lifecycle, and writing. Notes preserve durable project rationale, alternatives, trade-offs, and obligations. Apply [decision scope](README.md#decision-scope): exclude local investigation history and incidental implementation detail, including in proposed notes.

Every new note triggers a scoped supersession check. Search active records about the same decision or mechanism and classify full or partial replacement with [agent-notes-maintain](../skills/agent-notes-maintain/SKILL.md). Keep partial replacements active and cross-linked; archive qualifying implemented notes in the same change.

Use [agent-notes-write](../skills/agent-notes-write/SKILL.md) for authoring and [agent-notes-review](../skills/agent-notes-review/SKILL.md) to check implementation agreement. Preserve all meaningful conditions and trade-offs when condensing prose.

Files in [archived/](archived/AGENTS.md) are frozen history, never current authority. Exclude them from prose modernization and outgoing-link checks. Run `python3 scripts/agent_notes.py check` from the repository root after changes.
