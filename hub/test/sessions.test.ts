import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
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
    expect(s.kind).toBe("spawned");
    expect(s.status).toBe("running");
    expect(s.pid).toBeGreaterThan(0);
    expect(m.list().map((x) => x.id)).toContain(s.id);
    expect(m.get(s.id)?.name).toBe("t");
  });

  test("steer types text + CR, output lands in pty events and the ring buffer", async () => {
    const m = make();
    const events: SessionEvent[] = [];
    m.onEvent((e) => events.push(e));
    const s = m.spawn({ cwd: tmpdir() });
    m.steer(s.id, "hello-steer");
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

  test("attachExternal registers an external session; owned controls throw", () => {
    const m = make();
    const s = m.attachExternal({
      type: "hello",
      sessionId: "ext-1",
      cwd: "/tmp",
      pid: 123,
      ppid: 1,
      name: "ext",
    });
    expect(s.kind).toBe("external");
    expect(s.agentConnected).toBe(true);
    expect(() => m.stop("ext-1")).toThrow(/external/);
    expect(() => m.steer("ext-1", "x")).toThrow(/external/);
    expect(() => m.kill("ext-1")).toThrow(/external/);
    m.agentDisconnected("ext-1");
    expect(m.get("ext-1")?.status).toBe("disconnected");
    expect(m.get("ext-1")?.agentConnected).toBe(false);
  });

  test("attachExternal on a spawned session only flips agentConnected", () => {
    const m = make();
    const s = m.spawn({ cwd: tmpdir() });
    const after = m.attachExternal({
      type: "hello",
      sessionId: s.id,
      cwd: tmpdir(),
      pid: 999,
      ppid: 1,
      name: null,
    });
    expect(after.kind).toBe("spawned");
    expect(after.agentConnected).toBe(true);
    expect(after.pid).toBe(s.pid);
  });

  test("remove kills the process outright", async () => {
    const m = make();
    const s = m.spawn({ cwd: tmpdir() });
    const proc = (m as any).sessions.get(s.id).proc as Bun.Subprocess;
    m.remove(s.id);
    expect(m.get(s.id)).toBeUndefined();
    expect(await proc.exited).not.toBe(0);
  });

  test("unknown ids throw", () => {
    const m = make();
    expect(() => m.stop("nope")).toThrow(/no such session/);
  });
});

describe("childEnv", () => {
  test("drops nested-session markers and keeps everything else", async () => {
    const { childEnv } = await import("../src/sessions");
    const env = childEnv({ PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CONFIG_DIR: "/x" });
    expect(env).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/x" });
  });
});
