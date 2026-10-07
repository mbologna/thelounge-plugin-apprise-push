"use strict";

// ── Metrics ─────────────────────────────────────────────────────────────────────

// In-memory-only counters (no persistence, no external endpoint — consistent
// with the plugin's zero-runtime-dependency philosophy). index.js logs a
// snapshot periodically when cfg.debug is true.
function createMetrics() {
  const counters = { notified: 0, suppressed: 0, skipped: 0, sendFailed: 0 };

  function record(kind) {
    if (Object.hasOwn(counters, kind)) counters[kind]++;
  }

  function snapshot() {
    return { ...counters };
  }

  return { record, snapshot };
}

module.exports = { createMetrics };
