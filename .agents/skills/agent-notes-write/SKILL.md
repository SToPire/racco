---
name: agent-notes-write
description: Create and update project designs, technical proposals, requirements, and engineering decisions as Agent Notes. Use for design or implementation-plan requests even when the user does not name Agent Notes, and for recording rationale, refining requested design details, or rewriting completed proposals.
---

# Write Agent Notes

Record the reasons and trade-offs that future maintainers need. This workflow assumes the project has the Notes mechanism installed. Read `.agents/notes/README.md` and the applicable AGENTS.md files from the target repository; those files own the rules. If absent, use the startup skill from the complete suite before writing.

## Establish the decision

1. Read the requested change, current implementation, relevant tests, and existing active notes. Search by mechanism, symbols, and rejected alternatives. Follow an archived citation only when needed as historical evidence; do not use it as current authority.
2. Decide whether this change needs a note under the project's non-trivial-change rule. An existing owner can be updated when the decision remains the same. A reversal needs a new note and explicit links to the prior decision.
3. Choose the lifecycle and one class using the project README. Substantial future or partly implemented work is proposed. A completed decision starts directly in implemented; completing a proposal moves and rewrites it. Preserve the first-proposed date.
4. Before creating a draft or scaffold, select its single owning path under `.agents/notes/<lifecycle>/<class>/`. The design and its Agent Note are the same document. Generic co-authoring workflows, templates, and existing repository examples do not authorize another destination; do not create a `docs/` draft to move later or a short Note that merely links to a separate design.

## Select what belongs

Before drafting, state the decision and its decisive reason in one sentence each. Include a detail only if omitting it would obscure the choice, an important trade-off, or an obligation future changes must preserve. Investigate as deeply as needed, then select what belongs in the record.

Exclude inspection dates, local binary versions, machine paths, temporary output, command transcripts, and the author's account or network conditions. An explicitly adopted support baseline, format version, or deployment constraint belongs when it drives the decision; cite its project owner. A version merely observed on the author's machine does not establish such a requirement.

Keep the chosen approach, ownership, user-visible scope, consequential guarantees, and reasons alternatives lose. All project designs, proposals, requirements, and architecture records belong in `.agents/notes/`. Include design detail explicitly requested by the user, such as interfaces, algorithms, or UI interactions, in the owning note. Otherwise omit routine implementation inventories, sequencing, and test matrices; code and tests own those details. Never redirect them to a companion document under `docs/` or elsewhere.

Use the required sections without extra subsections by default. Each normally needs one short paragraph or a small list. Acceptance criteria name a few observable project outcomes; risks name material trade-offs or unresolved constraints. Avoid repeating the same scope across sections. Extra length must explain a consequential choice, trade-off, or obligation, or fulfill the user's request for design detail. Keep that detail in the same note. See [scope examples](references/decision-scope.md) when selecting from detailed research or an overlong draft.

Review and audit process records, findings, dialogue, and execution logs must never enter version control. Report them in the conversation; if a local file is needed, use only `.tmp/reviews/` and verify that the path is ignored and untracked. Fold durable conclusions into the owning note without preserving the transcript or citing local review artifacts as project authority. Renaming review findings as an Agent Note does not make them versionable.

## Write and reconcile

Use the matching template in [assets/](assets/) for a new proposal or implemented record. Replace all template fields. Each note is one Markdown file. A rejected record retains its proposal body; only its status verdict changes.

State the problem independently of the chosen solution. Record actual alternatives and why they lost; distinguish documented deliberation from a comparison performed during this task. If historical reasons cannot be established, report the evidence gap rather than inventing them. New proposals can explicitly compare keeping the current behavior with the proposed change.

Describe implemented decisions in the present tense. Preserve benefits, costs, and durable obligations. Keep a verification limitation only when it changes confidence in the decision or constrains adoption; state the limitation without a test log. Cite the existing owner of supporting evidence instead of reproducing it. References must make sense without the authoring conversation.

Every new note includes a scoped supersession audit using the installed `agent-notes-maintain` workflow. Search the same mechanism and process affected by the decision. Resolve known full or partial overlaps in this change; do not defer them to a future cleanup. A proposal-to-implementation move includes the body rewrite and inbound-link repair.

## Verify and report

Inspect the task's new and changed document paths before finishing. Confirm each design has one owning Note, no companion design elsewhere, and no review process record in the deliverable. Before an authorized commit, also inspect `git diff --cached --name-only` and the staged document contents; the path checker cannot recognize review prose disguised as another document.

Review the note's claims, headings, code, and links. Keep one physical line per paragraph and exactly one trailing newline. Then run from the repository root:

```sh
python3 scripts/agent_notes.py check
```

Run relevant project checks when verifying implementation claims, and report only evidence actually observed. Put commands run, local tool versions, and inspection details in the task handoff, not the note. Review links from and into active notes. Before finishing, retain design detail explicitly requested by the user and remove execution instructions that neither fulfill that request nor affect the decision. Report the owning note, its status, any superseded records and their disposition, and material unresolved questions. Writing a note does not authorize committing or publishing it.
