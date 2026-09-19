# AGENTS.md — Archived Agent Notes

Archived notes are frozen historical snapshots, not current authority. Never edit, reformat, repair, delete, or move a sealed note. New decisions belong in active notes.

During archival, move the Markdown file and insert `Archived: YYYY-MM-DD` below `Status: implemented`. Preserve all other note content and repair or remove inbound links. Do not inspect, verify, or repair archived outgoing links.

Use [agent-notes-maintain](../../skills/agent-notes-maintain/SKILL.md). From the repository root, append new seals with `python3 scripts/agent_notes.py seal`, then run `python3 scripts/agent_notes.py check`. Existing seals remain unchanged. CI compares them with a trusted pre-change commit using `AGENT_NOTES_BASE_REF` or `--base-ref`.
