"use strict";

// ── Highlight detection ──────────────────────────────────────────────────────────

// Strips IRC formatting so highlight matching and notification bodies are clean text.
function stripIrcFormatting(str) {
  return (
    String(str)
      // eslint-disable-next-line no-control-regex
      .replace(/\x03\d{0,2}(,\d{1,2})?/g, "") // mIRC colour codes
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F]/g, "")
  ); // all other control chars (bold, italic, reset…)
}

// The user's nick as a word, the way The Lounge itself detects it
// (Network.setNick in server/models/network.ts): not preceded or followed by a
// letter or digit, so the nick "al" highlights "al: hi" but not "also".
function nickRe(nick) {
  const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9]|\x03[0-9]{1,2})${escaped}(?:[^a-z0-9]|$)`, "i");
}

// Returns true if the message is a highlight: it contains the user's own nick
// as a word (case-insensitive) or matches a pre-compiled highlight-word pattern.
// `cfg.highlightRe` is produced by compileConfig().
function isHighlight(cfg, myNick, message) {
  if (myNick && nickRe(myNick).test(message)) return true;
  return cfg.highlightRe.some((re) => re.test(message));
}

module.exports = { stripIrcFormatting, isHighlight };
