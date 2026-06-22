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
