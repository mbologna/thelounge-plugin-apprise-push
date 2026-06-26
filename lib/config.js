"use strict";

const { URL } = require("url");
const { name: PKG_NAME, version: PKG_VERSION } = require("../package.json");

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

  // Notification priority — passed to Apprise as-is; null omits the field.
  // Accepted values: null, a number, or "min" | "low" | "normal" | "high" | "max"
  priority: null,

  // IANA timezone name for the {time} placeholder (e.g. "America/New_York").
  // Empty string = use the system/process timezone (default behavior).
  timezone: "",

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

// Compiles a string-or-array of glob patterns into an array of RegExp objects.
// Wrapping each pattern in *…* is optional — callers pass the full pattern.
function compileGlobList(val) {
  return [].concat(val).map(makeGlobRe);
}

// ── Validation ───────────────────────────────────────────────────────────────────

const VALID_ACTIONS = new Set(["notify", "suppress"]);
const VALID_PRIORITIES = new Set(["min", "low", "normal", "high", "max"]);
const VALID_MESSAGE_TYPES = new Set(["privmsg", "action"]);
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

  if (typeof raw.cooldown === "number" && raw.cooldown < 0)
    warn(`[apprise-push] "cooldown" should be >= 0 — clamped to 0`);

  if (typeof raw.timeout === "number" && raw.timeout < 100)
    warn(`[apprise-push] "timeout" is ${raw.timeout}ms — values under 100ms are likely a misconfiguration`);

  if (typeof raw.retry_delay === "number" && raw.retry_delay < 0)
    warn(`[apprise-push] "retry_delay" should be >= 0 — clamped to 0`);

  if (raw.apprise_headers !== undefined && typeof raw.apprise_headers !== "object") {
    warn(`[apprise-push] "apprise_headers" should be an object — ignored`);
  }

  if (raw.rules !== undefined && !Array.isArray(raw.rules)) {
    warn(`[apprise-push] "rules" should be an array — using defaults`);
  }

  if (
    raw.priority !== undefined &&
    raw.priority !== null &&
    typeof raw.priority !== "number" &&
    !VALID_PRIORITIES.has(raw.priority)
  ) {
    warn(
      `[apprise-push] "priority" should be null, a number, or one of: min low normal high max`
    );
  }

  if (raw.timezone && typeof raw.timezone === "string") {
    try {
      new Intl.DateTimeFormat("en", { timeZone: raw.timezone });
    } catch {
      warn(`[apprise-push] "timezone" is not a valid IANA timezone — using system timezone`);
    }
  }
}

// ── Config loading & compilation ───────────────────────────────────────────────

// Coerces a value to the type of its default, falling back to the default on mismatch.
function coerceNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Returns true if `tz` is a valid IANA timezone string.
function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
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
  cfg.cooldown = Math.max(0, coerceNumber(cfg.cooldown, DEFAULTS.cooldown));

  // Clear an invalid timezone so it never reaches toLocaleTimeString() as a bad value
  // (which would throw RangeError and crash the message handler).
  if (cfg.timezone && !isValidTimezone(cfg.timezone)) cfg.timezone = "";

  // Normalise list fields so callers always get arrays
  for (const key of ["nick_blacklist", "network_blacklist", "highlight_words"]) {
    if (!Array.isArray(cfg[key])) cfg[key] = cfg[key] ? [cfg[key]] : [];
  }

  // Pre-compile glob patterns → RegExp
  cfg.nickBlacklistRe = cfg.nick_blacklist.map(makeGlobRe);
  cfg.networkBlacklistRe = cfg.network_blacklist.map(makeGlobRe);
  cfg.highlightRe = cfg.highlight_words.map((w) => makeGlobRe(`*${w}*`));

  // Build outgoing HTTP headers from apprise_token / apprise_headers.
  // User-Agent is set first so apprise_headers can override it if needed.
  cfg.headers = { "User-Agent": `${PKG_NAME}/${PKG_VERSION}` };
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

    if (
      rule.priority !== undefined &&
      rule.priority !== null &&
      typeof rule.priority !== "number" &&
      !VALID_PRIORITIES.has(rule.priority)
    ) {
      warn(`[apprise-push] rule has unknown priority "${rule.priority}" — ignored`);
      rule.priority = null;
    }

    if (
      rule.message_type !== undefined &&
      !VALID_MESSAGE_TYPES.has(rule.message_type)
    ) {
      warn(
        `[apprise-push] rule has unknown message_type "${rule.message_type}" — ignored (use "privmsg" or "action")`
      );
      delete rule.message_type;
    }

    if (rule.channel !== undefined) rule._channelRe = compileGlobList(rule.channel);
    if (rule.network !== undefined) rule._networkRe = compileGlobList(rule.network);
    if (rule.nick !== undefined) rule._nickRe = compileGlobList(rule.nick);
    if (rule.contains !== undefined)
      rule._containsRe = [].concat(rule.contains).map((p) => makeGlobRe(`*${p}*`));
    if (rule.cooldown !== undefined)
      rule.cooldown = Math.max(0, coerceNumber(rule.cooldown, cfg.cooldown));

    return rule;
  });

  // Pre-parse and validate apprise_url — fail fast at load time, not per-send
  cfg.parsedUrl = null;
  if (cfg.apprise_url) {
    try {
      cfg.parsedUrl = new URL(cfg.apprise_url);
      if (cfg.parsedUrl.pathname === "/") {
        warn(
          `[apprise-push] apprise_url has no path — expected something like /notify/<key> (e.g. http://apprise:8000/notify/chatnotifications)`
        );
      }
    } catch (e) {
      console.error(`[apprise-push] invalid apprise_url: ${e.message}`);
    }
  }

  return cfg;
}

module.exports = {
  DEFAULTS,
  VALID_ACTIONS,
  VALID_PRIORITIES,
  VALID_MESSAGE_TYPES,
  makeGlobRe,
  matchesAny,
  compileGlobList,
  validateConfig,
  compileConfig,
};
