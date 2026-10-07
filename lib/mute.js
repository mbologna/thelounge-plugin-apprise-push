"use strict";

const fs = require("fs");

// ── Mute / snooze ───────────────────────────────────────────────────────────────

// Lets an operator silence all notifications without touching apprise-push.json
// (which would trip the hot-reload warning/validation path for an unrelated
// change). Controlled by the presence/content of a sibling file,
// apprise-push.mute, in the same directory as the config:
//
//   (file absent)      -> not muted
//   (empty file)       -> muted indefinitely, until the file is removed
//   "30"               -> muted for 30 minutes from whenever the file was (re)read
//   "2026-10-07T20:00Z" -> muted until that absolute ISO 8601 timestamp
//
// Returns an epoch-seconds timestamp to mute until (Infinity for indefinite),
// or 0 if the file doesn't exist or its content couldn't be parsed.
function parseMuteFile(content) {
  const trimmed = content.trim();
  if (trimmed === "") return Infinity;

  const asMinutes = Number(trimmed);
  if (Number.isFinite(asMinutes)) return Math.floor(Date.now() / 1000) + asMinutes * 60;

  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) return Math.floor(asDate / 1000);

  return 0;
}

// Tracks mute state in memory, re-read on demand via refresh() (index.js wires
// this to fire on changes to the mute file). Never throws — a missing or
// unreadable file is simply "not muted".
function createMuteState(mutePath, warn = console.warn) {
  let muteUntil = 0;

  function refresh() {
    if (!fs.existsSync(mutePath)) {
      if (muteUntil !== 0)
        console.log("[apprise-push] unmuted — apprise-push.mute removed");
      muteUntil = 0;
      return;
    }

    let content;
    try {
      content = fs.readFileSync(mutePath, "utf8");
    } catch (e) {
      warn(`[apprise-push] failed to read apprise-push.mute: ${e.message}`);
      return;
    }

    const parsed = parseMuteFile(content);
    if (parsed === 0 && content.trim() !== "") {
      warn(
        "[apprise-push] apprise-push.mute content is not empty, a number of minutes, or a timestamp — ignoring"
      );
      return;
    }

    muteUntil = parsed;
    console.log(
      muteUntil === Infinity
        ? "[apprise-push] muted indefinitely — remove apprise-push.mute to resume"
        : `[apprise-push] muted until ${new Date(muteUntil * 1000).toISOString()}`
    );
  }

  function isMuted(nowSec) {
    return nowSec < muteUntil;
  }

  refresh();
  return { refresh, isMuted };
}

module.exports = { createMuteState, parseMuteFile };
