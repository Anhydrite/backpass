import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as maki from "../src/discovery/adapters/maki.js";
import { statOrNull } from "../src/discovery/adapters/shared.js";
import { discoverTranscripts } from "../src/discovery/index.js";
import { loadConfig } from "../src/config.js";
import { State } from "../src/state.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function candidateFor(file) {
  const stat = statOrNull(file);
  return { key: file, path: file, mtimeMs: stat.mtimeMs, bytes: stat.size };
}

function messages(events) {
  return events.filter((event) => event.kind === "message");
}

function tools(events) {
  return events.filter((event) => event.kind === "tool");
}

function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function header(overrides = {}) {
  return {
    t: "header",
    v: 3,
    id: "session-1",
    model: "ocgo/deepseek-v4.1-flash",
    cwd: "/repo/demo",
    created_at: 1785667200,
    ...overrides,
  };
}

function turn(text) {
  return { t: "msg", d: { role: "user", content: [{ type: "text", text }] } };
}

/** Point the store at a throwaway home; `HOME`, `XDG_STATE_HOME` and `MAKI_STATE_DIR` are restored. */
function withMakiHome(homeDir, fn) {
  const previous = {
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    MAKI_STATE_DIR: process.env.MAKI_STATE_DIR,
  };
  process.env.HOME = homeDir;
  delete process.env.XDG_STATE_HOME;
  delete process.env.MAKI_STATE_DIR;
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === "function") return result.finally(restore);
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

test("maki adapter classifies a session from its header", () => {
  const file = path.join(FIXTURES, "maki-session.jsonl");
  const descriptor = maki.classify(candidateFor(file));

  assert.equal(descriptor.id, "maki-1234");
  assert.equal(descriptor.cwd, "/repo/demo");
  assert.equal(descriptor.model, "ocgo/deepseek-v4.1-flash");
  assert.equal(descriptor.title, "Add the changelog entry");
  // Maki records created_at in seconds and no remote, so dead worktrees stay at tier 3.
  assert.equal(descriptor.startedAt, 1785667200 * 1000);
  assert.deepEqual(descriptor.remotes, []);
  assert.deepEqual(descriptor.interactionSignals, {});
});

test("maki adapter reads turns, folds tool results, and drops housekeeping records", () => {
  const { events, model } = maki.read({ path: path.join(FIXTURES, "maki-session.jsonl") });

  assert.equal(model, "ocgo/deepseek-v4.1-flash");
  assert.deepEqual(
    messages(events).map((message) => `${message.role}: ${message.text}`),
    ["user: Add the changelog entry.", "assistant: Editing CHANGELOG.md.", "assistant: Done."],
  );
  const [toolCall] = tools(events);
  assert.equal(toolCall.name, "bash");
  assert.equal(toolCall.input.command, "git status");
  assert.equal(toolCall.result, "nothing to commit");
  assert.equal(toolCall.status, "completed");
  assert.equal(events.length, 4, "the image, `out`, `meta`, `frame` and `sub_msg` records add nothing");
});

test("maki enumerate lists a live session once and prefers it over its archived copy", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-maki-store-"));
  const root = path.join(homeDir, ".local", "state", "maki", "sessions");
  const live = path.join(root, "session-1.jsonl");
  writeJsonl(live, [header(), turn("live turn")]);
  writeJsonl(path.join(root, "archive", "session-1", "1.jsonl"), [header(), turn("archived turn")]);
  writeJsonl(path.join(root, "archive", "session-2", "1.jsonl"), [header({ id: "session-2" }), turn("first")]);
  writeJsonl(path.join(root, "archive", "session-2", "2.jsonl"), [header({ id: "session-2" }), turn("second")]);

  try {
    withMakiHome(homeDir, () => {
      const candidates = maki.enumerate();
      assert.deepEqual(
        candidates.map((candidate) => path.relative(root, candidate.path)).sort(),
        ["archive/session-2", "session-1.jsonl"],
        "the live file wins and archived segments are one candidate per session",
      );

      const archived = candidates.find((candidate) => candidate.path.endsWith("session-2"));
      assert.equal(
        archived.bytes,
        fs.statSync(path.join(root, "archive", "session-2", "1.jsonl")).size +
          fs.statSync(path.join(root, "archive", "session-2", "2.jsonl")).size,
      );
      const descriptor = maki.classify(archived);
      assert.equal(descriptor.id, "session-2");
      assert.equal(descriptor.cwd, "/repo/demo");
      assert.deepEqual(
        messages(maki.read(archived).events).map((message) => message.text),
        ["first", "second"],
        "segments read back as one conversation",
      );
    });
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("maki adapter ignores files that are not session headers", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-maki-bad-"));
  const root = path.join(homeDir, ".local", "state", "maki", "sessions");
  writeJsonl(path.join(root, "unknown.jsonl"), [{ t: "msg", d: { role: "user", content: [] } }]);
  writeJsonl(path.join(root, "no-cwd.jsonl"), [header({ cwd: undefined })]);

  try {
    withMakiHome(homeDir, () => {
      for (const candidate of maki.enumerate()) assert.equal(maki.classify(candidate), null);
    });
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("MAKI_STATE_DIR relocates the store", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-maki-relocated-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-maki-home-"));
  writeJsonl(path.join(stateDir, "sessions", "session-1.jsonl"), [header(), turn("hi")]);

  try {
    withMakiHome(homeDir, () => {
      process.env.MAKI_STATE_DIR = stateDir;
      const candidates = maki.enumerate();
      assert.deepEqual(
        candidates.map((candidate) => path.basename(candidate.path)),
        ["session-1.jsonl"],
      );
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("discovery associates Maki sessions through their header cwd", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-maki-scope-")));
  const repoRoot = path.join(dir, "project");
  const otherRoot = path.join(dir, "other");
  const homeDir = path.join(dir, "home");
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(otherRoot);
  execFileSync("git", ["init", "-q", repoRoot]);
  execFileSync("git", ["init", "-q", otherRoot]);
  const sessions = path.join(homeDir, ".local", "state", "maki", "sessions");
  writeJsonl(path.join(sessions, "in-project.jsonl"), [header({ id: "in-project", cwd: repoRoot }), turn("hi")]);
  writeJsonl(path.join(sessions, "in-child.jsonl"), [
    header({ id: "in-child", cwd: path.join(repoRoot, "sub") }),
    turn("hi"),
  ]);
  writeJsonl(path.join(sessions, "elsewhere.jsonl"), [header({ id: "elsewhere", cwd: otherRoot }), turn("hi")]);

  try {
    await withMakiHome(homeDir, async () => {
      const config = loadConfig(repoRoot, { discovery: { harnesses: ["maki"], since: "all" } });
      config.state = new State(repoRoot).ensure();
      const repo = { name: "project", root: repoRoot, worktrees: [repoRoot], remotes: [] };

      const project = await discoverTranscripts({ repo, config, strict: true });
      assert.deepEqual(project.transcripts.map((row) => row.nativeId).sort(), ["in-child", "in-project"]);
      assert.equal(project.perHarness.maki.matched, 2);
      assert.ok(project.transcripts.every((row) => row.harness === "maki"));
      assert.ok(project.transcripts.every((row) => row.association.tier === 1));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
