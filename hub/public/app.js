// claude-web UI — plain ES module, no build step.
const $ = (sel) => document.querySelector(sel);
const wsUrl = (path) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;

const state = {
  sessions: new Map(), // id -> session summary
  chat: new Map(), // id -> ChatEntry[]
  pending: new Map(), // id -> PendingPermission[]
  selected: null,
  tab: "chat",
  ws: null,
  term: null,
  fit: null, // xterm FitAddon
  termSub: null, // session id the terminal is subscribed to
};

/* ------------------------------- networking ------------------------------ */

async function api(path, body, method = "POST") {
  const r = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error ?? msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return r.json();
}

function connect() {
  const ws = new WebSocket(wsUrl("/ui"));
  state.ws = ws;
  ws.addEventListener("open", () => {
    $("#conn").classList.add("on");
    if (state.termSub) {
      // The hub replays its ring buffer on every subscribe; start from a clean screen.
      state.term?.reset();
      ws.send(JSON.stringify({ type: "subscribe_pty", id: state.termSub }));
    }
  });
  ws.addEventListener("close", () => {
    $("#conn").classList.remove("on");
    setTimeout(connect, 1500);
  });
  ws.addEventListener("message", (ev) => {
    let frame;
    try {
      frame = JSON.parse(ev.data);
    } catch (err) {
      console.warn("claude-web: dropped malformed frame", err);
      return;
    }
    try {
      onFrame(frame);
    } catch (err) {
      console.error("claude-web: frame handler failed", frame?.type, err);
    }
  });
}

function onFrame(f) {
  switch (f.type) {
    case "snapshot":
      state.sessions = new Map(f.sessions.map((s) => [s.id, s]));
      state.chat = new Map(Object.entries(f.chat));
      state.pending = new Map(Object.entries(f.pending));
      if (!state.selected) state.selected = remembered();
      if (state.selected && !state.sessions.has(state.selected)) state.selected = null;
      renderSessions();
      renderSession();
      break;
    case "session":
      state.sessions.set(f.session.id, f.session);
      renderSessions();
      if (f.session.id === state.selected) renderHeader();
      break;
    case "chat": {
      const log = state.chat.get(f.id) ?? [];
      log.push(f.entry);
      state.chat.set(f.id, log);
      if (f.id === state.selected) appendChat(f.entry);
      break;
    }
    case "permission_request": {
      const list = state.pending.get(f.id) ?? [];
      list.push(f.request);
      state.pending.set(f.id, list);
      if (f.id === state.selected) renderPermission();
      break;
    }
    case "session_removed":
      state.sessions.delete(f.id);
      state.chat.delete(f.id);
      state.pending.delete(f.id);
      if (state.selected === f.id) state.selected = null;
      renderSessions();
      renderSession();
      break;
    case "permissions_cleared":
      state.pending.set(f.id, []);
      if (f.id === state.selected) renderPermission();
      break;
    case "permission_resolved": {
      const list = (state.pending.get(f.id) ?? []).filter((p) => p.requestId !== f.request_id);
      state.pending.set(f.id, list);
      if (f.id === state.selected) renderPermission();
      break;
    }
    case "pty":
      if (state.term && f.id === state.termSub) {
        state.term.write(Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)));
      }
      break;
    default:
      break;
  }
}

/* -------------------------------- rendering ------------------------------ */

function renderSessions() {
  const ul = $("#sessions");
  ul.innerHTML = "";
  const list = [...state.sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
  for (const s of list) {
    const li = document.createElement("li");
    li.className = s.id === state.selected ? "selected" : "";
    li.innerHTML = `
      <div class="title">
        <span class="dot ${s.status === "running" ? "on" : ""}" title="${s.status}"></span>
        <span class="name">${esc(s.name || s.id.slice(0, 8))}</span>
        <span class="badge">${s.kind}</span>
        <span class="dot ${s.agentConnected ? "on" : ""}" title="channel plugin ${s.agentConnected ? "connected" : "not connected"}"></span>
      </div>
      <code title="${esc(s.cwd)}">${esc(s.cwd)}</code>`;
    li.addEventListener("click", () => select(s.id));
    ul.appendChild(li);
  }
}

function renderSession() {
  const s = state.sessions.get(state.selected);
  $("#empty").hidden = !!s;
  $("#session").hidden = !s;
  if (!s) return;
  renderHeader();
  renderChat();
  renderPermission();
  showTab(state.tab);
}

function renderHeader() {
  const s = state.sessions.get(state.selected);
  if (!s) return;
  $("#s-name").textContent = s.name || s.id.slice(0, 8);
  $("#s-kind").textContent = s.kind;
  const st = $("#s-status");
  const exit = s.exitCode != null ? String(s.exitCode) : s.exitSignal;
  st.textContent = s.status + (exit ? ` (${exit})` : "");
  st.className = `badge ${s.status}`;
  $("#s-cwd").textContent = `${s.cwd}  ·  ${s.id}`;
  const owned = s.kind === "spawned" && s.status === "running";
  const finished = s.status === "exited" || s.status === "disconnected";
  $("#btn-steer").disabled = !owned;
  $("#btn-stop").disabled = !owned;
  $("#btn-kill").disabled = !(owned || finished);
  $("#btn-kill").textContent = finished ? "Remove" : "Kill";
  $("#tab-term").disabled = s.kind !== "spawned";
  $("#btn-send").disabled = !s.agentConnected;
}

function renderChat() {
  const log = $("#chat-log");
  log.innerHTML = "";
  for (const e of state.chat.get(state.selected) ?? []) appendChat(e, false);
  log.scrollTop = log.scrollHeight;
}

function appendChat(e, scroll = true) {
  const log = $("#chat-log");
  const div = document.createElement("div");
  div.className = `msg ${e.role}`;
  if (e.role === "transcript") {
    const parts = [];
    if (e.text) parts.push(esc(e.text));
    for (const t of e.tools ?? []) {
      parts.push(
        `<details><summary>▸ ${esc(t.name)}</summary><pre>${esc(preview(t.input))}</pre></details>`,
      );
    }
    div.innerHTML = parts.join("<br>");
  } else {
    div.textContent = e.text;
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = new Date(e.ts).toLocaleTimeString();
    div.appendChild(ts);
  }
  log.appendChild(div);
  if (scroll) log.scrollTop = log.scrollHeight;
}

function renderPermission() {
  const banner = $("#perm-banner");
  const p = (state.pending.get(state.selected) ?? [])[0];
  banner.hidden = !p;
  if (!p) return;
  $("#perm-body").innerHTML = `<strong>${esc(p.toolName)}</strong> wants permission: ${esc(p.description)}<pre>${esc(p.inputPreview)}</pre>`;
  banner.dataset.requestId = p.requestId;
}

function showTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("active", b.dataset.tab === tab);
  $("#pane-chat").hidden = tab !== "chat";
  $("#pane-term").hidden = tab !== "term";
  if (tab === "term") mountTerminal();
}

/* -------------------------------- terminal ------------------------------- */

function mountTerminal() {
  const id = state.selected;
  if (!id) return;
  if (!state.term) {
    if (typeof window.Terminal !== "function" || typeof window.FitAddon?.FitAddon !== "function") {
      $("#term").textContent = "xterm failed to load (/vendor/xterm*.js). Terminal view unavailable.";
      return;
    }
    state.term = new window.Terminal({ convertEol: false, cursorBlink: true, fontSize: 13, scrollback: 5000 });
    state.fit = new window.FitAddon.FitAddon();
    state.term.loadAddon(state.fit);
    state.term.open($("#term"));
    state.term.onData((data) => {
      if (state.termSub) api(`/sessions/${state.termSub}/input`, { data: btoa(unescape(encodeURIComponent(data))) }).catch(() => {});
    });
    state.term.onResize(({ cols, rows }) => {
      if (state.termSub) api(`/sessions/${state.termSub}/resize`, { cols, rows }).catch(() => {});
    });
    new ResizeObserver(fitTerminal).observe($("#term"));
  }
  if (state.termSub !== id) {
    state.termSub = id;
    state.term.reset();
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: "subscribe_pty", id }));
  }
  fitTerminal();
}

function fitTerminal() {
  if (!state.term || !state.fit || $("#term").clientWidth === 0) return;
  state.fit.fit(); // triggers onResize -> /resize when the size actually changes
}

/* --------------------------------- actions ------------------------------- */

function remembered() {
  try { return localStorage.getItem("claude-web:selected"); } catch { return null; }
}

function select(id) {
  state.selected = id;
  try { localStorage.setItem("claude-web:selected", id); } catch { /* private mode */ }
  renderSessions();
  renderSession();
}

async function act(fn) {
  try {
    await fn();
  } catch (err) {
    alert(err.message);
  }
}

$("#new-session").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const name = String(fd.get("name") || "").trim();
  act(async () => {
    const s = await api("/sessions", { cwd: String(fd.get("cwd")).trim(), ...(name ? { name } : {}) });
    ev.target.reset();
    select(s.id);
  });
});

$("#composer").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const ta = $("#composer-text");
  const text = ta.value.trim();
  if (!text || !state.selected) return;
  act(async () => {
    await api(`/sessions/${state.selected}/message`, { text });
    ta.value = "";
  });
});
$("#composer-text").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    $("#composer").requestSubmit();
  }
});
$("#btn-steer").addEventListener("click", () => {
  const ta = $("#composer-text");
  const text = ta.value.trim();
  if (!text || !state.selected) return;
  act(async () => {
    await api(`/sessions/${state.selected}/steer`, { text });
    ta.value = "";
  });
});
$("#btn-stop").addEventListener("click", () => act(() => api(`/sessions/${state.selected}/stop`)));
$("#btn-kill").addEventListener("click", () => {
  const s = state.sessions.get(state.selected);
  const finished = s && (s.status === "exited" || s.status === "disconnected");
  if (!finished && !confirm("Kill this Claude session?")) return;
  act(() => api(`/sessions/${state.selected}`, undefined, "DELETE"));
});
$("#perm-allow").addEventListener("click", () => verdict("allow"));
$("#perm-deny").addEventListener("click", () => verdict("deny"));
function verdict(behavior) {
  const request_id = $("#perm-banner").dataset.requestId;
  if (!request_id) return;
  act(() => api(`/sessions/${state.selected}/permission`, { request_id, behavior }));
}
for (const b of document.querySelectorAll("#tabs button")) b.addEventListener("click", () => showTab(b.dataset.tab));

/* --------------------------------- helpers ------------------------------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function preview(input) {
  try {
    const s = JSON.stringify(input, null, 1);
    return s.length > 600 ? s.slice(0, 600) + "…" : s;
  } catch {
    return String(input);
  }
}

connect();
