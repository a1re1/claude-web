// claude-web UI. Framework-free: one WebSocket to /ui carries the session list,
// the selected session's full conversation (history + live entries), and raw
// PTY bytes for sessions the hub spawned. Actions go over HTTP.
(() => {
  "use strict";

  const MAX_CONTEXT_TOKENS = 1_000_000; // matches CLAUDE_WEB_MAX_CONTEXT_TOKENS default in the README
  const $ = (id) => document.getElementById(id);
  const el = {
    root: $("root"),
    conn: $("conn"),
    list: $("sessions"),
    newToggle: $("new-toggle"),
    newForm: $("new-form"),
    newCancel: $("new-cancel"),
    empty: $("empty"),
    view: $("view"),
    title: $("view-title"),
    sub: $("view-sub"),
    tabTerm: $("tab-term"),
    perm: $("perm-banner"),
    conv: $("conv"),
    truncated: $("truncated"),
    timeline: $("timeline"),
    term: $("term"),
    xterm: $("xterm"),
    msg: $("msg"),
    send: $("send"),
    stop: $("stop"),
    kill: $("kill"),
    status: $("status-bar"),
    showThinking: $("show-thinking"),
    showMeta: $("show-meta"),
    showSidechain: $("show-sidechain"),
    follow: $("follow"),
  };

  const state = {
    sessions: [],
    pending: {},
    selected: null,
    entries: [],
    tab: "conv",
    ws: null,
  };

  /* --------------------------------- helpers -------------------------------- */

  function fmtTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function ago(ts) {
    if (!ts) return "";
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  function fmtNum(n) {
    return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }
  function short(s, n = 60) {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
  function shortCwd(cwd) {
    const root = el.root.textContent;
    if (root && cwd.startsWith(root)) return "." + cwd.slice(root.length) || ".";
    return cwd;
  }
  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }
  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = `${res.status}`;
      try {
        msg = (await res.json()).error || msg;
      } catch {}
      throw new Error(msg);
    }
    return res.json();
  }
  function toast(msg) {
    el.status.textContent = msg;
    el.status.classList.add("warn");
    setTimeout(() => {
      el.status.classList.remove("warn");
      renderStatus();
    }, 4000);
  }

  /* ------------------------------ sessions rail ------------------------------ */

  function current() {
    return state.sessions.find((s) => s.id === state.selected) || null;
  }

  function renderList() {
    el.list.replaceChildren(
      ...state.sessions.map((s) => {
        const cls = ["", s.id === state.selected ? "active" : "", s.running ? "running" : "", s.busy ? "busy" : "", s.spawned && !s.running ? "exited" : ""].join(" ");
        const name = h("div", { class: "name", text: s.title || s.name || short(s.firstPrompt, 40) || s.id.slice(0, 8) });
        if (s.spawned) name.append(h("span", { class: "badge spawned", text: "claude-web" }));
        if (s.agentConnected) name.append(h("span", { class: "badge", text: "plugin" }));
        const n = (state.pending[s.id] || []).length;
        if (n) name.append(h("span", { class: "badge", text: `${n} permission${n > 1 ? "s" : ""}` }));
        const sub = h("div", { class: "sub", text: `${shortCwd(s.cwd)} · ${s.busy ? "working" : s.running ? "idle" : s.spawned ? `exited${s.exitCode != null ? ` (${s.exitCode})` : ""}` : "past"} · ${ago(s.updatedAt)}` });
        return h("li", { class: cls, title: s.id, onclick: () => select(s.id) }, h("span", { class: "dot" }), h("div", {}, name, sub));
      }),
    );
  }

  function select(id) {
    if (state.selected === id) return;
    state.selected = id;
    if (location.hash.slice(1) !== id) history.replaceState(null, "", `#${id}`);
    state.entries = [];
    el.timeline.replaceChildren();
    el.truncated.hidden = true;
    resetTerminal();
    renderList();
    renderView();
    send({ type: "subscribe", id });
  }

  /* --------------------------------- view ----------------------------------- */

  function renderView() {
    const s = current();
    el.empty.hidden = !!s;
    el.view.hidden = !s;
    if (!s) return;
    el.title.textContent = s.title || s.name || short(s.firstPrompt, 80) || s.id;
    const bits = [s.cwd, s.gitBranch ? `⎇ ${s.gitBranch}` : null, s.version ? `v${s.version}` : null, s.pid ? `pid ${s.pid}` : null, s.id];
    el.sub.textContent = bits.filter(Boolean).join("  ·  ");
    const canDrive = s.spawned && s.running;
    el.tabTerm.hidden = !s.spawned;
    el.send.disabled = !(canDrive || s.agentConnected);
    el.stop.disabled = !canDrive;
    el.kill.disabled = !s.spawned;
    el.kill.textContent = canDrive ? "Kill" : s.spawned ? "Remove" : "Kill";
    el.msg.placeholder = canDrive
      ? "Message the session… (Enter to send, Shift+Enter for newline)"
      : s.agentConnected
        ? "Message via the channel plugin… (Enter to send)"
        : s.running
          ? "This session was started outside claude-web; it is read-only here."
          : "This session is not running.";
    if (!s.spawned && state.tab === "term") setTab("conv");
    renderPermissions();
    renderStatus();
  }

  function setTab(tab) {
    state.tab = tab;
    for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.tab === tab);
    el.conv.hidden = tab !== "conv";
    el.term.hidden = tab !== "term";
    if (tab === "term") fitTerminal();
    else if (el.follow.checked) scrollToBottom();
  }

  function renderPermissions() {
    const list = state.pending[state.selected] || [];
    el.perm.hidden = list.length === 0;
    el.perm.replaceChildren(
      ...list.map((p) =>
        h(
          "div",
          { class: "perm" },
          h("b", { text: p.toolName }),
          h("span", { text: p.description }),
          h("code", { text: short(p.inputPreview, 300) }),
          h("button", { class: "primary", text: "Allow", onclick: () => decide(state.selected, p.requestId, "allow") }),
          h("button", { class: "danger", text: "Deny", onclick: () => decide(state.selected, p.requestId, "deny") }),
        ),
      ),
    );
  }

  async function decide(sessionId, requestId, behavior) {
    if (!sessionId) return; // the session vanished between render and click
    try {
      await api("POST", `/api/sessions/${encodeURIComponent(sessionId)}/permission`, { request_id: requestId, behavior });
    } catch (err) {
      toast(`permission: ${err.message}`);
    }
  }

  /* ------------------------------- status bar ------------------------------- */

  // Token totals are per API message, but the transcript repeats `usage` on
  // every content block of a reply, so de-duplicate by messageId. The latest
  // message's input side (input + cache read + cache create) is the context
  // Claude saw on its last call, which is what "context" means here.
  function renderStatus() {
    const s = current();
    if (!s) return;
    const seen = new Set();
    let model = null;
    let out = 0;
    let lastInput = 0;
    let turns = 0;
    let tools = 0;
    for (const e of state.entries) {
      if (e.kind === "prompt" && !e.meta && !e.sidechain) turns++;
      if (e.kind === "tool_use") tools++;
      if (e.kind !== "text" && e.kind !== "thinking" && e.kind !== "tool_use") continue;
      if (e.model) model = e.model;
      const key = e.messageId || e.uuid;
      if (!e.usage || seen.has(key)) continue;
      seen.add(key);
      out += e.usage.output;
      if (!e.sidechain) lastInput = e.usage.input + e.usage.cacheRead + e.usage.cacheCreate;
    }
    const pct = lastInput ? Math.min(100, Math.round((lastInput / MAX_CONTEXT_TOKENS) * 100)) : 0;
    const parts = [
      s.busy ? "● working" : s.running ? "○ idle" : s.spawned ? `■ exited${s.exitSignal ? ` (${s.exitSignal})` : s.exitCode != null ? ` (${s.exitCode})` : ""}` : "■ not running",
      model ? `model ${model}` : null,
      `${turns} prompt${turns === 1 ? "" : "s"}`,
      `${tools} tool call${tools === 1 ? "" : "s"}`,
      lastInput ? `context ${fmtNum(lastInput)} (${pct}%)` : null,
      out ? `output ${fmtNum(out)}` : null,
      `${state.entries.length} entries`,
    ];
    el.status.replaceChildren(...parts.filter(Boolean).map((t, i) => h("span", { class: i === 4 && pct >= 80 ? "warn" : "", text: t })));
  }

  /* -------------------------------- timeline -------------------------------- */

  function visible(e) {
    if (e.kind === "title") return false; // shown in the header, not the timeline
    if (e.sidechain && !el.showSidechain.checked) return false;
    if (e.kind === "thinking" && !el.showThinking.checked) return false;
    if (e.kind === "prompt" && e.meta && !el.showMeta.checked) return false;
    return true;
  }

  function pretty(v) {
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }

  function renderEntry(e) {
    const head = (label) => h("div", { class: "head" }, h("span", { text: label }), h("span", { text: fmtTime(e.ts) }), e.sidechain ? h("span", { text: "subagent" }) : null);
    const node = h("div", { class: `entry ${e.kind}${e.isError ? " error" : ""}${visible(e) ? "" : " hidden"}`, "data-uuid": e.uuid });
    switch (e.kind) {
      case "prompt":
        // Meta prompts are injected context (skill bodies etc.): keep them verbatim.
        node.append(head(e.meta ? "you (meta)" : "you"), e.meta ? h("div", { class: "body", text: e.text }) : markdown(e.text));
        break;
      case "text":
        node.append(head("claude"), markdown(e.text));
        break;
      case "thinking":
        node.append(h("details", {}, h("summary", { text: `thinking · ${short(e.text, 80)}` }), h("div", { class: "body", text: e.text })));
        break;
      case "tool_use": {
        const input = pretty(e.input);
        const summary = h("summary", {}, h("b", { text: e.name }), h("span", { text: ` ${short(inputHint(e.input), 90)}` }));
        node.append(h("details", {}, summary, h("pre", { text: input })));
        break;
      }
      case "tool_result":
        node.append(h("details", {}, h("summary", {}, h("b", { text: e.isError ? "result (error)" : "result" }), h("span", { text: ` ${short(e.text, 90)}` })), h("pre", { text: e.text })));
        break;
      case "system":
        node.append(h("details", {}, h("summary", {}, h("b", { text: e.subtype }), h("span", { text: ` ${short(e.text, 90)}` })), h("pre", { text: e.text })));
        break;
      case "compact":
        node.append(h("details", {}, h("summary", { text: "context was compacted · summary" }), h("pre", { text: e.text })));
        break;
      case "title":
        node.append(h("div", { class: "body", text: `title: ${e.text}` }));
        break;
      default:
        node.append(h("pre", { text: pretty(e) }));
    }
    return node;
  }

  // Rendered Markdown (see markdown.js); falls back to plain text if the
  // renderer failed to load or throws on odd input.
  function markdown(text) {
    const body = h("div", { class: "body md" });
    try {
      body.append(window.renderMarkdown(text));
    } catch {
      body.textContent = text;
    }
    return body;
  }

  // A short hint for a tool call: the most descriptive string in its input
  // (short() collapses whitespace and clamps it).
  function inputHint(input) {
    if (!input || typeof input !== "object") return pretty(input);
    for (const k of ["command", "file_path", "path", "pattern", "query", "description", "prompt", "url"]) {
      if (typeof input[k] === "string") return input[k];
    }
    const first = Object.values(input).find((v) => typeof v === "string");
    return first || JSON.stringify(input);
  }

  function appendEntries(entries) {
    const frag = document.createDocumentFragment();
    for (const e of entries) {
      state.entries.push(e);
      frag.append(renderEntry(e));
    }
    el.timeline.append(frag);
    if (el.follow.checked) scrollToBottom();
    renderStatus();
  }

  function applyFilters() {
    const nodes = el.timeline.children;
    for (let i = 0; i < nodes.length; i++) nodes[i].classList.toggle("hidden", !visible(state.entries[i]));
  }

  function scrollToBottom() {
    el.conv.scrollTop = el.conv.scrollHeight;
  }

  /* -------------------------------- terminal -------------------------------- */

  let term = null;
  let fit = null;
  function ensureTerminal() {
    if (term) return term;
    term = new window.Terminal({ convertEol: false, scrollback: 5000, fontSize: 13, theme: { background: "#000000" } });
    fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(el.xterm);
    term.onData((data) => {
      const s = current();
      if (!s || !s.spawned || !s.running) return;
      api("POST", `/api/sessions/${encodeURIComponent(s.id)}/input`, { data: btoa(unescape(encodeURIComponent(data))) }).catch((err) => toast(`input: ${err.message}`));
    });
    term.onResize(({ cols, rows }) => {
      const s = current();
      if (!s || !s.spawned || !s.running) return;
      api("POST", `/api/sessions/${encodeURIComponent(s.id)}/resize`, { cols, rows }).catch(() => {});
    });
    return term;
  }
  function resetTerminal() {
    if (term) term.reset();
  }
  function fitTerminal() {
    ensureTerminal();
    requestAnimationFrame(() => fit && fit.fit());
  }
  function writePty(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    ensureTerminal().write(bytes);
  }

  /* -------------------------------- composer -------------------------------- */

  async function sendMessage() {
    const s = current();
    const text = el.msg.value.trim();
    if (!s || !text) return;
    el.send.disabled = true;
    try {
      await api("POST", `/api/sessions/${encodeURIComponent(s.id)}/message`, { text });
      el.msg.value = "";
    } catch (err) {
      toast(`send: ${err.message}`);
    } finally {
      renderView();
    }
  }

  el.send.addEventListener("click", sendMessage);
  el.msg.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      sendMessage();
    }
  });
  el.stop.addEventListener("click", async () => {
    const s = current();
    if (!s) return;
    try {
      await api("POST", `/api/sessions/${encodeURIComponent(s.id)}/stop`);
    } catch (err) {
      toast(`stop: ${err.message}`);
    }
  });
  el.kill.addEventListener("click", async () => {
    const s = current();
    if (!s) return;
    const verb = s.running ? "Kill" : "Remove";
    if (!confirm(`${verb} session ${s.title || s.id.slice(0, 8)}?`)) return;
    try {
      await api("DELETE", `/api/sessions/${encodeURIComponent(s.id)}`);
    } catch (err) {
      toast(`${verb.toLowerCase()}: ${err.message}`);
    }
  });
  for (const b of document.querySelectorAll(".tab")) b.addEventListener("click", () => setTab(b.dataset.tab));
  for (const c of [el.showThinking, el.showMeta, el.showSidechain]) c.addEventListener("change", applyFilters);
  el.conv.addEventListener("scroll", () => {
    // Scrolling up pauses follow; scrolling back to the bottom resumes it.
    const atBottom = el.conv.scrollHeight - el.conv.scrollTop - el.conv.clientHeight < 40;
    if (!atBottom && el.follow.checked) el.follow.checked = false;
    else if (atBottom && !el.follow.checked) el.follow.checked = true;
  });

  /* ------------------------------- new session ------------------------------ */

  el.newToggle.addEventListener("click", () => {
    el.newForm.hidden = !el.newForm.hidden;
    if (!el.newForm.hidden) el.newForm.elements.cwd.focus();
  });
  el.newCancel.addEventListener("click", () => (el.newForm.hidden = true));
  el.newForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = el.newForm.elements;
    const body = {};
    if (f.cwd.value.trim()) body.cwd = f.cwd.value.trim();
    if (f.name.value.trim()) body.name = f.name.value.trim();
    if (f.prompt.value.trim()) body.prompt = f.prompt.value.trim();
    try {
      const s = await api("POST", "/api/sessions", body);
      el.newForm.reset();
      el.newForm.hidden = true;
      if (!state.sessions.some((x) => x.id === s.id)) state.sessions.unshift(s);
      select(s.id);
      setTab("term");
    } catch (err) {
      toast(`start: ${err.message}`);
    }
  });

  /* -------------------------------- websocket ------------------------------- */

  function send(frame) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(frame));
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ui`);
    state.ws = ws;
    ws.onopen = () => {
      el.conn.textContent = "connected";
      if (state.selected) {
        state.entries = [];
        el.timeline.replaceChildren();
        resetTerminal();
        send({ type: "subscribe", id: state.selected });
      }
    };
    ws.onclose = () => {
      el.conn.textContent = "disconnected — retrying…";
      setTimeout(connect, 1500);
    };
    ws.onmessage = (ev) => {
      let frame;
      try {
        frame = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (frame.type) {
        case "sessions":
          state.sessions = frame.sessions;
          state.pending = frame.pending || {};
          renderList();
          renderView();
          break;
        case "history":
          if (frame.id !== state.selected) return;
          state.entries = [];
          el.timeline.replaceChildren();
          el.truncated.hidden = !frame.truncated;
          appendEntries(frame.entries);
          break;
        case "entry":
          if (frame.id === state.selected) appendEntries([frame.entry]);
          break;
        case "pty":
          if (frame.id === state.selected) writePty(frame.data);
          break;
        case "session_removed":
          state.sessions = state.sessions.filter((s) => s.id !== frame.id);
          delete state.pending[frame.id];
          if (state.selected === frame.id) {
            state.selected = null;
            state.entries = [];
          }
          renderList();
          renderView();
          break;
        case "permission_request":
          (state.pending[frame.id] ||= []).push(frame.request);
          renderList();
          if (frame.id === state.selected) renderPermissions();
          break;
        case "permission_resolved":
          state.pending[frame.id] = (state.pending[frame.id] || []).filter((p) => p.requestId !== frame.request_id);
          renderList();
          if (frame.id === state.selected) renderPermissions();
          break;
        case "permissions_cleared":
          delete state.pending[frame.id];
          renderList();
          if (frame.id === state.selected) renderPermissions();
          break;
      }
    };
  }

  /* ---------------------------------- boot ---------------------------------- */

  fetch("/api/root")
    .then((r) => (r.ok ? r.json() : { root: "" }))
    .then((j) => (el.root.textContent = j.root || ""))
    .catch(() => {})
    .finally(() => {
      const hash = location.hash.slice(1);
      connect();
      if (hash) state.selected = hash;
    });
  window.addEventListener("hashchange", () => {
    const id = location.hash.slice(1);
    if (id && id !== state.selected) select(id);
  });
  window.addEventListener("resize", () => state.tab === "term" && fitTerminal());
})();
