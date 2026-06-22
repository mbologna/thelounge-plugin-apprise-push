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

// Returns true if the message is a highlight: it contains the user's own nick
// (case-insensitive substring) or matches a pre-compiled highlight-word pattern.
// `cfg.highlightRe` is produced by compileConfig().
function isHighlight(cfg, myNick, message) {
  if (myNick && message.toLowerCase().includes(myNick.toLowerCase())) return true;
  return cfg.highlightRe.some((re) => re.test(message));
}

module.exports = { stripIrcFormatting, isHighlight };
