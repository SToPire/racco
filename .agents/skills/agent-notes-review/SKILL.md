---
name: agent-notes-review
description: Review Agent Notes for decision relevance, current ownership, implementation agreement and meaningful alternatives. Use for consequential decision changes, stale records or scoped Notes review; do not demand records for ordinary fixes with unchanged rationale.
---

# Review Agent Notes

Read the target project's `.agents/notes/README.md`, applicable rules, requested diff and related owners. Inspect enough implementation, documentation and tests to distinguish a factual mismatch from an intentional changed decision.

Check that:

- A consequential decision has a clear owner; ordinary fixes need no no-information record.
- The lifecycle is honest, alternatives are grounded, and consequences preserve the choice's costs, ownership, persistence and deletion constraints.
- Factual claims and links match current code. A new decision identifies its predecessor; useful partial decisions remain discoverable.
- Prose explains why rather than reproducing plans, local environment observations, file inventories or test logs. Preserve material uncertainty without inventing evidence.
- Removed notes have no broken inbound references. Git retains history; old versions are evidence, not current authority.

Run `python3 scripts/agent_notes.py check` and relevant implementation checks when behavioral claims require them. The checker validates structure and local links, not rationale or code agreement. Report concrete mismatches, their impact and evidence; separate observed verification from gaps. Review-only requests do not authorize edits.
