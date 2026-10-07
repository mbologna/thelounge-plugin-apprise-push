"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createMuteState, parseMuteFile } = require("../lib/mute");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "apprise-push-mute-"));
}

// ── parseMuteFile ──────────────────────────────────────────────────────────────

test("parseMuteFile treats empty content as mute indefinitely", () => {
  assert.equal(parseMuteFile(""), Infinity);
  assert.equal(parseMuteFile("   \n"), Infinity);
});

test("parseMuteFile treats a number as minutes from now", () => {
  const before = Math.floor(Date.now() / 1000);
  const result = parseMuteFile("30");
  assert.ok(result >= before + 30 * 60 - 1 && result <= before + 30 * 60 + 1);
});

test("parseMuteFile treats an ISO timestamp as an absolute mute-until time", () => {
  const result = parseMuteFile("2099-01-01T00:00:00Z");
  assert.equal(result, Math.floor(Date.parse("2099-01-01T00:00:00Z") / 1000));
});

test("parseMuteFile returns 0 for unrecognized content", () => {
  assert.equal(parseMuteFile("not a number or a date"), 0);
});

// ── createMuteState ────────────────────────────────────────────────────────────

test("createMuteState reports not muted when the file doesn't exist", () => {
  const dir = tmpDir();
  const state = createMuteState(path.join(dir, "apprise-push.mute"), () => {});
  assert.equal(state.isMuted(Math.floor(Date.now() / 1000)), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("createMuteState mutes indefinitely for an empty file, until removed", () => {
  const dir = tmpDir();
  const mutePath = path.join(dir, "apprise-push.mute");
  fs.writeFileSync(mutePath, "");

  const state = createMuteState(mutePath, () => {});
  const now = Math.floor(Date.now() / 1000);
  assert.equal(state.isMuted(now), true);
  assert.equal(state.isMuted(now + 10_000_000), true);

  fs.rmSync(mutePath);
  state.refresh();
  assert.equal(state.isMuted(now), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("createMuteState mutes for N minutes when the file contains a number", () => {
  const dir = tmpDir();
  const mutePath = path.join(dir, "apprise-push.mute");
  fs.writeFileSync(mutePath, "30");

  const state = createMuteState(mutePath, () => {});
  const now = Math.floor(Date.now() / 1000);
  assert.equal(state.isMuted(now), true);
  assert.equal(state.isMuted(now + 31 * 60), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("createMuteState warns and stays unmuted for unrecognized content", () => {
  const dir = tmpDir();
  const mutePath = path.join(dir, "apprise-push.mute");
  fs.writeFileSync(mutePath, "garbage");

  const warnings = [];
  const state = createMuteState(mutePath, (m) => warnings.push(m));
  assert.equal(state.isMuted(Math.floor(Date.now() / 1000)), false);
  assert.ok(warnings.some((w) => w.includes("apprise-push.mute")));

  fs.rmSync(dir, { recursive: true, force: true });
});
