# Agent Note: Pin and verify the native Codex contract

Status: implemented

## Problem

Permissive synthetic peers accepted arbitrary RPCs and initialization results, hiding differences between the assumed protocol and the installed experimental CLI.

## Decision

Adopt one tested CLI release and full-history mode, validate version and platform during the real handshake, and fail before session mutations for unsupported peers. [The supported contract](../../../../docs/codex-contract.md) owns the release, native history limitation, reproducible no-model smoke and provenance of the sanitized native transcript. Strict peers reject undeclared RPCs. This extends [fixture boundaries](2026-10-02-fixture-boundaries.md) with native evidence; synthetic multi-agent tests remain labeled synthetic.

## Alternatives considered

**Accept any PATH version:** avoids explicit upgrades but silently changes an experimental wire contract. **Pretend generated fixtures are captured model traffic:** gives false confidence; a real no-model command exchange establishes a narrower, honest guarantee.

## Consequences

CLI upgrades are explicit maintenance work. Native paginated histories are unsupported until the selected release provides the required read contract; there is no fallback parser or automatic mutation replay.
