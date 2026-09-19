# Selecting content for a decision record

The reader needs to understand the choice and avoid repeating a costly mistake. Keep the smallest explanation that preserves those facts. These examples illustrate content selection; they do not prescribe a project's technical design.

## Local observation versus project requirement

**Omit:** “On September 16, the local CLI was version 0.154.0. Generated types were inspected in a temporary directory with this command…” The date, machine state, and inspection procedure describe the investigation.

**Keep, when supported by project evidence:** “The gateway handles commands as explicit operations; sending their names as prompts cannot guarantee the requested action.” This explains the architectural choice. If provider support is unresolved, state that material uncertainty without promoting one local installation into a compatibility promise.

**Keep an actual adopted version constraint:** “Version 3 is the project's persisted format. Readers reject newer versions to avoid interpreting unknown records.” The version and rejection behavior are part of the decision. A developer's installed tool version would not establish that policy.

## Implementation inventory versus architectural choice

**Omit:** a route-to-hook-to-hub call trace, a list of proposed files, complete JSON requests, database columns, event-handler ordering, and a numbered implementation sequence.

**Keep:** “The server owns command validation and execution, sharing the existing session exclusion and retry guarantees. Clients cannot choose arbitrary provider methods or native session identifiers.” Ownership and guarantees explain the approach; the implementation chooses the specific handlers and storage layout.

Exact technical details can matter. If the decision is which field establishes request identity, naming that field and its duplicate-request semantics is necessary. That does not require reproducing the full request schema.

## Acceptance outcome versus verification inventory

**Omit:** every keybinding, parser input, fixture event sequence, command run, and file to update.

**Keep:** “Supported commands perform their documented action without becoming chat prompts; retries cannot duplicate a state-changing operation; reconnecting restores its visible status.” The implementation checks must establish these outcomes, while their cases and execution logs stay with the checks and task report.

## Short does not mean incomplete

Preserve a real trade-off, negative guarantee, compatibility obligation, or unresolved dependency even when it costs a paragraph. Remove incidental facts before compressing obligations. Split a record only when it contains independent decisions that need separate owners; do not split one implementation plan into several notes to retain its detail.
