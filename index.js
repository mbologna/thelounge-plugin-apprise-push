"use strict";

const fs   = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");

// ── Defaults ───────────────────────────────────────────────────────────────────

const DEFAULTS = {
  // Required
  apprise_api_url: "",   // e.g. "http://localhost:8000"
  apprise_urls:    [],   // e.g. ["tgram://bottoken/chatid"]

  // Notification text — supports keyword expansion (see README)
  message_title:   "{title}",
  message_content: "{context}: [{nick}] {message}",
  message_length:  100,   // 0 = no truncation

  // Global pre-filters (applied before any rule)
  away_only:         false,  // only notify when no browser tabs are open
  cooldown:          300,    // seconds between notifications per context (0 = off)
  nick_blacklist:    [],     // glob patterns — nicks that never trigger notifications
  network_blacklist: [],     // glob patterns — network names that never trigger
  highlight_words:   [],     // extra words/patterns that count as a highlight

  // Ordered rule list — first matching rule wins.
  // Default: notify on nick highlights and PMs.
  rules: [
    { highlight: true },
    { pm: true },
  ],

  debug: false,
};

// ── Wildcard matching ──────────────────────────────────────────────────────────

// Case-insensitive glob matching (* = any sequence, ? = any char).
function glob(pattern, str) {
  const re = new RegExp(
    "^" +
      String(pattern)
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
    "i"
  );
  return re.test(str);
}

// Returns true if `value` matches any pattern in `list` (array of globs).
function matchesAny(list, value) {
  return list.some((p) => glob(p, value));
}

// ── Highlight detection ────────────────────────────────────────────────────────

function stripIrcFormatting(str) {
  return str
    .replace(/\x03\d{0,2}(,\d{1,2})?/g, "") // color codes
    .replace(/[\x00-\x1F\x7F]/g, "");         // all other control chars
}

// Returns true if the message is a highlight: own nick or a configured highlight word.
function isHighlight(cfg, myNick, message) {
  const lower = message.toLowerCase();
  if (lower.includes(myNick.toLowerCase())) return true;
  for (const word of cfg.highlight_words) {
    if (glob(`*${word}*`, message)) return true;
  }
  return false;
}

// ── Rule matching ──────────────────────────────────────────────────────────────

// A rule is an object whose keys are conditions (all must be true) plus an optional
// `action` ("notify" | "suppress", default "notify").
//
// Conditions:
//   channel   string|string[]  glob(s) matched against the channel name
//   pm        true             the message is a private message
//   highlight true             the message contains a highlight word or own nick
//   network   string|string[]  glob(s) matched against the network name
//   nick      string|string[]  glob(s) matched against the sender nick
//
// If no conditions are specified the rule matches everything.

function matchRule(rule, ctx) {
  const { isQuery, target, senderNick, networkName, isHl } = ctx;

  // `channel` — only channel messages in matching channels
  if (rule.channel !== undefined) {
    if (isQuery) return false;
    if (!matchesAny([].concat(rule.channel), target)) return false;
  }

  // `pm` — only private messages
  if (rule.pm === true && !isQuery) return false;
  if (rule.pm === false && isQuery) return false;

  // `highlight` — must be a highlight
  if (rule.highlight === true && !isHl) return false;

  // `network`
  if (rule.network !== undefined) {
    if (!matchesAny([].concat(rule.network), networkName)) return false;
  }

  // `nick` — sender nick
  if (rule.nick !== undefined) {
    if (!matchesAny([].concat(rule.nick), senderNick)) return false;
  }

  return true;
}

// Runs global pre-filters then evaluates the rule list.
// Returns "notify" | "suppress" | "skip".
function evaluate(cfg, ctx, lastNotified) {
  const { senderNick, networkName, clientKey, now, attachedCount } = ctx;

  // Global pre-filters
  if (cfg.away_only && attachedCount > 0) return "skip";
  if (matchesAny(cfg.nick_blacklist,    senderNick))  return "skip";
  if (matchesAny(cfg.network_blacklist, networkName)) return "skip";

  // Per-context cooldown
  if (cfg.cooldown > 0) {
    const last = lastNotified.get(clientKey) || 0;
    if (now - last < cfg.cooldown) return "skip";
  }

  // Rule list (first match wins)
  for (const rule of cfg.rules) {
    if (matchRule(rule, ctx)) {
      return rule.action === "suppress" ? "suppress" : "notify";
    }
  }

  return "skip"; // no rule matched
}

// ── Keyword expansion ──────────────────────────────────────────────────────────

function expand(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
}

function truncate(str, maxLen) {
  if (!maxLen || str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

// ── Apprise HTTP API ───────────────────────────────────────────────────────────

function sendApprise(cfg, title, body) {
  const endpoint = cfg.apprise_api_url.replace(/\/$/, "") + "/notify";
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch (e) {
    console.error(`[apprise-push] invalid apprise_api_url: ${e.message}`);
    return;
  }

  const payload = Buffer.from(
    JSON.stringify({ urls: cfg.apprise_urls, title, body })
  );

  const options = {
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    method:   "POST",
    headers: {
      "Content-Type":   "application/json",
      "Content-Length": payload.length,
    },
  };

  const transport = parsed.protocol === "https:" ? https : http;
  const req = transport.request(options, (res) => {
    if (cfg.debug) console.log(`[apprise-push] Apprise → HTTP ${res.statusCode}`);
  });
  req.on("error", (e) =>
    console.error(`[apprise-push] Apprise request failed: ${e.message}`)
  );
  req.end(payload);
}

// ── Message handler factory ────────────────────────────────────────────────────

function makeHandler(cfg, lastNotified) {
  return function handle({ client, network, target, senderNick, rawMessage, isQuery }) {
    const myNick = network.irc?.user?.nick || network.nick || "";
    if (!myNick) return;
    if (senderNick.toLowerCase() === myNick.toLowerCase()) return;

    const networkName  = network.name || network.host || "IRC";
    const cleanMessage = stripIrcFormatting(rawMessage);
    const now          = Math.floor(Date.now() / 1000);
    // Key for cooldown: scoped to client+network+context so channels/PMs track independently
    const clientKey    = `${client.name}:${networkName}:${target}`;

    const attached = client.attachedClients;
    const attachedCount =
      attached instanceof Map ? attached.size : Object.keys(attached || {}).length;

    const ctx = {
      isQuery,
      target,
      senderNick,
      networkName,
      isHl: isHighlight(cfg, myNick, cleanMessage),
      now,
      clientKey,
      attachedCount,
    };

    const decision = evaluate(cfg, ctx, lastNotified);
    if (cfg.debug) {
      console.log(
        `[apprise-push] ${isQuery ? "PM" : "chan"} "${target}" from "${senderNick}"` +
        ` hl=${ctx.isHl} → ${decision}`
      );
    }
    if (decision !== "notify") return;

    // Build and send notification
    const shortMsg     = truncate(cleanMessage, cfg.message_length);
    const defaultTitle = isQuery
      ? `PM from ${senderNick} [${networkName}]`
      : `[${networkName}] ${target}`;

    const vars = {
      context:  target,
      nick:     senderNick,
      network:  networkName,
      datetime: new Date().toISOString().replace("T", " ").slice(0, 19),
      unixtime: String(now),
      title:    defaultTitle,
      message:  shortMsg,
    };

    const title = expand(cfg.message_title,   vars);
    const body  = expand(cfg.message_content, vars);

    if (cfg.debug) console.log(`[apprise-push] → "${title}" / "${body}"`);

    sendApprise(cfg, title, body);
    lastNotified.set(clientKey, now);
  };
}

// ── Network listener attachment ────────────────────────────────────────────────

function attach(client, network, handle, seen) {
  if (!network.irc) return;
  // Re-attach if irc-framework instance was replaced (reconnect)
  if (seen.get(network) === network.irc) return;
  seen.set(network, network.irc);

  // irc-framework emits a generic "message" event for PRIVMSG and CTCP ACTION.
  // event.type: "privmsg" | "action" | "notice"
  // event.from_server: true for server-generated messages (skip those)
  network.irc.on("message", (event) => {
    if (event.from_server)      return;
    if (event.type === "notice") return;

    const isQuery = !event.target.startsWith("#");
    handle({
      client,
      network,
      target:      isQuery ? event.nick : event.target,
      senderNick:  event.nick,
      // Prefix /me actions so they read naturally: "* nick waves"
      rawMessage:  event.type === "action"
        ? `* ${event.nick} ${event.message}`
        : event.message,
      isQuery,
    });
  });

  if (cfg_debug_ref.debug) {
    console.log(`[apprise-push] attached: ${network.name || network.host}`);
  }
}

// Module-level debug ref so the attach closure can read it without capturing cfg
// (cfg is not in scope at module level; this is set in onServerStart)
let cfg_debug_ref = { debug: false };

// ── Plugin entry point ─────────────────────────────────────────────────────────

module.exports.onServerStart = (server) => {
  const tlHome = process.env.THELOUNGE_HOME || path.join(process.env.HOME, ".thelounge");
  const cfgPath = path.join(tlHome, "apprise-push.json");

  if (!fs.existsSync(cfgPath)) {
    console.warn(`[apprise-push] no config at ${cfgPath} — plugin inactive`);
    return;
  }

  let userCfg;
  try {
    userCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch (e) {
    console.error(`[apprise-push] config parse error: ${e.message}`);
    return;
  }

  const cfg = { ...DEFAULTS, ...userCfg };
  // Normalise list fields so callers always get arrays
  for (const key of ["apprise_urls", "nick_blacklist", "network_blacklist", "highlight_words"]) {
    if (!Array.isArray(cfg[key])) cfg[key] = cfg[key] ? [cfg[key]] : [];
  }
  cfg_debug_ref = cfg;

  if (!cfg.apprise_api_url) {
    console.warn("[apprise-push] apprise_api_url not set — plugin inactive");
    return;
  }

  const lastNotified = new Map(); // clientKey → unix timestamp
  const seen         = new Map(); // network object → irc-framework instance
  const handle       = makeHandler(cfg, lastNotified);

  function scan() {
    const clients =
      server.clients instanceof Map  ? server.clients.values()  :
      Array.isArray(server.clients)  ? server.clients           :
      Object.values(server.clients || {});

    for (const client of clients) {
      for (const network of client.networks || []) {
        attach(client, network, handle, seen);
      }
    }
  }

  scan();
  // Poll every 5 s to pick up new networks or reconnected irc instances
  setInterval(scan, 5000).unref();

  console.log("[apprise-push] started");
};
