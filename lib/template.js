"use strict";

// ── Keyword expansion & truncation ──────────────────────────────────────────────

// Replaces {placeholder} tokens with values from `vars`. Unknown tokens are left
// untouched so a typo is visible in the notification rather than silently dropped.
function expand(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, k) =>
    k in vars ? vars[k] : `{${k}}`
  );
}

// Truncates `str` to at most `maxLen` characters, replacing the cut tail with an
// ellipsis. `maxLen` of 0 (or falsy) means "no truncation".
function truncate(str, maxLen) {
  if (!maxLen || str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

module.exports = { expand, truncate };
