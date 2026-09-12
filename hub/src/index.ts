// claude-web hub: HTTP + WebSocket server that fronts SessionManager.
//
//   GET  /                       UI
//   GET  /health
//   GET  /api/sessions           list
//   POST /api/sessions           { cwd, name? } -> spawn under a PTY
//   GET  /api/sessions/:id       summary + chat log + pending permissions
//   POST /api/sessions/:id/message     { text }  -> channel message (needs agent)
//   POST /api/sessions/:id/steer       { text }  -> typed into the PTY
//   POST /api/sessions/:id/stop                  -> Escape into the PTY
//   POST /api/sessions/:id/input       { data }  -> raw keystrokes (base64)
//   POST /api/sessions/:id/resize      { cols, rows }
//   POST /api/sessions/:id/permission  { request_id, behavior }
//   DELETE /api/sessions/:id           -> kill
//   WS   /agent                  plugin side (hello first)
//   WS   /ui                     browser side (snapshot first)

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import {
  AgentHelloSchema,
  AgentToHubSchema,
  CreateSessionBodySchema,
  InputBodySchema,
  MessageBodySchema,
  PermissionBodySchema,
  ResizeBodySchema,
  SteerBodySchema,
  UiToHubSchema,
  type ChatEntry,
  type HubToAgent,
  type HubToUi,
  type PendingPermission,
  type SnapshotFrame,
} from "./protocol";
import { SessionManager } from "./sessions";

const CHAT_LIMIT = 500;
const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const STATIC: Record<string, string> = {
  "/": join(PUBLIC_DIR, "index.html"),
  "/index.html": join(PUBLIC_DIR, "index.html"),
  "/app.js": join(PUBLIC_DIR, "app.js"),
  "/app.css": join(PUBLIC_DIR, "app.css"),
  // xterm is vendored from node_modules so the UI works without a CDN.
  "/vendor/xterm.js": Bun.resolveSync("@xterm/xterm/lib/xterm.js", import.meta.dir),
  "/vendor/xterm.css": Bun.resolveSync("@xterm/xterm/css/xterm.css", import.meta.dir),
  "/vendor/xterm-addon-fit.js": Bun.resolveSync("@xterm/addon-fit/lib/addon-fit.js", import.meta.dir),
};

type UiData = { kind: "ui"; ptySub: string | null };
type AgentData = { kind: "agent"; sessionId: string | null };
type WsData = UiData | AgentData;
type Ws = ServerWebSocket<WsData>;

export interface HubOptions {
  port: number;
  hostname: string;
  sessions?: SessionManager;
  // When set, an agent hello must carry the same token or the socket is
  // closed. Spawned sessions receive it via CLAUDE_WEB_TOKEN automatically.
  agentToken?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

// Browser-origin trust boundary. Requests from non-browser clients (curl, the
// plugin's WebSocket) carry no Origin and pass; a browser request must come
// from the page the hub itself served (Origin host == Host), otherwise a
// drive-by page could spawn sessions, type into terminals, or approve
// permission prompts with the user's replayed credentials.
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  const host = req.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function parseBody<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "content-type must be application/json");
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "invalid body");
  return parsed.data;
}

export function createHub(opts: HubOptions) {
  const chat = new Map<string, ChatEntry[]>();
  const pending = new Map<string, PendingPermission[]>();
  const agents = new Map<string, Ws>();
  const uis = new Set<Ws>();
  // Assigned once Bun.serve reports the bound port (port 0 in tests).
  let sessions: SessionManager;

  function broadcast(frame: HubToUi): void {
    const payload = JSON.stringify(frame);
    for (const ws of uis) {
      if (frame.type === "pty" && ws.data.kind === "ui" && ws.data.ptySub !== frame.id) continue;
      ws.send(payload);
    }
  }

  function addChat(id: string, entry: ChatEntry): void {
    const log = chat.get(id) ?? [];
    log.push(entry);
    if (log.length > CHAT_LIMIT) log.splice(0, log.length - CHAT_LIMIT);
    chat.set(id, log);
    broadcast({ type: "chat", id, entry });
  }

  function sendToAgent(id: string, frame: HubToAgent): void {
    const ws = agents.get(id);
    if (!ws) throw new HttpError(409, "no agent connected for this session");
    ws.send(JSON.stringify(frame));
  }

  function snapshot(): SnapshotFrame {
    return {
      type: "snapshot",
      sessions: sessions.list(),
      chat: Object.fromEntries(chat),
      pending: Object.fromEntries(pending),
    };
  }

  function mustSession(id: string) {
    const s = sessions.get(id);
    if (!s) throw new HttpError(404, "no such session");
    return s;
  }

  function owned(fn: () => void): Response {
    try {
      fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("external")) throw new HttpError(409, msg);
      throw err;
    }
    return json({ ok: true });
  }

  async function route(req: Request, server: ReturnType<typeof Bun.serve>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const path = url.pathname;

    // Static assets and /health are public; every API read/write and both
    // WebSocket upgrades must come from our own origin (or a non-browser client).
    const guarded = req.method !== "GET" || path === "/agent" || path === "/ui" || path.startsWith("/api/");
    if (guarded && !sameOrigin(req)) {
      throw new HttpError(403, "cross-origin request refused");
    }

    if (path === "/agent" || path === "/ui") {
      const data: WsData =
        path === "/agent" ? { kind: "agent", sessionId: null } : { kind: "ui", ptySub: null };
      if (server.upgrade(req, { data })) return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    }

    if (req.method === "GET" && path === "/health") return json({ ok: true });

    if (req.method === "GET" && path in STATIC) {
      const file = Bun.file(STATIC[path]!);
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file);
    }

    if (path === "/api/sessions") {
      if (req.method === "GET") return json(sessions.list());
      if (req.method === "POST") {
        const body = await parseBody(req, CreateSessionBodySchema);
        const session = sessions.spawn({ cwd: body.cwd, name: body.name ?? null });
        return json(session, 201);
      }
      return new Response("method not allowed", { status: 405 });
    }

    const m = /^\/api\/sessions\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
    if (!m) return new Response("not found", { status: 404 });
    const id = decodeURIComponent(m[1]!);
    const action = m[2];
    const session = mustSession(id);

    if (!action) {
      if (req.method === "GET") {
        return json({ session, chat: chat.get(id) ?? [], pending: pending.get(id) ?? [] });
      }
      if (req.method === "DELETE") {
        // Running spawned sessions are killed; anything that is no longer
        // running (exited, or an external session whose plugin dropped) is
        // reaped together with its chat log and pending prompts.
        if (session.kind === "spawned" && session.status === "running") {
          sessions.kill(id);
          return json({ ok: true, action: "killed" });
        }
        if (session.status === "running") {
          // External and still connected: the plugin would just reconnect and
          // resurrect it, so tell the caller to exit it from its own terminal.
          throw new HttpError(409, "external session is still running; exit it from its own terminal");
        }
        sessions.remove(id);
        chat.delete(id);
        pending.delete(id);
        agents.get(id)?.close(1000, "session removed");
        agents.delete(id);
        broadcast({ type: "session_removed", id });
        return json({ ok: true, action: "removed" });
      }
      return new Response("method not allowed", { status: 405 });
    }
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    switch (action) {
      case "message": {
        const { text } = await parseBody(req, MessageBodySchema);
        const msgId = randomUUID();
        sendToAgent(id, { type: "message", id: msgId, text });
        addChat(id, { id: msgId, role: "user", text, ts: Date.now() });
        return json({ ok: true, id: msgId });
      }
      case "steer": {
        const { text } = await parseBody(req, SteerBodySchema);
        const res = owned(() => sessions.steer(id, text));
        // owned() throws on failure, so the row is only logged for a delivered steer.
        addChat(id, { id: randomUUID(), role: "steer", text, ts: Date.now() });
        return res;
      }
      case "stop":
        return owned(() => sessions.stop(id));
      case "input": {
        const { data } = await parseBody(req, InputBodySchema);
        return owned(() => sessions.write(id, Buffer.from(data, "base64")));
      }
      case "resize": {
        const { cols, rows } = await parseBody(req, ResizeBodySchema);
        return owned(() => sessions.resize(id, cols, rows));
      }
      case "permission": {
        const { request_id, behavior } = await parseBody(req, PermissionBodySchema);
        const list = pending.get(id) ?? [];
        if (!list.some((p) => p.requestId === request_id)) {
          throw new HttpError(404, "no such pending permission request");
        }
        sendToAgent(id, { type: "permission", request_id, behavior });
        pending.set(
          id,
          list.filter((p) => p.requestId !== request_id),
        );
        broadcast({ type: "permission_resolved", id, request_id, behavior });
        return json({ ok: true });
      }
      default:
        return new Response("not found", { status: 404 });
    }
  }

  function onAgentMessage(ws: Ws, raw: unknown): void {
    const data = ws.data as AgentData;
    if (data.sessionId === null) {
      const hello = AgentHelloSchema.safeParse(raw);
      if (!hello.success) {
        ws.close(1008, "first frame must be hello");
        return;
      }
      if (opts.agentToken && hello.data.token !== opts.agentToken) {
        ws.close(1008, "bad agent token");
        return;
      }
      data.sessionId = hello.data.sessionId;
      const prev = agents.get(data.sessionId);
      if (prev && prev !== ws) prev.close(1000, "replaced by a newer agent connection");
      agents.set(data.sessionId, ws);
      sessions.attachExternal(hello.data);
      return;
    }
    const frame = AgentToHubSchema.safeParse(raw);
    if (!frame.success) return;
    const id = data.sessionId;
    if (frame.data.type === "reply") {
      addChat(id, { id: randomUUID(), role: "assistant", text: frame.data.text, ts: Date.now() });
    } else {
      const request: PendingPermission = {
        requestId: frame.data.request_id,
        toolName: frame.data.tool_name,
        description: frame.data.description,
        inputPreview: frame.data.input_preview,
        ts: Date.now(),
      };
      const list = pending.get(id) ?? [];
      list.push(request);
      pending.set(id, list);
      broadcast({ type: "permission_request", id, request });
    }
  }

  function onUiMessage(ws: Ws, raw: unknown): void {
    const frame = UiToHubSchema.safeParse(raw);
    if (!frame.success) return;
    const data = ws.data as UiData;
    data.ptySub = frame.data.id;
    const ring = sessions.ring(frame.data.id);
    if (ring && ring.length > 0) {
      ws.send(
        JSON.stringify({ type: "pty", id: frame.data.id, data: Buffer.from(ring).toString("base64") }),
      );
    }
  }

  const server = Bun.serve<WsData>({
    port: opts.port,
    hostname: opts.hostname,
    async fetch(req, srv) {
      try {
        return await route(req, srv);
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message }, err.status);
        console.error("[hub] request failed:", err);
        return json({ error: "internal error" }, 500);
      }
    },
    websocket: {
      open(ws) {
        if (ws.data.kind === "ui") {
          uis.add(ws);
          ws.send(JSON.stringify(snapshot()));
        }
      },
      message(ws, message) {
        let raw: unknown;
        try {
          raw = JSON.parse(typeof message === "string" ? message : Buffer.from(message).toString("utf8"));
        } catch {
          return;
        }
        if (ws.data.kind === "agent") onAgentMessage(ws, raw);
        else onUiMessage(ws, raw);
      },
      close(ws) {
        if (ws.data.kind === "ui") {
          uis.delete(ws);
          return;
        }
        const id = ws.data.sessionId;
        if (id && agents.get(id) === ws) {
          agents.delete(id);
          sessions.agentDisconnected(id);
          // Nobody can answer these prompts any more; drop them so the UI
          // does not offer an Allow/Deny that can only 409.
          if ((pending.get(id) ?? []).length > 0) {
            pending.delete(id);
            broadcast({ type: "permissions_cleared", id });
          }
        }
      },
    },
  });

  sessions =
    opts.sessions ??
    new SessionManager({ hubUrl: `ws://${opts.hostname}:${server.port}`, agentToken: opts.agentToken });
  sessions.onEvent((event) => {
    if (event.type === "transcript") {
      addChat(event.id, {
        id: randomUUID(),
        role: "transcript",
        text: event.event.text,
        ts: event.event.ts,
        tools: event.event.tools,
      });
      return;
    }
    if (event.type === "session_removed") {
      chat.delete(event.id);
      pending.delete(event.id);
      agents.get(event.id)?.close(1000, "session removed");
      agents.delete(event.id);
    }
    broadcast(event);
  });

  return { server, sessions };
}

if (import.meta.main) {
  const port = Number(process.env.CLAUDE_WEB_PORT ?? 8790);
  const hostname = process.env.CLAUDE_WEB_HOST ?? "127.0.0.1";
  const { server } = createHub({ port, hostname, agentToken: process.env.CLAUDE_WEB_TOKEN || undefined });
  console.error(`[hub] listening on http://${hostname}:${server.port}`);
}
