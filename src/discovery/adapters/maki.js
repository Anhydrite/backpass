import path from "node:path";

import { emptyInteractionSignals } from "../../interaction.js";
import {
  attachToolResults,
  contentToEvents,
  home,
  listDirs,
  listFiles,
  parseJsonLine,
  readHeadLines,
  readJsonl,
  statOrNull,
} from "./shared.js";

/**
 * Maki: `~/.local/state/maki/sessions/<session-id>.jsonl`
 *
 * Maki is its own format, not a Pi store: the first line is a
 * `{ t: "header", v, id, model, cwd, created_at }` record (v2 and v3 are the same
 * shape), conversation turns arrive as `{ t: "msg", d: { role, content } }` lines
 * carrying Claude-style blocks (text / thinking / tool_use / tool_result / image),
 * and a few housekeeping record types share the file: `meta` (title, token usage),
 * `frame` (the system-prompt snapshot), `out` (a tool output, duplicated inside the
 * following `tool_result` block) and `sub_msg` (a subagent conversation keyed by the
 * parent tool-call id).
 *
 * Compaction archives a session as `sessions/archive/<session-id>/<n>.jsonl`
 * segments that repeat the same header and cwd; when a live `<session-id>.jsonl`
 * still exists it is the authority, so the archived copy is skipped to avoid
 * counting one session twice.
 *
 * No git remote is recorded anywhere, so a Maki session reaches tier 3 on cwd alone.
 * `MAKI_STATE_DIR` relocates the state directory (sessions live under
 * `<MAKI_STATE_DIR>/sessions`), while `XDG_STATE_HOME` moves the default root.
 */

const HEAD_LINES = 12;
const MAX_HEAD_LINE_BYTES = 64 * 1024;

export const name = "maki";

export function storeRoots() {
  const roots = [];
  const configured = process.env.MAKI_STATE_DIR?.trim();
  if (configured) roots.push(path.join(expandHome(configured), "sessions"));
  const xdg = process.env.XDG_STATE_HOME?.trim();
  roots.push(xdg ? path.join(xdg, "maki", "sessions") : home(".local", "state", "maki", "sessions"));
  return [...new Set(roots)];
}

function expandHome(value) {
  if (value === "~") return home();
  if (value.startsWith("~/")) return path.join(home(), value.slice(2));
  return path.resolve(value);
}

/**
 * A live session is one file. An archived session is a directory of numbered
 * segments, enumerated as a single candidate so the segments read back as one
 * conversation; `read` walks the directory.
 */
function candidateFor(key, files) {
  const stats = files.map((file) => statOrNull(file)).filter(Boolean);
  if (!stats.length) return null;
  return {
    key,
    path: key,
    files,
    mtimeMs: Math.max(...stats.map((stat) => stat.mtimeMs)),
    bytes: stats.reduce((total, stat) => total + stat.size, 0),
  };
}

export function enumerate() {
  const out = [];
  for (const root of storeRoots()) {
    for (const file of listFiles(root, ".jsonl")) {
      const candidate = candidateFor(file, [file]);
      if (candidate) out.push(candidate);
    }
    const archive = path.join(root, "archive");
    for (const dir of listDirs(archive)) {
      const id = path.basename(dir);
      if (statOrNull(path.join(root, `${id}.jsonl`))) continue;
      const segments = listFiles(dir, ".jsonl").sort();
      const candidate = segments.length ? candidateFor(dir, segments) : null;
      if (candidate) out.push(candidate);
    }
  }
  return out;
}

function recordsFor(target) {
  const stat = statOrNull(target);
  if (!stat) return [];
  if (stat.isDirectory())
    return listFiles(target, ".jsonl")
      .sort()
      .flatMap((file) => readJsonl(file));
  return readJsonl(target);
}

/** Header plus the first `meta` title, skipping the multi-kilobyte `frame` snapshot. */
function readHead(file) {
  const found = {};
  for (const line of readHeadLines(file, HEAD_LINES)) {
    if (line.length > MAX_HEAD_LINE_BYTES) continue;
    const entry = parseJsonLine(line);
    if (!entry) continue;
    if (!found.header && entry.t === "header" && typeof entry.cwd === "string") {
      found.header = entry;
      continue;
    }
    if (!found.title && entry.t === "meta" && typeof entry.title === "string" && entry.title.trim()) {
      found.title = entry.title.trim();
    }
  }
  return found;
}

export function classify(candidate) {
  const files = candidate.files || [candidate.path];
  const { header, title } = readHead(files[0]);
  if (!header) return null;

  const created = Number(header.created_at);
  return {
    id: header.id || path.basename(files[0], ".jsonl"),
    cwd: header.cwd,
    gitBranch: null,
    remotes: [],
    startedAt: Number.isFinite(created) && created > 0 ? created * 1000 : candidate.mtimeMs,
    model: typeof header.model === "string" ? header.model : null,
    title: title || null,
    interactionSignals: emptyInteractionSignals(),
  };
}

export function read(ref) {
  const events = [];
  let model = null;

  for (const entry of recordsFor(ref.path)) {
    if (entry.t === "header") {
      model = model || (typeof entry.model === "string" ? entry.model : null);
      continue;
    }
    // `out` duplicates a tool result, `meta`/`frame` carry no conversation, and
    // `sub_msg` interleaves another agent's turns into this file.
    if (entry.t !== "msg") continue;
    const message = entry.d || {};
    if (message.role !== "user" && message.role !== "assistant") continue;
    contentToEvents(message.role, message.content, events);
  }

  return { events: attachToolResults(events), model };
}
