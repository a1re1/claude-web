// Process management for the claude-web hub: spawn Claude Code under a PTY,
// keep a bounded ring buffer of terminal output for late joiners, and expose
// message/stop/write/resize/kill controls. Only sessions the hub started live
// here; sessions started elsewhere are discovered from disk (see discovery.ts)
// and are read-only.
//
// Terminal output is broadcast as base64 `pty` events; lifecycle changes as
// `session` / `session_removed` events (see onEvent).

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";

/* ---------------------------------- events ---------------------------------- */

export type SpawnedStatus = "running" | "exited";

// What the hub knows about a process it spawned. Merged with the transcript
// metadata from discovery.ts into the wire-level Session.
export interface SpawnedInfo {
  id: string;
  name: string | null;
  cwd: string;
  pid: number | null;
  status: SpawnedStatus;
  exitCode: number | null;
  exitSignal: string | null;
  createdAt: number;
}

// Thrown by the control verbs when the target process is no longer running.
export class SessionExitedError extends Error {
  constructor(id: string) {
    super(`session ${id} has exited`);
    this.name = "SessionExitedError";
  }
}

export type SessionEvent =
  | { type: "pty"; id: string; data: string } // base64 of raw PTY bytes
  | { type: "session"; session: SpawnedInfo }
  | { type: "session_removed"; id: string }; // removed explicitly or evicted by the exited cap

/* --------------------------------- constants -------------------------------- */

const RING_BYTES = 256 * 1024; // 256 KiB of recent PTY output for late joiners
const EXITED_RING_BYTES = 32 * 1024; // retained after exit, until removed or evicted
const MAX_EXITED = 50; // exited sessions kept for post-mortems; oldest evicted beyond this
const KILL_GRACE_MS = 3_000; // SIGTERM -> SIGKILL delay
const PROMPT_SETTLE_MS = 700; // quiet time after the input box appears before typing the first prompt
const DEFAULT_HUB_URL = "ws://127.0.0.1:8790";

/* ---------------------------------- records --------------------------------- */

interface SessionRecord extends SpawnedInfo {
  proc?: Bun.Subprocess<"ignore", "ignore", "ignore">;
  terminal?: { write(data: string | Uint8Array): void; resize(cols: number, rows: number): void };
  ring?: RingBuffer;
  killTimer?: ReturnType<typeof setTimeout>;
  promptTimer?: ReturnType<typeof setTimeout>;
  pendingPrompt: string | null; // typed once the input box shows up
  promptDecoder?: TextDecoder; // streaming decoder so a marker split across chunks still matches
  removed: boolean;
}

// Byte-bounded FIFO that keeps the most recent `capacity` bytes.
class RingBuffer {
  private buf = Buffer.alloc(0);
  constructor(private readonly capacity: number) {}
  push(chunk: Uint8Array): void {
    if (this.buf.length + chunk.length > this.capacity) {
      this.buf = Buffer.concat([this.buf, chunk]).subarray(
        Math.max(0, this.buf.length + chunk.length - this.capacity),
      );
    } else {
      this.buf = Buffer.concat([this.buf, chunk]);
    }
  }
  bytes(): Uint8Array {
    return new Uint8Array(this.buf); // copy: callers may hold on to it
  }
  // A new buffer holding at most the last `capacity` bytes of this one.
  tail(capacity: number): RingBuffer {
    const next = new RingBuffer(capacity);
    next.push(this.buf.subarray(Math.max(0, this.buf.length - capacity)));
    return next;
  }
  get size(): number {
    return this.buf.length;
  }
}

// Markers Claude Code sets on its own children. If the hub itself runs under a
// Claude session (e.g. started from a Claude terminal), inheriting them makes the
// spawned session behave as a nested child (transcript saving off, etc.).
const NESTED_SESSION_ENV = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_EXECPATH",
];

export function childEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !NESTED_SESSION_ENV.includes(k)) env[k] = v;
  }
  return env;
}

export interface SpawnCommandOptions {
  // Continue an existing session (`claude --resume <id>`, same id and
  // transcript) instead of starting a fresh one with that id.
  resume: boolean;
}

// The default `claude` invocation. The channel plugin is opt-in: set
// CLAUDE_WEB_CHANNEL (e.g. plugin:claude-web@claude-web or server:claude-web)
// to load it for Allow/Deny buttons in the UI; without it the hub drives the
// session purely through its PTY.
export function defaultSpawnCommand(
  id: string,
  name: string | null,
  channel: string | undefined = process.env.CLAUDE_WEB_CHANNEL,
  opts: SpawnCommandOptions = { resume: false },
): string[] {
  const cmd = ["claude", opts.resume ? "--resume" : "--session-id", id];
  if (channel) cmd.push("--dangerously-load-development-channels", channel);
  if (name != null) cmd.push("--name", name);
  return cmd;
}

/* ------------------------------- session manager ----------------------------- */

export interface SessionManagerOptions {
  // WebSocket base URL the spawned plugin should dial (CLAUDE_WEB_HUB).
  hubUrl?: string;
  // Shared secret handed to spawned sessions as CLAUDE_WEB_TOKEN.
  agentToken?: string;
  // Injectable spawn command; default is the real Claude Code invocation.
  // Called with (id, name, opts) so tests can substitute `cat`-like processes.
  spawnCommand?: (id: string, name: string | null, opts: SpawnCommandOptions) => string[];
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly hubUrl: string;
  private readonly agentToken: string | undefined;
  private readonly spawnCommand: (id: string, name: string | null, opts: SpawnCommandOptions) => string[];

  constructor(opts: SessionManagerOptions = {}) {
    this.hubUrl = opts.hubUrl ?? process.env.CLAUDE_WEB_HUB ?? DEFAULT_HUB_URL;
    this.agentToken = opts.agentToken;
    this.spawnCommand = opts.spawnCommand ?? ((id, name, o) => defaultSpawnCommand(id, name, undefined, o));
  }

  /* --------------------------------- lifecycle ------------------------------- */

  // Start a fresh session, or with `resume` continue the session with that id
  // in place (its transcript keeps growing under the same id). An exited
  // record for the same id is replaced.
  spawn({
    cwd: rawCwd,
    name,
    prompt,
    resume,
  }: {
    cwd: string;
    name?: string | null;
    prompt?: string | null;
    resume?: string | null;
  }): SpawnedInfo {
    // Claude Code keys its transcript directory on the resolved cwd
    // (/tmp/x -> /private/tmp/x on macOS), so resolve it here too or the
    // conversation would be looked up under the wrong project directory.
    const cwd = realpathSync(rawCwd);
    const id = resume ?? randomUUID();
    const prev = this.sessions.get(id);
    if (prev?.status === "running") throw new Error(`session ${id} is already running`);
    if (prev) this.remove(id);
    const rec: SessionRecord = {
      id,
      name: name ?? null,
      cwd,
      pid: null,
      status: "running",
      exitCode: null,
      exitSignal: null,
      createdAt: Date.now(),
      pendingPrompt: prompt && prompt.trim() ? prompt : null,
      removed: false,
    };
    this.sessions.set(id, rec);

    let proc: Bun.Subprocess<"ignore", "ignore", "ignore">;
    try {
      proc = Bun.spawn(this.spawnCommand(id, rec.name, { resume: resume != null }), {
        cwd,
        env: {
          ...childEnv(),
          CLAUDE_WEB_SESSION: id,
          CLAUDE_WEB_CWD: cwd,
          ...(name ? { CLAUDE_WEB_NAME: name } : {}),
          CLAUDE_WEB_HUB: this.hubUrl,
          ...(this.agentToken ? { CLAUDE_WEB_TOKEN: this.agentToken } : {}),
        },
        terminal: {
          cols: 120,
          rows: 40,
          data: (_term: unknown, chunk: Uint8Array) => this.onPtyChunk(rec, chunk),
        },
      });
    } catch (err) {
      // Spawn failed: do not leave a live session behind.
      this.sessions.delete(id);
      throw err;
    }

    rec.proc = proc;
    rec.pid = proc.pid;
    rec.terminal = proc.terminal;
    rec.ring = new RingBuffer(RING_BYTES);

    void this.watchExit(rec);
    this.emitSession(rec);
    return this.summary(rec);
  }

  private async watchExit(rec: SessionRecord): Promise<void> {
    const proc = rec.proc;
    if (!proc) return;
    const code = await proc.exited;
    if (rec.removed) return;
    rec.exitCode = code ?? null;
    rec.exitSignal = proc.signalCode ?? null;
    rec.status = "exited";
    this.clearKillTimer(rec);
    this.clearPromptTimer(rec);
    // Keep only the tail of the output for post-mortems so exited sessions
    // do not each pin 256 KiB until they are reaped.
    if (rec.ring) rec.ring = rec.ring.tail(EXITED_RING_BYTES);
    this.emitSession(rec);
    this.evictExited();
  }

  // Keep the registry bounded on a long-lived hub: beyond MAX_EXITED exited
  // sessions, drop the oldest so records and rings do not pile up.
  private evictExited(): void {
    const exited = [...this.sessions.values()]
      .filter((r) => r.status === "exited")
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const rec of exited.slice(0, Math.max(0, exited.length - MAX_EXITED))) {
      this.remove(rec.id);
    }
  }

  /* --------------------------------- registry -------------------------------- */

  list(): SpawnedInfo[] {
    return [...this.sessions.values()].map((rec) => this.summary(rec));
  }

  get(id: string): SpawnedInfo | undefined {
    const rec = this.sessions.get(id);
    return rec ? this.summary(rec) : undefined;
  }

  // Forget a session: SIGKILL if it is somehow still alive, drop its record.
  remove(id: string): void {
    const rec = this.sessions.get(id);
    if (!rec) return;
    rec.removed = true;
    this.clearKillTimer(rec);
    this.clearPromptTimer(rec);
    try {
      rec.proc?.kill("SIGKILL"); // no record left to escalate from, so go straight to SIGKILL
    } catch {
      /* already gone */
    }
    this.sessions.delete(id);
    this.emit({ type: "session_removed", id });
  }

  /* --------------------------------- controls -------------------------------- */

  // Type a message into the session's prompt and submit it.
  message(id: string, text: string): void {
    this.mustRunning(id).terminal!.write(text + "\r");
  }

  // Escape interrupts the current turn (Claude Code's own binding).
  stop(id: string): void {
    this.mustRunning(id).terminal!.write("\x1b");
  }

  write(id: string, data: string | Uint8Array): void {
    this.mustRunning(id).terminal!.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.mustRunning(id).terminal!.resize(cols, rows);
  }

  // SIGTERM, then SIGKILL after KILL_GRACE_MS if the process is still around.
  kill(id: string): void {
    const rec = this.mustGet(id);
    const proc = rec.proc;
    if (!proc || rec.status === "exited") return;
    try {
      proc.kill("SIGTERM");
    } catch {
      return; // already gone
    }
    this.clearKillTimer(rec);
    rec.killTimer = setTimeout(() => {
      rec.killTimer = undefined;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, KILL_GRACE_MS);
  }

  /* ---------------------------------- output --------------------------------- */

  // Recent raw PTY bytes, for late-joining UI subscribers.
  ring(id: string): Uint8Array | undefined {
    const rec = this.sessions.get(id);
    return rec?.ring?.bytes();
  }

  /* ---------------------------------- events --------------------------------- */

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /* ---------------------------------- helpers --------------------------------- */

  private mustGet(id: string): SessionRecord {
    const rec = this.sessions.get(id);
    if (!rec) throw new Error(`no such session: ${id}`);
    return rec;
  }

  private mustRunning(id: string): SessionRecord {
    const rec = this.mustGet(id);
    if (rec.status !== "running" || !rec.terminal) throw new SessionExitedError(id);
    return rec;
  }

  private clearKillTimer(rec: SessionRecord): void {
    if (rec.killTimer) clearTimeout(rec.killTimer);
    rec.killTimer = undefined;
  }

  private clearPromptTimer(rec: SessionRecord): void {
    if (rec.promptTimer) clearTimeout(rec.promptTimer);
    rec.promptTimer = undefined;
  }

  private onPtyChunk(rec: SessionRecord, chunk: Uint8Array): void {
    if (rec.removed) return;
    rec.ring?.push(chunk);
    this.emit({ type: "pty", id: rec.id, data: Buffer.from(chunk).toString("base64") });
    if (rec.pendingPrompt !== null) this.maybeTypePrompt(rec, chunk);
  }

  // The initial prompt is typed once Claude Code has drawn its input box
  // ("❯") and the screen has then been quiet for PROMPT_SETTLE_MS, so it lands
  // in the prompt rather than in a startup dialog. The marker is three UTF-8
  // bytes and may straddle two PTY reads, hence the streaming decoder.
  private maybeTypePrompt(rec: SessionRecord, chunk: Uint8Array): void {
    rec.promptDecoder ??= new TextDecoder();
    const text = rec.promptDecoder.decode(chunk, { stream: true });
    if (!rec.promptTimer && !text.includes("❯")) return;
    this.clearPromptTimer(rec);
    rec.promptTimer = setTimeout(() => {
      rec.promptTimer = undefined;
      const prompt = rec.pendingPrompt;
      rec.pendingPrompt = null;
      if (prompt !== null && rec.status === "running" && rec.terminal) rec.terminal.write(prompt + "\r");
    }, PROMPT_SETTLE_MS);
  }

  private summary(rec: SessionRecord): SpawnedInfo {
    return {
      id: rec.id,
      name: rec.name,
      cwd: rec.cwd,
      pid: rec.pid,
      status: rec.status,
      exitCode: rec.exitCode,
      exitSignal: rec.exitSignal,
      createdAt: rec.createdAt,
    };
  }

  private emitSession(rec: SessionRecord): void {
    this.emit({ type: "session", session: this.summary(rec) });
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[sessions] listener failed:", err);
      }
    }
  }
}
