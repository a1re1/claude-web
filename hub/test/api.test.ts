import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeProjectDir } from "../src/conversation";
import { createHub } from "../src/index";
import { SessionManager } from "../src/sessions";

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(20);
  }
}

let hub: ReturnType<typeof createHub>;
let base: string;
let wsBase: string;
// A fake ~ with one past transcript under the root and one outside it.
let home: string;
let root: string;
const PAST_ID = "11111111-1111-4111-8111-111111111111";
const OUTSIDE_ID = "22222222-2222-4222-8222-222222222222";

function writeTranscript(cwd: string, id: string, prompt: string): string {
  const dir = join(home, ".claude", "projects", encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  const ts = "2026-09-12T10:00:00.000Z";
  const lines = [
    { type: "user", uuid: `${id}-u1`, sessionId: id, cwd, timestamp: ts, gitBranch: "main", version: "2.1.269", message: { role: "user", content: prompt } },
    {
      type: "assistant",
      uuid: `${id}-a1`,
      sessionId: id,
      cwd,
      timestamp: ts,
      message: {
        id: "msg_1",
        role: "assistant",
        model: "claude-fable-5-1",
        content: [{ type: "text", text: "hi there" }],
        usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 1, output_tokens: 3 },
      },
    },
  ];
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "cw-home-"));
  root = realpathSync(mkdtempSync(join(tmpdir(), "cw-root-")));
  mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
  mkdirSync(join(root, "sub")); // resume spawns in the session's own directory, so it must exist
  writeTranscript(join(root, "sub"), PAST_ID, "past prompt");
  writeTranscript(join(home, "elsewhere"), OUTSIDE_ID, "outside prompt"); // a sibling of root, never under it
  hub = createHub({
    port: 0,
    hostname: "127.0.0.1",
    rootCwd: root,
    home,
    refreshMs: 100,
    sessions: new SessionManager({ spawnCommand: () => ["cat"], hubUrl: "ws://127.0.0.1:1" }),
  });
  base = `http://127.0.0.1:${hub.server.port}`;
  wsBase = `ws://127.0.0.1:${hub.server.port}`;
});
afterAll(() => {
  for (const s of hub.sessions.list()) hub.sessions.remove(s.id);
  hub.stop();
});

const post = (path: string, body?: unknown) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

class Sock {
  frames: any[] = [];
  ws: WebSocket;
  private opened: Promise<void>;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((res) => this.ws.addEventListener("open", () => res()));
    this.ws.addEventListener("message", (ev) => this.frames.push(JSON.parse(String(ev.data))));
  }
  ready() {
    return this.opened;
  }
  send(frame: unknown) {
    this.ws.send(JSON.stringify(frame));
  }
  async next(pred: (f: any) => boolean, ms = 3000): Promise<any> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.frames.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`no frame matched; got ${JSON.stringify(this.frames)}`);
      await Bun.sleep(20);
    }
  }
  close() {
    this.ws.close();
  }
}

describe("hub HTTP API", () => {
  test("health and root", async () => {
    const r = await fetch(base + "/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(await (await fetch(base + "/api/root")).json()).toEqual({ root });
  });

  test("serves the UI", async () => {
    const r = await fetch(base + "/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("<title>");
  });

  test("serves vendored xterm assets", async () => {
    const js = await fetch(base + "/vendor/xterm.js");
    expect(js.status).toBe(200);
    expect((await js.text()).length).toBeGreaterThan(10_000);
    expect((await fetch(base + "/vendor/xterm.css")).status).toBe(200);
    expect((await fetch(base + "/vendor/xterm-addon-fit.js")).status).toBe(200);
    expect((await fetch(base + "/markdown.js")).status).toBe(200);
  });

  test("cross-origin browser requests are refused", async () => {
    const evil = { origin: "https://evil.example", "content-type": "application/json" };
    const r = await fetch(base + "/api/sessions", { method: "POST", headers: evil, body: "{}" });
    expect(r.status).toBe(403);
    // Reads are guarded too: a drive-by page must not be able to dump transcripts.
    expect((await fetch(base + "/api/sessions", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(base + "/health", { headers: { origin: "https://evil.example" } })).status).toBe(200);
    const ok = await fetch(base + "/api/sessions", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ name: "same-origin" }),
    });
    expect(ok.status).toBe(201);
    hub.sessions.remove((await ok.json()).id);

    const ws = new WebSocket(wsBase + "/ui", { headers: { origin: "https://evil.example" } } as any);
    const outcome = await new Promise<string>((res) => {
      ws.addEventListener("open", () => res("open"));
      ws.addEventListener("error", () => res("error"));
      ws.addEventListener("close", () => res("close"));
    });
    expect(outcome).not.toBe("open");
  });

  test("non-JSON bodies are 415", async () => {
    const r = await fetch(base + "/api/sessions", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ cwd: tmpdir() }),
    });
    expect(r.status).toBe(415);
  });

  test("invalid bodies are 400", async () => {
    expect((await post("/api/sessions", { cwd: 1 })).status).toBe(400);
    expect((await post("/api/sessions", { cwd: join(root, "missing-dir") })).status).toBe(400);
    expect((await post("/api/sessions", "not json")).status).toBe(400);
  });

  test("lists past sessions under the root only, with their conversation", async () => {
    const list = await (await fetch(base + "/api/sessions")).json();
    const ids = list.map((s: any) => s.id);
    expect(ids).toContain(PAST_ID);
    expect(ids).not.toContain(OUTSIDE_ID);
    const past = list.find((s: any) => s.id === PAST_ID);
    expect(past.spawned).toBe(false);
    expect(past.running).toBe(false);
    expect(past.firstPrompt).toBe("past prompt");
    expect(past.cwd).toBe(join(root, "sub"));

    const detail = await (await fetch(`${base}/api/sessions/${PAST_ID}`)).json();
    expect(detail.session.id).toBe(PAST_ID);
    expect(detail.entries.map((e: any) => e.kind)).toEqual(["prompt", "text"]);
    expect(detail.entries[1].usage).toEqual({ input: 10, cacheRead: 5, cacheCreate: 1, output: 3 });
    expect(detail.entries[1].model).toBe("claude-fable-5-1");

    // Past sessions are read-only: no PTY to type into.
    expect((await post(`/api/sessions/${PAST_ID}/message`, { text: "hi" })).status).toBe(409);
    expect((await post(`/api/sessions/${PAST_ID}/stop`)).status).toBe(409);
    expect((await fetch(`${base}/api/sessions/${PAST_ID}`, { method: "DELETE" })).status).toBe(409);
    expect((await fetch(`${base}/api/sessions/${OUTSIDE_ID}`)).status).toBe(404);
    expect((await fetch(`${base}/api/sessions/nope`)).status).toBe(404);
  });

  test("spawned session lifecycle over HTTP", async () => {
    const created = await post("/api/sessions", { name: "api" });
    expect(created.status).toBe(201);
    const s = await created.json();
    expect(s.spawned).toBe(true);
    expect(s.running).toBe(true);
    expect(s.cwd).toBe(root); // defaults to the launch directory

    const list = await (await fetch(base + "/api/sessions")).json();
    const mine = list.find((x: any) => x.id === s.id);
    expect(mine.spawned).toBe(true);
    expect(list[0].id).toBe(s.id); // running first

    const detail = await (await fetch(`${base}/api/sessions/${s.id}`)).json();
    expect(detail.session.id).toBe(s.id);
    expect(detail.entries).toEqual([]); // no transcript yet

    expect((await post(`/api/sessions/${s.id}/message`, { text: "typed" })).status).toBe(200);
    expect((await post(`/api/sessions/${s.id}/stop`)).status).toBe(200);
    expect((await post(`/api/sessions/${s.id}/input`, { data: Buffer.from("x").toString("base64") })).status).toBe(200);
    expect((await post(`/api/sessions/${s.id}/resize`, { cols: 80, rows: 24 })).status).toBe(200);
    expect((await post(`/api/sessions/${s.id}/resize`, { cols: 1, rows: 24 })).status).toBe(400);
    await waitFor(() => Buffer.from(hub.sessions.ring(s.id)!).toString("utf8").includes("typed"));

    const killed = await fetch(`${base}/api/sessions/${s.id}`, { method: "DELETE" });
    expect(await killed.json()).toEqual({ ok: true, action: "killed" });
    await waitFor(() => hub.sessions.get(s.id)?.status === "exited");
    expect((await post(`/api/sessions/${s.id}/message`, { text: "late" })).status).toBe(409);
    const after = await (await fetch(`${base}/api/sessions/${s.id}`)).json();
    expect(after.session.running).toBe(false);
    expect(after.session.exitCode === 143 || after.session.exitSignal === "SIGTERM").toBe(true);

    const removed = await fetch(`${base}/api/sessions/${s.id}`, { method: "DELETE" });
    expect(await removed.json()).toEqual({ ok: true, action: "removed" });
    expect((await fetch(`${base}/api/sessions/${s.id}`)).status).toBe(404);
  });

  test("resume relaunches a past session under the hub's PTY with the same id", async () => {
    const r = await post(`/api/sessions/${PAST_ID}/resume`);
    expect(r.status).toBe(201);
    const s = await r.json();
    expect(s.id).toBe(PAST_ID);
    expect(s.spawned).toBe(true);
    expect(s.running).toBe(true);
    expect(s.cwd).toBe(join(root, "sub")); // the session's own directory, not the root
    expect(s.firstPrompt).toBe("past prompt"); // history is still there
    expect((await post(`/api/sessions/${PAST_ID}/resume`)).status).toBe(409);
    expect((await post(`/api/sessions/${PAST_ID}/message`, { text: "resumed" })).status).toBe(200);
    await waitFor(() => Buffer.from(hub.sessions.ring(PAST_ID)!).toString("utf8").includes("resumed"));
    expect((await post(`/api/sessions/nope/resume`)).status).toBe(404);
    await fetch(`${base}/api/sessions/${PAST_ID}`, { method: "DELETE" });
    await waitFor(() => hub.sessions.get(PAST_ID)?.status === "exited");
    // Back to a past session that can be resumed again.
    expect((await post(`/api/sessions/${PAST_ID}/resume`)).status).toBe(201);
    await fetch(`${base}/api/sessions/${PAST_ID}`, { method: "DELETE" });
    await waitFor(() => hub.sessions.get(PAST_ID)?.status === "exited");
    hub.sessions.remove(PAST_ID);
  });

  test("subscribed UI socket gets history, live entries and pty bytes", async () => {
    const ui = new Sock(wsBase + "/ui");
    await ui.ready();
    const first = await ui.next((f) => f.type === "sessions");
    expect(first.sessions.map((s: any) => s.id)).toContain(PAST_ID);

    ui.send({ type: "subscribe", id: PAST_ID });
    const hist = await ui.next((f) => f.type === "history" && f.id === PAST_ID);
    expect(hist.entries.length).toBe(2);
    expect(hist.truncated).toBe(false);

    // A line appended to the transcript arrives as a live entry.
    const file = join(home, ".claude", "projects", encodeProjectDir(join(root, "sub")), `${PAST_ID}.jsonl`);
    const line = { type: "user", uuid: `${PAST_ID}-u2`, sessionId: PAST_ID, timestamp: "2026-09-12T10:01:00.000Z", message: { role: "user", content: "second prompt" } };
    writeFileSync(file, JSON.stringify(line) + "\n", { flag: "a" });
    const live = await ui.next((f) => f.type === "entry" && f.id === PAST_ID);
    expect(live.entry.kind).toBe("prompt");
    expect(live.entry.text).toBe("second prompt");

    // Switching to a spawned session replays its ring and streams pty bytes.
    const s = await (await post("/api/sessions", { name: "pty" })).json();
    hub.sessions.message(s.id, "before-subscribe");
    await waitFor(() => Buffer.from(hub.sessions.ring(s.id)!).toString("utf8").includes("before-subscribe"));
    ui.send({ type: "subscribe", id: s.id });
    await ui.next((f) => f.type === "history" && f.id === s.id);
    const replay = await ui.next((f) => f.type === "pty" && f.id === s.id);
    expect(Buffer.from(replay.data, "base64").toString("utf8")).toContain("before-subscribe");
    ui.frames.length = 0;
    await post(`/api/sessions/${s.id}/message`, { text: "after-subscribe" });
    await ui.next((f) => f.type === "pty" && Buffer.from(f.data, "base64").toString("utf8").includes("after-subscribe"));
    // Past-session entries no longer reach this socket.
    writeFileSync(file, JSON.stringify(line) + "\n", { flag: "a" });
    await Bun.sleep(700);
    expect(ui.frames.some((f) => f.type === "entry" && f.id === PAST_ID)).toBe(false);

    hub.sessions.remove(s.id);
    await ui.next((f) => f.type === "session_removed" && f.id === s.id);
    ui.close();
  });

  test("pty bytes survive the base64 hop intact", async () => {
    const ui = new Sock(wsBase + "/ui");
    await ui.ready();
    const s = await (await post("/api/sessions", { name: "bytes" })).json();
    ui.send({ type: "subscribe", id: s.id });
    await ui.next((f) => f.type === "history" && f.id === s.id);
    const payload = "héllo ✓ \x1b[31mred\x1b[0m";
    await post(`/api/sessions/${s.id}/input`, { data: Buffer.from(payload).toString("base64") });
    await ui.next((f) => f.type === "pty" && f.id === s.id && Buffer.from(f.data, "base64").toString("utf8").includes("red"));
    const all = ui.frames
      .filter((f) => f.type === "pty" && f.id === s.id)
      .map((f) => Buffer.from(f.data, "base64").toString("utf8"))
      .join("");
    expect(all).toContain("héllo ✓");
    hub.sessions.remove(s.id);
    ui.close();
  });
});

describe("agent and UI websockets", () => {
  test("optional channel plugin: message and permission round-trip", async () => {
    const ui = new Sock(wsBase + "/ui");
    await ui.ready();
    await ui.next((f) => f.type === "sessions");

    // The plugin attaches to a session the hub already knows from disk.
    const agent = new Sock(wsBase + "/agent");
    await agent.ready();
    agent.send({ type: "hello", sessionId: PAST_ID, cwd: join(root, "sub"), pid: 1, ppid: 1, name: "ext" });
    const listed = await ui.next((f) => f.type === "sessions" && f.sessions.some((s: any) => s.id === PAST_ID && s.agentConnected));
    expect(listed.sessions.find((s: any) => s.id === PAST_ID).spawned).toBe(false);

    // Stop/delete still need a PTY; messages go through the channel.
    expect((await post(`/api/sessions/${PAST_ID}/stop`)).status).toBe(409);
    const r = await post(`/api/sessions/${PAST_ID}/message`, { text: "hello agent" });
    expect(await r.json()).toEqual({ ok: true, via: "channel" });
    const msg = await agent.next((f) => f.type === "message");
    expect(msg.text).toBe("hello agent");

    // Permission relay: agent -> UI, verdict UI -> agent.
    agent.send({ type: "permission_request", request_id: "req-1", tool_name: "Bash", description: "run ls", input_preview: "ls" });
    const req = await ui.next((f) => f.type === "permission_request" && f.id === PAST_ID);
    expect(req.request.requestId).toBe("req-1");
    const detail = await (await fetch(`${base}/api/sessions/${PAST_ID}`)).json();
    expect(detail.pending.map((p: any) => p.requestId)).toEqual(["req-1"]);
    expect((await post(`/api/sessions/${PAST_ID}/permission`, { request_id: "nope", behavior: "allow" })).status).toBe(404);
    expect((await post(`/api/sessions/${PAST_ID}/permission`, { request_id: "req-1", behavior: "deny" })).status).toBe(200);
    const verdict = await agent.next((f) => f.type === "permission");
    expect(verdict).toEqual({ type: "permission", request_id: "req-1", behavior: "deny" });
    await ui.next((f) => f.type === "permission_resolved" && f.request_id === "req-1");
    expect((await post(`/api/sessions/${PAST_ID}/permission`, { request_id: "req-1", behavior: "allow" })).status).toBe(404);

    // Pending prompts die with the plugin socket.
    agent.send({ type: "permission_request", request_id: "req-2", tool_name: "Bash", description: "x", input_preview: "x" });
    await ui.next((f) => f.type === "permission_request" && f.request.requestId === "req-2");
    agent.close();
    await ui.next((f) => f.type === "permissions_cleared" && f.id === PAST_ID);
    expect((await post(`/api/sessions/${PAST_ID}/message`, { text: "gone" })).status).toBe(409);
    ui.close();
  });

  test("a newer agent connection for the same session replaces the older one", async () => {
    const a = new Sock(wsBase + "/agent");
    await a.ready();
    const closed = new Promise<number>((res) => a.ws.addEventListener("close", (e) => res(e.code)));
    a.send({ type: "hello", sessionId: PAST_ID, cwd: root, pid: 1, ppid: 1, name: null });
    await waitFor(() => a.ws.readyState === WebSocket.OPEN);
    const b = new Sock(wsBase + "/agent");
    await b.ready();
    b.send({ type: "hello", sessionId: PAST_ID, cwd: root, pid: 1, ppid: 1, name: null });
    expect(await closed).toBe(1000);
    const r = await post(`/api/sessions/${PAST_ID}/message`, { text: "to b" });
    expect(r.status).toBe(200);
    await b.next((f) => f.type === "message" && f.text === "to b");
    b.close();
  });

  test("agent hello without the configured token is closed", async () => {
    const gated = createHub({ port: 0, hostname: "127.0.0.1", rootCwd: root, home, agentToken: "s3cret" });
    try {
      const url = `ws://127.0.0.1:${gated.server.port}/agent`;
      const hello = { type: "hello", sessionId: PAST_ID, cwd: root, pid: 1, ppid: 1, name: null };
      const bad = new Sock(url);
      await bad.ready();
      const closed = new Promise<number>((res) => bad.ws.addEventListener("close", (e) => res(e.code)));
      bad.send(hello);
      expect(await closed).toBe(1008);
      const good = new Sock(url);
      await good.ready();
      good.send({ ...hello, token: "s3cret" });
      let connected = false;
      await waitFor(() => {
        void gated.listSessions().then((l) => (connected = l.some((s) => s.id === PAST_ID && s.agentConnected)));
        return connected;
      });
      good.close();
    } finally {
      gated.stop();
    }
  });

  test("agent socket whose first frame is not hello is closed", async () => {
    const agent = new Sock(wsBase + "/agent");
    await agent.ready();
    const closed = new Promise<number>((res) => agent.ws.addEventListener("close", (e) => res(e.code)));
    agent.send({ type: "reply", text: "too early" });
    expect(await closed).toBe(1008);
  });
});
