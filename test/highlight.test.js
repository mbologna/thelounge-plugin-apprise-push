"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { stripIrcFormatting, isHighlight } = require("../lib/highlight");
const { compileConfig } = require("../lib/config");

const quietCfg = (raw) => compileConfig(raw, () => {});

test("stripIrcFormatting removes colour codes", () => {
  assert.equal(stripIrcFormatting("\x0304red\x03 text"), "red text");
});

test("stripIrcFormatting removes bold/reset control chars", () => {
  assert.equal(stripIrcFormatting("\x02bold\x0f end"), "bold end");
});

test("isHighlight matches own nick case-insensitively", () => {
  const cfg = quietCfg({});
  assert.equal(isHighlight(cfg, "Alice", "hey ALICE here"), true);
  assert.equal(isHighlight(cfg, "Alice", "nothing here"), false);
});

test("isHighlight matches highlight_words globs", () => {
  const cfg = quietCfg({ highlight_words: ["urgent", "prod*"] });
  assert.equal(isHighlight(cfg, "bob", "this is urgent"), true);
  assert.equal(isHighlight(cfg, "bob", "production down"), true);
  assert.equal(isHighlight(cfg, "bob", "all good"), false);
});

test("isHighlight tolerates empty myNick", () => {
  const cfg = quietCfg({});
  assert.equal(isHighlight(cfg, "", "anything"), false);
});
