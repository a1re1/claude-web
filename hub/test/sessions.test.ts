import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type SessionEvent } from "../src/sessions";

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(20);
  }
}

function ptyText(events: SessionEvent[], id: string): string {
  return events
    .filter((e): e is Extract<SessionEvent, { type: "pty" }> => e.type === "pty" && e.id === id)
    .map((e) => Buffer.from(e.data, "base64").toString("utf8"))
    .join("");
}

describe("SessionManager", () => {
  const managers: SessionManager[] = [];
  const make = () => {
    const m = new SessionManager({ spawnCommand: () => ["cat"], hubUrl: "ws://127.0.0.1:1" });
    managers.push(m);
    return m;
  };
  afterEach(() => {
    for (const m of managers) for (const s of m.list()) m.remove(s.id);
    managers.length = 0;
  });

  test("spawn runs the command under a PTY and reports running", async () => {
    const m = make();
    const s = m.spawn({ cwd: tmpdir(), name: "t" });
    expect(s.status).toBe("running");
    expect(s.pid).toBeGreaterThan(0);
    expect(m.list().map((x) => x.id)).toContain(s.id);
    expect(m.get(s.id)?.name).toBe("t");
  });

  test("message types text + CR, output lands in pty events and the ring buffer", async () => {
    const m = make();
    const events: SessionEvent[] = [];
    m.onEvent((e) => events.push(e));
    const s = m.spawn({ cwd: tmpdir() });
    m.message(s.id, "hello-steer");
    await waitFor(() => /hello-steer\r?\n/.test(ptyText(events, s.id)));
    const ring = Buffer.from(m.ring(s.id)!).toString("utf8");
    expect(ring).toContain("hello-steer");
  });

  test("stop writes Escape to the PTY", async () => {
    const m = make();
    const events: SessionEvent[] = [];
    m.onEvent((e) => events.push(e));
    const s = m.spawn({ cwd: tmpdir() });
    m.stop(s.id);
    // cat echoes the raw byte (0x1b) or the tty's ^[ rendering.
    await waitFor(() => /\x1b|\^\[/.test(ptyText(events, s.id)));
  });

  test("kill marks the session exited, emits a session event, and clears the SIGKILL timer", async () => {
    const m = make();
    const events: SessionEvent[] = [];
    m.onEvent((e) => events.push(e));
    const s = m.spawn({ cwd: tmpdir() });
    m.kill(s.id);
    await waitFor(() => m.get(s.id)?.status === "exited");
    // The exit cause survives either way Bun reports a signal death (143 or SIGTERM).
    const dead = m.get(s.id)!;
    expect(dead.exitCode === 143 || dead.exitSignal === "SIGTERM").toBe(true);
    expect((m as any).sessions.get(s.id).killTimer).toBeUndefined();
    expect(m.ring(s.id)!.length).toBeLessThanOrEqual(32 * 1024);
    const last = events.filter((e) => e.type === "session").at(-1);
    expect(last && last.type === "session" && last.session.status).toBe("exited");
  });

  test("exited sessions are capped; the oldest is evicted with a session_removed event", async () => {
    const m = new SessionManager({ spawnCommand: () => ["true"] });
    const events: SessionEvent[] = [];
    m.onEvent((e) => events.push(e));
    const ids: string[] = [];
    for (let i = 0; i < 52; i++) ids.push(m.spawn({ cwd: tmpdir() }).id);
    await waitFor(() => ids.every((id) => !m.get(id) || m.get(id)?.status === "exited"));
    await waitFor(() => m.list().filter((s) => s.status === "exited").length <= 50);
    const removed = events.filter((e) => e.type === "session_removed").map((e) => (e as any).id);
    expect(removed.length).toBe(2);
    expect(m.get(removed[0])).toBeUndefined();
  });

  test("remove kills the process outright", async () => {
    const m = make();
    const s = m.spawn({ cwd: tmpdir() });
    const proc = (m as any).sessions.get(s.id).proc as Bun.Subprocess;
    m.remove(s.id);
    expect(m.get(s.id)).toBeUndefined();
    expect(await proc.exited).not.toBe(0);
  });

  test("an initial prompt is typed once the input box (❯) has appeared and settled", async () => {
    // A shell prints "❯" then waits; the prompt must arrive after it, not before.
    const m = new SessionManager({
      spawnCommand: () => ["sh", "-c", "printf 'booting\\n'; sleep 0.3; printf '❯ '; cat"],
      hubUrl: "ws://127.0.0.1:1",
    });
    managers.push(m);
    const events: SessionEvent[] = [];
    m.onEvent((e) => events.push(e));
    const s = m.spawn({ cwd: tmpdir(), prompt: "first-prompt" });
    await waitFor(() => /first-prompt\r?\n/.test(ptyText(events, s.id)), 5000);
    const text = ptyText(events, s.id);
    expect(text.indexOf("❯")).toBeLessThan(text.indexOf("first-prompt"));
  });

  test("the prompt marker still matches when its UTF-8 bytes straddle two PTY reads", async () => {
    // ❯ is E2 9D AF; emit the first byte, pause, then the rest.
    const m = new SessionManager({
      spawnCommand: () => ["sh", "-c", "printf '\\342'; sleep 0.3; printf '\\235\\257 '; cat"],
      hubUrl: "ws://127.0.0.1:1",
    });
    managers.push(m);
    const events: SessionEvent[] = [];
    m.onEvent((e) => events.push(e));
    const s = m.spawn({ cwd: tmpdir(), prompt: "split-prompt" });
    await waitFor(() => /split-prompt\r?\n/.test(ptyText(events, s.id)), 5000);
    // A blank prompt is never typed.
    const blank = m.spawn({ cwd: tmpdir(), prompt: "   " });
    expect((m as any).sessions.get(blank.id).pendingPrompt).toBeNull();
  });

  test("spawned sessions only get CLAUDE_WEB_NAME when a name was given", async () => {
    const m = new SessionManager({ spawnCommand: () => ["sh", "-c", "echo NAME=${CLAUDE_WEB_NAME-unset}; cat"], hubUrl: "ws://127.0.0.1:1" });
    managers.push(m);
    const events: SessionEvent[] = [];
    m.onEvent((e) => events.push(e));
    const anon = m.spawn({ cwd: tmpdir() });
    const named = m.spawn({ cwd: tmpdir(), name: "nm" });
    await waitFor(() => /NAME=unset/.test(ptyText(events, anon.id)));
    await waitFor(() => /NAME=nm/.test(ptyText(events, named.id)));
  });

  test("cwd is resolved to its real path, matching where Claude Code writes the transcript", async () => {
    const m = make();
    const real = realpathSync(tmpdir());
    const link = join(real, `cw-link-${process.pid}`);
    try {
      symlinkSync(real, link);
      expect(m.spawn({ cwd: link }).cwd).toBe(real);
    } finally {
      rmSync(link, { force: true });
    }
    expect(() => m.spawn({ cwd: join(real, "does-not-exist") })).toThrow();
  });

  test("unknown ids throw", () => {
    const m = make();
    expect(() => m.stop("nope")).toThrow(/no such session/);
  });
});

describe("defaultSpawnCommand", () => {
  test("loads the channel plugin only when asked", async () => {
    const { defaultSpawnCommand } = await import("../src/sessions");
    expect(defaultSpawnCommand("id1", null, undefined)).toEqual(["claude", "--session-id", "id1"]);
    expect(defaultSpawnCommand("id1", "nm", "plugin:claude-web@claude-web")).toEqual([
      "claude",
      "--session-id",
      "id1",
      "--dangerously-load-development-channels",
      "plugin:claude-web@claude-web",
      "--name",
      "nm",
    ]);
  });
});

describe("childEnv", () => {
  test("drops nested-session markers and keeps everything else", async () => {
    const { childEnv } = await import("../src/sessions");
    const env = childEnv({ PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CONFIG_DIR: "/x" });
    expect(env).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/x" });
  });
});
