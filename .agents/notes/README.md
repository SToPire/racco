# Agent Notes

## Purpose

Keep concise reasons for decisions a future maintainer could otherwise reverse by mistake. Notes own rationale, alternatives, ownership and consequences; code and user documentation own implementation and usage details. Git owns revision history.

## When to write a note

Write or update a note when changing a durable decision: component or data ownership, persistence and deletion boundaries, supported platform or provider contract, a security boundary, or an important trade-off whose reason is not evident from code. Update the existing owner when only its factual realization changes. A contrary decision gets a new owner that identifies what changed and why.

Routine defect fixes, local refactors, added tests, formatting and dependency maintenance do not require notes when the existing decision remains accurate. Do not append a task log or repeat an unchanged decision just to satisfy a process.

For a new note, search the same mechanism and related alternatives; reconcile overlapping ownership in the same change. Use [write](../skills/agent-notes-write/SKILL.md), [maintain](../skills/agent-notes-maintain/SKILL.md) and [review](../skills/agent-notes-review/SKILL.md) as applicable. This does not require a corpus-wide audit.

## Layout and naming

Keep each note at `<lifecycle>/<class>/YYYY-MM-DD-topic.md`. Preserve its original topic date during a move. Lifecycles are `proposed`, `implemented`, and `rejected`. Classes are `architecture`, `process`, `feature`, `bug-fix`, `simplification`, and `testing`; choose the decision's actual topic. Browse or search the tree; no central index is needed. The local attributes file keeps Markdown line endings consistent.

## Lifecycle and maintenance

- `proposed`: intended or partly implemented work. Record observable acceptance criteria and material risks.
- `implemented`: a completed, current decision. Keep its meaningful factual claims aligned with code in the same change; see [implemented rules](implemented/AGENTS.md).
- `rejected`: a declined proposal with its reason in the status. Retain it only while it prevents a plausible mistake; keep historical intent distinct from current facts.

When a proposal is implemented, rewrite it into a present-tense decision. When a decision changes, preserve still-useful rationale and obligations in its current owner and cross-link partial replacements. Delete obsolete or fully superseded records when they no longer guide work, repairing inbound links. A removal decision retains any enduring ownership, persistence, deletion or reintroduction constraints. Do not delete useful reasons merely to reduce file count.

Git history preserves prior versions and removed records. There is no separate frozen archive, hash manifest, sealing command, or trusted baseline. A commit message can identify a removed predecessor; active documents must link to current owners. Notes maintenance never authorizes destructive operations, publication, or a change outside the requested scope.

## The file format

Start a note with:

```markdown
# Agent Note: <title>

Status: implemented

## Problem
```

Use exactly one `Status:` line matching its directory: `proposed`, `implemented`, or `rejected — <reason>`. Every body starts with `Problem` and includes `Alternatives considered`. Implemented records also require `Decision` and `Consequences`; proposals require `Proposal`, `Acceptance criteria` and `Risks`; rejected records retain the proposal and its alternatives. Do not leave proposal-era plans in implemented records.

Use the [templates](../skills/agent-notes-write/assets/) for new notes. One short paragraph per section is normally enough. Alternatives must be actual choices, not invented historical deliberation; explicitly state uncertainty when the earlier reasoning is unknown.

## Decision scope

Keep a detail only when omitting it would obscure the choice, its cost, an ownership boundary, or an obligation future work must preserve. Support constraints adopted by the project belong; one author's machine state, inspection dates, commands, task sequencing, file inventories and test output do not. Preserve material uncertainty without copying investigation logs. Link existing code or documentation for operational detail.

## Checks

Run `python3 scripts/agent_notes.py check` from the repository root. It validates note paths, headers, required sections, line endings, and local file/Markdown-heading links in the Notes, project skills, root rules and README. It does not validate remote URLs or replace review of decision quality and code agreement. No Git history or network access is needed to run it.
