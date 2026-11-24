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
//   "30"               -> muted for 30 minutes from when the file was last written
//   "2026-10-07T20:00Z" -> muted until that absolute ISO 8601 timestamp
//
// Returns an epoch-seconds timestamp to mute until (Infinity for indefinite),
// or 0 if the file doesn't exist or its content couldn't be parsed. Minutes
// count from `writtenMs`, the file's modification time, so a restart that
// re-reads the file doesn't start the snooze over.
function parseMuteFile(content, writtenMs = Date.now()) {
  const trimmed = content.trim();
  if (trimmed === "") return Infinity;

  const asMinutes = Number(trimmed);
  if (Number.isFinite(asMinutes)) return Math.floor(writtenMs / 1000) + asMinutes * 60;

  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) return Math.floor(asDate / 1000);

  return 0;
}

// Tracks mute state in memory, re-read on demand via refresh() (index.js wires
// this to fire on changes to the mute file). Never throws — a missing or
// unreadable file is simply "not muted".
function createMuteState(mutePath, warn = console.warn) {
  let muteUntil = 0;
  let expiryLogged = false;

  function refresh() {
    if (!fs.existsSync(mutePath)) {
      if (muteUntil !== 0)
        console.log("[apprise-push] unmuted — apprise-push.mute removed");
      muteUntil = 0;
      return;
    }

    let content;
    let writtenMs;
    try {
      content = fs.readFileSync(mutePath, "utf8");
      writtenMs = fs.statSync(mutePath).mtimeMs;
    } catch (e) {
      warn(`[apprise-push] failed to read apprise-push.mute: ${e.message}`);
      return;
    }

    const parsed = parseMuteFile(content, writtenMs);
    if (parsed === 0 && content.trim() !== "") {
      warn(
        "[apprise-push] apprise-push.mute content is not empty, a number of minutes, or a timestamp — ignoring"
      );
      return;
    }

    muteUntil = parsed;
    expiryLogged = false;
    if (muteUntil <= Math.floor(Date.now() / 1000)) {
      console.log("[apprise-push] apprise-push.mute has already expired — not muted");
      expiryLogged = true;
      return;
    }
    console.log(
      muteUntil === Infinity
        ? "[apprise-push] muted indefinitely — remove apprise-push.mute to resume"
        : `[apprise-push] muted until ${new Date(muteUntil * 1000).toISOString()}`
    );
  }

  function isMuted(nowSec) {
    if (nowSec < muteUntil) return true;
    if (muteUntil !== 0 && !expiryLogged) {
      expiryLogged = true;
      console.log("[apprise-push] unmuted — the snooze ended");
    }
    return false;
  }

  refresh();
  return { refresh, isMuted };
}

module.exports = { createMuteState, parseMuteFile };
