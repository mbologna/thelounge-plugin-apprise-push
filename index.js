"use strict";

const fs    = require("fs");
const path  = require("path");
const http  = require("http");
const https = require("https");
const { URL } = require("url");

// ── Defaults ───────────────────────────────────────────────────────────────────

const DEFAULTS = {
  // Required — full Apprise API notify endpoint, e.g. "http://apprise:8000/notify/chatnotifications"
  apprise_url: "",

  // Notification text — supports {nick}, {channel}, {network}, {message}
  title_pm:   "PM from {nick} [{network}]",
  title_chan:  "[{network}] {channel}",
  body:        "{nick}: {message}",
  body_length: 100,  // 0 = no truncation

  // Global pre-filters (applied before any rule)
  away_only:         false,
  cooldown:          0,      // seconds between notifications per context (0 = disabled)
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

// ── Highlight detection ────────────────────────────────────────────────────────

function stripIrcFormatting(str) {
  return str
    .replace(/\x03\d{0,2}(,\d{1,2})?/g, "") // color codes
    .replace(/[\x00-\x1F\x7F]/g, "");         // all other control chars
}

// Returns true if the message is a highlight: own nick (case-insensitive substring)
// or a pre-compiled highlight-word pattern.
function isHighlight(cfg, myNick, message) {
  if (message.toLowerCase().includes(myNick.toLowerCase())) return true;
  return cfg.highlightRe.some((re) => re.test(message));
}

// ── Config loading & compilation ───────────────────────────────────────────────

const VALID_ACTIONS = new Set(["notify", "suppress"]);

// Merges user config with defaults, normalises fields, pre-compiles all glob
// patterns, validates rule actions, and pre-parses apprise_url — so none of
// that work happens per-message.
function compileConfig(raw) {
  const cfg = { ...DEFAULTS, ...raw };

  // Normalise list fields so callers always get arrays
  for (const key of ["nick_blacklist", "network_blacklist", "highlight_words"]) {
    if (!Array.isArray(cfg[key])) cfg[key] = cfg[key] ? [cfg[key]] : [];
  }

  // Pre-compile glob patterns → RegExp
  cfg.nickBlacklistRe    = cfg.nick_blacklist.map(makeGlobRe);
  cfg.networkBlacklistRe = cfg.network_blacklist.map(makeGlobRe);
  cfg.highlightRe        = cfg.highlight_words.map((w) => makeGlobRe(`*${w}*`));

  // Clone rule objects (avoid mutating DEFAULTS.rules), validate actions,
  // and pre-compile per-rule glob patterns.
  cfg.rules = (raw.rules || DEFAULTS.rules).map((r) => {
    const rule = { ...r };
    if (rule.action !== undefined && !VALID_ACTIONS.has(rule.action)) {
      console.warn(`[apprise-push] unknown rule action "${rule.action}" — treated as "notify"`);
    }
    if (rule.channel !== undefined) rule._channelRe = [].concat(rule.channel).map(makeGlobRe);
    if (rule.network !== undefined) rule._networkRe = [].concat(rule.network).map(makeGlobRe);
    if (rule.nick    !== undefined) rule._nickRe    = [].concat(rule.nick).map(makeGlobRe);
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
// Pre-compiled RegExp versions are stored in _channelRe / _networkRe / _nickRe.

function matchRule(rule, ctx) {
  const { isQuery, channel, senderNick, networkName, isHl } = ctx;

  // `channel` — only channel messages in matching channels
  if (rule._channelRe !== undefined) {
    if (isQuery || !matchesAny(rule._channelRe, channel)) return false;
  }

  // `pm` — only private messages
  if (rule.pm === true  && !isQuery) return false;
  if (rule.pm === false &&  isQuery) return false;

  // `highlight` — must be a highlight
  if (rule.highlight === true && !isHl) return false;

  // `network`
  if (rule._networkRe !== undefined && !matchesAny(rule._networkRe, networkName)) return false;

  // `nick` — sender nick
  if (rule._nickRe !== undefined && !matchesAny(rule._nickRe, senderNick)) return false;

  return true;
}

// Runs global pre-filters then evaluates the rule list.
// Returns "notify" | "suppress" | "skip".
function evaluate(cfg, ctx, lastNotified) {
  const { senderNick, networkName, clientKey, now, attachedCount } = ctx;

  // Global pre-filters
  if (cfg.away_only && attachedCount > 0) return "skip";
  if (matchesAny(cfg.nickBlacklistRe,    senderNick))  return "skip";
  if (matchesAny(cfg.networkBlacklistRe, networkName)) return "skip";

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
  const parsed = cfg.parsedUrl;
  if (!parsed) return; // invalid URL already logged at compile time

  const payload = Buffer.from(JSON.stringify({ title, body }));

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
  // Destroy the socket after 10 s to avoid connections piling up when Apprise is slow/down
  req.setTimeout(10_000, () => req.destroy(new Error("request timeout")));
  req.on("error", (e) =>
    console.error(`[apprise-push] Apprise request failed: ${e.message}`)
  );
  req.end(payload);
}

// ── Message handler factory ────────────────────────────────────────────────────

// Accepts a `getCfg` getter so hot-reloaded config is always picked up without
// re-registering the irc-framework event listener.
function makeHandler(getCfg, lastNotified) {
  return function handle({ client, network, target, senderNick, rawMessage, isQuery }) {
    const cfg = getCfg();

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
      channel:     target,
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

    const vars = {
      channel: target,
      nick:    senderNick,
      network: networkName,
      message: truncate(cleanMessage, cfg.body_length),
    };

    const title = expand(isQuery ? cfg.title_pm : cfg.title_chan, vars);
    const body  = expand(cfg.body, vars);

    if (cfg.debug) console.log(`[apprise-push] → "${title}" / "${body}"`);

    sendApprise(cfg, title, body);
    // Only track timestamps when cooldown is active — avoids unbounded Map growth
    // when cooldown=0 (entries would be written but never read)
    if (cfg.cooldown > 0) lastNotified.set(clientKey, now);
  };
}

// ── Network hook via monkey-patch ──────────────────────────────────────────────

// TheLounge's plugin API (onServerStart) does not expose server.clients.
// Instead we patch Network.prototype.createIrcFramework, which is called once
// per network connection (and again on manual reconnect), giving us `this.irc`
// right after it is created — before any messages can arrive.
// Timing is correct: loadPackages() (which calls onServerStart) runs before
// manager.init() which triggers client.connect() → network.createIrcFramework().

const PATCHED = Symbol("apprisePushPatched");

function setupNetworkHook(handle, getCfg) {
  const networkModPath = Object.keys(require.cache).find(
    (k) => k.includes("thelounge") && k.endsWith("/models/network.js")
  );

  if (!networkModPath) {
    console.error("[apprise-push] network.js not found in module cache — plugin inactive");
    return false;
  }

  const Network = require(networkModPath).default;
  if (!Network?.prototype?.createIrcFramework) {
    console.error("[apprise-push] Network.prototype.createIrcFramework not found — plugin inactive");
    return false;
  }

  // Guard against double-patching — would otherwise add duplicate "message" listeners
  // if the plugin entry point is ever called more than once in the same process.
  if (Network.prototype[PATCHED]) return true;
  Network.prototype[PATCHED] = true;

  const orig = Network.prototype.createIrcFramework;
  Network.prototype.createIrcFramework = function (client) {
    orig.call(this, client);

    const network = this;

    // irc-framework emits a generic "message" event for PRIVMSG and CTCP ACTION.
    // event.type: "privmsg" | "action" | "notice"
    // event.from_server: true for server-generated messages (skip those)
    network.irc.on("message", (event) => {
      if (event.from_server)       return;
      if (event.type === "notice") return;

      const isQuery = !event.target.startsWith("#");
      handle({
        client,
        network,
        target:     isQuery ? event.nick : event.target,
        senderNick: event.nick,
        // Prefix /me actions so they read naturally: "* nick waves"
        rawMessage: event.type === "action"
          ? `* ${event.nick} ${event.message}`
          : event.message,
        isQuery,
      });
    });

    if (getCfg().debug) {
      console.log(`[apprise-push] attached: ${network.name || network.host}`);
    }
  };

  return true;
}

// ── Plugin entry point ─────────────────────────────────────────────────────────

module.exports.onServerStart = (server) => {
  const tlHome = process.env.THELOUNGE_HOME || path.join(process.env.HOME, ".thelounge");
  const cfgPath = path.join(tlHome, "apprise-push.json");

  if (!fs.existsSync(cfgPath)) {
    console.warn(`[apprise-push] no config at ${cfgPath} — plugin inactive`);
    return;
  }

  let rawCfg;
  try {
    rawCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch (e) {
    console.error(`[apprise-push] config parse error: ${e.message}`);
    return;
  }

  let cfg = compileConfig(rawCfg);

  if (!cfg.apprise_url) {
    console.warn("[apprise-push] apprise_url not set — plugin inactive");
    return;
  }

  const lastNotified = new Map();
  const getCfg = () => cfg;
  const handle = makeHandler(getCfg, lastNotified);

  if (!setupNetworkHook(handle, getCfg)) return;

  // Hot-reload: recompile config whenever the file changes — no TheLounge restart needed.
  // Debounced (200 ms) because editors often write files in multiple flush events.
  let reloadTimer = null;
  fs.watch(cfgPath, { persistent: false }, () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      try {
        const newRaw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        cfg = compileConfig(newRaw);
        console.log(
          cfg.apprise_url
            ? "[apprise-push] config reloaded"
            : "[apprise-push] config reloaded — apprise_url unset, notifications disabled"
        );
      } catch (e) {
        console.error(`[apprise-push] config reload failed: ${e.message} — keeping previous config`);
      }
    }, 200);
  });

  console.log("[apprise-push] started");
};
