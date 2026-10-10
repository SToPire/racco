import assert from "node:assert/strict";
import test from "node:test";
import {
  formatRequestElapsed,
  receiveRequestClock,
  requestElapsedMs,
} from "./request-clock.js";

test("elapsed time uses receipt anchors, catches up after hidden time, and never regresses on live samples", () => {
  const first = receiveRequestClock(null, { id: "a", elapsedMs: 12000 }, 400);
  assert(first);
  assert.equal(requestElapsedMs(first, 8400), 20000);
  const delayed = receiveRequestClock(
    first,
    { id: "a", elapsedMs: 19000 },
    8400,
  );
  assert(delayed);
  assert.equal(requestElapsedMs(delayed, 8400), 20000);
  assert.equal(delayed.sampleElapsedMs, 19000);
  assert.equal(requestElapsedMs(delayed, 68400), 80000);
  const corrected = receiveRequestClock(
    delayed,
    { id: "a", elapsedMs: 82000 },
    68400,
  );
  assert(corrected);
  assert.equal(requestElapsedMs(corrected, 68400), 82000);
});

test("reconnect replaces stale estimates; terminal and new requests clear the previous clock", () => {
  const first = receiveRequestClock(null, { id: "a", elapsedMs: 12000 }, 100);
  assert(first);
  const stale = { ...first, stale: true };
  const reconnected = receiveRequestClock(
    stale,
    { id: "a", elapsedMs: 30000 },
    50100,
  );
  assert(reconnected);
  assert.equal(reconnected.stale, false);
  assert.equal(requestElapsedMs(reconnected, 50100), 30000);
  const next = receiveRequestClock(
    reconnected,
    { id: "b", elapsedMs: 0 },
    60100,
  );
  assert(next);
  assert.equal(requestElapsedMs(next, 61100), 1000);
  assert.equal(receiveRequestClock(next, null, 62100), null);
});

test("elapsed labels truncate seconds and handle minute and hour boundaries", () => {
  for (const [ms, label] of [
    [0, "00:00"],
    [999, "00:00"],
    [1000, "00:01"],
    [59999, "00:59"],
    [60000, "01:00"],
    [3599999, "59:59"],
    [3600000, "1:00:00"],
    [3723000, "1:02:03"],
    [36000000, "10:00:00"],
  ] as const)
    assert.equal(formatRequestElapsed(ms), label);
});
