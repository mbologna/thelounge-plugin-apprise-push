"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");

// ── Configuration defaults ─────────────────────────────────────────────────────
//
// Place overrides in $THELOUNGE_HOME/apprise-push.json
//
// Keyword expansion in message_title / message_content:
//   {context}   channel name or sender nick (for PMs)
//   {nick}      message sender
//   {network}   IRC network name
//   {datetime}  ISO 8601 timestamp (server local)
//   {unixtime}  unix timestamp
//   {title}     default computed title
//   {message}   message text (stripped + truncated)
//
// Conditions (all default to permissive / off):
//   away_only         — only notify when no TheLounge browser tabs are open
//   highlight         — space-sep highlight patterns (see README); own nick always included
//   last_notification — cooldown in seconds between notifications per context (0 = disabled)
//   nick_blacklist    — space-sep nicks to suppress (wildcards OK, e.g. "*bot")
//   network_blacklist — space-sep IRC network names to suppress
//   context           — space-sep channel/nick patterns to allow ("-" prefix negates)
//
// channel_conditions / query_conditions — boolean expression over condition names.
//   "all" expands to the canonical AND of all applicable conditions.
//   Custom example: "highlight and (last_notification or context)"
//   Atoms: any condition name, "true", "false"
//   Operators: "and" (higher precedence), "or"

const DEFAULTS = {
  // Required
  apprise_api_url: "",   // e.g. "http://apprise:8000"
  apprise_urls:    [],   // e.g. ["tgram://bottoken/chatid", "slack://..."]

  // Notification format
  message_title:   "{title}",
  message_content: "{context}: [{nick}] {message}",
  message_length:  100,  // 0 = unlimited

  // Conditions
  away_only:         false,
  highlight:         "",   // extra patterns beyond own nick; see matchHighlight()
  last_notification: 300,  // 0 = disabled
  nick_blacklist:    "",
  network_blacklist: "",
  context:           "*",  // default: match all

  // Condition logic
  channel_conditions: "all",
  query_conditions:   "all",

  debug: false,
};

// ── String / pattern helpers ───────────────────────────────────────────────────

function wildcardMatch(pattern, str) {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
    "i"
  );
  return re.test(str);
}

// znc-push style context list: space-sep, first match wins, "-" prefix negates.
// Default "*" matches everything.
function matchContextList(list, value) {
  const patterns = list.trim().split(/\s+/).filter(Boolean);
  if (!patterns.length) return true;
  for (const p of patterns) {
    const negated = p.startsWith("-");
    if (wildcardMatch(negated ? p.slice(1) : p, value)) return !negated;
  }
  return false;
}

// Simple blacklist: any pattern matching → blacklisted. No negation.
function isBlacklisted(list, value) {
  return list
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .some((p) => wildcardMatch(p, value));
}

// znc-push highlight matching.
// Own nick is always an implicit trigger at the end.
// Configured patterns: first match wins.
//   "-foo"  → negated: if message contains "foo", suppress highlight
//   "_foo"  → whole-word match (surrounded by whitespace or string boundary)
//   "*foo"  → treat as literal pattern starting with * (escape the znc prefix)
//   "foo"   → substring wildcard match
function matchHighlight(highlightCfg, myNick, message) {
  const patterns = highlightCfg.trim().split(/\s+/).filter(Boolean);

  for (const p of patterns) {
    let negated = false;
    let wholeWord = false;
    let pat = p;

    if (pat.startsWith("-")) {
      negated = true;
      pat = pat.slice(1);
    } else if (pat.startsWith("_")) {
      wholeWord = true;
      pat = pat.slice(1);
    } else if (pat.startsWith("*")) {
      // literal star prefix: treat rest as a wildcard pattern
      pat = pat.slice(1);
    }

    let matched;
    if (wholeWord) {
      const reBody = pat
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "\\S*");
      matched = new RegExp(`(?:^|\\s)${reBody}(?:\\s|$)`, "i").test(message);
    } else {
      matched = wildcardMatch(`*${pat}*`, message);
    }

    if (matched) return !negated;
  }

  // Implicit: own nick anywhere in the message
  return wildcardMatch(`*${myNick}*`, message);
}

function stripIrcFormatting(str) {
  return (
    str
      // color codes: \x03[fg][,bg]
      .replace(/\x03\d{0,2}(,\d{1,2})?/g, "")
      // all other control characters (bold, italic, underline, reverse, etc.)
      .replace(/[\x00-\x1F\x7F]/g, "")
  );
}

function truncate(str, maxLen) {
  if (!maxLen || str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

function expand(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
}

// ── Boolean condition evaluator ────────────────────────────────────────────────
//
// Grammar (and > or precedence, matches standard boolean logic):
//   expr    → and_expr ("or" and_expr)*
//   and_expr→ primary ("and" primary)*
//   primary → "(" expr ")" | "true" | "false" | <condition_name>

function evalExpression(expr, cond) {
  // Tokenize: parentheses and identifiers only
  const tokens = expr.match(/\(|\)|[a-z_]+/g) || [];
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseOr() {
    let v = parseAnd();
    while (peek() === "or") {
      next();
      v = v || parseAnd();
    }
    return v;
  }

  function parseAnd() {
    let v = parsePrimary();
    while (peek() === "and") {
      next();
      v = v && parsePrimary();
    }
    return v;
  }

  function parsePrimary() {
    const tok = next();
    if (tok === "(") {
      const v = parseOr();
      next(); // consume ")"
      return v;
    }
    if (tok === "true") return true;
    if (tok === "false") return false;
    return Boolean(cond[tok] ?? false);
  }

  try {
    return Boolean(parseOr());
  } catch {
    return false;
  }
}

// Evaluates channel_conditions or query_conditions.
// "all" expands to the canonical condition set for each message type:
//   channel: away_only AND highlight AND last_notification AND nick_blacklist
//            AND network_blacklist AND context
//   query:   away_only AND last_notification AND nick_blacklist AND network_blacklist
function checkConditions(expression, cond, isQuery) {
  if (expression === "all") {
    const keys = isQuery
      ? ["away_only", "last_notification", "nick_blacklist", "network_blacklist"]
      : ["away_only", "highlight", "last_notification", "nick_blacklist", "network_blacklist", "context"];
    return keys.every((k) => cond[k]);
  }
  return evalExpression(expression, cond);
}

// ── Apprise HTTP API ───────────────────────────────────────────────────────────

function sendApprise(cfg, title, body) {
  const endpoint = `${cfg.apprise_api_url.replace(/\/$/, "")}/notify`;
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
    port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: "POST",
    headers: {
      "Content-Type":   "application/json",
      "Content-Length": payload.length,
    },
  };

  const transport = parsed.protocol === "https:" ? https : http;
  const req = transport.request(options, (res) => {
    if (cfg.debug) console.log(`[apprise-push] Apprise responded ${res.statusCode}`);
  });
  req.on("error", (e) => console.error(`[apprise-push] Apprise request failed: ${e.message}`));
  req.end(payload);
}

// ── Core message handler ───────────────────────────────────────────────────────

function makeHandler(cfg, lastNotified) {
  return function handleMessage({ client, network, target, nick, message, isQuery }) {
    // Resolve current nick from irc-framework's user object
    const myNick = network.irc?.user?.nick || network.nick || "";
    if (!myNick) return;

    // Never self-notify
    if (nick.toLowerCase() === myNick.toLowerCase()) return;

    const networkName = network.name || network.host || "IRC";
    const cleanMsg = stripIrcFormatting(message);
    const now = Math.floor(Date.now() / 1000);
    const contextKey = `${client.name}:${networkName}:${target}`;
    const lastTime = lastNotified.get(contextKey) || 0;

    // Count attached browser sessions (supports object and Map)
    const attached = client.attachedClients;
    const attachedCount = attached instanceof Map
      ? attached.size
      : Object.keys(attached || {}).length;

    const cond = {
      // true = condition satisfied (notification may proceed)
      away_only:         !cfg.away_only || attachedCount === 0,
      highlight:         isQuery || matchHighlight(cfg.highlight, myNick, cleanMsg),
      last_notification: cfg.last_notification === 0 || now - lastTime >= cfg.last_notification,
      nick_blacklist:    !isBlacklisted(cfg.nick_blacklist, nick),
      network_blacklist: !isBlacklisted(cfg.network_blacklist, networkName),
      context:           matchContextList(cfg.context, target),
    };

    if (cfg.debug) {
      console.log(`[apprise-push] ${isQuery ? "PM" : "chan"} from ${nick} in ${target}`, cond);
    }

    const expression = isQuery ? cfg.query_conditions : cfg.channel_conditions;
    if (!checkConditions(expression, cond, isQuery)) return;

    // Build notification
    const shortMsg = truncate(cleanMsg, cfg.message_length);
    const defaultTitle = isQuery
      ? `PM from ${nick} [${networkName}]`
      : `[${networkName}] ${target}`;

    const vars = {
      context:  target,
      nick,
      network:  networkName,
      datetime: new Date().toISOString().replace("T", " ").slice(0, 19),
      unixtime: String(now),
      title:    defaultTitle,
      message:  shortMsg,
    };

    const title = expand(cfg.message_title, vars);
    const body  = expand(cfg.message_content, vars);

    if (cfg.debug) console.log(`[apprise-push] → "${title}" / "${body}"`);

    sendApprise(cfg, title, body);
    lastNotified.set(contextKey, now);
  };
}

// ── Network attachment ─────────────────────────────────────────────────────────

function attachNetwork(client, network, handleMessage, attachedNetworks, debug) {
  if (!network.irc) return;

  // Re-attach if the irc-framework instance was replaced (reconnect)
  if (attachedNetworks.get(network) === network.irc) return;
  attachedNetworks.set(network, network.irc);

  // TheLounge uses irc-framework which emits a generic "message" event.
  // event.type is "privmsg", "action", or "notice".
  // event.from_server is true for server-originated messages (skip those).
  network.irc.on("message", (event) => {
    if (event.from_server) return;
    if (event.type === "notice") return; // skip NOTICEs

    const isQuery = !event.target.startsWith("#");
    handleMessage({
      client,
      network,
      target:  isQuery ? event.nick : event.target,
      nick:    event.nick,
      // Prefix /me actions so they read naturally in the notification body
      message: event.type === "action"
        ? `* ${event.nick} ${event.message}`
        : event.message,
      isQuery,
    });
  });

  if (debug) {
    const name = network.name || network.host || "?";
    console.log(`[apprise-push] listening on network: ${name}`);
  }
}

// ── Plugin entry point ─────────────────────────────────────────────────────────

module.exports.onServerStart = (server) => {
  // Load config
  const tloungeHome =
    process.env.THELOUNGE_HOME || path.join(process.env.HOME, ".thelounge");
  const configPath = path.join(tloungeHome, "apprise-push.json");
  const cfg = { ...DEFAULTS };

  if (fs.existsSync(configPath)) {
    try {
      Object.assign(cfg, JSON.parse(fs.readFileSync(configPath, "utf8")));
    } catch (e) {
      console.error(`[apprise-push] config error: ${e.message}`);
    }
  } else {
    console.warn(`[apprise-push] no config found at ${configPath} — plugin inactive`);
    return;
  }

  if (!cfg.apprise_api_url) {
    console.warn("[apprise-push] apprise_api_url not set — plugin inactive");
    return;
  }

  const lastNotified = new Map();              // contextKey → unix timestamp
  const attachedNetworks = new Map();          // network object → irc instance
  const handleMessage = makeHandler(cfg, lastNotified);

  // Scan all current clients/networks and attach listeners.
  // Runs on startup and every 5s to catch new clients or reconnects.
  function scan() {
    const clients = server.clients instanceof Map
      ? server.clients.values()
      : Array.isArray(server.clients)
        ? server.clients
        : Object.values(server.clients || {});

    for (const client of clients) {
      for (const network of client.networks || []) {
        attachNetwork(client, network, handleMessage, attachedNetworks, cfg.debug);
      }
    }
  }

  scan();
  setInterval(scan, 5000).unref(); // .unref() so the interval doesn't keep Node alive alone

  if (cfg.debug) console.log("[apprise-push] started");
};
