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
// ellipsis. `maxLen` of 0 (or falsy) means "no truncation". Counts code points,
// not UTF-16 units, so the cut never splits an emoji into a lone surrogate.
function truncate(str, maxLen) {
  if (!maxLen) return str;
  const chars = Array.from(str);
  if (chars.length <= maxLen) return str;
  return chars.slice(0, maxLen - 1).join("") + "…";
}

module.exports = { expand, truncate };
