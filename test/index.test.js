"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const {
  makeHandler,
  isHistoryReplay,
  isChannelTarget,
  isMutedWindow,
} = require("../index");
const { compileConfig } = require("../lib/config");
const { createMetrics } = require("../lib/metrics");

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

test("makeHandler enforces the global max_per_minute rate limit", async () => {
  const { closeAll, received, port } = await withServer();
  const url = `http://127.0.0.1:${port}/notify/key`;

  const cfg = compileConfig(
    { apprise_url: url, max_per_minute: 1, rules: [{}] },
    () => {}
  );
  const handler = makeHandler(() => cfg, new Map(), []);

  // Two different contexts so per-context cooldown doesn't interfere.
  handler(makeEvent({ target: "#one" }));
  handler(makeEvent({ target: "#two" }));

  await new Promise((r) => setTimeout(r, 50));
  closeAll();

  assert.equal(received.length, 1, "second notification blocked by max_per_minute");
});

test("makeHandler routes a rule's apprise_url override instead of the global one", async () => {
  const {
    closeAll: closeMain,
    received: mainReceived,
    port: mainPort,
  } = await withServer();
  const { closeAll: closeAlt, received: altReceived, port: altPort } = await withServer();

  const cfg = compileConfig(
    {
      apprise_url: `http://127.0.0.1:${mainPort}/notify/key`,
      rules: [
        {
          channel: "#incidents",
          apprise_url: `http://127.0.0.1:${altPort}/notify/other`,
        },
        {},
      ],
    },
    () => {}
  );
  const handler = makeHandler(() => cfg, new Map());

  handler(makeEvent({ target: "#incidents" }));

  await new Promise((r) => setTimeout(r, 50));
  closeMain();
  closeAlt();

  assert.equal(mainReceived.length, 0, "global endpoint should not receive the request");
  assert.equal(
    altReceived.length,
    1,
    "rule's override endpoint should receive the request"
  );
});

test("makeHandler suppresses all notifications when muted", async () => {
  const { closeAll, received, port } = await withServer();
  const url = `http://127.0.0.1:${port}/notify/key`;

  const cfg = compileConfig({ apprise_url: url, rules: [{}] }, () => {});
  const muted = { isMuted: () => true };
  const handler = makeHandler(() => cfg, new Map(), [], muted);

  handler(makeEvent());

  await new Promise((r) => setTimeout(r, 50));
  closeAll();

  assert.equal(received.length, 0, "muted — no notification should be sent");
});

test("makeHandler sends normally when not muted", async () => {
  const { closeAll, received, port } = await withServer();
  const url = `http://127.0.0.1:${port}/notify/key`;

  const cfg = compileConfig({ apprise_url: url, rules: [{}] }, () => {});
  const notMuted = { isMuted: () => false };
  const handler = makeHandler(() => cfg, new Map(), [], notMuted);

  handler(makeEvent());

  await new Promise((r) => setTimeout(r, 50));
  closeAll();

  assert.equal(received.length, 1);
});

test("makeHandler records metrics for notified, suppressed, and skipped decisions", async () => {
  const { closeAll, port } = await withServer();
  const url = `http://127.0.0.1:${port}/notify/key`;

  const cfg = compileConfig(
    {
      apprise_url: url,
      rules: [{ channel: "#spam", action: "suppress" }, { channel: "#dev" }],
    },
    () => {}
  );
  const metrics = createMetrics();
  const handler = makeHandler(() => cfg, new Map(), [], undefined, metrics);

  handler(makeEvent({ target: "#dev" })); // notify
  handler(makeEvent({ target: "#spam" })); // suppress
  handler(makeEvent({ target: "#random" })); // no rule matches -> skip

  await new Promise((r) => setTimeout(r, 50));
  closeAll();

  const snap = metrics.snapshot();
  assert.equal(snap.notified, 1);
  assert.equal(snap.suppressed, 1);
  assert.equal(snap.skipped, 1);
});

test("makeHandler records sendFailed when Apprise delivery fails", async () => {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(500);
      res.end("err");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/notify/key`;

  const cfg = compileConfig({ apprise_url: url, retries: 0, rules: [{}] }, () => {});
  const metrics = createMetrics();
  const handler = makeHandler(() => cfg, new Map(), [], undefined, metrics);

  handler(makeEvent());

  await new Promise((r) => setTimeout(r, 100));
  server.closeAllConnections();
  server.close();

  assert.equal(metrics.snapshot().sendFailed, 1);
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

test("isChannelTarget follows the server's CHANTYPES, not just #", () => {
  const irc = (chantypes) => ({
    network: {
      isChannelName: (name) => (chantypes ?? "&#").includes(name[0]),
    },
  });
  assert.equal(isChannelTarget(irc(), "#dev"), true);
  assert.equal(isChannelTarget(irc(), "&bitlbee"), true);
  assert.equal(isChannelTarget(irc(), "alice"), false);
  assert.equal(isChannelTarget(irc("#"), "&bitlbee"), false);
  assert.equal(isChannelTarget(irc("#!+"), "!abcdeops"), true);
});

test("isChannelTarget treats # and & as channels without network info", () => {
  assert.equal(isChannelTarget(undefined, "#dev"), true);
  assert.equal(isChannelTarget({}, "&bitlbee"), true);
  assert.equal(isChannelTarget({}, "root"), false);
});

test("isHistoryReplay recognises messages replayed in a history batch", () => {
  const live = { type: "privmsg", nick: "dave", target: "al", message: "hi" };
  assert.equal(isHistoryReplay(live), false);
  assert.equal(
    isHistoryReplay({
      ...live,
      batch: { id: "1", type: "chathistory", params: ["dave"] },
    }),
    true
  );
  assert.equal(isHistoryReplay({ ...live, batch: { type: "znc.in/playback" } }), true);
  assert.equal(isHistoryReplay({ ...live, batch: { type: "draft/multiline" } }), false);
});

test("makeHandler skips a message from an ignored user", async () => {
  const { closeAll, received, port } = await withServer();
  const url = `http://127.0.0.1:${port}/notify/key`;
  const cfg = compileConfig({ apprise_url: url, rules: [{}] }, () => {});
  const handler = makeHandler(() => cfg, new Map());

  handler(makeEvent({ isQuery: true, target: "bob", senderNick: "bob", ignored: true }));
  await new Promise((r) => setTimeout(r, 50));
  closeAll();

  assert.equal(received.length, 0);
});

test("isMutedWindow reads the window's muted flag from The Lounge's network", () => {
  const channels = {
    "#quiet": { muted: true },
    "#loud": { muted: false },
    bob: { muted: true },
  };
  const network = { getChannel: (name) => channels[name] };
  assert.equal(isMutedWindow(network, "#quiet"), true);
  assert.equal(isMutedWindow(network, "#loud"), false);
  assert.equal(isMutedWindow(network, "bob"), true);
  assert.equal(isMutedWindow(network, "newcomer"), false);
  assert.equal(isMutedWindow({}, "#quiet"), false);
});

test("makeHandler skips a message in a muted channel", async () => {
  const { closeAll, received, port } = await withServer();
  const url = `http://127.0.0.1:${port}/notify/key`;
  const cfg = compileConfig({ apprise_url: url, rules: [{}] }, () => {});
  const handler = makeHandler(() => cfg, new Map());

  handler(makeEvent({ channelMuted: true }));
  await new Promise((r) => setTimeout(r, 50));
  closeAll();

  assert.equal(received.length, 0);
});

test("makeHandler never treats a service's channel line as a highlight", async () => {
  const { closeAll, received, port } = await withServer();
  const url = `http://127.0.0.1:${port}/notify/key`;
  const cfg = compileConfig(
    { apprise_url: url, rules: [{ highlight: true }, { channel: "#bots" }] },
    () => {},
    { THELOUNGE_SERVICE_NICKS: "Satsuki" }
  );
  const handler = makeHandler(() => cfg, new Map());

  handler(makeEvent({ senderNick: "Satsuki", rawMessage: "mynick: hi" }));
  handler(
    makeEvent({ target: "#bots", senderNick: "Satsuki", rawMessage: "mynick: queued" })
  );
  await new Promise((r) => setTimeout(r, 50));
  closeAll();

  assert.equal(received.length, 1, "only the #bots rule matched");
  assert.equal(received[0].body, "Satsuki: mynick: queued");
});

test("makeHandler counts a service's line as a highlight with ignore_services off", async () => {
  const { closeAll, received, port } = await withServer();
  const url = `http://127.0.0.1:${port}/notify/key`;
  const cfg = compileConfig(
    { apprise_url: url, ignore_services: false, rules: [{ highlight: true }] },
    () => {},
    { THELOUNGE_SERVICE_NICKS: "Satsuki" }
  );
  const handler = makeHandler(() => cfg, new Map());

  handler(makeEvent({ senderNick: "Satsuki", rawMessage: "mynick: hi" }));
  await new Promise((r) => setTimeout(r, 50));
  closeAll();

  assert.equal(received.length, 1);
});
