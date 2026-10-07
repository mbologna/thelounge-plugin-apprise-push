"use strict";

// ── Digest / batching ───────────────────────────────────────────────────────────

// Coalesces multiple "notify" decisions for the same context into a single
// Apprise notification, flushed `windowSec` after the first buffered message.
// Internal helper used by index.js — not part of the plugin's public surface.
// `notifyLog`, if given, records one timestamp per flush (not per buffered
// message) so a digest batch counts as a single notification against
// cfg.max_per_minute, matching what's actually sent over the wire. `metrics`,
// if given, records one "sendFailed" per flush whose delivery ultimately failed.
function createDigestManager(sendApprise, notifyLog = null, metrics = null) {
  const buffers = new Map(); // clientKey -> { lines, title, priority, cfg, parsedUrl, timer }

  // Buffers one message body line for `clientKey`. Title/priority/cfg/parsedUrl
  // are taken from the most recent call (the context — channel/network/rule —
  // is stable for a given clientKey, so this is equivalent across the batch).
  function enqueue({ clientKey, title, bodyLine, priority, cfg, parsedUrl, windowSec }) {
    let buf = buffers.get(clientKey);
    if (!buf) {
      buf = { lines: [], title, priority, cfg, parsedUrl, timer: null };
      buffers.set(clientKey, buf);
    }
    buf.lines.push(bodyLine);
    buf.title = title;
    buf.priority = priority;

    if (!buf.timer) {
      buf.timer = setTimeout(() => {
        buffers.delete(clientKey);
        if (notifyLog && buf.cfg.max_per_minute > 0) {
          notifyLog.push(Math.floor(Date.now() / 1000));
        }
        sendApprise(
          buf.cfg,
          buf.title,
          buf.lines.join("\n"),
          buf.priority,
          buf.parsedUrl
        ).then((ok) => {
          if (ok === false && metrics) metrics.record("sendFailed");
        });
      }, windowSec * 1000);
      // Don't let a pending digest keep the process alive.
      if (buf.timer.unref) buf.timer.unref();
    }
  }

  return { enqueue };
}

module.exports = { createDigestManager };
