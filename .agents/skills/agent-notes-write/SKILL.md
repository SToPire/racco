---
name: agent-notes-write
description: Record durable project decisions, ownership boundaries, alternatives and trade-offs in Agent Notes. Use for consequential new or changed decisions, completing proposals, or correcting a current decision owner; ordinary fixes that preserve decisions need no record.
---

# Write Agent Notes

Read the target repository's `.agents/notes/README.md` and applicable `AGENTS.md` files. Follow their scope and format; do not create records for routine changes with no new decision.

1. Read the change, relevant implementation and tests. Search related notes by mechanism and alternatives. Update an existing owner when the decision is unchanged; create a new owner when the choice or rationale changes.
2. State the choice and decisive reason. Retain ownership, persistence and deletion constraints, actual alternatives, costs and material uncertainty. Keep commands, investigation logs, local environment facts and implementation inventories out; consult [scope examples](references/decision-scope.md) when needed.
3. Use the appropriate [template](assets/) and lifecycle. Completed work is implemented; partial work remains proposed. Do not invent historical deliberation to fill a section. Preserve the original date when moving an existing topic.
4. Reconcile related decisions with [agent-notes-maintain](../agent-notes-maintain/SKILL.md). Keep useful partial replacements and repair links to moved or removed records. Git owns earlier versions.
5. Check claims against code and review local links. Run `python3 scripts/agent_notes.py check`. Report the current owner and any material unresolved decision; put execution evidence in the task handoff.

Writing a note does not authorize unrelated changes, destructive actions, committing or publishing.
