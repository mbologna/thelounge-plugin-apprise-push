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
        const err = new Error(`HTTP ${statusCode}`);
        err.statusCode = statusCode;
        reject(err);
      }
    });

    req.setTimeout(cfg.timeout, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A 4xx means Apprise was reached and refused the request: an unknown key
// (404), a bad token (401/403), a service that rejected the message (424).
// Retrying won't change that, so it is a configuration error. 408 and 429 are
// the exceptions: a timeout and a rate limit pass on their own.
function isConfigError(err) {
  const code = err && err.statusCode;
  return code >= 400 && code < 500 && code !== 408 && code !== 429;
}

// Where a target URL is reported: origin and path, never the query string or
// any user:password@ part.
const describe = (u) => u.origin + u.pathname;

// The same URL with its last path segment (the Apprise key) replaced:
// http://apprise:8000/notify/irc → http://apprise:8000/notify/system-alerts.
function withKey(parsedUrl, key) {
  const path = parsedUrl.pathname.replace(/\/+$/, "");
  const prefix = path.slice(0, path.lastIndexOf("/") + 1);
  return new URL(prefix + encodeURIComponent(key), parsedUrl.origin);
}

// At most one config-error alert per ALERT_INTERVAL_MS for the whole process,
// so a misconfigured key can't turn every IRC message into an alert.
const ALERT_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastAlertAt = null;

// Tells the alert key (cfg.alert_key) that a key answers 4xx, through the same
// instances (the failing URL's origin, then the fallback bases). One pass, no
// retries, and its own failures only log: an alert must never trigger another.
async function sendConfigErrorAlert(cfg, parsedUrl, failures) {
  const key = cfg.alert_key;
  if (!key) return;
  const alertUrl = withKey(parsedUrl, key);
  // The failing key is the alert key itself: nowhere left to report to.
  if (alertUrl.pathname === parsedUrl.pathname.replace(/\/+$/, "")) return;
  const now = Date.now();
  if (lastAlertAt !== null && now - lastAlertAt < ALERT_INTERVAL_MS) return;
  lastAlertAt = now;

  const lines = failures.map((f) => `- ${f.url}: HTTP ${f.statusCode}`);
  const payload = Buffer.from(
    JSON.stringify({
      title: "TheLounge apprise-push: Apprise rejected a notification",
      body:
        "Apprise answered with a client error, so IRC notifications sent to these " +
        "endpoints are not being delivered:\n" +
        lines.join("\n") +
        "\nCheck that the key exists in Apprise's configuration (404) and that the " +
        "token is valid (401/403). Further errors are only logged for the next 24 hours.",
      type: "warning",
    })
  );

  let error;
  for (const target of targetsFor(cfg, alertUrl)) {
    try {
      await sendOnce(cfg, payload, target);
      console.warn(`[apprise-push] sent a config-error alert to ${describe(target)}`);
      return;
    } catch (e) {
      error = e;
    }
  }
  console.error(
    `[apprise-push] could not send the config-error alert to key "${key}": ${error.message}`
  );
}

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

// Logs each target that answered 4xx as an error (even when a fallback then
// delivered: the key is still broken on that instance) and sends the
// rate-limited alert. Never rejects.
async function reportConfigErrors(cfg, parsedUrl, failures) {
  if (failures.size === 0) return;
  const list = [...failures].map(([url, statusCode]) => ({ url, statusCode }));
  for (const f of list) {
    console.error(
      `[apprise-push] Apprise answered HTTP ${f.statusCode} for ${f.url}: ` +
        "check that the key exists in Apprise and the token is valid"
    );
  }
  try {
    await sendConfigErrorAlert(cfg, parsedUrl, list);
  } catch (e) {
    console.error(`[apprise-push] config-error alert failed: ${e.message}`);
  }
}

// Sends a notification with retry + exponential backoff. Fire-and-forget: the
// returned promise never rejects (failures are logged), so callers don't need to
// handle it. Honors cfg.timeout, cfg.retries, and cfg.retry_delay.
// `overrideUrl` (a parsed URL) lets a rule route to a different Apprise endpoint
// than cfg.parsedUrl — headers/timeout/retries still come from cfg.
// Each attempt tries the URL, then the fallback bases (apprise_fallback_bases)
// on the same path; the backoff only runs when all of them failed, and not at
// all when every one answered with a config error (4xx, see isConfigError).
// Config errors are logged and reported to cfg.alert_key (reportConfigErrors).
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
  const configErrors = new Map(); // target URL → last 4xx status

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let error;
    let allConfigErrors = true;
    for (const target of targets) {
      try {
        const status = await sendOnce(cfg, payload, target);
        if (cfg.debug)
          console.log(`[apprise-push] Apprise ${target.origin} → HTTP ${status}`);
        await reportConfigErrors(cfg, parsedUrl, configErrors);
        return true;
      } catch (e) {
        error = e;
        if (isConfigError(e)) configErrors.set(describe(target), e.statusCode);
        else allConfigErrors = false;
        if (cfg.debug)
          console.log(`[apprise-push] Apprise ${target.origin} failed (${e.message})`);
      }
    }
    if (allConfigErrors) {
      await reportConfigErrors(cfg, parsedUrl, configErrors);
      return false;
    }
    if (attempt === attempts) {
      console.error(
        `[apprise-push] Apprise request failed after ${attempts} attempt(s): ${error.message}`
      );
      await reportConfigErrors(cfg, parsedUrl, configErrors);
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

// Tests only: forget when the last config-error alert went out.
function resetAlertState() {
  lastAlertAt = null;
}

module.exports = { sendApprise, resetAlertState, ALERT_INTERVAL_MS };
