import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
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

beforeAll(() => {
  hub = createHub({
    port: 0,
    hostname: "127.0.0.1",
    sessions: new SessionManager({ spawnCommand: () => ["cat"], hubUrl: "ws://127.0.0.1:1" }),
  });
  base = `http://127.0.0.1:${hub.server.port}`;
  wsBase = `ws://127.0.0.1:${hub.server.port}`;
});
afterAll(() => {
  for (const s of hub.sessions.list()) hub.sessions.remove(s.id);
  hub.server.stop(true);
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
  test("health", async () => {
    const r = await fetch(base + "/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
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
  });

  test("cross-origin browser requests are refused", async () => {
    const evil = { origin: "https://evil.example", "content-type": "application/json" };
    const r = await fetch(base + "/api/sessions", { method: "POST", headers: evil, body: "{}" });
    expect(r.status).toBe(403);
    // Reads are guarded too: a drive-by page must not be able to dump chat logs or prompts.
    expect((await fetch(base + "/api/sessions", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(base + "/health", { headers: { origin: "https://evil.example" } })).status).toBe(200);
    const ok = await fetch(base + "/api/sessions", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ cwd: tmpdir(), name: "same-origin" }),
    });
    expect(ok.status).toBe(201);
    hub.sessions.remove((await ok.json()).id);
    // GETs stay readable cross-origin only through CORS, which the hub never grants.
    expect((await fetch(base + "/health", { headers: { origin: "https://evil.example" } })).status).toBe(200);

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
    expect((await post("/api/sessions", { nope: 1 })).status).toBe(400);
    expect((await post("/api/sessions", "not json")).status).toBe(400);
  });

  test("session CRUD over HTTP", async () => {
    const created = await post("/api/sessions", { cwd: tmpdir(), name: "api" });
    expect(created.status).toBe(201);
    const s = await created.json();
    expect(s.kind).toBe("spawned");

    const list = await (await fetch(base + "/api/sessions")).json();
    expect(list.map((x: any) => x.id)).toContain(s.id);

    const one = await (await fetch(`${base}/api/sessions/${s.id}`)).json();
    expect(one.session.id).toBe(s.id);
    expect(one.chat).toEqual([]);

    expect((await fetch(`${base}/api/sessions/does-not-exist`)).status).toBe(404);

    // No plugin has dialed in for this session: channel messages are refused.
    expect((await post(`/api/sessions/${s.id}/message`, { text: "hi" })).status).toBe(409);

    // PTY controls work on spawned sessions.
    expect((await post(`/api/sessions/${s.id}/stop`)).status).toBe(200);
    expect((await post(`/api/sessions/${s.id}/resize`, { cols: 80, rows: 24 })).status).toBe(200);
    expect((await post(`/api/sessions/${s.id}/input`, { data: btoa("x") })).status).toBe(200);

    // Raw input is delivered as bytes: a multi-byte character split across
    // two calls must come out intact from the PTY echo.
    const ui0 = new Sock(wsBase + "/ui");
    await ui0.ready();
    await ui0.next((f) => f.type === "snapshot");
    ui0.send({ type: "subscribe_pty", id: s.id });
    const euro = Buffer.from("€"); // e2 82 ac
    await post(`/api/sessions/${s.id}/input`, { data: euro.subarray(0, 1).toString("base64") });
    await post(`/api/sessions/${s.id}/input`, { data: euro.subarray(1).toString("base64") });
    const bytesDeadline = Date.now() + 3000;
    for (;;) {
      const raw = Buffer.concat(
        ui0.frames.filter((f) => f.type === "pty" && f.id === s.id).map((f) => Buffer.from(f.data, "base64")),
      );
      if (raw.includes(euro)) break;
      if (Date.now() > bytesDeadline) throw new Error(`euro never echoed intact: ${raw.toString("hex")}`);
      await Bun.sleep(20);
    }
    ui0.close();

    const del = await fetch(`${base}/api/sessions/${s.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json()).action).toBe("killed");
    const deadline = Date.now() + 3000;
    while (hub.sessions.get(s.id)?.status !== "exited" && Date.now() < deadline) await Bun.sleep(20);
    expect(hub.sessions.get(s.id)?.status).toBe("exited");

    // A second DELETE reaps the exited session.
    const ui = new Sock(wsBase + "/ui");
    await ui.ready();
    const reap = await fetch(`${base}/api/sessions/${s.id}`, { method: "DELETE" });
    expect((await reap.json()).action).toBe("removed");
    await ui.next((f) => f.type === "session_removed" && f.id === s.id);
    expect((await fetch(`${base}/api/sessions/${s.id}`)).status).toBe(404);
    ui.close();
  });

  test("steer output reaches a pty-subscribed UI socket", async () => {
    const s = hub.sessions.spawn({ cwd: tmpdir() });
    const ui = new Sock(wsBase + "/ui");
    await ui.ready();
    await ui.next((f) => f.type === "snapshot");
    ui.send({ type: "subscribe_pty", id: s.id });
    expect((await post(`/api/sessions/${s.id}/steer`, { text: "ping-steer" })).status).toBe(200);
    const deadline = Date.now() + 3000;
    for (;;) {
      const text = ui.frames
        .filter((f) => f.type === "pty" && f.id === s.id)
        .map((f) => Buffer.from(f.data, "base64").toString("utf8"))
        .join("");
      if (text.includes("ping-steer")) break;
      if (Date.now() > deadline) throw new Error("pty output never arrived");
      await Bun.sleep(20);
    }
    // The steer is also logged as a chat row so it is visible off the Terminal tab.
    const row = ui.frames.find((f) => f.type === "chat" && f.id === s.id && f.entry.role === "steer");
    expect(row?.entry.text).toBe("ping-steer");
    const detail = await (await fetch(`${base}/api/sessions/${s.id}`)).json();
    expect(detail.chat.some((e: any) => e.role === "steer" && e.text === "ping-steer")).toBe(true);
    ui.close();
    hub.sessions.remove(s.id);
  });
});

describe("agent and UI websockets", () => {
  test("hello registers an external session; message/reply/permission round-trip", async () => {
    const ui = new Sock(wsBase + "/ui");
    await ui.ready();
    const snap = await ui.next((f) => f.type === "snapshot");
    expect(Array.isArray(snap.sessions)).toBe(true);

    const agent = new Sock(wsBase + "/agent");
    await agent.ready();
    agent.send({ type: "hello", sessionId: "ext-42", cwd: "/tmp/proj", pid: 1, ppid: 1, name: "ext" });
    const sess = await ui.next((f) => f.type === "session" && f.session.id === "ext-42");
    expect(sess.session.kind).toBe("external");
    expect(sess.session.agentConnected).toBe(true);

    // Steer/stop/delete are refused for live external sessions.
    expect((await post("/api/sessions/ext-42/stop")).status).toBe(409);
    expect((await fetch(`${base}/api/sessions/ext-42`, { method: "DELETE" })).status).toBe(409);

    // hub -> agent message, mirrored to the UI chat log.
    const r = await post("/api/sessions/ext-42/message", { text: "hello agent" });
    expect(r.status).toBe(200);
    const msg = await agent.next((f) => f.type === "message");
    expect(msg.text).toBe("hello agent");
    const userChat = await ui.next((f) => f.type === "chat" && f.entry.role === "user");
    expect(userChat.entry.text).toBe("hello agent");

    // agent -> hub reply.
    agent.send({ type: "reply", text: "hello browser" });
    const reply = await ui.next((f) => f.type === "chat" && f.entry.role === "assistant");
    expect(reply.entry.text).toBe("hello browser");
    const detail = await (await fetch(`${base}/api/sessions/ext-42`)).json();
    expect(detail.chat.map((c: any) => c.role)).toEqual(["user", "assistant"]);

    // permission relay.
    agent.send({
      type: "permission_request",
      request_id: "abcde",
      tool_name: "Bash",
      description: "List files",
      input_preview: '{"command":"ls"}',
    });
    const preq = await ui.next((f) => f.type === "permission_request");
    expect(preq.request.requestId).toBe("abcde");
    expect((await post("/api/sessions/ext-42/permission", { request_id: "zzzzz", behavior: "allow" })).status).toBe(404);
    expect((await post("/api/sessions/ext-42/permission", { request_id: "abcde", behavior: "allow" })).status).toBe(200);
    const verdict = await agent.next((f) => f.type === "permission");
    expect(verdict).toEqual({ type: "permission", request_id: "abcde", behavior: "allow" });
    await ui.next((f) => f.type === "permission_resolved" && f.request_id === "abcde");
    const after = await (await fetch(`${base}/api/sessions/ext-42`)).json();
    expect(after.pending).toEqual([]);

    // A prompt left pending when the agent drops is cleared, not orphaned.
    agent.send({
      type: "permission_request",
      request_id: "fghij",
      tool_name: "Write",
      description: "Write a file",
      input_preview: "{}",
    });
    await ui.next((f) => f.type === "permission_request" && f.request.requestId === "fghij");

    // agent drop -> disconnected.
    agent.close();
    await ui.next((f) => f.type === "permissions_cleared" && f.id === "ext-42");
    expect((await (await fetch(`${base}/api/sessions/ext-42`)).json()).pending).toEqual([]);
    const gone = await ui.next(
      (f) => f.type === "session" && f.session.id === "ext-42" && f.session.status === "disconnected",
    );
    expect(gone.session.agentConnected).toBe(false);
    expect((await post("/api/sessions/ext-42/message", { text: "anyone?" })).status).toBe(409);
    ui.close();
  });

  test("agent hello without the configured token is closed", async () => {
    const gated = createHub({ port: 0, hostname: "127.0.0.1", agentToken: "s3cret" });
    try {
      const url = `ws://127.0.0.1:${gated.server.port}/agent`;
      const hello = { type: "hello", sessionId: "tok-1", cwd: tmpdir(), pid: 1, ppid: 1, name: null };
      const bad = new Sock(url);
      await bad.ready();
      const closed = new Promise<number>((res) => bad.ws.addEventListener("close", (e) => res(e.code)));
      bad.send(hello);
      expect(await closed).toBe(1008);
      expect(gated.sessions.get("tok-1")).toBeUndefined();
      const good = new Sock(url);
      await good.ready();
      good.send({ ...hello, token: "s3cret" });
      await waitFor(() => gated.sessions.get("tok-1")?.agentConnected === true);
      good.close();
    } finally {
      gated.server.stop(true);
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
