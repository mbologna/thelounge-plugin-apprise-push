"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { matchRule, evaluate } = require("../lib/rules");
const { compileConfig } = require("../lib/config");

const cfg = (raw) => compileConfig(raw, () => {});

const baseCtx = (over = {}) => ({
  isQuery: false,
  channel: "#dev",
  senderNick: "alice",
  networkName: "Libera",
  cleanMessage: "hello world",
  messageType: "privmsg",
  isHl: false,
  now: 1000,
  clientKey: "c:Libera:#dev",
  attachedCount: 0,
  ...over,
});

// ── matchRule ──────────────────────────────────────────────────────────────────

test("empty rule matches everything", () => {
  const c = cfg({ rules: [{}] });
  assert.equal(matchRule(c.rules[0], baseCtx()), true);
});

test("channel rule does not match PMs", () => {
  const c = cfg({ rules: [{ channel: "#dev" }] });
  assert.equal(matchRule(c.rules[0], baseCtx({ isQuery: true })), false);
});

test("channel rule matches glob", () => {
  const c = cfg({ rules: [{ channel: "#d*" }] });
  assert.equal(matchRule(c.rules[0], baseCtx({ channel: "#deploy" })), true);
  assert.equal(matchRule(c.rules[0], baseCtx({ channel: "#ops" })), false);
});

test("pm:true matches only queries", () => {
  const c = cfg({ rules: [{ pm: true }] });
  assert.equal(matchRule(c.rules[0], baseCtx({ isQuery: true })), true);
  assert.equal(matchRule(c.rules[0], baseCtx({ isQuery: false })), false);
});

test("highlight:true requires a highlight", () => {
  const c = cfg({ rules: [{ highlight: true }] });
  assert.equal(matchRule(c.rules[0], baseCtx({ isHl: true })), true);
  assert.equal(matchRule(c.rules[0], baseCtx({ isHl: false })), false);
});

test("network and nick globs are ANDed", () => {
  const c = cfg({ rules: [{ network: "Libera", nick: "a*" }] });
  assert.equal(matchRule(c.rules[0], baseCtx()), true);
  assert.equal(matchRule(c.rules[0], baseCtx({ senderNick: "bob" })), false);
  assert.equal(matchRule(c.rules[0], baseCtx({ networkName: "OFTC" })), false);
});

// ── evaluate ───────────────────────────────────────────────────────────────────

test("evaluate returns notify with the matched rule", () => {
  const c = cfg({ rules: [{ highlight: true }, { pm: true }] });
  const r = evaluate(c, baseCtx({ isHl: true }), new Map());
  assert.equal(r.decision, "notify");
  assert.equal(r.rule.highlight, true);
});

test("evaluate first-match-wins ordering", () => {
  const c = cfg({
    rules: [{ channel: "#dev", action: "suppress" }, { highlight: true }],
  });
  const r = evaluate(c, baseCtx({ isHl: true }), new Map());
  assert.equal(r.decision, "suppress");
});

test("evaluate returns skip when no rule matches", () => {
  const c = cfg({ rules: [{ pm: true }] });
  const r = evaluate(c, baseCtx({ isQuery: false }), new Map());
  assert.equal(r.decision, "skip");
});

test("evaluate nick_blacklist is a global pre-filter", () => {
  const c = cfg({ nick_blacklist: ["*bot*"], rules: [{}] });
  const r = evaluate(c, baseCtx({ senderNick: "helperbot" }), new Map());
  assert.equal(r.decision, "skip");
});

test("evaluate network_blacklist is a global pre-filter", () => {
  const c = cfg({ network_blacklist: ["OFTC"], rules: [{}] });
  const r = evaluate(c, baseCtx({ networkName: "OFTC" }), new Map());
  assert.equal(r.decision, "skip");
});

test("evaluate away_only skips when clients are attached", () => {
  const c = cfg({ away_only: true, rules: [{}] });
  assert.equal(evaluate(c, baseCtx({ attachedCount: 1 }), new Map()).decision, "skip");
  assert.equal(evaluate(c, baseCtx({ attachedCount: 0 }), new Map()).decision, "notify");
});

test("evaluate cooldown suppresses repeats within the window", () => {
  const c = cfg({ cooldown: 60, rules: [{}] });
  const last = new Map([["c:Libera:#dev", 1000]]);
  assert.equal(evaluate(c, baseCtx({ now: 1030 }), last).decision, "skip");
  assert.equal(evaluate(c, baseCtx({ now: 1061 }), last).decision, "notify");
});

// ── suppress + cooldown ────────────────────────────────────────────────────────

// (The timestamp update for suppress decisions is done in index.js, not in rules.js,
//  so this test verifies the evaluate return value used by index.js to track state.)
test("suppress rule returns the matched rule so caller can track cooldown", () => {
  const c = cfg({ rules: [{ channel: "#spam", action: "suppress", cooldown: 60 }] });
  const r = evaluate(c, baseCtx({ channel: "#spam", clientKey: "c:Libera:#spam" }), new Map());
  assert.equal(r.decision, "suppress");
  // rule must be returned (not null) so index.js can compute effectiveCooldown
  assert.ok(r.rule !== null);
  assert.equal(r.rule.cooldown, 60);
});

// ── message_type condition ─────────────────────────────────────────────────────

test("message_type:privmsg matches only regular messages", () => {
  const c = cfg({ rules: [{ message_type: "privmsg" }] });
  assert.equal(matchRule(c.rules[0], baseCtx({ messageType: "privmsg" })), true);
  assert.equal(matchRule(c.rules[0], baseCtx({ messageType: "action" })), false);
});

test("message_type:action matches only /me actions", () => {
  const c = cfg({ rules: [{ message_type: "action" }] });
  assert.equal(matchRule(c.rules[0], baseCtx({ messageType: "action" })), true);
  assert.equal(matchRule(c.rules[0], baseCtx({ messageType: "privmsg" })), false);
});

test("omitting message_type matches both privmsg and action", () => {
  const c = cfg({ rules: [{}] });
  assert.equal(matchRule(c.rules[0], baseCtx({ messageType: "privmsg" })), true);
  assert.equal(matchRule(c.rules[0], baseCtx({ messageType: "action" })), true);
});

// ── contains condition ─────────────────────────────────────────────────────────

test("contains string matches message containing the word", () => {
  const c = cfg({ rules: [{ contains: "critical" }] });
  assert.equal(matchRule(c.rules[0], baseCtx({ cleanMessage: "system critical failure" })), true);
  assert.equal(matchRule(c.rules[0], baseCtx({ cleanMessage: "all good" })), false);
});

test("contains array: any pattern matches (OR logic)", () => {
  const c = cfg({ rules: [{ contains: ["down", "critical"] }] });
  assert.equal(matchRule(c.rules[0], baseCtx({ cleanMessage: "service is down" })), true);
  assert.equal(matchRule(c.rules[0], baseCtx({ cleanMessage: "critical alert" })), true);
  assert.equal(matchRule(c.rules[0], baseCtx({ cleanMessage: "all systems nominal" })), false);
});

test("contains ANDs with other conditions", () => {
  const c = cfg({ rules: [{ channel: "#ops", contains: "deploy" }] });
  // channel matches, contains matches → true
  assert.equal(matchRule(c.rules[0], baseCtx({ channel: "#ops", cleanMessage: "deploying now" })), true);
  // channel matches, contains does not match → false
  assert.equal(matchRule(c.rules[0], baseCtx({ channel: "#ops", cleanMessage: "hello" })), false);
  // channel does not match → false
  assert.equal(matchRule(c.rules[0], baseCtx({ channel: "#dev", cleanMessage: "deploying now" })), false);
});

// ── per-rule cooldown ──────────────────────────────────────────────────────────

test("per-rule cooldown:0 overrides global cooldown", () => {
  // Global cooldown is 60s but the PM rule has cooldown:0 (always notify)
  const c = cfg({ cooldown: 60, rules: [{ pm: true, cooldown: 0 }, { pm: false }] });
  const last = new Map([["c:Libera:alice", 999]]);
  // PM context — should notify despite global cooldown
  assert.equal(
    evaluate(c, baseCtx({ isQuery: true, channel: "alice", clientKey: "c:Libera:alice", now: 1000 }), last).decision,
    "notify"
  );
});

test("per-rule cooldown suppresses within its own window", () => {
  // Global cooldown is 0 but the channel rule has cooldown:300
  const c = cfg({ cooldown: 0, rules: [{ channel: "#general", cooldown: 300 }] });
  const last = new Map([["c:Libera:#general", 900]]);
  assert.equal(
    evaluate(c, baseCtx({ channel: "#general", clientKey: "c:Libera:#general", now: 1000 }), last).decision,
    "skip"
  );
  assert.equal(
    evaluate(c, baseCtx({ channel: "#general", clientKey: "c:Libera:#general", now: 1201 }), last).decision,
    "notify"
  );
});

test("evaluate includes reason on skip decisions", () => {
  const away = cfg({ away_only: true, rules: [{}] });
  assert.equal(evaluate(away, baseCtx({ attachedCount: 1 }), new Map()).reason, "away_only");

  const nb = cfg({ nick_blacklist: ["*bot*"], rules: [{}] });
  assert.equal(evaluate(nb, baseCtx({ senderNick: "helperbot" }), new Map()).reason, "nick_blacklist");

  const net = cfg({ network_blacklist: ["OFTC"], rules: [{}] });
  assert.equal(evaluate(net, baseCtx({ networkName: "OFTC" }), new Map()).reason, "network_blacklist");

  const cd = cfg({ cooldown: 60, rules: [{}] });
  const last = new Map([["c:Libera:#dev", 1000]]);
  assert.equal(evaluate(cd, baseCtx({ now: 1030 }), last).reason, "cooldown");

  const nm = cfg({ rules: [{ pm: true }] });
  assert.equal(evaluate(nm, baseCtx({ isQuery: false }), new Map()).reason, "no_match");
});

test("evaluate returns rule object so callers can read per-rule priority", () => {
  const c = cfg({ rules: [{ highlight: true, priority: "high" }, { pm: true }] });
  const r = evaluate(c, baseCtx({ isHl: true }), new Map());
  assert.equal(r.decision, "notify");
  assert.equal(r.rule.priority, "high");
});

test("per-rule cooldowns are independent across rules", () => {
  // Two rules: #general with 300s cooldown, #dev with 0 cooldown
  const c = cfg({ cooldown: 0, rules: [{ channel: "#general", cooldown: 300 }, { channel: "#dev", cooldown: 0 }] });
  const last = new Map([["c:Libera:#general", 900], ["c:Libera:#dev", 999]]);
  // #general is in cooldown
  assert.equal(
    evaluate(c, baseCtx({ channel: "#general", clientKey: "c:Libera:#general", now: 1000 }), last).decision,
    "skip"
  );
  // #dev is not in cooldown (cooldown:0)
  assert.equal(
    evaluate(c, baseCtx({ channel: "#dev", clientKey: "c:Libera:#dev", now: 1000 }), last).decision,
    "notify"
  );
});
