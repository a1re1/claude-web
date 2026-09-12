// plugin/test/hub-client.test.ts — HubClient against a real local WebSocket.
import { afterAll, describe, expect, test } from "bun:test";
import { HubClient } from "../hub-client.ts";

type ServerSocket = { send: (data: string) => void; close: () => void };

/** Start a Bun.serve websocket server on port 0; returns helpers. */
function startWsServer(opts?: {
  onOpen?: (socket: ServerSocket) => void;
  onMessage?: (socket: ServerSocket, data: string) => void;
}) {
  const sockets = new Set<ServerSocket>();
  const server = Bun.serve<{ sock: ServerSocket | null }>({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req, { data: { sock: null as ServerSocket | null } })) return;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        const s = {
          send: (data: string) => ws.send(data),
          close: () => ws.close(),
        };
        (ws.data as { sock: ServerSocket | null }).sock = s;
        sockets.add(s);
        opts?.onOpen?.(s);
      },
      message(ws, data) {
        const s = (ws.data as { sock: ServerSocket | null }).sock;
        if (s) opts?.onMessage?.(s, String(data));
      },
      close(ws) {
        const s = (ws.data as { sock: ServerSocket | null }).sock;
        if (s) sockets.delete(s);
      },
    },
  });
  const url = `ws://127.0.0.1:${server.port}`;
  const broadcast = (data: string) => {
    for (const s of sockets) s.send(data);
  };
  return {
    broadcast,
    url,
    port: server.port,
    closeAll: () => {
      for (const s of [...sockets]) s.close();
    },
    stop: () => server.stop(true),
  };
}

const SHORT_BACKOFF = { minBackoffMs: 20, maxBackoffMs: 60 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until cond() is true or the timeout elapses (then throw). */
async function waitFor(cond: () => boolean, timeoutMs = 2000, what = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

describe("HubClient", () => {
  const clients: HubClient[] = [];
  const servers: ReturnType<typeof startWsServer>[] = [];
  const track = (c: HubClient) => {
    clients.push(c);
    return c;
  };

  afterAll(() => {
    for (const c of clients) c.close();
    for (const s of servers) s.stop();
  });

  test("sends hello on connect and round-trips frames", async () => {
    const seen: string[] = [];
    let clientSock: ServerSocket | null = null;
    const srv = startWsServer({
      onOpen: (s) => (clientSock = s),
      onMessage: (_s, data) => {
        seen.push(data);
        // Echo the frame back so the client's on() handler can observe it.
        clientSock?.send(`{"type":"echo","got":${data}}`);
      },
    });
    servers.push(srv);
    const received: Record<string, unknown>[] = [];
    const client = track(new HubClient(srv.url, { type: "hello", sessionId: "s1" }, SHORT_BACKOFF));
    client.on((f) => received.push(f));
    client.connect();
    await waitFor(() => client.connected, 2000, "connect");
    expect(seen).toEqual([JSON.stringify({ type: "hello", sessionId: "s1" })]);

    client.send({ type: "reply", text: "hi" });
    // The server echoes the hello back too, so pick out the reply's echo
    // instead of relying on arrival order.
    const isReplyEcho = (f: Record<string, unknown>) =>
      (f.got as { type?: string } | undefined)?.type === "reply";
    await waitFor(() => received.some(isReplyEcho), 2000, "echo frame");
    expect(received.find(isReplyEcho)).toEqual({ type: "echo", got: { type: "reply", text: "hi" } });
    expect(client.send({ type: "another" })).toBe(true);
  });

  test("send() returns false when not connected", async () => {
    const client = track(new HubClient("ws://127.0.0.1:1", { type: "hello" }, SHORT_BACKOFF));
    expect(client.connected).toBe(false);
    expect(client.send({ type: "reply", text: "x" })).toBe(false);
  });

  test("reconnects and re-sends hello after the server closes the socket", async () => {
    const hellos: string[] = [];
    const srv = startWsServer({ onMessage: (_s, data) => hellos.push(data) });
    servers.push(srv);
    const client = track(new HubClient(srv.url, { type: "hello", sessionId: "s2" }, SHORT_BACKOFF));
    client.connect();
    await waitFor(() => client.connected, 2000, "first connect");
    expect(hellos).toEqual([JSON.stringify({ type: "hello", sessionId: "s2" })]);

    srv.closeAll();
    await waitFor(() => !client.connected, 2000, "disconnect");
    expect(hellos.length).toBe(1);

    // Backoff is 20-60ms; the second hello must arrive without any manual kick.
    await waitFor(() => hellos.length >= 2, 3000, "re-hello after reconnect");
    expect(hellos[1]).toBe(JSON.stringify({ type: "hello", sessionId: "s2" }));
    expect(client.connected).toBe(true);
  });

  test("a second connect() replaces the socket without the stale close churning the live one", async () => {
    let opens = 0;
    const srv = startWsServer({ onOpen: () => opens++ });
    servers.push(srv);
    const client = track(new HubClient(srv.url, { type: "hello", sessionId: "s2b" }, SHORT_BACKOFF));
    client.connect();
    await waitFor(() => client.connected, 2000, "first connect");
    client.connect(); // the open socket becomes stale and is closed; its onclose must be inert
    await waitFor(() => opens === 2 && client.connected, 2000, "second connect");
    await Bun.sleep(200); // several 20-60ms backoffs: a stale onclose would churn the live socket here
    expect(client.connected).toBe(true);
    expect(opens).toBe(2);
  });

  test("close() stops reconnecting and clears state", async () => {
    const hellos: string[] = [];
    const srv = startWsServer({ onMessage: (_s, data) => hellos.push(data) });
    servers.push(srv);
    const client = track(new HubClient(srv.url, { type: "hello", sessionId: "s3" }, SHORT_BACKOFF));
    client.connect();
    await waitFor(() => client.connected, 2000, "connect");
    client.close();
    expect(client.connected).toBe(false);

    const hellosAtClose = hellos.length;
    srv.closeAll(); // would normally trigger a reconnect
    await sleep(250); // several backoff windows' worth
    expect(hellos.length).toBe(hellosAtClose);
    expect(client.send({ type: "reply", text: "x" })).toBe(false);
    expect(client.connected).toBe(false);
  });

  test("on() unsubscribe stops frame delivery", async () => {
    const srv = startWsServer({
      // any inbound frame is broadcast back to every connected socket
      onMessage: (_s, data) => srv.broadcast(data),
    });
    servers.push(srv);
    const kept: Record<string, unknown>[] = [];
    const dropped: Record<string, unknown>[] = [];
    const client = track(new HubClient(srv.url, { type: "hello" }, SHORT_BACKOFF));
    client.on((f) => kept.push(f));
    const off = client.on((f) => dropped.push(f));
    client.connect();
    await waitFor(() => kept.some((f) => f.type === "hello"), 2000, "hello echo");
    off();
    const droppedBefore = dropped.length;
    client.send({ type: "ping", n: 1 });
    await waitFor(() => kept.some((f) => f.type === "ping"), 2000, "ping echo");
    expect(dropped.length).toBe(droppedBefore);
  });
});
