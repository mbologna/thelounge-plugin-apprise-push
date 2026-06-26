"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { makeHandler } = require("../index");
const { compileConfig } = require("../lib/config");

// ── Helpers ────────────────────────────────────────────────────────────────────

// Minimal in-process HTTP server that always responds 200. Returns the list of
// received request bodies so tests can assert on what was POSTed.
// closeAll() tears down keep-alive sockets immediately so the test runner exits cleanly.
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

// Minimal mock objects that satisfy the handler's expectations.
function makeClient(name = "testclient", attachedCount = 0) {
  const attachedClients = new Map();
  for (let i = 0; i < attachedCount; i++) attachedClients.set(String(i), {});
  return { name, attachedClients };
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
    rawMessage: "hey mynick look at this",
    isQuery: false,
    messageType: "privmsg",
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test("makeHandler sends a notification when a rule matches", async () => {
  const { closeAll, received, port } = await withServer();
  const url = `http://127.0.0.1:${port}/notify/key`;

  const cfg = compileConfig(
    { apprise_url: url, rules: [{ highlight: true }, { pm: true }] },
    () => {}
  );
  const handler = makeHandler(() => cfg, new Map());

  // Message contains own nick → isHighlight → rule[0] matches
  handler(makeEvent({ rawMessage: "hey mynick look at this" }));

  // sendApprise is async fire-and-forget — wait for the HTTP request to complete
  await new Promise((r) => setTimeout(r, 50));
  closeAll();

  assert.equal(received.length, 1);
  assert.ok(received[0].title);
  assert.ok(received[0].body.includes("alice"));
});

test("makeHandler expands template variables in title and body", async () => {
  const { closeAll, received, port } = await withServer();
  const url = `http://127.0.0.1:${port}/notify/key`;

  const cfg = compileConfig(
    {
      apprise_url: url,
      title_chan: "[{network}] {channel}",
      body: "{nick}: {message}",
      rules: [{}],
    },
    () => {}
  );
  const handler = makeHandler(() => cfg, new Map());

  handler(makeEvent({ rawMessage: "hello world", senderNick: "bob" }));

  await new Promise((r) => setTimeout(r, 50));
  closeAll();

  assert.equal(received.length, 1);
  assert.equal(received[0].title, "[Libera] #dev");
  assert.equal(received[0].body, "bob: hello world");
});

test("makeHandler skips messages from own nick", async () => {
  const { closeAll, received, port } = await withServer();
  const url = `http://127.0.0.1:${port}/notify/key`;

  const cfg = compileConfig({ apprise_url: url, rules: [{}] }, () => {});
  const handler = makeHandler(() => cfg, new Map());

  // senderNick matches own nick — should be silently dropped
  handler(makeEvent({ senderNick: "mynick" }));

  await new Promise((r) => setTimeout(r, 50));
  closeAll();

  assert.equal(received.length, 0);
});

test("makeHandler respects away_only when browser is attached", async () => {
  const { closeAll, received, port } = await withServer();
  const url = `http://127.0.0.1:${port}/notify/key`;

  const cfg = compileConfig({ apprise_url: url, away_only: true, rules: [{}] }, () => {});
  const handler = makeHandler(() => cfg, new Map());

  handler(makeEvent({ client: makeClient("c", 1) }));

  await new Promise((r) => setTimeout(r, 50));
  closeAll();

  assert.equal(received.length, 0);
});

test("makeHandler enforces cooldown between notifications for the same context", async () => {
  const { closeAll, received, port } = await withServer();
  const url = `http://127.0.0.1:${port}/notify/key`;

  const cfg = compileConfig({ apprise_url: url, cooldown: 60, rules: [{}] }, () => {});
  const lastNotified = new Map();
  const handler = makeHandler(() => cfg, lastNotified);

  const event = makeEvent();

  // First message: should notify and record timestamp
  handler(event);
  await new Promise((r) => setTimeout(r, 50));

  const key = "testclient:Libera:#dev";
  assert.ok(lastNotified.has(key), "timestamp should be recorded after first notify");

  // Second message within cooldown window: no notification
  handler(event);
  await new Promise((r) => setTimeout(r, 50));

  closeAll();
  assert.equal(received.length, 1, "only one notification within the cooldown window");
});

test("makeHandler records timestamp for suppress decisions so their cooldown works", async () => {
  const { closeAll, received, port } = await withServer();
  const url = `http://127.0.0.1:${port}/notify/key`;

  const cfg = compileConfig(
    { apprise_url: url, rules: [{ channel: "#spam", action: "suppress", cooldown: 60 }] },
    () => {}
  );
  const lastNotified = new Map();
  const handler = makeHandler(() => cfg, lastNotified);

  const event = makeEvent({ target: "#spam", client: makeClient("c") });

  // First message: suppress fires, timestamp should be recorded
  handler(event);
  await new Promise((r) => setTimeout(r, 20));

  const key = "c:Libera:#spam";
  assert.ok(lastNotified.has(key), "suppress rule should record timestamp");
  assert.equal(received.length, 0, "suppress rule produces no notifications");

  closeAll();
});
