# Agent Note: Keep child snapshot invariants together

Status: implemented

## Problem

Codex lifecycle orchestration and child snapshot ordering shared many mutable maps in one driver, making it difficult to see which transitions protect against stale history and suffix-only output.

## Decision

A Codex-specific snapshot reconciler owns child identities, in-flight read generations, terminal precedence and unaligned-item state, along with their transitions. The driver retains RPC calls, main-turn cancellation and process lifecycle. Native turn-scoped terminal notifications may close their own tracked items, but only the current turn can change the child’s overall state; the driver checks the reconciler before emitting a terminal state that would otherwise terminate newer content. Existing activity and tool trackers are passed as concrete collaborators; reconciliation has no transport callback or generic provider abstraction. [Background child guarantees](../bug-fix/2026-09-22-codex-background-child-events.md) and [partial history](../bug-fix/2026-10-02-partial-subagent-history.md) remain the behavior owners; this record changes their implementation boundary only.

## Alternatives considered

**One class per map:** scatters the invariants across additional coordination points. **Remove generations or terminal guards:** shortens code by dropping the evidence required to reject stale native responses.

## Consequences

Ordering and alignment changes now have one owner while lifecycle behavior remains visible in the driver. Existing snapshot, ownership and background-event regressions remain mandatory; extraction does not weaken their cases or add callbacks between these modules.
