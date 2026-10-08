---
name: agent-notes-review
description: Review Agent Notes and design-document ownership for durable rationale, requested scope, lifecycle accuracy, implementation agreement, and supersession. Use when notes need review, designs are misplaced or duplicated, or review process records may have entered a change.
---

# Review Agent Notes

Review the requested decision or change using the target project's `.agents/notes/README.md`, applicable AGENTS.md files, and relevant active notes. This skill covers decision records and their relationship to the implementation. It supplements the project's code-review workflow.

## Check document ownership

Inspect the task's new and changed documents, including any staged candidates, before judging their prose. A project design outside `.agents/notes/`, a design split from its owning Note, or a versioned review process record is a correctness issue. The design itself must live in the owning Note, including requested interface, algorithm, and UI details. Renaming findings as a Note or archiving the review report does not turn a process record into a durable decision.

## Compare intent, implementation, and evidence

Establish the actual diff and its base when reviewing a change. Inspect enough surrounding code, configuration, documentation, and tests to verify each claim. Prioritize consequential defects over wording preferences.

- Does the change require a new or updated note? Does an existing record already own it?
- Does a proposal describe observable acceptance criteria and real risks? Is partly completed work still identified as proposed?
- Does an implemented record match actual paths, symbols, defaults, mechanisms, failures, and externally visible behavior? Does a completed proposal include its lifecycle move and body rewrite?
- Are alternatives grounded in evidence? Do consequences preserve both benefits and costs, durable verification obligations, and limitations that affect the decision?
- Does a changed decision explicitly relate to its predecessor? Are partial replacements retained, and are full consolidations lossless?
- Do code and tests establish the claimed behavior? Distinguish observed checks from planned checks or the author's self-report.

A disagreement with an existing note calls for design analysis. Identify whether the change is a defect or an intentional decision with new evidence; an older record is not an automatic veto. Use archived material only for an intentional historical citation, never as current authority.

## Review prose and references

Treat relevance and level of detail as part of the review. A fact can be accurate and still be unsuitable for a project decision record. Apply these questions to proposed notes as well as implemented ones:

- Does the reader need this passage to understand the choice, its trade-offs, or a durable obligation? Flag investigation narration and implementation instructions that fail this test.
- Does a date, tool version, absolute path, or environment limitation describe the project or only the author's machine? Keep adopted support and format constraints; flag local observations presented as project requirements.
- Does the proposal retain the approach, observable outcomes, and design details the user actually requested? Preserve requested interfaces, algorithms, and UI interactions in the owning Note. Flag incidental execution walkthroughs; do not use concision to remove requested detail or recommend a companion design outside Notes.
- Does each section add distinct information? Flag repeated scope, unnecessary subsections, and exhaustive catalogs. Length alone is not a defect when every paragraph explains a consequential decision.

Preserve the conditions, exceptions, ownership, and negative guarantees that belong to the decision when suggesting a shorter version. Remove session-only citations and reviewer dialogue. Give a concrete cut or concise replacement for excessive detail; “be more concise” is not an actionable finding.

Check that the note's claims, tables, code, and references agree with the implementation evidence. Check inbound links after moves and deletions. Exclude archived sources from prose and outgoing-link audits.

## Validate and report

Run `python3 scripts/agent_notes.py check` from the target root, using `--base-ref` for the trusted pre-change commit when validating committed archive changes. Run relevant implementation checks if the review needs behavioral evidence. A passing structural checker cannot establish decision quality or code agreement.

Return findings in the conversation. If a local report is needed, write only under `.tmp/reviews/` and verify it is ignored and untracked; never stage the report, dialogue, approval transcript, or execution log. Before an authorized commit, inspect staged document paths and contents as well as checker results. Durable decisions derived from review belong in the existing owner without the review narrative.

Report each finding with the file location, the incorrect or missing claim, practical impact, and supporting evidence. Separate defects from optional improvements. Identify unverified claims without inventing test results. A review request produces findings; edit records only when the task also authorizes fixes.
