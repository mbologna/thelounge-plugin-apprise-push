"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { makeHandler } = require("../index");
const { compileConfig } = require("../lib/config");
const { formatBatch, MAX_DIGEST_LINES } = require("../lib/digest");

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

// Resolves once `received` holds `count` requests, or after `timeoutMs`: a fixed
// sleep loses the race to the HTTP round trip when test files run in parallel.
async function waitForRequests(received, count, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (received.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
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
  await waitForRequests(received, 1);
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
  assert.equal(received[0].title, "[Libera] #dev (2 messages)");
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

  await waitForRequests(received, 1);
  closeAll();

  assert.equal(received.length, 1, "PM rule's digest_window:0 sends immediately");
});

test("a digest batch is dropped when muted before its window ends", async () => {
  const { closeAll, received, port } = await withServer();
  const url = `http://127.0.0.1:${port}/notify/key`;
  const cfg = compileConfig(
    { apprise_url: url, digest_window: 0.05, rules: [{}] },
    () => {}
  );
  let muted = false;
  const handler = makeHandler(() => cfg, new Map(), [], { isMuted: () => muted });

  handler(makeEvent({ rawMessage: "before the mute" }));
  muted = true;

  await new Promise((r) => setTimeout(r, 100));
  closeAll();

  assert.equal(received.length, 0, "nothing is sent while muted");
});

test("formatBatch leaves a single message as it is", () => {
  assert.deepEqual(formatBatch("[Libera] #dev", ["alice: hi"]), {
    title: "[Libera] #dev",
    body: "alice: hi",
  });
});

test("formatBatch caps the lines and says how many were left out", () => {
  const lines = Array.from({ length: MAX_DIGEST_LINES + 5 }, (_, i) => `u${i}: m${i}`);
  const { title, body } = formatBatch("[Libera] #dev", lines);
  assert.equal(title, `[Libera] #dev (${MAX_DIGEST_LINES + 5} messages)`);
  const out = body.split("\n");
  assert.equal(out.length, MAX_DIGEST_LINES + 1);
  assert.equal(
    out[MAX_DIGEST_LINES - 1],
    `u${MAX_DIGEST_LINES - 1}: m${MAX_DIGEST_LINES - 1}`
  );
  assert.equal(out[MAX_DIGEST_LINES], "… and 5 more");
});
