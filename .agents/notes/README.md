# Agent Notes

## Purpose

An Agent Note is a concise project-level record of a proposal or decision: why the problem matters, what was chosen, what alternatives lost, and what the choice costs. Keep the rationale and obligations that can guide a future engineering decision. Code, interface documentation, and task reports own implementation detail and execution evidence.

## Layout and naming

```text
.agents/notes/
  .gitattributes
  README.md
  AGENTS.md
  proposed/<class>/YYYY-MM-DD-topic.md
  implemented/AGENTS.md
  implemented/<class>/YYYY-MM-DD-topic.md
  rejected/<class>/YYYY-MM-DD-topic.md
  archived/AGENTS.md
  archived/manifest.json
  archived/<class>/YYYY-MM-DD-topic.md
```

The path encodes lifecycle and class. The filename date is when the topic was first proposed, as established by Git history; moving it does not change that date. Use a descriptive topic name. Each note is one Markdown file. The local `.gitattributes` preserves LF bytes at Git checkout so archive hashes remain valid across platforms. Empty `.gitkeep` files preserve class directories and are excluded from record checks and archive seals.

Keep one copy of each note. Move the file when its lifecycle changes. Use relative Markdown links between records, so moved targets can be found and repaired. Browse the lifecycle/class tree or search it; do not create a centralized `INDEX.md`.

## Classification

Each note uses exactly one class from this closed set. Adding a class requires updating this table and the checker's class list together.

| Class | Decision covered |
|---|---|
| `architecture` | Structure of shipped code, component relationships, and runtime concepts. |
| `process` | Tooling, policies, and workflows around the code. |
| `feature` | A new user- or model-facing capability. |
| `bug-fix` | Correction of a defect or a gap identified by an incident. |
| `simplification` | Removal or consolidation of code, behavior, or interfaces without adding a capability. |
| `testing` | Test infrastructure and strategy. |

Architecture describes the source that ships; process describes how the project develops it. Choose the actual decision rather than a generic refactor category.

## When to write a note

Every non-trivial change adds or updates at least one Agent Note in the same PR. This includes behavior, architecture, shared contracts, tooling, testing strategy, persistent data, wire or configuration formats, and any decision a maintainer may reasonably revisit. Only a mechanical or local edit without a change to behavior, contracts, structure, process, or rationale is exempt.

Update the record that already owns the decision when only its factual realization changes. Do not create a duplicate. A contrary decision or changed rationale requires a new note and links to the predecessor; do not rewrite an old note into a different decision. Every new note triggers a scoped supersession audit with [agent-notes-maintain](../skills/agent-notes-maintain/SKILL.md).

Substantial future work starts in `proposed/`; completed work can start directly in `implemented/`. Partly implemented work remains proposed. Use [agent-notes-write](../skills/agent-notes-write/SKILL.md) for authoring and [agent-notes-review](../skills/agent-notes-review/SKILL.md) for checking records against implementation and evidence.

## Lifecycle and maintenance

| Location | Meaning and maintenance obligation |
|---|---|
| `proposed/` | Intended work, not yet fully implemented; proposals can evolve. |
| `implemented/` | A completed decision; maintain factual agreement with the implementation in the same change. |
| `rejected/` | A declined proposal; its body is frozen and the status line records the reason. Retain it only while it prevents a plausible meaningful mistake. |
| `archived/` | A sealed historical snapshot of an implemented note; it is not current authority and cannot be changed. |

Moving proposed work to implemented rewrites Proposal into a present-tense Decision and folds durable outcomes and trade-offs into Consequences. Link to existing verification evidence where it affects the decision; keep execution logs out of the record. Moving a proposal to rejected preserves its body and changes the status verdict. Proposals never enter the archive.

An implemented note keeps its decision-relevant factual claims current without cataloging the implementation. Factual maintenance does not authorize reversing the decision. Read [implemented/AGENTS.md](implemented/AGENTS.md) before editing those records.

## Supersession and consolidation

Inspect related active records when adding a note. Keep and cross-link partial replacements and independently useful rationale; update facts that remain current. Reject obsolete proposals. Delete rejected notes that no longer prevent a plausible mistake. Archive qualifying implemented notes in the same PR.

A fully superseded implemented note can be consolidated into its current owner and deleted only after every unique rationale, alternative, consequence, required verification, and named coverage gap is preserved there. Repair every inbound link before deleting the old note. Git history alone is not an adequate surviving copy of the rationale.

A feature-addition note can be consolidated into a removal note only when the feature is absent from production code, configuration, schemas, durable and wire formats, migration, compatibility behavior, supported documentation, and tests that exercise it as supported. The owner preserves the original motivation, why it no longer justifies the feature, alternatives to full removal, the capability given up, conditions for reintroduction, and verification of complete absence. Tests asserting absence can remain. Any surviving compatibility or supported behavior makes supersession partial.

## Archive and deletion

Archive an implemented note when its decision is complete and its rationale is unlikely to guide future work. Keep it active while its alternatives, ownership rules, negative guarantees, security or persistence semantics, required verification, or reintroduction conditions remain useful. Age, length, and a target reduction quota do not decide retention.

The archive operation moves the Markdown file to `archived/<class>/`, retains `Status: implemented`, inserts `Archived: YYYY-MM-DD` immediately below the status, and repairs or removes inbound links. The archive-date line is the only permitted content change to the note during archival. Do not inspect or repair outgoing links in archived documents.

The append-only `archived/manifest.json` seals each note with SHA-256. Once sealed, the note cannot be edited, reformatted, moved, or deleted. Historical citations may link into it, but current work uses active records and current documentation. Renewed relevance requires a new active note. Follow [archived/AGENTS.md](archived/AGENTS.md) and the maintenance skill.

## The file format

The first lines of an active note are:

```markdown
# Agent Note: <title>

Status: proposed

## Problem
```

Keep the `# Agent Note: ` title prefix. Status is exactly `proposed`, `implemented`, or `rejected — <reason>` after `Status: `. Dates and amendment explanations belong outside the status line.

Every note opens its body with `## Problem`. Required headings are:

| Lifecycle | Required sections after Problem |
|---|---|
| `proposed` | `Proposal`, `Alternatives considered`, `Acceptance criteria`, `Risks` |
| `implemented` | `Decision`, `Alternatives considered`, `Consequences` |
| `rejected` | `Proposal`, `Alternatives considered`; retain the proposal's other sections |

Use the required sections without extra subsections by default. Add a technical section only when it is necessary to explain a consequential choice or obligation. Proposed notes describe the intended approach and observable outcomes, not an implementation plan. Implemented notes cannot use `Proposal`, `Plan`, `Migration plan`, or `Acceptance criteria` as second-level headings. An optional verification section records a material limitation or durable guarantee and links to its evidence, rather than listing checks and their output.

Alternatives are mandatory and must be genuine. Describe each candidate and why it lost in a bold-led paragraph or a `Why not …?` subsection. Do not invent historical deliberation to fill the section; establish the evidence or explicitly report the gap. A new proposal can compare keeping current behavior with changing it. This fresh-repository mechanism has no legacy-format exemption.

## Decision scope

For each candidate fact, ask whether omitting it would obscure the choice, its trade-offs, or an obligation that future changes must preserve. Keep the project problem, chosen approach, ownership, user-visible scope, genuine alternatives, and material consequences. Research can be extensive while its decision record remains short.

Omit the author's machine state: inspection dates, installed binary versions, home or temporary paths, shell output, account state, and one-off environment limitations. Keep a version, platform, or deployment constraint only when the project explicitly adopts it and it affects the decision. Cite the owning requirement; do not infer a support promise from a local observation. The filename's first-proposed date remains required metadata.

Keep file-by-file change plans, call traces, API and database inventories, algorithms, UI interaction specifications, work sequencing, and test matrices in their owning code or documentation. Exact technical detail belongs in a note only when the choice depends on it, such as a field's compatibility or ownership semantics. Link existing owners for supporting detail. Do not create a companion plan or appendix solely to preserve text that does not belong in the record.

Each required section normally needs one short paragraph or a small list. Acceptance criteria state a few observable project outcomes; risks state material trade-offs or unresolved constraints. Avoid repeating scope in several sections. Before expanding a record, identify the choice, trade-off, or obligation the extra prose explains. Preserve necessary negative guarantees and compatibility obligations; length alone is neither a correctness check nor a retention criterion.

## Writing

Write one physical line per paragraph and exactly one trailing newline. Preserve the decision's actors, conditions, obligations, exceptions, benefits, and costs. Keep a verification gap only when it changes confidence in the choice or constrains adoption. Use concrete terms and references understandable without the authoring conversation. Put commands run and local inspection details in the task handoff. Remove reviewer dialogue, code walkthroughs, and ungrounded planning residue.

## Checks

Run commands from the repository root:

```sh
python3 scripts/agent_notes.py check
python3 scripts/agent_notes.py seal
```

Use `seal` only after the permitted archive move and metadata update; it validates all prior seals before appending new ones. `check` is read-only. The checker validates tree structure, header and section grammar, line endings, and archive integrity. Meaning, code agreement, and link validity require review; use existing project link checks with archived sources excluded where available.

Local archive checks compare against committed HEAD. CI supplies a trusted pre-change commit through `AGENT_NOTES_BASE_REF` or `--base-ref`; the ref must exist locally. Fetch it when checkout history is shallow. An invalid explicit ref fails. Never repair a CI failure by changing existing seals or running write commands in CI.
