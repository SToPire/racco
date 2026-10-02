# Agent Note: Preserve readable parent history when a child is unavailable

Status: implemented

## Problem

Sequential descendant reads make a large native tree slow, and one missing or stale child used to hide the entire parent conversation.

## Decision

Discover child identities before reading their content, then read at most four children concurrently. A failed discovery or child read produces an explicit partial-history notice; successfully read parent and sibling history remains usable. Failed or unaligned child snapshots are never applied. This changes the failure scope of [snapshot reconciliation](2026-09-22-codex-background-child-events.md), while retaining its generation, terminal-state and ownership protections.

## Alternatives considered

**Fail the complete conversation:** makes incompleteness obvious but also removes useful independent history. **Unbounded parallel reads:** reduce latency at the cost of flooding the native process for large trees.

## Consequences

A partial view may omit a child's earlier content until the user reloads it. Explicit notices distinguish that situation from an empty successful history; a parent read failure still fails the conversation read.
