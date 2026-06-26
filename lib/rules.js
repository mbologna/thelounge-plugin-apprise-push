"use strict";

const { matchesAny } = require("./config");

// ── Rule matching ──────────────────────────────────────────────────────────────

// A rule is an object whose keys are conditions (all must be true — AND logic) plus an
// optional `action` ("notify" | "suppress", default "notify") and optional template/
// delivery overrides (`title`, `body`, `cooldown`, `priority`).
//
// Conditions:
//   channel      string|string[]  glob(s) matched against the channel name
//   pm           boolean          true → only PMs, false → only channel messages
//   highlight    boolean          true → message must contain own nick or highlight_words
//   network      string|string[]  glob(s) matched against the network name
//   nick         string|string[]  glob(s) matched against the sender nick
//   contains     string|string[]  glob(s) matched against the clean message text
//   message_type string           "privmsg" | "action" — filter /me vs normal messages
//
// If no conditions are specified the rule matches everything.
// Pre-compiled RegExp versions are stored as _channelRe / _networkRe / _nickRe / _containsRe.

function matchRule(rule, ctx) {
  const { isQuery, channel, senderNick, networkName, isHl, cleanMessage, messageType } = ctx;

  // `channel` — only channel messages in matching channels
  if (rule._channelRe !== undefined) {
    if (isQuery || !matchesAny(rule._channelRe, channel)) return false;
  }

  // `pm` — only private messages / only channel messages
  if (rule.pm === true && !isQuery) return false;
  if (rule.pm === false && isQuery) return false;

  // `highlight` — must be a highlight
  if (rule.highlight === true && !isHl) return false;

  // `network`
  if (rule._networkRe !== undefined && !matchesAny(rule._networkRe, networkName))
    return false;

  // `nick` — sender nick
  if (rule._nickRe !== undefined && !matchesAny(rule._nickRe, senderNick)) return false;

  // `contains` — message text must match at least one pattern
  if (rule._containsRe !== undefined && !matchesAny(rule._containsRe, cleanMessage))
    return false;

  // `message_type` — "privmsg" or "action" (/me)
  if (rule.message_type !== undefined && rule.message_type !== messageType) return false;

  return true;
}

// Runs global pre-filters then evaluates the rule list.
// Returns { decision: "notify" | "suppress" | "skip", rule } where `rule` is the
// matched rule (for template overrides) when the decision is "notify".
function evaluate(cfg, ctx, lastNotified) {
  const { senderNick, networkName, clientKey, now, attachedCount } = ctx;

  // Global pre-filters
  if (cfg.away_only && attachedCount > 0)
    return { decision: "skip", reason: "away_only", rule: null };
  if (matchesAny(cfg.nickBlacklistRe, senderNick))
    return { decision: "skip", reason: "nick_blacklist", rule: null };
  if (matchesAny(cfg.networkBlacklistRe, networkName))
    return { decision: "skip", reason: "network_blacklist", rule: null };

  // Rule list (first match wins)
  for (const rule of cfg.rules) {
    if (!matchRule(rule, ctx)) continue;

    // Per-rule cooldown overrides the global cooldown; both default to 0 (disabled)
    const effectiveCooldown = rule.cooldown ?? cfg.cooldown;
    if (effectiveCooldown > 0) {
      const last = lastNotified.get(clientKey) || 0;
      if (now - last < effectiveCooldown)
        return { decision: "skip", reason: "cooldown", rule: null };
    }

    return {
      decision: rule.action === "suppress" ? "suppress" : "notify",
      reason: rule.action === "suppress" ? "suppress" : "notify",
      rule,
    };
  }

  return { decision: "skip", reason: "no_match", rule: null };
}

module.exports = { matchRule, evaluate };
