"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { expand, truncate } = require("../lib/template");

test("expand replaces known placeholders", () => {
  const out = expand("{nick}: {message}", { nick: "alice", message: "hi" });
  assert.equal(out, "alice: hi");
});

test("expand leaves unknown placeholders untouched", () => {
  assert.equal(expand("{nick} {bogus}", { nick: "a" }), "a {bogus}");
});

test("expand supports new placeholders mynick and time", () => {
  const out = expand("[{mynick}] {time}", { mynick: "me", time: "12:00" });
  assert.equal(out, "[me] 12:00");
});

test("expand coerces non-string templates", () => {
  assert.equal(expand(123, {}), "123");
});

test("truncate leaves short strings unchanged", () => {
  assert.equal(truncate("hello", 100), "hello");
});

test("truncate cuts long strings and appends ellipsis", () => {
  assert.equal(truncate("hello world", 5), "hell…");
});

test("truncate with 0 maxLen disables truncation", () => {
  assert.equal(truncate("hello world", 0), "hello world");
});
