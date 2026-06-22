"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { sendApprise } = require("../lib/apprise");
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
