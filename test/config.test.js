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
