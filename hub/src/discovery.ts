// Session discovery for claude-web: list Claude Code sessions for a launch
// directory from on-disk transcripts (~/.claude/projects) merged with the live
// process registry (~/.claude/sessions), reading large transcripts in bounded
// first/last windows and caching per-file metadata between refreshes.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RegistryEntry, SessionInfo } from "./protocol";
import { encodeProjectDir, parseConvLine } from "./conversation";

/* --------------------------------- registry --------------------------------- */

// Reads ~/.claude/sessions/<pid>.json files into RegistryEntry values. *.key
// files, unparseable files, and records missing required fields are ignored;
// `alive` is kill(pid, 0): success or EPERM means the process exists.
export function readRegistry(home: string = os.homedir()): RegistryEntry[] {
  const dir = path.join(home, ".claude", "sessions");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // no ~/.claude/sessions (or unreadable): no registry entries
  }
  const entries: RegistryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue; // skips *.key companions
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue; // unparseable file
    }
    const r = asRecord(raw);
    if (r === null) continue;
    const pid = r.pid;
    const sessionId = r.sessionId;
    const cwd = r.cwd;
    if (typeof pid !== "number" || !Number.isInteger(pid)) continue;
    if (typeof sessionId !== "string" || typeof cwd !== "string") continue;
    entries.push({
      pid,
      sessionId,
      cwd,
      status: typeof r.status === "string" ? r.status : null,
      name: typeof r.name === "string" ? r.name : null,
      kind: typeof r.kind === "string" ? r.kind : null,
      startedAt: typeof r.startedAt === "number" ? r.startedAt : null,
      updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : null,
      alive: isAlive(pid),
    });
  }
  return entries;
}

// Whether a process exists: kill(pid, 0) succeeds, or fails with EPERM (the
// process exists but belongs to another user). ESRCH and anything else: no.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/* ------------------------------- path helpers -------------------------------- */

// True when `cwd` is `rootCwd` itself or a path underneath it (component-wise,
// so a sibling directory sharing a prefix does not count).
export function isUnder(rootCwd: string, cwd: string): boolean {
  return cwd === rootCwd || cwd.startsWith(rootCwd + path.sep);
}

/* ------------------------------ transcript scan ------------------------------ */

const SCAN_WINDOW = 64 * 1024; // read at most the first/last 64 KiB
const SCAN_WHOLE = 2 * SCAN_WINDOW; // files up to 128 KiB are read whole

// Metadata scanned out of one transcript's first/last windows.
interface TranscriptMeta {
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  firstPrompt: string | null;
  startedAt: number | null; // first non-meta prompt's timestamp
  lastPrompt: string | null; // latest last-prompt record or non-meta prompt
  title: string | null; // last ai-title record
}

// Complete lines only: a window boundary can cut a line (or a UTF-8 sequence)
// in half, so `head`/`whole` drop the trailing partial line and `tail` drops
// both the leading and the trailing partial line.
function completeLines(text: string, mode: "head" | "tail" | "whole"): string[] {
  const firstNl = text.indexOf("\n");
  const lastNl = text.lastIndexOf("\n");
  if (mode === "tail") {
    return firstNl === -1 || firstNl === lastNl
      ? []
      : text.slice(firstNl + 1, lastNl).split("\n");
  }
  return lastNl === -1 ? [] : text.slice(0, lastNl).split("\n");
}

// Scan complete JSONL lines for session metadata: cwd/gitBranch/version from
// the first user or assistant record carrying them, the first non-meta prompt
// (and its timestamp), the last-prompt record (else the last non-meta prompt),
// and the last ai-title record.
function scanMeta(lines: string[]): TranscriptMeta {
  const meta: TranscriptMeta = {
    cwd: null,
    gitBranch: null,
    version: null,
    firstPrompt: null,
    startedAt: null,
    lastPrompt: null,
    title: null,
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // garbage line in the window
    }
    const r = asRecord(parsed);
    if (r === null) continue;
    const type = r.type;
    if (type === "last-prompt") {
      if (typeof r.lastPrompt === "string") meta.lastPrompt = r.lastPrompt;
      continue;
    }
    if (type === "ai-title") {
      if (typeof r.aiTitle === "string") meta.title = r.aiTitle;
      continue;
    }
    if (type !== "user" && type !== "assistant") continue;
    if (meta.cwd === null && typeof r.cwd === "string") {
      meta.cwd = r.cwd;
    }
    if (meta.gitBranch === null && typeof r.gitBranch === "string") {
      meta.gitBranch = r.gitBranch;
    }
    if (meta.version === null && typeof r.version === "string") {
      meta.version = r.version;
    }
    const entry = parseConvLine(trimmed);
    if (entry !== null && entry.kind === "prompt" && !entry.meta) {
      if (meta.firstPrompt === null) {
        meta.firstPrompt = entry.text;
        meta.startedAt = entry.ts > 0 ? entry.ts : null;
      }
      meta.lastPrompt = entry.text; // whichever comes later in the file wins
    }
  }
  return meta;
}

// Title precedence: last ai-title record, else the first line of firstPrompt
// (trimmed, capped at 120 chars), else null.
function titleFrom(meta: TranscriptMeta): string | null {
  if (meta.title !== null) return meta.title;
  if (meta.firstPrompt !== null) {
    const firstLine = meta.firstPrompt.split("\n")[0] ?? "";
    return firstLine.trim().slice(0, 120);
  }
  return null;
}

// Read the first and last 64 KiB of a file (concatenated) without reading the
// middle. Only called for files larger than 128 KiB, so both reads are full.
async function readWindows(filePath: string, size: number): Promise<Buffer> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const head = Buffer.alloc(SCAN_WINDOW);
    await handle.read(head, 0, SCAN_WINDOW, 0);
    const tail = Buffer.alloc(SCAN_WINDOW);
    await handle.read(tail, 0, SCAN_WINDOW, size - SCAN_WINDOW);
    return Buffer.concat([head, tail]);
  } finally {
    await handle.close();
  }
}

/* -------------------------------- session index ------------------------------ */

interface CacheEntry {
  key: string; // `${mtimeMs}:${size}` fingerprint of the scan
  meta: TranscriptMeta;
}

// Discovers Claude Code sessions under `rootCwd`: every transcript directly
// inside ~/.claude/projects/<encoded> (or <encoded>-<suffix> for worktrees),
// merged with live registry entries from readRegistry(). Files larger than
// 128 KiB are read only in bounded first/last 64 KiB windows, and per-file
// metadata is cached by path+mtime+size so unchanged files are not re-scanned.
export class SessionIndex {
  private readonly rootCwd: string;
  private readonly home: string;
  private readonly cache = new Map<string, CacheEntry>(); // keyed by file path
  private sessions: SessionInfo[] = [];
  private cwdFallback = new Set<string>(); // ids whose cwd is the rootCwd fallback, per refresh

  constructor(opts: { rootCwd: string; home?: string }) {
    this.rootCwd = opts.rootCwd;
    this.home = opts.home ?? os.homedir();
  }

  // Re-scan project dirs and registry; returns sessions sorted running-first
  // then by updatedAt (newest first). Never throws: a missing ~/.claude
  // simply yields [].
  async refresh(): Promise<SessionInfo[]> {
    const projectsDir = path.join(this.home, ".claude", "projects");
    const prefix = encodeProjectDir(this.rootCwd);
    let dirNames: string[];
    try {
      dirNames = await fs.promises.readdir(projectsDir);
    } catch {
      this.sessions = [];
      return [];
    }
    const seen = new Set<string>();
    const byId = new Map<string, SessionInfo>();
    this.cwdFallback = new Set();
    for (const dirName of dirNames) {
      if (dirName !== prefix && !dirName.startsWith(prefix + "-")) continue;
      let dirents: fs.Dirent[];
      try {
        dirents = await fs.promises.readdir(path.join(projectsDir, dirName), {
          withFileTypes: true,
        });
      } catch {
        continue; // raced away between listing and reading
      }
      for (const dirent of dirents) {
        if (!dirent.isFile() || !dirent.name.endsWith(".jsonl")) continue;
        const filePath = path.join(projectsDir, dirName, dirent.name);
        if (seen.has(filePath)) continue;
        seen.add(filePath);
        const info = await this.scanTranscript(filePath);
        // The slug encoding is lossy ("/x/app 2" and "/x/app/2" both become
        // "-x-app-2"), so the directory prefix is only a pre-filter: the cwd
        // recorded in the transcript decides.
        if (info !== null && isUnder(this.rootCwd, info.cwd)) byId.set(info.id, info);
      }
    }
    this.mergeRegistry(byId);
    const sessions = [...byId.values()].sort(compareSessions);
    this.sessions = sessions;
    for (const filePath of [...this.cache.keys()]) {
      if (!seen.has(filePath)) this.cache.delete(filePath); // stale eviction
    }
    return sessions;
  }

  // The most recent refresh()'s session with the given id, if any.
  get(id: string): SessionInfo | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  // Scan one transcript (cache-aware) into a not-yet-running SessionInfo.
  private async scanTranscript(filePath: string): Promise<SessionInfo | null> {
    let size = 0;
    let mtimeMs = 0;
    try {
      const stat = await fs.promises.stat(filePath);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      return null; // raced away between listing and reading
    }
    const key = `${mtimeMs}:${size}`;
    const cached = this.cache.get(filePath);
    if (cached !== undefined && cached.key === key) {
      return this.toInfo(filePath, cached.meta, size, mtimeMs);
    }
    let lines: string[];
    try {
      if (size <= SCAN_WHOLE) {
        const text = new TextDecoder().decode(await fs.promises.readFile(filePath));
        lines = completeLines(text, "whole");
      } else {
        const buf = await readWindows(filePath, size);
        const head = completeLines(
          new TextDecoder().decode(buf.subarray(0, SCAN_WINDOW)),
          "head",
        );
        const tail = completeLines(
          new TextDecoder().decode(buf.subarray(SCAN_WINDOW)),
          "tail",
        );
        lines = [...head, ...tail];
      }
    } catch {
      return null; // unreadable: skip until the next refresh
    }
    const meta = scanMeta(lines);
    this.cache.set(filePath, { key, meta });
    return this.toInfo(filePath, meta, size, mtimeMs);
  }

  private toInfo(
    filePath: string,
    meta: TranscriptMeta,
    size: number,
    mtimeMs: number,
  ): SessionInfo {
    const id = path.basename(filePath).replace(/\.jsonl$/, "");
    if (meta.cwd === null) this.cwdFallback.add(id);
    return {
      id,
      cwd: meta.cwd ?? this.rootCwd,
      transcriptPath: filePath,
      title: titleFrom(meta),
      firstPrompt: meta.firstPrompt,
      lastPrompt: meta.lastPrompt,
      gitBranch: meta.gitBranch,
      version: meta.version,
      startedAt: meta.startedAt,
      updatedAt: mtimeMs,
      sizeBytes: size,
      running: false,
      busy: false,
      pid: null,
      name: null,
    };
  }

  // Merge alive registry entries whose cwd is under rootCwd: a matching
  // transcript becomes running (with pid/name/busy); a live entry without a
  // transcript yet appears as a transcript-less SessionInfo.
  private mergeRegistry(byId: Map<string, SessionInfo>): void {
    const live = readRegistry(this.home).filter(
      (entry) => entry.alive && isUnder(this.rootCwd, entry.cwd),
    );
    for (const entry of live) {
      const existing = byId.get(entry.sessionId);
      if (existing !== undefined) {
        existing.running = true;
        existing.busy = entry.status === "busy";
        existing.pid = entry.pid;
        existing.name = entry.name;
        if (this.cwdFallback.has(existing.id)) existing.cwd = entry.cwd;
      } else {
        byId.set(entry.sessionId, {
          id: entry.sessionId,
          cwd: entry.cwd,
          transcriptPath: null,
          title: entry.name,
          firstPrompt: null,
          lastPrompt: null,
          gitBranch: null,
          version: null,
          startedAt: entry.startedAt,
          updatedAt: entry.updatedAt,
          sizeBytes: 0,
          running: true,
          busy: entry.status === "busy",
          pid: entry.pid,
          name: entry.name,
        });
      }
    }
  }
}

// Running sessions first, then by updatedAt (newest first); nulls sort last.
function compareSessions(a: SessionInfo, b: SessionInfo): number {
  if (a.running !== b.running) return a.running ? -1 : 1;
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}
