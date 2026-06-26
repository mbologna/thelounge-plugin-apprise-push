"use strict";

const fs = require("fs");
const path = require("path");

const { compileConfig } = require("./lib/config");
const { stripIrcFormatting, isHighlight } = require("./lib/highlight");
const { evaluate } = require("./lib/rules");
const { expand, truncate } = require("./lib/template");
const { sendApprise } = require("./lib/apprise");

// ── Message handler factory ────────────────────────────────────────────────────

// Accepts a `getCfg` getter so hot-reloaded config is always picked up without
// re-registering the irc-framework event listener.
function makeHandler(getCfg, lastNotified) {
  return function handle({ client, network, target, senderNick, rawMessage, isQuery, messageType }) {
    const cfg = getCfg();

    const myNick = network.irc?.user?.nick || network.nick || "";
    if (!myNick) return;
    if (senderNick.toLowerCase() === myNick.toLowerCase()) return;

    const networkName = network.name || network.host || "IRC";
    const cleanMessage = stripIrcFormatting(rawMessage);
    const now = Math.floor(Date.now() / 1000);
    // Key for cooldown: scoped to client+network+context so channels/PMs track independently
    const clientKey = `${client.name}:${networkName}:${target}`;

    const attached = client.attachedClients;
    const attachedCount =
      attached instanceof Map ? attached.size : Object.keys(attached || {}).length;

    const ctx = {
      isQuery,
      channel: target,
      senderNick,
      networkName,
      cleanMessage,
      messageType,
      isHl: isHighlight(cfg, myNick, cleanMessage),
      now,
      clientKey,
      attachedCount,
    };

    const { decision, reason, rule } = evaluate(cfg, ctx, lastNotified);
    if (cfg.debug) {
      const label = decision === "notify" ? decision : `${decision} (${reason})`;
      console.log(
        `[apprise-push] ${isQuery ? "PM" : "chan"} "${target}" from "${senderNick}"` +
          ` hl=${ctx.isHl} → ${label}`
      );
    }
    // Record cooldown timestamp for both notify and suppress decisions so that a
    // suppress rule with cooldown actually throttles (otherwise last stays 0 forever
    // and the cooldown check never fires for suppress rules).
    // Skip decisions have rule=null (pre-filter exits) — nothing to track.
    if (rule !== null) {
      const effectiveCooldown = rule.cooldown ?? cfg.cooldown;
      if (effectiveCooldown > 0) lastNotified.set(clientKey, now);
    }

    if (decision !== "notify") return;

    const vars = {
      channel: target,
      nick: senderNick,
      network: networkName,
      mynick: myNick,
      time: cfg.timezone
        ? new Date().toLocaleTimeString(undefined, { timeZone: cfg.timezone })
        : new Date().toLocaleTimeString(),
      message: truncate(cleanMessage, cfg.body_length),
    };

    // Per-rule template overrides fall back to the global templates.
    const titleTpl = rule.title ?? (isQuery ? cfg.title_pm : cfg.title_chan);
    const bodyTpl = rule.body ?? cfg.body;

    const title = expand(titleTpl, vars);
    const body = expand(bodyTpl, vars);

    if (cfg.debug) console.log(`[apprise-push] → "${title}" / "${body}"`);

    const priority = rule.priority ?? cfg.priority ?? null;
    sendApprise(cfg, title, body, priority);
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
    console.error(
      "[apprise-push] network.js not found in module cache — plugin inactive"
    );
    return false;
  }

  const Network = require(networkModPath).default;
  if (!Network?.prototype?.createIrcFramework) {
    console.error(
      "[apprise-push] Network.prototype.createIrcFramework not found — plugin inactive"
    );
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
      if (event.from_server) return;
      if (event.type === "notice") return;

      const isQuery = !event.target.startsWith("#");
      handle({
        client,
        network,
        target: isQuery ? event.nick : event.target,
        senderNick: event.nick,
        // Prefix /me actions so they read naturally: "* nick waves"
        rawMessage:
          event.type === "action" ? `* ${event.nick} ${event.message}` : event.message,
        isQuery,
        messageType: event.type, // "privmsg" or "action"
      });
    });

    if (getCfg().debug) {
      console.log(`[apprise-push] attached: ${network.name || network.host}`);
    }
  };

  return true;
}

// ── Plugin entry point ─────────────────────────────────────────────────────────

module.exports.onServerStart = () => {
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
        console.error(
          `[apprise-push] config reload failed: ${e.message} — keeping previous config`
        );
      }
    }, 200);
  });

  console.log("[apprise-push] started");
};

// Exported for tests / programmatic use.
module.exports.makeHandler = makeHandler;
module.exports.setupNetworkHook = setupNetworkHook;
