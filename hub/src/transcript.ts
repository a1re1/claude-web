// Transcript access for claude-web: locate Claude Code session transcripts,
// parse them line-by-line into compact events, and tail them as they grow.
//
// Transcripts live at ~/.claude/projects/<encodedCwd>/<sessionId>.jsonl where
// encodedCwd is the absolute cwd with every character that is not
// [A-Za-z0-9] replaced by '-'.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

export interface ToolCall {
  name: string;
  input: unknown;
}

// A compact view of one user/assistant transcript line.
export interface TranscriptEvent {
  role: "user" | "assistant";
  text: string;
  tools: ToolCall[];
  ts: number;
}

interface RawContentBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: unknown;
  content?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// tool_result blocks may carry string content or an array of blocks; flatten
// either shape into plain text for the compact view.
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content as RawContentBlock[]) {
      if (isRecord(block) && typeof block.text === "string") parts.push(block.text);
    }
    return parts.join("\n");
  }
  return "";
}

// message.content: a plain string, or an array of typed blocks.
function extractParts(content: unknown): { text: string; tools: ToolCall[]; toolResults: string[] } {
  const textParts: string[] = [];
  const tools: ToolCall[] = [];
  const toolResults: string[] = [];

  if (typeof content === "string") {
    textParts.push(content);
  } else if (Array.isArray(content)) {
    for (const raw of content as RawContentBlock[]) {
      if (!isRecord(raw)) continue;
      if (raw.type === "text" && typeof raw.text === "string") {
        textParts.push(raw.text);
      } else if (raw.type === "tool_use" && typeof raw.name === "string") {
        tools.push({ name: raw.name, input: raw.input });
      } else if (raw.type === "tool_result") {
        const t = toolResultText(raw.content);
        if (t) toolResults.push(t);
      }
      // everything else (images, thinking, ...) is ignored
    }
  }
  return { text: textParts.join("\n"), tools, toolResults };
}

// Parse one .jsonl transcript line into a TranscriptEvent, or return null for
// anything that is not a user/assistant message we care about. Never throws.
export function parseTranscriptLine(line: string): TranscriptEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.type !== "user" && parsed.type !== "assistant") return null;

  const message = parsed.message;
  if (!isRecord(message)) return null;

  const { text, tools, toolResults } = extractParts(message.content);

  // Timestamp: transcript lines carry an ISO `timestamp`; fall back to mtime-ish 0.
  let ts = 0;
  if (typeof parsed.timestamp === "string") {
    const t = Date.parse(parsed.timestamp);
    if (Number.isFinite(t)) ts = t;
  } else if (typeof parsed.timestamp === "number" && Number.isFinite(parsed.timestamp)) {
    ts = parsed.timestamp;
  }

  const result: TranscriptEvent = {
    role: parsed.type === "user" ? "user" : "assistant",
    text,
    tools,
    ts,
  };
  if (toolResults.length > 0) {
    // Surface tool results as trailing text so the UI can show what came back.
    result.text = result.text
      ? `${result.text}\n${toolResults.join("\n")}`
      : toolResults.join("\n");
  }
  return result;
}

/* --------------------------------- tailer ----------------------------------- */

const POLL_MS = 500;

// Polls a transcript file and emits each newly parsed event via `onEvent`.
// Tolerates the file not existing yet, partial UTF-8/JSON lines at the tail,
// and truncation (restarts from the beginning of the file).
export class TranscriptTailer {
  private readonly filePath: string;
  private readonly onEvent: (event: TranscriptEvent) => void;
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private position = 0; // byte offset of fully-consumed content
  private carry = ""; // partial line held back across polls
  private fingerprint = ""; // size+mtime of the last poll, detects truncation

  constructor(filePath: string, onEvent: (event: TranscriptEvent) => void, pollMs = POLL_MS) {
    this.filePath = filePath;
    this.onEvent = onEvent;
    this.pollMs = pollMs;
  }

  private decoder = new TextDecoder();
  private polling = false;

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
    const event = parseTranscriptLine(trimmed);
    if (event === null) return; // not a user/assistant line, or unparseable
    try {
      this.onEvent(event);
    } catch (err) {
      console.error("[claude-web] transcript event handler failed:", err);
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
        // the sync form (or fs.promises.stat) instead.
        const stat = fs.statSync(this.filePath); // throws when the file does not exist yet
        size = stat.size;
        mtimeMs = stat.mtimeMs;
      } catch {
        return; // unreadable: try again next tick
      }
      const fingerprint = `${size}:${mtimeMs}`;
      if (fingerprint !== this.fingerprint && size < this.position) {
        // Truncated or rewritten: start over from the beginning.
        this.position = 0;
        this.carry = "";
        this.decoder = new TextDecoder();
      }
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
      console.error("[claude-web] transcript tail failed:", err);
    } finally {
      this.polling = false;
    }
  }
}
