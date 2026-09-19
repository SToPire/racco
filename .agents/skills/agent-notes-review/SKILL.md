---
name: agent-notes-review
description: Review Agent Notes for durable project rationale, concise scope, lifecycle accuracy, implementation agreement, and supersession. Use when a note needs review or contains machine-specific observations, excessive implementation detail, or missing trade-offs.
---

# Review Agent Notes

Review the requested decision or change using the target project's `.agents/notes/README.md`, applicable AGENTS.md files, and relevant active notes. This skill covers decision records and their relationship to the implementation. It supplements the project's code-review workflow.

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
- Does a proposal explain an approach and observable outcomes, or prescribe call chains, fields, tables, UI mechanics, work sequencing, and test cases? Ask for the decision-level statement and a link to an existing owner where needed.
- Does each section add distinct information? Flag repeated scope, unnecessary subsections, and exhaustive catalogs. Length alone is not a defect when every paragraph explains a consequential decision.

Preserve the conditions, exceptions, ownership, and negative guarantees that belong to the decision when suggesting a shorter version. Remove session-only citations and reviewer dialogue. Give a concrete cut or concise replacement for excessive detail; “be more concise” is not an actionable finding.

Check that the note's claims, tables, code, and references agree with the implementation evidence. Check inbound links after moves and deletions. Exclude archived sources from prose and outgoing-link audits.

## Validate and report

Run `python3 scripts/agent_notes.py check` from the target root, using `--base-ref` for the trusted pre-change commit when validating committed archive changes. Run relevant implementation checks if the review needs behavioral evidence. A passing structural checker cannot establish decision quality or code agreement.

Report each finding with the file location, the incorrect or missing claim, practical impact, and supporting evidence. Separate defects from optional improvements. Identify unverified claims without inventing test results. A review request produces findings; edit records only when the task also authorizes fixes.
