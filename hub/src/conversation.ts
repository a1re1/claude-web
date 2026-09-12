// Conversation access for claude-web: parse ~/.claude/projects transcript
// lines into ConvEntry protocol values, read history in bulk, and tail a
// transcript file incrementally. Supersedes transcript.ts (kept until its
// consumers are rewritten).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ConvEntrySchema, type ConvEntry } from "./protocol";

/* ------------------------------ locating files ------------------------------ */

// /Users/x/src/claude-web/.worktrees/a -> -Users-x-src-claude-web--worktrees-a
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function transcriptPath(
  cwd: string,
  sessionId: string,
  home: string = os.homedir(),
): string {
  return path.join(
    home,
    ".claude",
    "projects",
    encodeProjectDir(cwd),
    `${sessionId}.jsonl`,
  );
}

/* ------------------------------ line parsing -------------------------------- */

interface RawContentBlock {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
  content?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textBlocksOnly(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const raw of content as RawContentBlock[]) {
    if (!isRecord(raw) || raw.type !== "text" || typeof raw.text !== "string") {
      return null;
    }
    parts.push(raw.text);
  }
  return parts.join("\n");
}

// tool_result blocks carry string content or an array of blocks; flatten the
// string or its text blocks into plain text (images and other blocks skipped).
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const raw of content as RawContentBlock[]) {
      if (isRecord(raw) && raw.type === "text" && typeof raw.text === "string") {
        parts.push(raw.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

// Epoch ms from an ISO `timestamp` string, a numeric timestamp, else 0.
function parseTs(timestamp: unknown): number {
  if (typeof timestamp === "string") {
    const t = Date.parse(timestamp);
    return Number.isFinite(t) ? t : 0;
  }
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
  return 0;
}

function usageOf(message: Record<string, unknown>): {
  input: number;
  cacheRead: number;
  cacheCreate: number;
  output: number;
} | null {
  const usage = message.usage;
  if (!isRecord(usage)) return null;
  const num = (key: string): number =>
    typeof usage[key] === "number" && Number.isFinite(usage[key]) ? usage[key] : 0;
  return {
    input: num("input_tokens"),
    cacheRead: num("cache_read_input_tokens"),
    cacheCreate: num("cache_creation_input_tokens"),
    output: num("output_tokens"),
  };
}

function buildEntry(record: Record<string, unknown>): ConvEntry | null {
  const type = record.type;
  const base = {
    uuid: typeof record.uuid === "string" ? record.uuid : randomUUID(),
    ts: parseTs(record.timestamp),
    sidechain: record.isSidechain === true,
  };

  if (type === "ai-title") {
    if (typeof record.aiTitle !== "string") return null;
    return { kind: "title", ...base, text: record.aiTitle };
  }

  if (type === "system") {
    if (typeof record.content !== "string" || record.content === "") return null;
    return {
      kind: "system",
      ...base,
      subtype: typeof record.subtype === "string" ? record.subtype : "",
      level: typeof record.level === "string" ? record.level : null,
      text: record.content,
    };
  }

  if (type !== "user" && type !== "assistant") return null;
  const message = record.message;
  if (!isRecord(message)) return null;
  const content = message.content;

  if (type === "user") {
    if (record.isCompactSummary === true) {
      const compact = typeof content === "string"
        ? content
        : textBlocksOnly(content) ?? "";
      return { kind: "compact", ...base, text: compact };
    }
    if (Array.isArray(content)) {
      // Records carry one tool_result per line; surface the first one.
      for (const raw of content as RawContentBlock[]) {
        if (isRecord(raw) && raw.type === "tool_result") {
          return {
            kind: "tool_result",
            ...base,
            toolUseId: typeof raw.tool_use_id === "string" ? raw.tool_use_id : "",
            text: toolResultText(raw.content),
            isError: raw.is_error === true,
          };
        }
      }
    }
    const text = typeof content === "string" ? content : textBlocksOnly(content);
    if (text === null) return null;
    return { kind: "prompt", ...base, text, meta: record.isMeta === true };
  }

  // Assistant: exactly one content block per line.
  const blocks = Array.isArray(content) ? (content as RawContentBlock[]) : [];
  const block = blocks.length > 0 && isRecord(blocks[0]) ? blocks[0] : null;
  if (block === null) return null;
  const assistantBase = {
    ...base,
    messageId: typeof message.id === "string" ? message.id : null,
    model: typeof message.model === "string" ? message.model : null,
    usage: usageOf(message),
  };
  if (block.type === "text" && typeof block.text === "string") {
    return { kind: "text", ...assistantBase, text: block.text };
  }
  if (block.type === "thinking" && typeof block.thinking === "string") {
    return { kind: "thinking", ...assistantBase, text: block.thinking };
  }
  if (block.type === "tool_use" && typeof block.name === "string") {
    return {
      kind: "tool_use",
      ...assistantBase,
      toolUseId: typeof block.id === "string" ? block.id : "",
      name: block.name,
      input: block.input,
    };
  }
  return null; // image / server_tool_use / anything else
}

// Parse ONE transcript JSONL line into a ConvEntry, or null for anything we
// do not represent (attachments, queue operations, unparseable lines, ...).
// Never throws: JSON errors and schema failures both yield null.
export function parseConvLine(line: string): ConvEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  let entry: ConvEntry | null = null;
  try {
    entry = buildEntry(parsed);
  } catch {
    return null;
  }
  if (entry === null) return null;
  const checked = ConvEntrySchema.safeParse(entry);
  return checked.success ? checked.data : null;
}

/* ----------------------------- bulk history read ---------------------------- */

const DEFAULT_HISTORY_LIMIT = 5000;

// Read a whole transcript and return its entries (only the last `limit`),
// whether older entries were dropped, and the byte size consumed so a tailer
// can continue from there. A missing or unreadable file yields an empty result.
export async function readConversation(
  filePath: string,
  limit: number = DEFAULT_HISTORY_LIMIT,
): Promise<{ entries: ConvEntry[]; truncated: boolean; bytes: number }> {
  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(filePath);
  } catch {
    return { entries: [], truncated: false, bytes: 0 };
  }
  const entries: ConvEntry[] = [];
  for (const line of new TextDecoder().decode(buf).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entry = parseConvLine(trimmed);
    if (entry !== null) entries.push(entry);
  }
  const truncated = entries.length > limit;
  return { entries: truncated ? entries.slice(-limit) : entries, truncated, bytes: buf.byteLength };
}

/* --------------------------------- tailer ----------------------------------- */

const POLL_MS = 500;

interface TailerOptions {
  pollMs?: number;
  startAt?: number; // byte offset to begin from (skip history already read)
}

// Polls a transcript file and emits each newly parsed ConvEntry via `onEvent`.
// Tolerates the file not existing yet, partial UTF-8/JSON lines at the tail,
// and truncation (restarts from the beginning of the file).
export class ConversationTailer {
  private readonly filePath: string;
  private readonly onEvent: (entry: ConvEntry) => void;
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private position = 0; // byte offset of fully-consumed content
  private carry = ""; // partial line held back across polls
  private fingerprint = ""; // size+mtime of the last poll, detects truncation
  private seenStat = false; // don't treat a pre-truncated file as a restart

  private decoder = new TextDecoder();
  private polling = false;

  constructor(filePath: string, onEvent: (entry: ConvEntry) => void, opts: TailerOptions = {}) {
    this.filePath = filePath;
    this.onEvent = onEvent;
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.position = opts.startAt ?? 0;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private emitLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    const entry = parseConvLine(trimmed);
    if (entry === null) return; // not a representable line, or unparseable
    try {
      this.onEvent(entry);
    } catch (err) {
      console.error("[claude-web] conversation event handler failed:", err);
    }
  }

  // Byte-accurate incremental read: `position` counts file bytes (slice offsets
  // are byte-based), the streaming TextDecoder holds back partial UTF-8
  // sequences, and `carry` holds back a partial final line until its newline
  // arrives.
  private async poll(): Promise<void> {
    if (this.polling) return; // never overlap polls
    this.polling = true;
    try {
      let size: number;
      let mtimeMs: number;
      try {
        // Bun's callback-style fs.stat(path) does not return a promise — it
        // throws ERR_INVALID_ARG_TYPE when awaited without a callback. Use
        // fs.promises.stat instead.
        const stat = await fs.promises.stat(this.filePath); // throws when the file does not exist yet
        size = stat.size;
        mtimeMs = stat.mtimeMs;
      } catch {
        return; // unreadable: try again next tick
      }
      const fingerprint = `${size}:${mtimeMs}`;
      if (size < this.position) {
        // Truncated or rewritten: start over from the beginning. Before the
        // first successful stat, history below startAt is simply gone.
        if (!this.seenStat) this.position = size;
        else {
          this.position = 0;
          this.carry = "";
          this.decoder = new TextDecoder();
        }
      }
      this.seenStat = true;
      this.fingerprint = fingerprint;
      if (size === this.position) return;

      const chunk = new Uint8Array(
        await Bun.file(this.filePath).slice(this.position).arrayBuffer(),
      );
      this.position += chunk.byteLength;
      const text = this.decoder.decode(chunk, { stream: true });
      const lines = (this.carry + text).split("\n");
      this.carry = lines.pop() ?? ""; // last element is a possibly-incomplete line
      for (const line of lines) this.emitLine(line);
    } catch (err) {
      console.error("[claude-web] conversation tail failed:", err);
    } finally {
      this.polling = false;
    }
  }
}
