"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { compileConfig, makeGlobRe, matchesAny, DEFAULTS } = require("../lib/config");

const quiet = () => {};
const cfg = (raw) => compileConfig(raw, quiet);

test("makeGlobRe matches with * and ? case-insensitively", () => {
  const re = makeGlobRe("pro?uct*");
  assert.equal(re.test("PRODUCTION"), true);
  assert.equal(re.test("product-1"), true);
  assert.equal(re.test("prod"), false);
});

test("makeGlobRe escapes regex special chars", () => {
  const re = makeGlobRe("a.b+c");
  assert.equal(re.test("a.b+c"), true);
  assert.equal(re.test("axbxc"), false);
});

test("matchesAny returns true when any pattern matches", () => {
  const list = ["*bot*", "ChanServ"].map(makeGlobRe);
  assert.equal(matchesAny(list, "helperbot"), true);
  assert.equal(matchesAny(list, "ChanServ"), true);
  assert.equal(matchesAny(list, "alice"), false);
});

test("compileConfig fills defaults", () => {
  const c = cfg({ apprise_url: "http://x/notify/k" });
  assert.equal(c.title_pm, DEFAULTS.title_pm);
  assert.equal(c.timeout, 10000);
  assert.equal(c.retries, 2);
  assert.equal(c.retry_delay, 500);
});

test("compileConfig parses apprise_url", () => {
  const c = cfg({ apprise_url: "https://host:8443/notify/key?x=1" });
  assert.equal(c.parsedUrl.hostname, "host");
  assert.equal(c.parsedUrl.port, "8443");
  assert.equal(c.parsedUrl.pathname, "/notify/key");
});

test("compileConfig builds auth headers from token", () => {
  const c = cfg({ apprise_token: "abc123" });
  assert.equal(c.headers.Authorization, "Bearer abc123");
});

test("compileConfig merges apprise_headers and overrides token header", () => {
  const c = cfg({
    apprise_token: "abc",
    apprise_headers: { Authorization: "Basic zzz", "X-Tag": "irc" },
  });
  assert.equal(c.headers.Authorization, "Basic zzz");
  assert.equal(c.headers["X-Tag"], "irc");
});

test("compileConfig normalises scalar list fields to arrays", () => {
  const c = cfg({ nick_blacklist: "ChanServ" });
  assert.deepEqual(c.nick_blacklist, ["ChanServ"]);
  assert.equal(c.nickBlacklistRe.length, 1);
});

test("compileConfig coerces bad numeric values to defaults", () => {
  const c = cfg({ timeout: "nope", retries: -5 });
  assert.equal(c.timeout, DEFAULTS.timeout);
  assert.equal(c.retries, 0); // clamped to >= 0
});

test("compileConfig clones rules and compiles per-rule globs", () => {
  const c = cfg({ rules: [{ channel: ["#a", "#b"], action: "notify" }] });
  assert.equal(c.rules[0]._channelRe.length, 2);
  // DEFAULTS.rules must remain untouched
  assert.deepEqual(DEFAULTS.rules, [{ highlight: true }, { pm: true }]);
});

test("compileConfig warns on unknown keys", () => {
  const warnings = [];
  compileConfig({ bogus_key: 1 }, (m) => warnings.push(m));
  assert.ok(warnings.some((w) => w.includes("bogus_key")));
});

test("compileConfig warns on non-array rules and falls back to defaults", () => {
  const warnings = [];
  const c = compileConfig({ rules: "nope" }, (m) => warnings.push(m));
  assert.ok(warnings.some((w) => w.includes("rules")));
  assert.equal(c.rules.length, DEFAULTS.rules.length);
});

test("compileConfig compiles contains glob patterns on rules", () => {
  const c = cfg({ rules: [{ contains: ["critical", "down*"] }] });
  assert.equal(c.rules[0]._containsRe.length, 2);
  // Both patterns are wrapped in *...* so they match anywhere in the string
  assert.ok(c.rules[0]._containsRe[0].test("system critical failure"));
  assert.ok(c.rules[0]._containsRe[1].test("service is down now"));
});

test("compileConfig coerces per-rule cooldown", () => {
  const c = cfg({ rules: [{ cooldown: "30" }, { cooldown: -10 }] });
  assert.equal(c.rules[0].cooldown, 0); // non-number falls back to cfg.cooldown (0), then clamped
  assert.equal(c.rules[1].cooldown, 0); // negative clamped to 0
});

test("compileConfig warns on invalid priority string", () => {
  const warnings = [];
  compileConfig({ priority: "urgent" }, (m) => warnings.push(m));
  assert.ok(warnings.some((w) => w.includes("priority")));
});

test("compileConfig does not warn on valid priority values", () => {
  const warnings = [];
  compileConfig({ priority: "high" }, (m) => warnings.push(m));
  compileConfig({ priority: 1 }, (m) => warnings.push(m));
  compileConfig({ priority: null }, (m) => warnings.push(m));
  assert.ok(!warnings.some((w) => w.includes("priority")));
});

test("compileConfig warns on invalid IANA timezone", () => {
  const warnings = [];
  compileConfig({ timezone: "Not/ATimezone" }, (m) => warnings.push(m));
  assert.ok(warnings.some((w) => w.includes("timezone")));
});

test("compileConfig does not warn on valid IANA timezone", () => {
  const warnings = [];
  compileConfig({ timezone: "America/New_York" }, (m) => warnings.push(m));
  assert.ok(!warnings.some((w) => w.includes("timezone")));
});

test("compileConfig clears invalid timezone to empty string (crash prevention)", () => {
  const c = cfg({ timezone: "Not/ATimezone" });
  assert.equal(c.timezone, "");
});

test("compileConfig preserves valid timezone", () => {
  const c = cfg({ timezone: "Europe/Berlin" });
  assert.equal(c.timezone, "Europe/Berlin");
});

test("compileConfig warns when apprise_url has no path", () => {
  const warnings = [];
  compileConfig({ apprise_url: "http://apprise:8000" }, (m) => warnings.push(m));
  assert.ok(warnings.some((w) => w.includes("no path")));
});

test("compileConfig does not warn when apprise_url has a real path", () => {
  const warnings = [];
  compileConfig({ apprise_url: "http://apprise:8000/notify/key" }, (m) => warnings.push(m));
  assert.ok(!warnings.some((w) => w.includes("no path")));
});

test("compileConfig clamps negative cooldown to 0", () => {
  const c = cfg({ cooldown: -60 });
  assert.equal(c.cooldown, 0);
});

test("compileConfig warns on negative cooldown", () => {
  const warnings = [];
  compileConfig({ cooldown: -60 }, (m) => warnings.push(m));
  assert.ok(warnings.some((w) => w.includes("cooldown")));
});

test("compileConfig warns on very low timeout", () => {
  const warnings = [];
  compileConfig({ timeout: 50 }, (m) => warnings.push(m));
  assert.ok(warnings.some((w) => w.includes("timeout")));
});

test("compileConfig warns on invalid per-rule priority and resets to null", () => {
  const warnings = [];
  const c = compileConfig({ rules: [{ priority: "urgent" }] }, (m) => warnings.push(m));
  assert.ok(warnings.some((w) => w.includes("priority")));
  assert.equal(c.rules[0].priority, null);
});

test("compileConfig warns on invalid per-rule message_type and drops the field", () => {
  const warnings = [];
  const c = compileConfig({ rules: [{ message_type: "notice" }] }, (m) => warnings.push(m));
  assert.ok(warnings.some((w) => w.includes("message_type")));
  assert.equal(c.rules[0].message_type, undefined);
});

test("compileConfig accepts valid per-rule message_type", () => {
  const c = cfg({ rules: [{ message_type: "privmsg" }, { message_type: "action" }] });
  assert.equal(c.rules[0].message_type, "privmsg");
  assert.equal(c.rules[1].message_type, "action");
});
