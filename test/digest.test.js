"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { makeHandler } = require("../index");
const { compileConfig } = require("../lib/config");

// Minimal in-process HTTP server that always responds 200. Returns received bodies.
function withServer() {
  return new Promise((resolve) => {
    const received = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.writeHead(200);
        res.end("ok");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const closeAll = () => {
        server.closeAllConnections();
        server.close();
      };
      resolve({ closeAll, received, port });
    });
  });
}

function makeClient(name = "testclient") {
  return { name, attachedClients: new Map() };
}

function makeNetwork(nick = "mynick", name = "Libera") {
  return { irc: { user: { nick } }, nick, name };
}

function makeEvent(overrides = {}) {
  return {
    client: makeClient(),
    network: makeNetwork(),
    target: "#dev",
    senderNick: "alice",
    rawMessage: "hello",
    isQuery: false,
    messageType: "privmsg",
    ...overrides,
  };
}

test("digest_window:0 sends immediately (no batching)", async () => {
  const { closeAll, received, port } = await withServer();
  const url = `http://127.0.0.1:${port}/notify/key`;
  const cfg = compileConfig({ apprise_url: url, rules: [{}] }, () => {});
  const handler = makeHandler(() => cfg, new Map());

  handler(makeEvent());
  await new Promise((r) => setTimeout(r, 50));
  closeAll();

  assert.equal(received.length, 1);
});

test("digest_window batches multiple messages for the same context into one notification", async () => {
  const { closeAll, received, port } = await withServer();
  const url = `http://127.0.0.1:${port}/notify/key`;
  const cfg = compileConfig(
    { apprise_url: url, digest_window: 0.05, rules: [{}] },
    () => {}
  );
  const handler = makeHandler(() => cfg, new Map());

  handler(makeEvent({ senderNick: "alice", rawMessage: "first" }));
  handler(makeEvent({ senderNick: "bob", rawMessage: "second" }));

  // Nothing should have been sent yet — still within the digest window.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(received.length, 0, "no notification before the window elapses");

  await new Promise((r) => setTimeout(r, 100));
  closeAll();

  assert.equal(received.length, 1, "exactly one batched notification");
  assert.ok(received[0].body.includes("alice"));
  assert.ok(received[0].body.includes("bob"));
});

test("digest batches are independent per context (clientKey)", async () => {
  const { closeAll, received, port } = await withServer();
  const url = `http://127.0.0.1:${port}/notify/key`;
  const cfg = compileConfig(
    { apprise_url: url, digest_window: 0.05, rules: [{}] },
    () => {}
  );
  const handler = makeHandler(() => cfg, new Map());

  handler(makeEvent({ target: "#one", senderNick: "alice" }));
  handler(makeEvent({ target: "#two", senderNick: "bob" }));

  await new Promise((r) => setTimeout(r, 100));
  closeAll();

  assert.equal(received.length, 2, "each context flushes its own batch");
});

test("a digest batch counts once against max_per_minute, not once per message", async () => {
  const { closeAll, received, port } = await withServer();
  const url = `http://127.0.0.1:${port}/notify/key`;
  const cfg = compileConfig(
    { apprise_url: url, digest_window: 0.05, max_per_minute: 1, rules: [{}] },
    () => {}
  );
  const notifyLog = [];
  const handler = makeHandler(() => cfg, new Map(), notifyLog);

  // Five messages for the same context, all within the digest window — should
  // coalesce into one batch and count as exactly one notification.
  for (let i = 0; i < 5; i++) {
    handler(makeEvent({ senderNick: `user${i}`, rawMessage: `msg${i}` }));
  }

  await new Promise((r) => setTimeout(r, 100));
  closeAll();

  assert.equal(received.length, 1, "all five messages coalesced into one batch");
  assert.equal(
    notifyLog.length,
    1,
    "rate limit log reflects one sent notification, not five"
  );
});

test("per-rule digest_window:0 bypasses digest even when the global default is set", async () => {
  const { closeAll, received, port } = await withServer();
  const url = `http://127.0.0.1:${port}/notify/key`;
  const cfg = compileConfig(
    { apprise_url: url, digest_window: 30, rules: [{ pm: true, digest_window: 0 }, {}] },
    () => {}
  );
  const handler = makeHandler(() => cfg, new Map());

  handler(makeEvent({ isQuery: true, target: "alice" }));

  await new Promise((r) => setTimeout(r, 50));
  closeAll();

  assert.equal(received.length, 1, "PM rule's digest_window:0 sends immediately");
});
