---
name: agent-notes-maintain
description: Audit and maintain Agent Notes when decisions supersede old records or a scoped cleanup finds misplaced or duplicate designs. Consolidate designs into their owning notes, classify replacement, reject obsolete proposals, and preserve immutable archived notes.
---

# Maintain Agent Notes

Keep useful decision knowledge active and preserve sealed history. Read the target repository's `.agents/notes/README.md` and the instructions for each affected lifecycle. This is a semantic judgment workflow; file age and word count only help locate candidates.

## Scope and evidence

A new note requires a local audit of notes about the same decision, mechanism, process, or rejected alternative. A corpus audit uses the user's requested scope. Inspect current source, configuration, schemas, compatibility handling, tests, documentation, newer notes, and inbound links before deciding whether a record still constrains work.

For a read-only audit, report proposed dispositions. When maintenance is authorized or required by the note being written, apply the scoped dispositions and link repairs. Do not expand a local supersession check into unrelated corpus cleanup.

Project designs belong in their owning `.agents/notes/` record. When the requested cleanup includes an external or duplicate design, merge its meaningful design content into that owner and repair inbound links before removing the duplicate. Review process records are not candidates for a new or archived Note: retain only resulting durable decisions in the owner. Report the audit in the conversation; local findings or logs belong only in ignored, untracked `.tmp/reviews/` files.

## Keep active records at decision scope

An overlong active note may still contain an important decision. When edits are authorized, remove local inspection history and incidental implementation inventories while preserving its rationale, trade-offs, durable obligations, and design details explicitly requested by the user. Requested interfaces, algorithms, and UI interactions stay in the owning Note; do not shorten the Note by moving them into a companion document. Link code, tests, or an independently owned Agent Note for supporting evidence. Do not archive a useful decision merely because its current prose is verbose, and do not modernize sealed history.

Consolidation preserves unique decision knowledge, not every sentence of the old record. Carry forward verification guarantees, material evidence gaps, and requested design detail; omit routine test matrices, machine-specific observations, and execution logs. A detail belongs when losing it would change a future choice, permit an incorrect implementation, or fail the user's design request.

## Classify records

- **Implemented, keep:** its alternatives, ownership rules, negative guarantees, security or persistence semantics, verification obligations, material evidence gap, or reintroduction conditions still guide plausible future changes.
- **Implemented, archive:** the decision is complete and its rationale is unlikely to guide future work. A closed one-off visual adjustment can qualify; a short durability rule can remain essential. Do not chase a quota.
- **Proposed, retain or reject:** a live proposal remains proposed. An obsolete proposal moves to rejected with an honest reason; proposals never enter the archive.
- **Rejected, retain or delete:** retain it while it prevents a tempting, meaningful mistake. Otherwise delete the note and repair inbound links. Its proposal body remains frozen while retained.

For supersession, distinguish factual relocation, partial replacement, full consolidation, and a new contrary decision. Keep partial replacements active and cross-linked. Before deleting a fully consolidated record, transfer every unique rationale, alternative, consequence, required verification, and named coverage gap into the current owner; Git history alone is insufficient.

Feature removal qualifies as full replacement only when the feature is absent from production code, configuration, schemas, durable and wire formats, migration and compatibility behavior, supported documentation, and tests of supported behavior. Preserve its original motivation, removal reason, alternatives to full removal, capability lost, reintroduction conditions, and evidence of complete absence. A surviving compatibility path makes replacement partial.

## Archive a qualifying implemented note

1. Run the checker before moving the note. Preserve all body bytes; do not modernize paths, rewrite prose, or repair outgoing links during archival.
2. Move the Markdown file from `implemented/<class>/` to `archived/<class>/`. Keep the filename and `Status: implemented`. Insert `Archived: YYYY-MM-DD` immediately below the status line.
3. Search active repository prose for inbound links. Redirect to current authority, preserve an intentional historical citation at the archived path, or remove an obsolete reference. Do not inspect, verify, or repair archived outgoing links.
4. Run `python3 scripts/agent_notes.py seal`, then `python3 scripts/agent_notes.py check`. The sealing command validates prior seals before appending new hashes. Never edit or regenerate existing manifest entries to make changed content pass.

Once sealed, the note cannot be edited, moved, reformatted, or deleted. Renewed relevance is recorded in a new active note citing the archive; it does not unfreeze history. Use the project's trusted CI baseline for committed changes.

## Verify and report

For active lifecycle moves, rewrite the content for the destination state and run the checker. Inspect incoming references repository-wide, including outside the Notes tree. Run any existing project link checks with archived sources excluded.

Inspect all document outputs and, before an authorized commit, the staged paths and contents. No companion design or review process record may remain in the deliverable; local audit files must remain ignored and untracked. A passing Notes checker does not establish the semantic ownership of every document.

Report retained, archived, consolidated, rejected, and deleted notes, with a brief future-value reason for each borderline choice. State which links and checks were actually reviewed. Archive hash verification does not establish the validity of historical outgoing links.
