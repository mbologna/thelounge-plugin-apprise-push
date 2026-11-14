"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { URL } = require("node:url");

const { sendApprise, resetAlertState, ALERT_INTERVAL_MS } = require("../lib/apprise");
const { compileConfig } = require("../lib/config");

// Spins up a throwaway HTTP server. `handler(req, res, body)` decides the response.
function withServer(handler) {
  return new Promise((resolve) => {
    const received = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body, method: req.method, url: req.url });
        handler(req, res, body, received.length);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, received, url: `http://127.0.0.1:${port}/notify/key` });
    });
  });
}

const cfgFor = (url, extra = {}) =>
  compileConfig({ apprise_url: url, ...extra }, () => {});

test("sendApprise POSTs JSON title/body to the endpoint", async () => {
  const { server, received, url } = await withServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });

  await sendApprise(cfgFor(url), "My Title", "My Body");
  server.close();

  assert.equal(received.length, 1);
  assert.equal(received[0].method, "POST");
  assert.equal(received[0].url, "/notify/key");
  assert.equal(received[0].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(received[0].body), { title: "My Title", body: "My Body" });
});

test("sendApprise sends auth headers", async () => {
  const { server, received, url } = await withServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });

  await sendApprise(
    cfgFor(url, { apprise_token: "secret", apprise_headers: { "X-Tag": "irc" } }),
    "t",
    "b"
  );
  server.close();

  assert.equal(received[0].headers["authorization"], "Bearer secret");
  assert.equal(received[0].headers["x-tag"], "irc");
});

test("sendApprise retries on 5xx then succeeds", async () => {
  const { server, received, url } = await withServer((_req, res, _body, n) => {
    if (n === 1) {
      res.writeHead(503);
      res.end("busy");
    } else {
      res.writeHead(200);
      res.end("ok");
    }
  });

  await sendApprise(cfgFor(url, { retries: 2, retry_delay: 1 }), "t", "b");
  server.close();

  assert.equal(received.length, 2); // first failed, second succeeded
});

test("sendApprise gives up after exhausting retries without throwing", async () => {
  const { server, received, url } = await withServer((_req, res) => {
    res.writeHead(500);
    res.end("err");
  });

  await sendApprise(cfgFor(url, { retries: 1, retry_delay: 1 }), "t", "b");
  server.close();

  assert.equal(received.length, 2); // initial attempt + 1 retry
});

test("sendApprise is a no-op when apprise_url is invalid", async () => {
  const cfg = compileConfig({ apprise_url: "not a url" }, () => {});
  await sendApprise(cfg, "t", "b"); // must resolve without throwing
  assert.equal(cfg.parsedUrl, null);
});

test("sendApprise includes priority in payload when set", async () => {
  const { server, received, url } = await withServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });

  await sendApprise(cfgFor(url), "Title", "Body", "high");
  server.close();

  const parsed = JSON.parse(received[0].body);
  assert.equal(parsed.priority, "high");
});

test("sendApprise sends User-Agent header", async () => {
  const { server, received, url } = await withServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });

  await sendApprise(cfgFor(url), "t", "b");
  server.close();

  assert.ok(
    received[0].headers["user-agent"].startsWith("thelounge-plugin-apprise-push/"),
    "User-Agent should start with package name"
  );
});

test("sendApprise uses overrideUrl when provided instead of cfg.parsedUrl", async () => {
  const {
    server: mainServer,
    received: mainReceived,
    url: mainUrl,
  } = await withServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  const {
    server: altServer,
    received: altReceived,
    url: altUrl,
  } = await withServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });

  const cfg = cfgFor(mainUrl);
  const overrideUrl = new URL(altUrl);
  await sendApprise(cfg, "t", "b", null, overrideUrl);

  mainServer.close();
  altServer.close();

  assert.equal(mainReceived.length, 0, "main endpoint should not receive the request");
  assert.equal(altReceived.length, 1, "override endpoint should receive the request");
});

test("sendApprise falls back to cfg.parsedUrl when overrideUrl is not provided", async () => {
  const { server, received, url } = await withServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });

  await sendApprise(cfgFor(url), "t", "b", null, null);
  server.close();

  assert.equal(received.length, 1);
});

test("sendApprise omits priority from payload when null", async () => {
  const { server, received, url } = await withServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });

  await sendApprise(cfgFor(url), "Title", "Body", null);
  server.close();

  const parsed = JSON.parse(received[0].body);
  assert.equal(Object.hasOwn(parsed, "priority"), false);
});

test("sendApprise falls back to apprise_fallback_bases on the same path", async () => {
  const down = await withServer((_req, res) => {
    res.writeHead(503);
    res.end();
  });
  const up = await withServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  const fallback = new URL(up.url).origin;

  const ok = await sendApprise(
    cfgFor(down.url, { apprise_fallback_bases: [fallback], retries: 0 }),
    "t",
    "b"
  );
  down.server.close();
  up.server.close();

  assert.equal(ok, true);
  assert.equal(down.received.length, 1);
  assert.equal(up.received.length, 1);
  assert.equal(up.received[0].url, "/notify/key");
});

test("sendApprise tries every target in each attempt before backing off", async () => {
  const a = await withServer((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  const b = await withServer((_req, res, _body, n) => {
    res.writeHead(n === 2 ? 200 : 500);
    res.end();
  });

  const ok = await sendApprise(
    cfgFor(a.url, {
      apprise_fallback_bases: [new URL(b.url).origin],
      retries: 1,
      retry_delay: 1,
    }),
    "t",
    "b"
  );
  a.server.close();
  b.server.close();

  assert.equal(ok, true);
  assert.equal(a.received.length, 2);
  assert.equal(b.received.length, 2);
});

test("a fallback base equal to the URL's origin is not tried twice", async () => {
  const { server, received, url } = await withServer((_req, res) => {
    res.writeHead(500);
    res.end();
  });

  const ok = await sendApprise(
    cfgFor(url, { apprise_fallback_bases: [new URL(url).origin], retries: 0 }),
    "t",
    "b"
  );
  server.close();

  assert.equal(ok, false);
  assert.equal(received.length, 1);
});

// ── Config errors (4xx) ───────────────────────────────────────────────────────

// A server that answers `status(url)` per request path, recording every request.
const routed = (status) =>
  withServer((req, res) => {
    res.writeHead(status(req.url));
    res.end();
  });

const alertsIn = (received) =>
  received
    .filter((r) => r.url !== "/notify/key")
    .map((r) => ({ url: r.url, ...JSON.parse(r.body) }));

const quietConsole = (t) => ({
  error: t.mock.method(console, "error", () => {}),
  warn: t.mock.method(console, "warn", () => {}),
});

test("a 404 is not retried, is logged as an error and alerts system-alerts", async (t) => {
  resetAlertState();
  const log = quietConsole(t);
  const { server, received, url } = await routed((u) =>
    u === "/notify/key" ? 404 : 200
  );

  const ok = await sendApprise(cfgFor(url, { retries: 2, retry_delay: 1 }), "t", "b");
  server.close();

  assert.equal(ok, false);
  assert.equal(
    received.filter((r) => r.url === "/notify/key").length,
    1,
    "no retry on 404"
  );
  const alerts = alertsIn(received);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].url, "/notify/system-alerts");
  assert.equal(alerts[0].type, "warning");
  assert.match(alerts[0].body, /\/notify\/key: HTTP 404/);
  assert.ok(
    log.error.mock.calls.some((c) =>
      /HTTP 404 for http:\/\/127\.0\.0\.1:\d+\/notify\/key/.test(c.arguments[0])
    ),
    "the 404 is logged with console.error"
  );
});

test("the config-error alert goes out at most once per 24 hours", async (t) => {
  resetAlertState();
  const log = quietConsole(t);
  const { server, received, url } = await routed((u) =>
    u === "/notify/key" ? 404 : 200
  );
  const cfg = cfgFor(url, { retries: 0 });

  await sendApprise(cfg, "t", "b");
  await sendApprise(cfg, "t", "b");
  assert.equal(alertsIn(received).length, 1, "second 404 within 24 h: no alert");
  assert.equal(log.error.mock.calls.length, 2, "but every 404 is logged");

  const realNow = Date.now;
  t.after(() => (Date.now = realNow));
  Date.now = () => realNow() + ALERT_INTERVAL_MS + 1000;
  await sendApprise(cfg, "t", "b");
  server.close();

  assert.equal(alertsIn(received).length, 2, "after 24 h the alert goes out again");
});

test("a 404 on the URL still alerts when a fallback base delivers", async (t) => {
  resetAlertState();
  const log = quietConsole(t);
  const broken = await routed((u) => (u === "/notify/key" ? 404 : 200));
  const good = await routed(() => 200);

  const ok = await sendApprise(
    cfgFor(broken.url, { apprise_fallback_bases: [new URL(good.url).origin] }),
    "t",
    "b"
  );
  broken.server.close();
  good.server.close();

  assert.equal(ok, true);
  assert.equal(good.received.length, 1);
  assert.deepEqual(
    alertsIn(broken.received).map((a) => a.url),
    ["/notify/system-alerts"]
  );
  assert.equal(log.error.mock.calls.length, 1);
});

test("the alert fails over to the fallback bases", async (t) => {
  resetAlertState();
  quietConsole(t);
  const a = await routed(() => 404); // knows neither key
  const b = await routed(() => 200);

  const ok = await sendApprise(
    cfgFor(a.url, { apprise_fallback_bases: [new URL(b.url).origin] }),
    "t",
    "b"
  );
  a.server.close();
  b.server.close();

  assert.equal(ok, true, "b delivered the notification");
  assert.deepEqual(
    a.received.map((r) => r.url),
    ["/notify/key", "/notify/system-alerts"]
  );
  assert.deepEqual(
    b.received.map((r) => r.url),
    ["/notify/key", "/notify/system-alerts"]
  );
});

test("alert_key sets the alert's key and keeps the URL's path prefix", async (t) => {
  resetAlertState();
  quietConsole(t);
  const { server, received, url } = await routed((u) =>
    u.startsWith("/apprise/notify/key") ? 404 : 200
  );
  const base = new URL(url).origin;

  await sendApprise(
    cfgFor(`${base}/apprise/notify/key?x=1`, { alert_key: "ops", retries: 0 }),
    "t",
    "b"
  );
  server.close();

  assert.deepEqual(
    received.map((r) => r.url),
    ["/apprise/notify/key?x=1", "/apprise/notify/ops"]
  );
  const body = JSON.parse(received[1].body).body;
  assert.ok(!body.includes("x=1"), "the query string stays out of the alert");
});

test('alert_key "" turns the alert off but still logs the error', async (t) => {
  resetAlertState();
  const log = quietConsole(t);
  const { server, received, url } = await routed(() => 404);

  const ok = await sendApprise(cfgFor(url, { alert_key: "", retries: 0 }), "t", "b");
  server.close();

  assert.equal(ok, false);
  assert.equal(received.length, 1);
  assert.equal(log.error.mock.calls.length, 1);
});

test("a failing alert key gets no alert about itself", async (t) => {
  resetAlertState();
  quietConsole(t);
  const { server, received, url } = await routed(() => 404);
  const base = new URL(url).origin;

  await sendApprise(cfgFor(`${base}/notify/system-alerts/`, { retries: 0 }), "t", "b");
  server.close();

  assert.equal(received.length, 1);
});

test("a rejected alert is logged and not retried or re-alerted", async (t) => {
  resetAlertState();
  const log = quietConsole(t);
  const { server, received, url } = await routed(() => 404);

  const ok = await sendApprise(cfgFor(url, { retries: 2, retry_delay: 1 }), "t", "b");
  server.close();

  assert.equal(ok, false);
  assert.deepEqual(
    received.map((r) => r.url),
    ["/notify/key", "/notify/system-alerts"]
  );
  assert.ok(
    log.error.mock.calls.some((c) =>
      c.arguments[0].includes(
        'could not send the config-error alert to key "system-alerts"'
      )
    )
  );
});

test("5xx keeps retrying and sends no alert", async (t) => {
  resetAlertState();
  const log = quietConsole(t);
  const { server, received, url } = await routed(() => 502);

  const ok = await sendApprise(cfgFor(url, { retries: 2, retry_delay: 1 }), "t", "b");
  server.close();

  assert.equal(ok, false);
  assert.equal(received.length, 3);
  assert.equal(alertsIn(received).length, 0);
  assert.equal(log.error.mock.calls.length, 1);
  assert.match(
    log.error.mock.calls[0].arguments[0],
    /failed after 3 attempt\(s\): HTTP 502/
  );
});

test("408 and 429 are retried like transient failures, without an alert", async (t) => {
  for (const code of [408, 429]) {
    resetAlertState();
    quietConsole(t);
    const { server, received, url } = await withServer((_req, res, _body, n) => {
      res.writeHead(n === 1 ? code : 200);
      res.end();
    });

    const ok = await sendApprise(cfgFor(url, { retries: 1, retry_delay: 1 }), "t", "b");
    server.close();

    assert.equal(ok, true, `HTTP ${code} then 200`);
    assert.equal(received.length, 2);
    assert.equal(alertsIn(received).length, 0);
  }
});

test("a 404 on one instance and a 5xx on the other still retries, then alerts", async (t) => {
  resetAlertState();
  quietConsole(t);
  const a = await routed((u) => (u === "/notify/key" ? 404 : 200));
  const b = await routed(() => 503);

  const ok = await sendApprise(
    cfgFor(a.url, {
      apprise_fallback_bases: [new URL(b.url).origin],
      retries: 1,
      retry_delay: 1,
    }),
    "t",
    "b"
  );
  a.server.close();
  b.server.close();

  assert.equal(ok, false);
  assert.equal(a.received.filter((r) => r.url === "/notify/key").length, 2, "retried");
  assert.equal(alertsIn(a.received).length, 1);
});
