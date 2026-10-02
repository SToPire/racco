---
name: agent-notes-maintain
description: Reconcile Agent Notes when a decision changes or scoped cleanup is requested. Keep current ownership and useful rationale, consolidate overlap, and remove obsolete records with Git preserving history.
---

# Maintain Agent Notes

Read the target repository's `.agents/notes/README.md` and affected lifecycle rules. Limit a new-note review to related mechanisms and alternatives; use the requested scope for a broader audit.

Inspect code, configuration, tests, current documentation and inbound links before deciding a note's disposition:

- Keep current ownership, persistence or deletion constraints, important alternatives, and unresolved risks that still guide future work. Correct their factual claims when authorized.
- Keep and cross-link partial replacements. Consolidate useful shared rationale into one clear current owner.
- Rewrite completed proposals as implemented. Mark declined proposals rejected with an honest reason; retain them only while they prevent a plausible mistake.
- Remove obsolete or fully superseded records when their remaining value is historical. Preserve any still-applicable obligation in the current owner and repair every inbound link. Git retains the removed content; no separate archive or sealing step is needed.

For a feature removal, distinguish unsupported historical behavior from any behavior that remains current. Keep enduring ownership, safety, data retention and reintroduction constraints in the removal owner. Do not mechanically preserve implementation inventories or demand a new removal record for every local refactor.

Run `python3 scripts/agent_notes.py check`, review links from outside the Notes tree, and report meaningful ownership changes. A read-only review reports dispositions; apply edits only when the task authorizes them. Notes maintenance does not grant permission for unrelated edits, data deletion or publishing.
