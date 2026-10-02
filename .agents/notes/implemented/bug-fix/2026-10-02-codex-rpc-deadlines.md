# Agent Note: Bound Codex RPC waits

Status: implemented

## Problem

A live native process can omit a response indefinitely, blocking daemon initialization or keeping a management operation and its directory lease open forever.

## Decision

Initialization has a 15-second deadline and every other RPC a 30-second response deadline. Read timeouts discard only that pending read; initialization or mutation timeouts fail the Codex provider and wait for the native process to close. Mutation failures explicitly report an unconfirmed result and are never replayed. Provider initialization failures remain isolated so the WebUI, diagnostics and other provider can start. This extends [bounded turn cancellation](2026-10-02-codex-bounded-cancellation.md) to RPC waits; both records retain their separate cancellation and unknown-outcome obligations.

## Alternatives considered

**Unlimited waits:** preserve tolerance for stalled peers but make service availability depend on them. **Retry mutations:** can duplicate work when only the acknowledgement was lost.

## Consequences

An unusually slow native response may require the user to retry a read or recover the provider. Closing a provider cannot undo side effects already performed, and no timeout is evidence that a mutation never began.
