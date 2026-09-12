// Tests for hub/src/transcript.ts: project-dir encoding, transcript path
// construction, transcript line parsing (string / block / tool content,
// malformed input), and the incremental TranscriptTailer.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  encodeProjectDir,
  parseTranscriptLine,
  transcriptPath,
  TranscriptTailer,
} from "../src/transcript";
import type { TranscriptEvent } from "../src/transcript";

/* ------------------------------- encoding ----------------------------------- */

describe("encodeProjectDir", () => {
  test("encodes the supplied example path", () => {
    expect(encodeProjectDir("/Users/x/src/claude-web/.worktrees/a")).toBe(
      "-Users-x-src-claude-web--worktrees-a",
    );
  });

  test("encodes every non-[A-Za-z0-9] character as '-'", () => {
    expect(encodeProjectDir("/a b/c.d-e")).toBe("-a-b-c-d-e");
    expect(encodeProjectDir("C:\\Users\\tyler whitehurst")).toBe(
      "C--Users-tyler-whitehurst",
    );
    expect(encodeProjectDir("/tmp/péq")).toBe("-tmp-p-q");
    expect(encodeProjectDir("plain")).toBe("plain");
  });
});

describe("transcriptPath", () => {
  test("joins home/.claude/projects/<encoded>/<id>.jsonl", () => {
    const p = transcriptPath("/Users/x/src/claude-web/.worktrees/a", "sess-1", "/home/u");
    expect(p).toBe("/home/u/.claude/projects/-Users-x-src-claude-web--worktrees-a/sess-1.jsonl");
  });

  test("defaults home to os.homedir()", () => {
    const p = transcriptPath("/w", "s");
    expect(p).toBe(path.join(os.homedir(), ".claude", "projects", "-w", "s.jsonl"));
  });
});

/* ------------------------------- parsing ------------------------------------ */

describe("parseTranscriptLine", () => {
  test("parses a string-content user line", () => {
    const line = JSON.stringify({
      type: "user",
      timestamp: "2026-09-12T00:00:00.000Z",
      message: { role: "user", content: "hello there" },
    });
    const ev = parseTranscriptLine(line);
    expect(ev).toEqual({
      role: "user",
      text: "hello there",
      tools: [],
      ts: Date.parse("2026-09-12T00:00:00.000Z"),
    });
  });

  test("parses assistant text + tool_use blocks and a tool_result", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-12T00:01:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "running a tool" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          { type: "tool_result", tool_use_id: "t1", content: "file.ts\n" },
        ],
      },
    });
    const ev = parseTranscriptLine(line);
    expect(ev?.role).toBe("assistant");
    expect(ev?.text).toBe("running a tool\nfile.ts\n");
    expect(ev?.tools).toEqual([{ name: "Bash", input: { command: "ls" } }]);
    expect(ev?.ts).toBe(Date.parse("2026-09-12T00:01:02.000Z"));
  });

  test("tool_result content may be an array of {type:'text'} blocks", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }] }],
      },
    });
    const ev = parseTranscriptLine(line);
    expect(ev?.role).toBe("user");
    expect(ev?.text).toBe("part1\npart2");
    expect(ev?.tools).toEqual([]);
  });

  test("assistant message with only tool_use yields empty text but keeps tools", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { path: "x.ts" } }] },
    });
    const ev = parseTranscriptLine(line);
    expect(ev?.text).toBe("");
    expect(ev?.tools).toEqual([{ name: "Read", input: { path: "x.ts" } }]);
  });

  test("missing/invalid timestamp falls back to 0", () => {
    const ev = parseTranscriptLine(JSON.stringify({ type: "user", message: { content: "hi" } }));
    expect(ev?.ts).toBe(0);
    const bad = parseTranscriptLine(
      JSON.stringify({ type: "user", timestamp: "not-a-date", message: { content: "hi" } }),
    );
    expect(bad?.ts).toBe(0);
  });

  test("returns null for non user/assistant types and other shapes", () => {
    expect(parseTranscriptLine(JSON.stringify({ type: "summary", summary: "x" }))).toBeNull();
    expect(parseTranscriptLine(JSON.stringify({ type: "user" }))).toBeNull(); // no message
    expect(parseTranscriptLine(JSON.stringify({ type: "assistant", message: "not-a-record" }))).toBeNull();
    expect(parseTranscriptLine("[]")).toBeNull(); // array, not record
    expect(parseTranscriptLine("42")).toBeNull();
    expect(parseTranscriptLine("null")).toBeNull();
  });

  test("returns null on malformed JSON and never throws", () => {
    expect(parseTranscriptLine("{not json")).toBeNull();
    expect(parseTranscriptLine('{"type":"user","message":')).toBeNull();
    expect(parseTranscriptLine("\x00\xff broken")).toBeNull();
    expect(parseTranscriptLine("")).toBeNull();
  });
});

/* -------------------------------- tailer ------------------------------------ */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("TranscriptTailer", () => {
  function tmpFile(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cw-tail-")), "s.jsonl");
  }

  function collect(events: TranscriptEvent[]) {
    return (ev: TranscriptEvent) => events.push(ev);
  }

  test("emits existing lines on start (catch-up)", async () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ type: "user", message: { content: "first" } }) + "\n" +
      JSON.stringify({ type: "assistant", message: { content: "second" } }) + "\n",
    );
    const events: TranscriptEvent[] = [];
    const tailer = new TranscriptTailer(file, collect(events), 25);
    tailer.start();
    await sleep(150);
    tailer.stop();
    expect(events.map((e) => e.text)).toEqual(["first", "second"]);
  });

  test("tolerates a missing file, then picks up appended lines", async () => {
    const file = tmpFile(); // deliberately never created up front
    const events: TranscriptEvent[] = [];
    const tailer = new TranscriptTailer(file, collect(events), 25);
    tailer.start();
    await sleep(100); // polls while the file does not exist
    fs.writeFileSync(
      file,
      JSON.stringify({ type: "user", message: { content: "late arrival" } }) + "\n",
    );
    await sleep(150);
    tailer.stop();
    expect(events.map((e) => e.text)).toEqual(["late arrival"]);
  });

  test("emits incrementally as lines are appended", async () => {
    const file = tmpFile();
    const line = (t: string) =>
      JSON.stringify({ type: "user", message: { content: t } }) + "\n";
    fs.writeFileSync(file, line("one"));
    const events: TranscriptEvent[] = [];
    const tailer = new TranscriptTailer(file, collect(events), 25);
    tailer.start();
    await sleep(100);
    expect(events.map((e) => e.text)).toEqual(["one"]);
    fs.appendFileSync(file, line("two") + line("three"));
    await sleep(150);
    tailer.stop();
    expect(events.map((e) => e.text)).toEqual(["one", "two", "three"]);
  });

  test("holds back a partial JSON line until its newline arrives", async () => {
    const file = tmpFile();
    const full = JSON.stringify({ type: "user", message: { content: "whole line" } });
    fs.writeFileSync(file, '{"type":"user","message":{"content":"par');
    const events: TranscriptEvent[] = [];
    const tailer = new TranscriptTailer(file, collect(events), 25);
    tailer.start();
    await sleep(120);
    expect(events).toEqual([]); // partial line not emitted yet
    fs.appendFileSync(file, 'tial"}}' + "\n"); // completes the SAME line
    await sleep(150);
    tailer.stop();
    expect(events.map((e) => e.text)).toEqual(["partial"]);
    expect(full).toContain("whole line"); // fixture sanity
  });

  test("holds back a partial trailing UTF-8 sequence across polls", async () => {
    const file = tmpFile();
    const text = "héllo wörld";
    const payload = JSON.stringify({ type: "user", message: { content: text } }) + "\n";
    const bytes = new TextEncoder().encode(payload);
    const cut = payload.indexOf('"h') + 2 + 1; // inside the 2-byte 'é' sequence
    fs.writeFileSync(file, bytes.slice(0, cut));
    const events: TranscriptEvent[] = [];
    const tailer = new TranscriptTailer(file, collect(events), 25);
    tailer.start();
    await sleep(120);
    fs.appendFileSync(file, bytes.slice(cut)); // the rest of the char + tail
    await sleep(150);
    tailer.stop();
    expect(events.map((e) => e.text)).toEqual([text]);
  });

  test("restarts from the beginning after truncation", async () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ type: "user", message: { content: "before" } }) + "\n",
    );
    const events: TranscriptEvent[] = [];
    const tailer = new TranscriptTailer(file, collect(events), 25);
    tailer.start();
    await sleep(120);
    expect(events.map((e) => e.text)).toEqual(["before"]);
    // Claude Code never truncates, but a rewritten file must not corrupt state.
    // Size-shrink is the detectable truncation signal (an in-place rewrite with
    // equal-or-greater length is indistinguishable from an append), so the
    // replacement content here is shorter than the original line.
    fs.writeFileSync(file, JSON.stringify({ type: "user", message: { content: "after" } }) + "\n");
    await sleep(150);
    tailer.stop();
    expect(events.map((e) => e.text)).toEqual(["before", "after"]);
  });

  test("skips unparseable lines and keeps going", async () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      "GARBAGE\n" +
      JSON.stringify({ type: "summary", summary: "skip me" }) + "\n" +
      JSON.stringify({ type: "assistant", message: { content: "kept" } }) + "\n",
    );
    const events: TranscriptEvent[] = [];
    const tailer = new TranscriptTailer(file, collect(events), 25);
    tailer.start();
    await sleep(150);
    tailer.stop();
    expect(events.map((e) => e.text)).toEqual(["kept"]);
  });

  test("stop() stops emitting", async () => {
    const file = tmpFile();
    const events: TranscriptEvent[] = [];
    const tailer = new TranscriptTailer(file, collect(events), 25);
    tailer.start();
    await sleep(80);
    tailer.stop();
    tailer.stop(); // idempotent
    fs.appendFileSync(
      file,
      JSON.stringify({ type: "user", message: { content: "ignored" } }) + "\n",
    );
    await sleep(120);
    expect(events).toEqual([]);
  });
});
