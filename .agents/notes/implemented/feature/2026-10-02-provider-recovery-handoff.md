# Agent Note: Recover Codex and release idle native ownership

Status: implemented

## Problem

A failed Codex transport used to require restarting the whole daemon, affecting the other provider. Loaded native sessions also remained owned until daemon shutdown, with no explicit idle handoff.

## Decision

The new-conversation page offers an explicit Codex-only reconnect and idle-release action. It closes the existing native process completely before starting an empty connection, releases all loaded Codex sessions, preserves the Hub update listener, and never replays turns. Active main turns, complete asynchronous management operations, compaction and descendants—including children whose state is unconfirmed—block the action. Claude is untouched. Shutdown invalidates a concurrent recovery before it can spawn a replacement process. The [pinned native contract](../../../../docs/codex-contract.md) does not prove ownership release from an unsubscribe ACK, so process exit is the handoff boundary. This adds recovery to [bounded cancellation](../bug-fix/2026-10-02-codex-bounded-cancellation.md) without changing its shared failure scope.

## Alternatives considered

**Restart the daemon:** also interrupts independent Claude work. **Treat unsubscribe as unload:** the supported native release still reports the thread loaded after that acknowledgement. **Restart automatically or replay failed tasks:** risks repeating mutations with unconfirmed outcomes.

## Consequences

The idle release covers every Codex session, not just the currently visible one; the UI states that scope. The next explicit task resumes its native session on demand. Background services launched outside the native process are not covered by this ownership release.
