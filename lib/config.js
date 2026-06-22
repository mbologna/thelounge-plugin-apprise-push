"use strict";

const { URL } = require("url");

// ── Defaults ───────────────────────────────────────────────────────────────────

const DEFAULTS = {
  // Required — full Apprise API notify endpoint, e.g. "http://apprise:8000/notify/chatnotifications"
  apprise_url: "",

  // Optional Apprise authentication.
  //   apprise_token   — shorthand, sent as "Authorization: Bearer <token>"
  //   apprise_headers — arbitrary extra HTTP headers (overrides the bearer header on conflict)
  apprise_token: "",
  apprise_headers: {},

  // HTTP delivery tuning
  timeout: 10000, // ms before a single Apprise request is aborted
  retries: 2, // additional attempts after the first on transient failure (0 = no retry)
  retry_delay: 500, // base backoff in ms; grows exponentially (500, 1000, 2000…)

  // Notification text — supports {nick}, {channel}, {network}, {message}, {mynick}, {time}
  title_pm: "PM from {nick} [{network}]",
  title_chan: "[{network}] {channel}",
  body: "{nick}: {message}",
  body_length: 100, // 0 = no truncation

  // Global pre-filters (applied before any rule)
  away_only: false,
  cooldown: 0, // seconds between notifications per context (0 = disabled)
  nick_blacklist: [], // glob patterns — nicks that never trigger notifications
  network_blacklist: [], // glob patterns — network names that never trigger
  highlight_words: [], // extra words/patterns that count as a highlight

  // Ordered rule list — first matching rule wins.
  // Default: notify on nick highlights and PMs.
  rules: [{ highlight: true }, { pm: true }],

  debug: false,
};

// ── Wildcard matching ──────────────────────────────────────────────────────────

// Compiles a case-insensitive glob pattern (* = any sequence, ? = any char) to a RegExp.
// Call once at config load time; reuse the result to avoid per-message recompilation.
function makeGlobRe(pattern) {
  return new RegExp(
    "^" +
      String(pattern)
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
    "i"
  );
}

// Returns true if `value` matches any pre-compiled RegExp in `reList`.
function matchesAny(reList, value) {
  return reList.some((re) => re.test(value));
}

// ── Validation ───────────────────────────────────────────────────────────────────

const VALID_ACTIONS = new Set(["notify", "suppress"]);
const KNOWN_KEYS = new Set(Object.keys(DEFAULTS));

// Emits actionable warnings for likely config mistakes. Never throws — a bad value
// falls back to its default so the plugin keeps running.
function validateConfig(raw, warn = console.warn) {
  if (!raw || typeof raw !== "object") return;

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      warn(`[apprise-push] unknown config key "${key}" — ignored`);
    }
  }

  const numericKeys = ["timeout", "retries", "retry_delay", "body_length", "cooldown"];
  for (const key of numericKeys) {
    if (raw[key] !== undefined && typeof raw[key] !== "number") {
      warn(`[apprise-push] "${key}" should be a number — using default ${DEFAULTS[key]}`);
    }
  }

  if (raw.apprise_headers !== undefined && typeof raw.apprise_headers !== "object") {
    warn(`[apprise-push] "apprise_headers" should be an object — ignored`);
  }

  if (raw.rules !== undefined && !Array.isArray(raw.rules)) {
    warn(`[apprise-push] "rules" should be an array — using defaults`);
  }
}

// ── Config loading & compilation ───────────────────────────────────────────────

// Coerces a value to the type of its default, falling back to the default on mismatch.
function coerceNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Merges user config with defaults, normalises fields, pre-compiles all glob
// patterns, validates rule actions, builds the request headers, and pre-parses
// apprise_url — so none of that work happens per-message.
function compileConfig(raw, warn = console.warn) {
  validateConfig(raw, warn);

  const cfg = { ...DEFAULTS, ...raw };

  // Numeric guards
  cfg.timeout = coerceNumber(cfg.timeout, DEFAULTS.timeout);
  cfg.retries = Math.max(0, coerceNumber(cfg.retries, DEFAULTS.retries));
  cfg.retry_delay = Math.max(0, coerceNumber(cfg.retry_delay, DEFAULTS.retry_delay));
  cfg.body_length = coerceNumber(cfg.body_length, DEFAULTS.body_length);
  cfg.cooldown = coerceNumber(cfg.cooldown, DEFAULTS.cooldown);

  // Normalise list fields so callers always get arrays
  for (const key of ["nick_blacklist", "network_blacklist", "highlight_words"]) {
    if (!Array.isArray(cfg[key])) cfg[key] = cfg[key] ? [cfg[key]] : [];
  }

  // Pre-compile glob patterns → RegExp
  cfg.nickBlacklistRe = cfg.nick_blacklist.map(makeGlobRe);
  cfg.networkBlacklistRe = cfg.network_blacklist.map(makeGlobRe);
  cfg.highlightRe = cfg.highlight_words.map((w) => makeGlobRe(`*${w}*`));

  // Build outgoing HTTP headers from apprise_token / apprise_headers.
  cfg.headers = {};
  if (cfg.apprise_token) cfg.headers["Authorization"] = `Bearer ${cfg.apprise_token}`;
  if (cfg.apprise_headers && typeof cfg.apprise_headers === "object") {
    Object.assign(cfg.headers, cfg.apprise_headers);
  }

  // Clone rule objects (avoid mutating DEFAULTS.rules), validate actions,
  // and pre-compile per-rule glob patterns.
  const rawRules = Array.isArray(raw && raw.rules) ? raw.rules : DEFAULTS.rules;
  cfg.rules = rawRules.map((r) => {
    const rule = { ...r };
    if (rule.action !== undefined && !VALID_ACTIONS.has(rule.action)) {
      warn(`[apprise-push] unknown rule action "${rule.action}" — treated as "notify"`);
    }
    if (rule.channel !== undefined)
      rule._channelRe = [].concat(rule.channel).map(makeGlobRe);
    if (rule.network !== undefined)
      rule._networkRe = [].concat(rule.network).map(makeGlobRe);
    if (rule.nick !== undefined) rule._nickRe = [].concat(rule.nick).map(makeGlobRe);
    return rule;
  });

  // Pre-parse and validate apprise_url — fail fast at load time, not per-send
  cfg.parsedUrl = null;
  if (cfg.apprise_url) {
    try {
      cfg.parsedUrl = new URL(cfg.apprise_url);
    } catch (e) {
      console.error(`[apprise-push] invalid apprise_url: ${e.message}`);
    }
  }

  return cfg;
}

module.exports = {
  DEFAULTS,
  VALID_ACTIONS,
  makeGlobRe,
  matchesAny,
  validateConfig,
  compileConfig,
};
