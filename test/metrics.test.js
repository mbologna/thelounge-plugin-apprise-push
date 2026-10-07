"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createMetrics } = require("../lib/metrics");

test("createMetrics starts all counters at zero", () => {
  const m = createMetrics();
  assert.deepEqual(m.snapshot(), {
    notified: 0,
    suppressed: 0,
    skipped: 0,
    sendFailed: 0,
  });
});

test("record increments the matching counter", () => {
  const m = createMetrics();
  m.record("notified");
  m.record("notified");
  m.record("skipped");
  assert.deepEqual(m.snapshot(), {
    notified: 2,
    suppressed: 0,
    skipped: 1,
    sendFailed: 0,
  });
});

test("record ignores unknown counter names", () => {
  const m = createMetrics();
  m.record("bogus");
  assert.deepEqual(m.snapshot(), {
    notified: 0,
    suppressed: 0,
    skipped: 0,
    sendFailed: 0,
  });
});

test("snapshot returns an independent copy", () => {
  const m = createMetrics();
  const snap = m.snapshot();
  m.record("notified");
  assert.equal(snap.notified, 0);
  assert.equal(m.snapshot().notified, 1);
});
