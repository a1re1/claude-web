// Tests for hub/src/conversation.ts: project-dir encoding, transcript path
// construction, ConvEntry parsing of every fixture record shape (plus
// malformed input), bulk history reads, and the incremental ConversationTailer.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ConversationTailer,
  encodeProjectDir,
  parseConvLine,
  readConversation,
  transcriptPath,
} from "../src/conversation";
import type { ConvEntry } from "../src/protocol";

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

/* ---------------------------- fixture parsing ------------------------------- */

// One record of each shape, in file order. Both fixture `system` records carry
// null `content`, so they drop (the positive system case is constructed below).
const fixtureLines: string[] = fs
  .readFileSync(path.join(import.meta.dir, "fixtures", "transcript.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");

const fixtureEntries: (ConvEntry | null)[] = fixtureLines.map(parseConvLine);

describe("parseConvLine against the fixture", () => {
  test("line 1: string-content user prompt", () => {
    const e = fixtureEntries[0];
    expect(e?.kind).toBe("prompt");
    if (e?.kind !== "prompt") return;
    expect(e.text.startsWith("claude code support channels")).toBe(true);
    expect(e.meta).toBe(false);
    expect(e.uuid).toBe("8db16457-bbbe-4664-8990-df3a6500f32a");
    expect(e.ts).toBe(Date.parse("2026-09-12T00:02:33.874Z"));
    expect(e.sidechain).toBe(false);
  });

  test("line 2: attachment drops", () => {
    expect(fixtureEntries[1]).toBeNull();
  });

  test("line 3: last-prompt drops", () => {
    expect(fixtureEntries[2]).toBeNull();
  });

  test("line 4: ai-title becomes a title with synthesized uuid and ts 0", () => {
    const e = fixtureEntries[3];
    expect(e?.kind).toBe("title");
    if (e?.kind !== "title") return;
    expect(e.text).toBe("Custom web UI channel plugin");
    expect(e.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.ts).toBe(0);
  });

  test("line 5: thinking block with usage numbers", () => {
    const e = fixtureEntries[4];
    expect(e?.kind).toBe("thinking");
    if (e?.kind !== "thinking") return;
    expect(e.messageId).toBe("msg_011CexZi6k1WbTj8SnTo692p");
    expect(e.model).toBe("claude-fable-5-1");
    expect(e.usage).toEqual({ input: 2, cacheRead: 30516, cacheCreate: 9062, output: 337 });
  });

  test("line 6: assistant text block", () => {
    const e = fixtureEntries[5];
    expect(e?.kind).toBe("text");
    if (e?.kind !== "text") return;
    expect(e.text.startsWith("Restating the goal")).toBe(true);
    expect(e.usage).toEqual({ input: 2, cacheRead: 30516, cacheCreate: 9062, output: 337 });
  });

  test("line 7: tool_use block with name and input", () => {
    const e = fixtureEntries[6];
    expect(e?.kind).toBe("tool_use");
    if (e?.kind !== "tool_use") return;
    expect(e.toolUseId).toBe("toolu_01BstWEBbNT6xKG1ktLQNLKe");
    expect(e.name).toBe("Skill");
    expect((e.input as { skill?: string }).skill).toBe("spellcraft:navis");
  });

  test("line 8: tool_result with string content", () => {
    const e = fixtureEntries[7];
    expect(e?.kind).toBe("tool_result");
    if (e?.kind !== "tool_result") return;
    expect(e.toolUseId).toBe("toolu_01BstWEBbNT6xKG1ktLQNLKe");
    expect(e.text).toBe("Launching skill: spellcraft:navis");
    expect(e.isError).toBe(false);
  });

  test("line 9: meta user prompt (skill body)", () => {
    const e = fixtureEntries[8];
    expect(e?.kind).toBe("prompt");
    if (e?.kind !== "prompt") return;
    expect(e.meta).toBe(true);
    expect(e.text.startsWith("Base directory for this skill:")).toBe(true);
  });

  test("line 10: tool_result whose content has no text blocks", () => {
    const e = fixtureEntries[9];
    expect(e?.kind).toBe("tool_result");
    if (e?.kind !== "tool_result") return;
    expect(e.toolUseId).toBe("toolu_01FBVWrXpUz6kKzRXAzj7oef");
    expect(e.text).toBe("");
  });

  test("lines 11-12: system records with null content drop", () => {
    expect(fixtureEntries[10]).toBeNull();
    expect(fixtureEntries[11]).toBeNull();
  });

  test("line 13: queue-operation drops", () => {
    expect(fixtureEntries[12]).toBeNull();
  });

  test("line 14: compact summary", () => {
    const e = fixtureEntries[13];
    expect(e?.kind).toBe("compact");
    if (e?.kind !== "compact") return;
    expect(e.text.startsWith("This session is being continued")).toBe(true);
    expect(e.uuid).toBe("c4f06d30-cfd5-446c-86f8-e0131e2c7a75");
  });
});

/* --------------------------- constructed parsing ---------------------------- */

function userLine(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: "hello" },
    uuid: "u-1",
    timestamp: "2026-09-12T00:00:00.000Z",
    ...extra,
  });
}

describe("parseConvLine constructed cases", () => {
  test("assistant record without usage yields usage null", () => {
    const e = parseConvLine(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        uuid: "a-1",
      }),
    );
    expect(e).toEqual({
      kind: "text",
      uuid: "a-1",
      ts: 0,
      sidechain: false,
      messageId: null,
      model: null,
      usage: null,
      text: "hi",
    });
  });

  test("missing message.id falls back to null messageId; numeric timestamp passes through", () => {
    const e = parseConvLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "m",
          usage: { input_tokens: 4 },
          content: [{ type: "text", text: "x" }],
        },
        timestamp: 1789171211911,
      }),
    );
    expect(e?.kind).toBe("text");
    if (e?.kind !== "text") return;
    expect(e.messageId).toBeNull();
    expect(e.usage).toEqual({ input: 4, cacheRead: 0, cacheCreate: 0, output: 0 });
    expect(e.ts).toBe(1789171211911);
  });

  test("unparseable JSON, non-object lines, and unknown types all yield null", () => {
    expect(parseConvLine("{not json")).toBeNull();
    expect(parseConvLine("42")).toBeNull();
    expect(parseConvLine('"a string"')).toBeNull();
    expect(parseConvLine("null")).toBeNull();
    expect(parseConvLine(JSON.stringify({ type: "progress", n: 1 }))).toBeNull();
    expect(parseConvLine(JSON.stringify({ type: "file-history-snapshot" }))).toBeNull();
    expect(parseConvLine(JSON.stringify({ type: "summary", summary: "s" }))).toBeNull();
    expect(parseConvLine("")).toBeNull();
  });

  test("user records with unsupported content shapes yield null", () => {
    expect(parseConvLine(userLine({ message: { role: "user", content: 42 } }))).toBeNull();
    expect(
      parseConvLine(
        userLine({
          message: { role: "user", content: [{ type: "image", source: {} }] },
        }),
      ),
    ).toBeNull();
    expect(parseConvLine(userLine({ message: null }))).toBeNull();
  });

  test("assistant records with unknown or missing blocks yield null", () => {
    expect(
      parseConvLine(
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "image", source: {} }] },
        }),
      ),
    ).toBeNull();
    expect(
      parseConvLine(JSON.stringify({ type: "assistant", message: { role: "assistant" } })),
    ).toBeNull();
  });

  test("system record with non-empty string content parses", () => {
    const e = parseConvLine(
      JSON.stringify({
        type: "system",
        subtype: "hook_summary",
        content: "hooks ran",
        level: "info",
        uuid: "s-1",
        timestamp: "2026-09-12T00:00:01.000Z",
        isSidechain: true,
      }),
    );
    expect(e).toEqual({
      kind: "system",
      uuid: "s-1",
      ts: Date.parse("2026-09-12T00:00:01.000Z"),
      sidechain: true,
      subtype: "hook_summary",
      level: "info",
      text: "hooks ran",
    });
  });

  test("system record with empty content and missing subtype/level defaults", () => {
    expect(parseConvLine(JSON.stringify({ type: "system", content: "" }))).toBeNull();
    const e = parseConvLine(JSON.stringify({ type: "system", content: "notice" }));
    expect(e?.kind).toBe("system");
    if (e?.kind !== "system") return;
    expect(e.subtype).toBe("");
    expect(e.level).toBeNull();
  });

  test("missing uuid is synthesized and a bad ISO timestamp maps to 0", () => {
    const e = parseConvLine(userLine({ uuid: undefined, timestamp: "not-a-date" }));
    expect(e?.kind).toBe("prompt");
    if (e?.kind !== "prompt") return;
    expect(e.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.ts).toBe(0);
  });

  test("is_error and isMeta are coerced with !! semantics", () => {
    const r = parseConvLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }],
        },
        uuid: "u-2",
      }),
    );
    expect(r?.kind).toBe("tool_result");
    if (r?.kind !== "tool_result") return;
    expect(r.isError).toBe(true);
  });

  test("tool_result array content joins only text blocks", () => {
    const r = parseConvLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t2",
              content: [
                { type: "text", text: "part one" },
                { type: "image", source: {} },
                { type: "text", text: "part two" },
              ],
            },
          ],
        },
      }),
    );
    expect(r?.kind).toBe("tool_result");
    if (r?.kind !== "tool_result") return;
    expect(r.text).toBe("part one\npart two");
  });

  test("compact summary with text blocks joins them", () => {
    const e = parseConvLine(
      JSON.stringify({
        type: "user",
        isCompactSummary: true,
        message: { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      }),
    );
    expect(e?.kind).toBe("compact");
    if (e?.kind !== "compact") return;
    expect(e.text).toBe("a\nb");
  });
});

/* ------------------------------ history read -------------------------------- */

describe("readConversation", () => {
  test("returns the last `limit` entries with truncated flag and byte count", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-read-"));
    const file = path.join(dir, "s.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      lines.push(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: `prompt ${i}` },
          uuid: `u-${i}`,
          timestamp: "2026-09-12T00:00:00.000Z",
        }),
      );
    }
    fs.writeFileSync(file, lines.join("\n") + "\n");

    const full = await readConversation(file);
    expect(full.entries.length).toBe(5);
    expect(full.truncated).toBe(false);
    expect(full.bytes).toBe(fs.statSync(file).size);

    const limited = await readConversation(file, 2);
    expect(limited.entries.length).toBe(2);
    expect(limited.truncated).toBe(true);
    expect(limited.entries.map((e) => (e.kind === "prompt" ? e.text : ""))).toEqual([
      "prompt 3",
      "prompt 4",
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a missing file yields empty entries, no truncation, zero bytes", async () => {
    const r = await readConversation(path.join(os.tmpdir(), "no-such-file.jsonl"));
    expect(r).toEqual({ entries: [], truncated: false, bytes: 0 });
  });
});

/* --------------------------------- tailer ----------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function promptLine(text: string, uuid: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    uuid,
    timestamp: "2026-09-12T00:00:00.000Z",
  });
}

// Polls `check` until it returns true or the timeout elapses.
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

describe("ConversationTailer", () => {
  test("emits appended lines once, honours startAt, handles partial lines", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-tail-"));
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, promptLine("first", "u-1") + "\n");

    const history = await readConversation(file);
    expect(history.bytes).toBe(fs.statSync(file).size);
    const emitted: ConvEntry[] = [];
    const tailer = new ConversationTailer(
      file,
      (entry) => emitted.push(entry),
      { pollMs: 20, startAt: history.bytes },
    );
    tailer.start();

    // startAt: the existing line is not re-emitted.
    await sleep(80);
    expect(emitted.length).toBe(0);

    // A partial line: half the JSON, no newline, then the rest.
    const appended = promptLine("second", "u-2") + "\n";
    const mid = Math.floor(appended.length / 2);
    fs.appendFileSync(file, appended.slice(0, mid));
    await sleep(80);
    expect(emitted.length).toBe(0); // carried across polls, not emitted
    fs.appendFileSync(file, appended.slice(mid));
    await waitFor(() => emitted.length === 1);

    // A multibyte character split across two polls still decodes once.
    const third = promptLine("third héllo wörld", "u-3") + "\n";
    const raw = Buffer.from(third, "utf8");
    const split = raw.indexOf(Buffer.from("é", "utf8")) + 1; // split inside the 2-byte char
    fs.appendFileSync(file, raw.subarray(0, split));
    fs.appendFileSync(file, raw.subarray(split));
    await waitFor(() => emitted.length === 2);

    expect(emitted.map((e) => (e.kind === "prompt" ? e.text : ""))).toEqual([
      "second",
      "third héllo wörld",
    ]);
    // No duplicate emissions for any uuid.
    const uuids = emitted.map((e) => e.uuid);
    expect(new Set(uuids).size).toBe(uuids.length);
    tailer.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("without startAt it emits existing history, then appends", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-tail2-"));
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, promptLine("first", "u-1") + "\n");

    const emitted: ConvEntry[] = [];
    const tailer = new ConversationTailer(file, (entry) => emitted.push(entry), { pollMs: 20 });
    tailer.start();
    await waitFor(() => emitted.length === 1);

    fs.appendFileSync(file, promptLine("second", "u-2") + "\n");
    await waitFor(() => emitted.length === 2);
    expect(emitted.map((e) => (e.kind === "prompt" ? e.text : ""))).toEqual(["first", "second"]);
    tailer.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("restarts from the beginning when the file shrinks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-tail3-"));
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, promptLine("first", "u-1") + "\n" + promptLine("second", "u-2") + "\n");

    const emitted: ConvEntry[] = [];
    const tailer = new ConversationTailer(file, (entry) => emitted.push(entry), { pollMs: 20 });
    tailer.start();
    await waitFor(() => emitted.length === 2);

    // Truncate to one line: the tailer must restart and re-emit it.
    fs.writeFileSync(file, promptLine("fresh", "u-9") + "\n");
    await waitFor(() => emitted.length === 3);
    const last = emitted[emitted.length - 1];
    if (!last || last.kind !== "prompt") {
      throw new Error("tailer should emit a prompt after truncation");
    }
    expect(last.text).toBe("fresh");
    tailer.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/* -------------------------------- images ------------------------------------ */

describe("parseConvLine with inline images", () => {
  const PNG = "iVBORw0KGgo="; // any base64 will do; the parser does not decode it
  const user = (content: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "user", uuid: "u-img", timestamp: "2026-09-13T12:05:00.000Z", message: { role: "user", content }, ...extra });

  test("a prompt with a pasted image keeps its text and carries the image", () => {
    const e = parseConvLine(
      user([
        { type: "text", text: "what is this a picture of? [Image #1]" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
      ]),
    );
    expect(e?.kind).toBe("prompt");
    if (e?.kind !== "prompt") return;
    expect(e.text).toBe("what is this a picture of? [Image #1]");
    expect(e.images).toEqual([{ mediaType: "image/png", data: PNG }]);
    expect(e.meta).toBe(false);
  });

  test("an image-only prompt still renders (empty text, one image)", () => {
    const e = parseConvLine(user([{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: PNG } }]));
    expect(e?.kind).toBe("prompt");
    if (e?.kind !== "prompt") return;
    expect(e.text).toBe("");
    expect(e.images[0]?.mediaType).toBe("image/jpeg");
  });

  test("unknown block types are skipped instead of dropping the prompt", () => {
    const e = parseConvLine(user([{ type: "document", source: {} }, { type: "text", text: "see attached" }]));
    expect(e?.kind).toBe("prompt");
    if (e?.kind !== "prompt") return;
    expect(e.text).toBe("see attached");
    expect(e.images).toEqual([]);
  });

  test("a prompt with neither text nor images drops", () => {
    expect(parseConvLine(user([{ type: "document", source: {} }]))).toBeNull();
  });

  test("string prompts and tool results without images have an empty images list", () => {
    const p = parseConvLine(user("plain"));
    expect(p?.kind === "prompt" && p.images).toEqual([]);
    const r = parseConvLine(user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]));
    expect(r?.kind === "tool_result" && r.images).toEqual([]);
  });

  test("a tool result carrying an image (Claude read a picture) exposes it", () => {
    const e = parseConvLine(
      user([
        {
          type: "tool_result",
          tool_use_id: "t2",
          content: [
            { type: "text", text: "Read 1 image" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
          ],
        },
      ]),
    );
    expect(e?.kind).toBe("tool_result");
    if (e?.kind !== "tool_result") return;
    expect(e.toolUseId).toBe("t2");
    expect(e.text).toBe("Read 1 image");
    expect(e.images).toEqual([{ mediaType: "image/png", data: PNG }]);
  });
});
