"use strict";

// ── Digest / batching ───────────────────────────────────────────────────────────

// A flushed batch shows at most this many message lines, then "… and N more",
// so a flood stays well under push services' size limits (Telegram: 4096).
const MAX_DIGEST_LINES = 20;

// Title and body of a flushed batch: the title says how many messages it holds,
// the body lists the first MAX_DIGEST_LINES of them.
function formatBatch(title, lines) {
  if (lines.length <= 1) return { title, body: lines.join("\n") };
  const shown = lines.slice(0, MAX_DIGEST_LINES);
  const rest = lines.length - shown.length;
  if (rest > 0) shown.push(`… and ${rest} more`);
  return { title: `${title} (${lines.length} messages)`, body: shown.join("\n") };
}

// Coalesces multiple "notify" decisions for the same context into a single
// Apprise notification, flushed `windowSec` after the first buffered message.
// Internal helper used by index.js — not part of the plugin's public surface.
// `notifyLog`, if given, records one timestamp per flush (not per buffered
// message) so a digest batch counts as a single notification against
// cfg.max_per_minute, matching what's actually sent over the wire. `metrics`,
// if given, records one "sendFailed" per flush whose delivery ultimately failed.
// `isMuted(nowSec)`, if given, is checked again at flush time: a batch whose
// window ends while notifications are muted is dropped, not sent.
function createDigestManager(
  sendApprise,
  notifyLog = null,
  metrics = null,
  isMuted = () => false
) {
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
        if (isMuted(Math.floor(Date.now() / 1000))) return;
        if (notifyLog && buf.cfg.max_per_minute > 0) {
          notifyLog.push(Math.floor(Date.now() / 1000));
        }
        const { title: batchTitle, body } = formatBatch(buf.title, buf.lines);
        sendApprise(buf.cfg, batchTitle, body, buf.priority, buf.parsedUrl).then((ok) => {
          if (ok === false && metrics) metrics.record("sendFailed");
        });
      }, windowSec * 1000);
      // Don't let a pending digest keep the process alive.
      if (buf.timer.unref) buf.timer.unref();
    }
  }

  return { enqueue };
}

module.exports = { createDigestManager, formatBatch, MAX_DIGEST_LINES };
