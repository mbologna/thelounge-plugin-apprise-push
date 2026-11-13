"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");

// ── Apprise HTTP API ───────────────────────────────────────────────────────────

// Performs a single POST to the Apprise notify endpoint. Resolves on a 2xx
// response, rejects on transport error, timeout, or a non-2xx status (so the
// retry layer can decide whether to try again).
function sendOnce(cfg, payload, parsed) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": payload.length,
        ...cfg.headers,
      },
    };

    const transport = parsed.protocol === "https:" ? https : http;
    const req = transport.request(options, (res) => {
      // Drain the response so the socket can be reused/freed.
      res.resume();
      const { statusCode } = res;
      if (statusCode >= 200 && statusCode < 300) {
        resolve(statusCode);
      } else {
        reject(new Error(`HTTP ${statusCode}`));
      }
    });

    req.setTimeout(cfg.timeout, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The URL to send to, then the same path and query on each fallback base
// (cfg.fallbackBases), skipping duplicates.
function targetsFor(cfg, parsedUrl) {
  const targets = [parsedUrl];
  for (const base of cfg.fallbackBases || []) {
    const t = new URL(parsedUrl.pathname + parsedUrl.search, base.origin);
    if (!targets.some((u) => u.href === t.href)) targets.push(t);
  }
  return targets;
}

// Sends a notification with retry + exponential backoff. Fire-and-forget: the
// returned promise never rejects (failures are logged), so callers don't need to
// handle it. Honors cfg.timeout, cfg.retries, and cfg.retry_delay.
// `overrideUrl` (a parsed URL) lets a rule route to a different Apprise endpoint
// than cfg.parsedUrl — headers/timeout/retries still come from cfg.
// Each attempt tries the URL, then the fallback bases (apprise_fallback_bases)
// on the same path; the backoff only runs when all of them failed.
// Resolves `true` on success, `false` if every attempt failed, or `undefined`
// if nothing was attempted (no valid URL) — callers may use this for metrics.
async function sendApprise(cfg, title, body, priority = null, overrideUrl = null) {
  const parsedUrl = overrideUrl || cfg.parsedUrl;
  if (!parsedUrl) return undefined; // invalid URL already logged at compile time

  const notif = { title, body };
  if (priority != null) notif.priority = priority;
  const payload = Buffer.from(JSON.stringify(notif));
  const attempts = cfg.retries + 1;
  const targets = targetsFor(cfg, parsedUrl);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let error;
    for (const target of targets) {
      try {
        const status = await sendOnce(cfg, payload, target);
        if (cfg.debug) console.log(`[apprise-push] Apprise ${target.origin} → HTTP ${status}`);
        return true;
      } catch (e) {
        error = e;
        if (cfg.debug) console.log(`[apprise-push] Apprise ${target.origin} failed (${e.message})`);
      }
    }
    if (attempt === attempts) {
      console.error(
        `[apprise-push] Apprise request failed after ${attempts} attempt(s): ${error.message}`
      );
      return false;
    }
    const delay = cfg.retry_delay * 2 ** (attempt - 1);
    if (cfg.debug) {
      console.log(
        `[apprise-push] Apprise attempt ${attempt} failed (${error.message}); retrying in ${delay}ms`
      );
    }
    await sleep(delay);
  }
  return false;
}

module.exports = { sendApprise };
