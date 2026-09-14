// claude-web hub: HTTP + WebSocket server behind the browser UI.
//
//   GET  /                        UI
//   GET  /health
//   GET  /api/sessions            every session under the root (running first)
//   POST /api/sessions            { cwd?, name?, prompt? } -> start claude under a PTY
//   GET  /api/sessions/:id        { session, entries, truncated, pending }
//   POST /api/sessions/:id/resume               -> claude --resume <id> in its cwd, under a PTY
//   POST /api/sessions/:id/message    { text }  -> typed into the PTY (or a channel message)
//   POST /api/sessions/:id/stop                 -> Escape into the PTY
//   POST /api/sessions/:id/input      { data }  -> raw keystrokes (base64)
//   POST /api/sessions/:id/resize     { cols, rows }
//   POST /api/sessions/:id/permission { request_id, behavior }
//   DELETE /api/sessions/:id          -> kill (running) / forget (exited); an
//                                        untouched external idle session is SIGTERMed by pid
//   WS   /agent                   optional channel plugin (hello first)
//   WS   /ui                      browser: `sessions` first, then subscribe/history/entry/pty
//
// PTY-backed controls exist only for sessions this hub spawned; sessions
// started elsewhere are observed through their transcript on disk.

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import { ConversationTailer, readConversation, transcriptPath } from "./conversation";
import { SessionIndex, inScope, type Scope } from "./discovery";
import {
  AgentHelloSchema,
  AgentToHubSchema,
  CreateSessionBodySchema,
  InputBodySchema,
  MessageBodySchema,
  PermissionBodySchema,
  ResizeBodySchema,
  UiToHubSchema,
  type HubToAgent,
  type HubToUi,
  type PendingPermission,
  type Session,
  type SessionInfo,
  type SessionsFrame,
} from "./protocol";
import { SessionExitedError, SessionManager, type SpawnedInfo } from "./sessions";

const HISTORY_LIMIT = 5000; // entries sent on subscribe; older ones are dropped
const REFRESH_MS = 2000; // session list rescan interval
const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const STATIC: Record<string, string> = {
  "/": join(PUBLIC_DIR, "index.html"),
  "/index.html": join(PUBLIC_DIR, "index.html"),
  "/app.js": join(PUBLIC_DIR, "app.js"),
  "/markdown.js": join(PUBLIC_DIR, "markdown.js"),
  "/app.css": join(PUBLIC_DIR, "app.css"),
  // xterm is vendored from node_modules so the UI works without a CDN.
  "/vendor/xterm.js": Bun.resolveSync("@xterm/xterm/lib/xterm.js", import.meta.dir),
  "/vendor/xterm.css": Bun.resolveSync("@xterm/xterm/css/xterm.css", import.meta.dir),
  "/vendor/xterm-addon-fit.js": Bun.resolveSync("@xterm/addon-fit/lib/addon-fit.js", import.meta.dir),
};

type UiData = { kind: "ui"; sub: string | null; gen: number; tailer: ConversationTailer | null };
type AgentData = { kind: "agent"; sessionId: string | null };
type WsData = UiData | AgentData;
type Ws = ServerWebSocket<WsData>;

export interface HubOptions {
  port: number;
  hostname: string;
  // Directory whose sessions are listed, and where new ones start.
  rootCwd: string;
  // "cwd" (default): only sessions in rootCwd itself; "tree": rootCwd and
  // below; "all": every session on the machine.
  scope?: Scope;
  // ~ override for tests (transcripts live under <home>/.claude).
  home?: string;
  sessions?: SessionManager;
  // When set, an agent hello must carry the same token or the socket is
  // closed. Spawned sessions receive it via CLAUDE_WEB_TOKEN automatically.
  agentToken?: string;
  refreshMs?: number;
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

// A spawned process that has not written its transcript yet still shows up.
function infoFromSpawned(s: SpawnedInfo): SessionInfo {
  return {
    id: s.id,
    cwd: s.cwd,
    transcriptPath: null,
    title: s.name,
    firstPrompt: null,
    lastPrompt: null,
    gitBranch: null,
    version: null,
    startedAt: s.createdAt,
    updatedAt: s.createdAt,
    sizeBytes: 0,
    running: s.status === "running",
    busy: false,
    pid: s.pid,
    name: s.name,
    memoryBytes: null,
  };
}

// An external session nobody has used: alive, idle, and no transcript on
// disk. Ending it loses nothing, which is the only case where the hub is
// willing to signal a process it did not start.
function isUntouched(s: Session): boolean {
  return s.running && !s.spawned && !s.busy && s.transcriptPath === null && s.pid !== null;
}

export function createHub(opts: HubOptions) {
  const pending = new Map<string, PendingPermission[]>();
  const agents = new Map<string, Ws>();
  const uis = new Set<Ws>();
  const scope: Scope = opts.scope ?? "cwd";
  const index = new SessionIndex({ rootCwd: opts.rootCwd, scope, home: opts.home });
  let sessions: SessionManager;
  let lastList = ""; // JSON of the last broadcast list, to skip no-op refreshes

  /* --------------------------------- sessions -------------------------------- */

  function merge(info: SessionInfo, spawned: SpawnedInfo | undefined): Session {
    return {
      ...info,
      running: info.running || spawned?.status === "running",
      pid: info.pid ?? spawned?.pid ?? null,
      name: info.name ?? spawned?.name ?? null,
      title: info.title ?? spawned?.name ?? null,
      spawned: spawned !== undefined,
      exitCode: spawned?.exitCode ?? null,
      exitSignal: spawned?.exitSignal ?? null,
      agentConnected: agents.has(info.id),
    };
  }

  async function listSessions(): Promise<Session[]> {
    const infos = await index.refresh();
    const seen = new Set<string>();
    const out: Session[] = [];
    for (const info of infos) {
      seen.add(info.id);
      out.push(merge(info, sessions.get(info.id)));
    }
    for (const s of sessions.list()) {
      if (!seen.has(s.id)) out.push(merge(infoFromSpawned(s), s));
    }
    out.sort((a, b) => Number(b.running) - Number(a.running) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return out;
  }

  async function getSession(id: string): Promise<Session> {
    await index.refresh();
    const info = index.get(id);
    const spawned = sessions.get(id);
    if (!info && !spawned) throw new HttpError(404, "no such session");
    return merge(info ?? infoFromSpawned(spawned!), spawned);
  }

  function transcriptFor(s: Session): string | null {
    return s.transcriptPath ?? (s.spawned ? transcriptPath(s.cwd, s.id, opts.home) : null);
  }

  async function sessionsFrame(): Promise<SessionsFrame> {
    return { type: "sessions", sessions: await listSessions(), pending: Object.fromEntries(pending) };
  }

  let refreshing = false;
  async function pushSessions(force = false): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      const frame = await sessionsFrame();
      const payload = JSON.stringify(frame);
      if (!force && payload === lastList) return;
      lastList = payload;
      for (const ws of uis) ws.send(payload);
    } catch (err) {
      console.error("[hub] session refresh failed:", err);
    } finally {
      refreshing = false;
    }
  }

  /* --------------------------------- broadcast ------------------------------- */

  function broadcast(frame: HubToUi): void {
    const payload = JSON.stringify(frame);
    for (const ws of uis) {
      const data = ws.data as UiData;
      if ((frame.type === "pty" || frame.type === "entry") && data.sub !== frame.id) continue;
      ws.send(payload);
    }
  }

  function sendToAgent(id: string, frame: HubToAgent): void {
    const ws = agents.get(id);
    if (!ws) throw new HttpError(409, "no channel plugin connected for this session");
    ws.send(JSON.stringify(frame));
  }

  /* ------------------------------ UI subscriptions --------------------------- */

  function unsubscribe(ws: Ws): void {
    const data = ws.data as UiData;
    data.tailer?.stop();
    data.tailer = null;
    data.sub = null;
  }

  async function subscribe(ws: Ws, id: string): Promise<void> {
    unsubscribe(ws);
    const data = ws.data as UiData;
    // Only the newest subscribe on a socket may install a tailer; older ones
    // that are still reading history bail out when they see a newer gen.
    const gen = ++data.gen;
    let session: Session;
    try {
      session = await getSession(id);
    } catch {
      return; // unknown id: nothing to stream
    }
    if (data.gen !== gen) return;
    data.sub = id;
    const path = transcriptFor(session);
    const history = path ? await readConversation(path, HISTORY_LIMIT) : { entries: [], truncated: false, bytes: 0 };
    if (data.gen !== gen) return; // re-subscribed while reading
    ws.send(JSON.stringify({ type: "history", id, entries: history.entries, truncated: history.truncated }));
    if (path) {
      data.tailer = new ConversationTailer(
        path,
        (entry) => {
          if (data.gen === gen) ws.send(JSON.stringify({ type: "entry", id, entry }));
        },
        { startAt: history.bytes },
      );
      data.tailer.start();
    }
    const ring = sessions.ring(id);
    if (ring && ring.length > 0) {
      ws.send(JSON.stringify({ type: "pty", id, data: Buffer.from(ring).toString("base64") }));
    }
  }

  /* ----------------------------------- routes -------------------------------- */

  function owned(id: string, fn: () => void): Response {
    if (!sessions.get(id)) throw new HttpError(409, "this session was not started by claude-web; only its transcript is available");
    try {
      fn();
    } catch (err) {
      if (err instanceof SessionExitedError) throw new HttpError(409, err.message);
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
        path === "/agent" ? { kind: "agent", sessionId: null } : { kind: "ui", sub: null, gen: 0, tailer: null };
      if (server.upgrade(req, { data })) return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    }

    if (req.method === "GET" && path === "/health") return json({ ok: true });
    if (req.method === "GET" && path === "/api/root") return json({ root: opts.rootCwd, scope });

    if (req.method === "GET" && path in STATIC) {
      const file = Bun.file(STATIC[path]!);
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file);
    }

    if (path === "/api/sessions") {
      if (req.method === "GET") return json(await listSessions());
      if (req.method === "POST") {
        const body = await parseBody(req, CreateSessionBodySchema);
        let spawned: SpawnedInfo;
        let cwd = opts.rootCwd;
        if (body.cwd !== undefined) {
          try {
            cwd = realpathSync(body.cwd);
          } catch {
            throw new HttpError(400, "no such directory");
          }
          // A session started outside the scope would never show up here.
          if (!inScope(scope, opts.rootCwd, cwd)) throw new HttpError(400, `directory is outside this claude-web's scope (${scope === "cwd" ? opts.rootCwd : `under ${opts.rootCwd}`})`);
        }
        try {
          spawned = sessions.spawn({ cwd, name: body.name ?? null, prompt: body.prompt ?? null });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(400, "no such directory");
          throw err;
        }
        return json(merge(infoFromSpawned(spawned), spawned), 201);
      }
      return new Response("method not allowed", { status: 405 });
    }

    const m = /^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (!m) return new Response("not found", { status: 404 });
    const id = decodeURIComponent(m[1]!);
    const action = m[2];

    if (!action) {
      if (req.method === "GET") {
        const session = await getSession(id);
        const p = transcriptFor(session);
        const conv = p ? await readConversation(p, HISTORY_LIMIT) : { entries: [], truncated: false, bytes: 0 };
        return json({ session, entries: conv.entries, truncated: conv.truncated, pending: pending.get(id) ?? [] });
      }
      if (req.method === "DELETE") {
        const spawned = sessions.get(id);
        if (!spawned) {
          const session = await getSession(id); // 404 when unknown
          if (!isUntouched(session)) {
            throw new HttpError(409, "this session was not started by claude-web and has a conversation; exit it from its own terminal");
          }
          try {
            process.kill(session.pid!, "SIGTERM");
          } catch {
            throw new HttpError(409, "process already gone");
          }
          void pushSessions(true);
          return json({ ok: true, action: "killed", external: true });
        }
        if (spawned.status === "running") {
          sessions.kill(id);
          return json({ ok: true, action: "killed" });
        }
        sessions.remove(id);
        pending.delete(id);
        return json({ ok: true, action: "removed" });
      }
      return new Response("method not allowed", { status: 405 });
    }
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    switch (action) {
      case "resume": {
        const session = await getSession(id); // 404 when unknown
        if (session.running) {
          throw new HttpError(409, session.spawned ? "session is already running" : "session is running in another terminal; exit it there first");
        }
        let spawned: SpawnedInfo;
        try {
          spawned = sessions.spawn({ cwd: session.cwd, name: session.name, resume: id });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(409, `directory no longer exists: ${session.cwd}`);
          throw err;
        }
        pending.delete(id);
        return json(merge(index.get(id) ?? infoFromSpawned(spawned), spawned), 201);
      }
      case "message": {
        const { text } = await parseBody(req, MessageBodySchema);
        const spawned = sessions.get(id);
        if (spawned?.status === "running") return owned(id, () => sessions.message(id, text));
        if (agents.has(id)) {
          sendToAgent(id, { type: "message", id: randomUUID(), text });
          return json({ ok: true, via: "channel" });
        }
        await getSession(id); // 404 when unknown
        throw new HttpError(409, "session is not running under claude-web and has no channel plugin attached");
      }
      case "stop":
        return owned(id, () => sessions.stop(id));
      case "input": {
        const { data } = await parseBody(req, InputBodySchema);
        return owned(id, () => sessions.write(id, Buffer.from(data, "base64")));
      }
      case "resize": {
        const { cols, rows } = await parseBody(req, ResizeBodySchema);
        return owned(id, () => sessions.resize(id, cols, rows));
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

  /* ------------------------------- agent sockets ------------------------------ */

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
      void pushSessions(true);
      return;
    }
    const frame = AgentToHubSchema.safeParse(raw);
    if (!frame.success) return;
    const id = data.sessionId;
    if (frame.data.type === "reply") return; // replies already land in the transcript
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

  function onUiMessage(ws: Ws, raw: unknown): void {
    const frame = UiToHubSchema.safeParse(raw);
    if (!frame.success) return;
    if (frame.data.type === "subscribe") void subscribe(ws, frame.data.id);
    else unsubscribe(ws);
  }

  /* ---------------------------------- server --------------------------------- */

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
      async open(ws) {
        if (ws.data.kind === "ui") {
          uis.add(ws);
          try {
            ws.send(JSON.stringify(await sessionsFrame()));
          } catch (err) {
            console.error("[hub] initial session list failed:", err);
          }
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
          unsubscribe(ws);
          uis.delete(ws);
          return;
        }
        const id = ws.data.sessionId;
        if (id && agents.get(id) === ws) {
          agents.delete(id);
          pending.delete(id);
          broadcast({ type: "permissions_cleared", id });
          void pushSessions(true);
        }
      },
    },
  });

  sessions =
    opts.sessions ??
    new SessionManager({ hubUrl: `ws://${opts.hostname}:${server.port}`, agentToken: opts.agentToken });
  sessions.onEvent((event) => {
    if (event.type === "pty") {
      broadcast(event);
      return;
    }
    if (event.type === "session_removed") {
      pending.delete(event.id);
      broadcast(event);
    }
    void pushSessions(true);
  });

  const refresher = setInterval(() => void pushSessions(), opts.refreshMs ?? REFRESH_MS);

  function stop(): void {
    clearInterval(refresher);
    for (const ws of uis) unsubscribe(ws);
    server.stop(true);
  }

  return { server, sessions, index, stop, listSessions };
}

if (import.meta.main) {
  const port = Number(process.env.CLAUDE_WEB_PORT ?? 8790);
  const hostname = process.env.CLAUDE_WEB_HOST ?? "127.0.0.1";
  const { server } = createHub({
    port,
    hostname,
    rootCwd: process.cwd(),
    agentToken: process.env.CLAUDE_WEB_TOKEN || undefined,
  });
  console.error(`[hub] listening on http://${hostname}:${server.port} (sessions under ${process.cwd()})`);
}
