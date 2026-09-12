// Session management for the claude-web hub: spawn Claude Code (or register
// externally-started sessions) under a PTY, keep a bounded ring buffer of
// terminal output for late joiners, tail the session's Claude Code transcript,
// and expose stop/steer/write/resize/kill controls.
//
// All terminal output is broadcast as base64 `pty` events; transcript events
// are broadcast as `transcript` events; session status changes as `session`
// events (see onEvent).

import { randomUUID } from "node:crypto";
import type { AgentHello, Session, SessionKind, SessionStatus } from "./protocol";
import { TranscriptTailer, transcriptPath, type TranscriptEvent } from "./transcript";

/* ---------------------------------- events ---------------------------------- */

export type SessionEvent =
  | { type: "pty"; id: string; data: string } // base64 of raw PTY bytes
  | { type: "transcript"; id: string; event: TranscriptEvent }
  | { type: "session"; session: Session }
  | { type: "session_removed"; id: string }; // evicted by the exited-session cap

/* --------------------------------- constants -------------------------------- */

const RING_BYTES = 256 * 1024; // 256 KiB of recent PTY output for late joiners
const EXITED_RING_BYTES = 32 * 1024; // retained after exit, until removed or evicted
const MAX_EXITED = 50; // exited spawned sessions kept for post-mortems; oldest evicted beyond this
const KILL_GRACE_MS = 3_000; // SIGTERM -> SIGKILL delay
const DEFAULT_HUB_URL = "ws://127.0.0.1:8790";

/* ---------------------------------- session --------------------------------- */

interface SessionRecord {
  id: string;
  name: string | null;
  cwd: string;
  kind: SessionKind;
  status: SessionStatus;
  pid: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  createdAt: number;
  agentConnected: boolean;

  proc?: Bun.Subprocess<"ignore", "ignore", "ignore">;
  terminal?: { write(data: string | Uint8Array): void; resize(cols: number, rows: number): void };
  ring?: RingBuffer;
  tailer?: TranscriptTailer;
  killTimer?: ReturnType<typeof setTimeout>;
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

/* ------------------------------- session manager ----------------------------- */

export interface SessionManagerOptions {
  // WebSocket base URL the spawned plugin should dial (CLAUDE_WEB_HUB).
  hubUrl?: string;
  // Shared secret handed to spawned sessions as CLAUDE_WEB_TOKEN.
  agentToken?: string;
  // Injectable spawn command; default is the real Claude Code invocation.
  // Called with (id, name) so tests can substitute `cat`-like processes.
  spawnCommand?: (id: string, name: string | null) => string[];
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly hubUrl: string;
  private readonly agentToken: string | undefined;
  private readonly spawnCommand: (id: string, name: string | null) => string[];

  constructor(opts: SessionManagerOptions = {}) {
    this.hubUrl = opts.hubUrl ?? process.env.CLAUDE_WEB_HUB ?? DEFAULT_HUB_URL;
    this.agentToken = opts.agentToken;
    this.spawnCommand =
      opts.spawnCommand ??
      ((id, name) => {
        const cmd = [
          "claude",
          "--session-id",
          id,
          "--dangerously-load-development-channels",
          process.env.CLAUDE_WEB_CHANNEL ?? "plugin:claude-web@claude-web",
        ];
        if (name != null) cmd.push("--name", name);
        return cmd;
      });
  }

  /* --------------------------------- lifecycle ------------------------------- */

  spawn({ cwd, name }: { cwd: string; name?: string | null }): Session {
    const id = randomUUID();
    const rec: SessionRecord = {
      id,
      name: name ?? null,
      cwd,
      kind: "spawned",
      status: "starting",
      pid: null,
      exitCode: null,
      exitSignal: null,
      createdAt: Date.now(),
      agentConnected: false,
      removed: false,
    };
    this.sessions.set(id, rec);

    let proc: Bun.Subprocess<"ignore", "ignore", "ignore">;
    try {
      proc = Bun.spawn(this.spawnCommand(id, rec.name), {
        cwd,
        env: {
          ...childEnv(),
          CLAUDE_WEB_SESSION: id,
          CLAUDE_WEB_CWD: cwd,
          CLAUDE_WEB_NAME: name ?? "",
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
      // Spawn failed: do not leave a live "starting" session behind.
      this.sessions.delete(id);
      throw err;
    }

    rec.proc = proc;
    rec.pid = proc.pid;
    rec.terminal = proc.terminal;
    rec.ring = new RingBuffer(RING_BYTES);
    rec.status = "running";
    rec.tailer = new TranscriptTailer(transcriptPath(cwd, id), (event) =>
      this.emit({ type: "transcript", id, event }),
    );
    rec.tailer.start();

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
    rec.tailer?.stop();
    // Keep only the tail of the output for post-mortems so exited sessions
    // do not each pin 256 KiB until they are reaped.
    if (rec.ring) rec.ring = rec.ring.tail(EXITED_RING_BYTES);
    this.emitSession(rec);
    this.evictExited();
  }

  // Keep the registry bounded on a long-lived hub: beyond MAX_EXITED exited
  // sessions, drop the oldest so records, rings and tailers do not pile up.
  private evictExited(): void {
    const exited = [...this.sessions.values()]
      .filter((r) => r.status === "exited")
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const rec of exited.slice(0, Math.max(0, exited.length - MAX_EXITED))) {
      this.remove(rec.id);
      this.emit({ type: "session_removed", id: rec.id });
    }
  }

  /* --------------------------------- registry -------------------------------- */

  list(): Session[] {
    return [...this.sessions.values()].map((rec) => this.summary(rec));
  }

  get(id: string): Session | undefined {
    const rec = this.sessions.get(id);
    return rec ? this.summary(rec) : undefined;
  }

  // Called when a plugin dials the hub's /agent endpoint with its hello frame.
  // Registers a kind:'external' session, or flips agentConnected on an already
  // spawned session (the plugin dialing home) without changing its ownership.
  attachExternal(hello: AgentHello): Session {
    const existing = this.sessions.get(hello.sessionId);
    if (existing) {
      existing.agentConnected = true;
      if (existing.kind === "external") {
        // The plugin process is the only pid we know for external sessions.
        existing.pid = hello.pid ?? existing.pid;
        if (existing.status !== "running") existing.status = "running";
      }
      this.emitSession(existing);
      return this.summary(existing);
    }
    const rec: SessionRecord = {
      id: hello.sessionId,
      name: hello.name ?? null,
      cwd: hello.cwd,
      kind: "external",
      status: "running",
      pid: hello.pid ?? null,
      exitCode: null,
      exitSignal: null,
      createdAt: Date.now(),
      agentConnected: true,
      removed: false,
    };
    this.sessions.set(rec.id, rec);
    this.emitSession(rec);
    return this.summary(rec);
  }

  // The plugin socket dropped: agentConnected=false; external sessions become
  // 'disconnected' (nobody owns their PTY anymore), spawned sessions keep
  // running under the hub's PTY.
  agentDisconnected(id: string): void {
    const rec = this.sessions.get(id);
    if (!rec) return;
    rec.agentConnected = false;
    if (rec.kind === "external") rec.status = "disconnected";
    this.emitSession(rec);
  }

  remove(id: string): void {
    const rec = this.sessions.get(id);
    if (!rec) return;
    rec.removed = true;
    rec.tailer?.stop();
    this.clearKillTimer(rec);
    try {
      rec.proc?.kill("SIGKILL"); // no record left to escalate from, so go straight to SIGKILL
    } catch {
      /* already gone */
    }
    this.sessions.delete(id);
  }

  /* --------------------------------- controls -------------------------------- */

  stop(id: string): void {
    const rec = this.mustGet(id);
    this.requireOwned(rec);
    rec.terminal?.write("\x1b"); // Escape interrupts the running turn
  }

  steer(id: string, text: string): void {
    const rec = this.mustGet(id);
    this.requireOwned(rec);
    rec.terminal?.write(text + "\r");
  }

  // Raw keystrokes. Bytes go straight to the PTY so multi-byte sequences
  // split across calls are not mangled by a string round-trip.
  write(id: string, data: string | Uint8Array): void {
    const rec = this.mustGet(id);
    this.requireOwned(rec);
    rec.terminal?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const rec = this.mustGet(id);
    this.requireOwned(rec);
    rec.terminal?.resize(cols, rows);
  }

  kill(id: string): void {
    const rec = this.mustGet(id);
    this.requireOwned(rec);
    const proc = rec.proc;
    if (!proc) return;
    try {
      proc.kill(); // SIGTERM
    } catch {
      return;
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

  /* ---------------------------------- helpers -------------------------------- */

  private mustGet(id: string): SessionRecord {
    const rec = this.sessions.get(id);
    if (!rec) throw new Error(`no such session: ${id}`);
    return rec;
  }

  private clearKillTimer(rec: SessionRecord): void {
    if (rec.killTimer) clearTimeout(rec.killTimer);
    rec.killTimer = undefined;
  }

  private requireOwned(rec: SessionRecord): void {
    if (rec.kind === "external") {
      throw new Error(`session ${rec.id} is external; the hub does not own its terminal`);
    }
  }

  private onPtyChunk(rec: SessionRecord, chunk: Uint8Array): void {
    if (rec.removed) return;
    rec.ring?.push(chunk);
    this.emit({ type: "pty", id: rec.id, data: Buffer.from(chunk).toString("base64") });
  }

  private summary(rec: SessionRecord): Session {
    return {
      id: rec.id,
      name: rec.name,
      cwd: rec.cwd,
      kind: rec.kind,
      status: rec.status,
      pid: rec.pid,
      exitCode: rec.exitCode,
      exitSignal: rec.exitSignal,
      createdAt: rec.createdAt,
      agentConnected: rec.agentConnected,
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
