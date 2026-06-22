"use strict";

const { matchesAny } = require("./config");

// ── Rule matching ──────────────────────────────────────────────────────────────

// A rule is an object whose keys are conditions (all must be true) plus an optional
// `action` ("notify" | "suppress", default "notify") and optional `title`/`body`
// template overrides.
//
// Conditions:
//   channel   string|string[]  glob(s) matched against the channel name
//   pm        boolean          true → only PMs, false → only channel messages
//   highlight true             the message contains a highlight word or own nick
//   network   string|string[]  glob(s) matched against the network name
//   nick      string|string[]  glob(s) matched against the sender nick
//
// If no conditions are specified the rule matches everything.
// Pre-compiled RegExp versions are stored in _channelRe / _networkRe / _nickRe.

function matchRule(rule, ctx) {
  const { isQuery, channel, senderNick, networkName, isHl } = ctx;

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

  return true;
}

// Runs global pre-filters then evaluates the rule list.
// Returns { decision: "notify" | "suppress" | "skip", rule } where `rule` is the
// matched rule (for template overrides) when the decision is "notify".
function evaluate(cfg, ctx, lastNotified) {
  const { senderNick, networkName, clientKey, now, attachedCount } = ctx;

  // Global pre-filters
  if (cfg.away_only && attachedCount > 0) return { decision: "skip", rule: null };
  if (matchesAny(cfg.nickBlacklistRe, senderNick))
    return { decision: "skip", rule: null };
  if (matchesAny(cfg.networkBlacklistRe, networkName))
    return { decision: "skip", rule: null };

  // Per-context cooldown
  if (cfg.cooldown > 0) {
    const last = lastNotified.get(clientKey) || 0;
    if (now - last < cfg.cooldown) return { decision: "skip", rule: null };
  }

  // Rule list (first match wins)
  for (const rule of cfg.rules) {
    if (matchRule(rule, ctx)) {
      return {
        decision: rule.action === "suppress" ? "suppress" : "notify",
        rule,
      };
    }
  }

  return { decision: "skip", rule: null }; // no rule matched
}

module.exports = { matchRule, evaluate };
