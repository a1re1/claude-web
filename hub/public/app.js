// claude-web UI. Framework-free: one WebSocket to /ui carries the session list,
// the selected session's full conversation (history + live entries), and raw
// PTY bytes for sessions the hub spawned. Actions go over HTTP.
//
// Layout follows the "Drip Agent v2" mock: a centered chat stream (user
// bubbles, agent text, activity cards grouping tool calls), a floating header
// pill with the session status, a turn rail of ticks to jump around, a
// floating composer, and a Details/Sessions inspector on the right.
(() => {
  "use strict";

  const MAX_CONTEXT_TOKENS = 1_000_000; // matches CLAUDE_WEB_MAX_CONTEXT_TOKENS default in the README
  const SEP_GAP_MS = 30 * 60 * 1000; // a time separator before a prompt after this much quiet
  const $ = (id) => document.getElementById(id);
  const el = {
    pill: $("pill"), pillDot: $("pill-dot"), pillName: $("pill-name"), pillStatus: $("pill-status"),
    newToggle: $("new-toggle"), newDialog: $("new-dialog"), newForm: $("new-form"), newCancel: $("new-cancel"),
    stop: $("stop"), inspectorToggle: $("inspector-toggle"), inspector: $("inspector"),
    ticks: $("ticks"), peek: $("peek"), peekLabel: $("peek-label"), peekTime: $("peek-time"), peekTitle: $("peek-title"), peekExcerpt: $("peek-excerpt"),
    stream: $("stream"), column: $("column"), empty: $("empty"), truncated: $("truncated"), timeline: $("timeline"), live: $("live"), liveText: $("live-text"),
    term: $("term"), xterm: $("xterm"),
    perm: $("perm-banner"), msg: $("msg"), chipTerm: $("chip-term"), resume: $("resume"), kill: $("kill"), modelChip: $("model-chip"), draftCount: $("draft-count"), send: $("send"),
    paneSessions: $("pane-sessions"), paneDetails: $("pane-details"), root: $("root"), groups: $("session-groups"), showEmpty: $("show-empty"), emptyCount: $("empty-count"),
    detailRun: $("detail-run"), ctxText: $("ctx-text"), ctxPct: $("ctx-pct"), ctxFill: $("ctx-fill"), detailUsage: $("detail-usage"), detailFoot: $("detail-foot"),
    showThinking: $("show-thinking"), showMeta: $("show-meta"), showSidechain: $("show-sidechain"), follow: $("follow"),
  };

  const state = {
    sessions: [],
    pending: {},
    selected: null,
    entries: [],
    turns: [], // rendered turns: { id, kind: user|agent|group, ts, node, rows, title, excerpt }
    lastTs: 0,
    showTerm: false,
    inspector: false,
    pane: "details",
    current: -1, // turn under the reader (turn rail)
    ws: null,
  };

  /* --------------------------------- helpers -------------------------------- */

  function fmtClock(ts) {
    return ts ? new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  }
  function fmtSep(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const today = new Date().toDateString() === d.toDateString();
    return `${today ? "Today" : d.toLocaleDateString([], { month: "short", day: "numeric" })} ${fmtClock(ts)}`;
  }
  function fmtRowTime(ts) {
    return ts ? new Date(ts).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  }
  function ago(ts) {
    if (!ts) return "";
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }
  function fmtNum(n) {
    return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }
  function fmtBytes(n) {
    if (n == null) return "";
    return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
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
    const res = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      let msg = `${res.status}`;
      try {
        msg = (await res.json()).error || msg;
      } catch {}
      throw new Error(msg);
    }
    return res.json();
  }
  let toastTimer = null;
  function toast(msg) {
    el.pillStatus.textContent = msg;
    el.pillStatus.style.color = "var(--red)";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.pillStatus.style.color = "";
      renderHeader();
    }, 4000);
  }
  function current() {
    return state.sessions.find((s) => s.id === state.selected) || null;
  }
  // Alive but never used: no transcript, not started here.
  function isEmpty(s) {
    return s.transcriptPath === null && !s.spawned;
  }
  function pretty(v) {
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }
  // A short hint for a tool call: the most descriptive string in its input.
  function inputHint(input) {
    if (!input || typeof input !== "object") return pretty(input);
    for (const k of ["command", "file_path", "path", "pattern", "query", "description", "prompt", "url", "skill"]) {
      if (typeof input[k] === "string") return input[k];
    }
    const first = Object.values(input).find((v) => typeof v === "string");
    return first || JSON.stringify(input);
  }
  const TOOL_COLORS = [
    [/^bash$/i, "var(--teal)"],
    [/^(read|grep|glob|ls|notebookread)$/i, "var(--purple)"],
    [/^(edit|write|multiedit|notebookedit)$/i, "var(--orange)"],
    [/^(task|agent)/i, "var(--accent)"],
    [/^web/i, "var(--indigo)"],
    [/^todo/i, "var(--yellow)"],
  ];
  function tagColor(name) {
    for (const [re, c] of TOOL_COLORS) if (re.test(name)) return c;
    return "var(--text-secondary)";
  }
  function tag(text, color) {
    const t = h("span", { class: "tag", text });
    t.style.setProperty("--c", color);
    return t;
  }

  /* ------------------------------ session lists ------------------------------ */

  function renderSessions() {
    const empty = state.sessions.filter(isEmpty);
    el.emptyCount.textContent = empty.length ? `(${empty.length}, ${fmtBytes(empty.reduce((a, s) => a + (s.memoryBytes || 0), 0))})` : "";
    const visible = el.showEmpty.checked ? state.sessions : state.sessions.filter((s) => !isEmpty(s) || s.id === state.selected);
    const running = visible.filter((s) => s.running);
    const past = visible.filter((s) => !s.running);
    const group = (label, list, accent) => {
      const g = h("div", { class: "sgroup" }, h("div", { class: "section-title" }, h("span", { text: label }), h("span", { class: `count${accent ? " accent" : ""}`, text: String(list.length) })));
      if (!list.length) g.append(h("div", { class: "snone", text: label === "Running" ? "Nothing running" : "No sessions yet" }));
      for (const s of list) {
        const n = (state.pending[s.id] || []).length;
        const row = h(
          "div",
          { class: `srow${s.id === state.selected ? " on" : ""}`, title: `${s.cwd}\n${s.id}`, onclick: () => select(s.id) },
          h("span", { class: `dot${s.busy ? " busy" : ""}${s.spawned && !s.running ? " exited" : ""}` }),
          h("span", { class: "sid", text: s.id.slice(0, 8) }),
          h("span", { class: "stitle", text: (s.title || s.name || short(s.firstPrompt, 40) || shortCwd(s.cwd)) + (n ? ` · ${n} permission${n > 1 ? "s" : ""}` : "") }),
          h("span", { class: "sage", text: s.running ? fmtBytes(s.memoryBytes) || ago(s.updatedAt) : ago(s.updatedAt) }),
        );
        g.append(row);
      }
      return g;
    };
    el.groups.replaceChildren(group("Running", running, true), group("Recent", past, false));
  }

  function select(id) {
    if (state.selected === id) return;
    state.selected = id;
    if (location.hash.slice(1) !== id) history.replaceState(null, "", `#${id}`);
    resetStream();
    resetTerminal();
    setTerm(false);
    renderAll();
    send({ type: "subscribe", id });
  }

  /* --------------------------------- header --------------------------------- */

  function renderHeader() {
    const s = current();
    el.pill.hidden = !s;
    el.empty.hidden = !!s;
    if (!s) return;
    el.pillName.textContent = s.title || s.name || short(s.firstPrompt, 60) || s.id.slice(0, 8);
    el.pillDot.className = `dot${s.busy ? " busy" : s.spawned && !s.running ? " exited" : ""}`;
    const st = stats();
    const bits = [
      s.busy ? "Working" : s.running ? "Idle" : s.spawned ? `Exited${s.exitCode != null ? ` (${s.exitCode})` : ""}` : "Not running",
      st.model ? st.model.replace(/^claude-/, "") : null,
      `${st.prompts} prompt${st.prompts === 1 ? "" : "s"}`,
      st.lastInput ? `${fmtNum(st.lastInput)} ctx` : null,
    ];
    el.pillStatus.textContent = bits.filter(Boolean).join(" · ");
    const canDrive = s.spawned && s.running;
    el.stop.disabled = !canDrive;
    renderComposer(s, canDrive);
    renderLive(s, st);
  }

  function renderComposer(s, canDrive) {
    const untouched = s.running && !s.spawned && !s.busy && s.transcriptPath === null; // mirrors the hub's rule
    const canSend = canDrive || s.agentConnected;
    el.chipTerm.hidden = !s.spawned;
    el.chipTerm.setAttribute("aria-pressed", String(state.showTerm));
    el.resume.hidden = s.running;
    el.kill.hidden = !(s.spawned || untouched);
    el.kill.lastElementChild.textContent = canDrive || untouched ? "Kill" : "Remove";
    el.kill.title = untouched ? "This session has no conversation; ending it loses nothing." : "";
    el.msg.disabled = !canSend;
    el.msg.placeholder = canDrive
      ? "Message the session"
      : s.agentConnected
        ? "Message via the channel plugin"
        : s.running
          ? untouched
            ? "An unused session in another terminal. Kill it to free its memory."
            : "Started in another terminal; read-only here"
          : "Not running. Resume to continue the conversation here";
    const model = stats().model;
    el.modelChip.textContent = model || "";
    updateSendButton(canDrive, canSend);
  }

  function updateSendButton(canDrive, canSend) {
    const draft = el.msg.value.trim();
    el.draftCount.textContent = draft ? `${el.msg.value.length} chars` : "";
    if (draft) {
      el.send.className = "iconbtn sm primary";
      el.send.title = "Send";
      el.send.disabled = !canSend;
    } else {
      el.send.className = "iconbtn sm stop";
      el.send.title = "Stop the current turn";
      el.send.disabled = !canDrive;
    }
  }

  function renderLive(s, st) {
    el.live.hidden = !s.busy;
    el.liveText.textContent = `Working${st.model ? ` · ${st.model}` : ""}`;
  }

  /* ---------------------------------- stats ---------------------------------- */

  // Token totals are per API message, but the transcript repeats `usage` on
  // every content block of a reply, so de-duplicate by messageId. The latest
  // message's input side (input + cache read + cache create) is the context
  // Claude saw on its last call.
  function stats() {
    const seen = new Set();
    const st = { model: null, prompts: 0, tools: 0, input: 0, cacheRead: 0, cacheCreate: 0, output: 0, lastInput: 0 };
    for (const e of state.entries) {
      if (e.kind === "prompt" && !e.meta && !e.sidechain) st.prompts++;
      if (e.kind === "tool_use") st.tools++;
      if (e.kind !== "text" && e.kind !== "thinking" && e.kind !== "tool_use") continue;
      if (e.model) st.model = e.model;
      const key = e.messageId || e.uuid;
      if (!e.usage || seen.has(key)) continue;
      seen.add(key);
      st.input += e.usage.input;
      st.cacheRead += e.usage.cacheRead;
      st.cacheCreate += e.usage.cacheCreate;
      st.output += e.usage.output;
      if (!e.sidechain) st.lastInput = e.usage.input + e.usage.cacheRead + e.usage.cacheCreate;
    }
    return st;
  }

  /* -------------------------------- inspector -------------------------------- */

  function setInspector(open, pane) {
    state.inspector = open;
    if (pane) state.pane = pane;
    el.inspector.hidden = !open;
    el.inspector.classList.toggle("wide", state.pane === "sessions");
    el.inspectorToggle.setAttribute("aria-pressed", String(open));
    for (const b of el.inspector.querySelectorAll(".seg button")) b.setAttribute("aria-pressed", String(b.dataset.pane === state.pane));
    el.paneSessions.hidden = state.pane !== "sessions";
    el.paneDetails.hidden = state.pane !== "details";
    try {
      localStorage.setItem("claude-web.inspector", JSON.stringify({ open, pane: state.pane }));
    } catch {}
    if (open) renderDetails();
  }

  function renderDetails() {
    const s = current();
    const kv = (k, v, cls = "") => [h("span", { class: "k", text: k }), h("span", { class: `v ${cls}`, text: v })];
    if (!s) {
      el.detailRun.replaceChildren(...kv("Session", "none selected"));
      el.detailUsage.replaceChildren();
      el.ctxText.textContent = "";
      el.ctxPct.textContent = "";
      el.ctxFill.style.width = "0";
      el.detailFoot.textContent = "";
      return;
    }
    const st = stats();
    const status = s.busy ? ["Working", "var(--green)"] : s.running ? ["Idle", "var(--text-secondary)"] : s.spawned ? [`Exited${s.exitCode != null ? ` (${s.exitCode})` : ""}`, "var(--red)"] : ["Not running", "var(--text-tertiary)"];
    const statusV = h("span", { class: "v tags" }, tag(status[0], status[1]));
    el.detailRun.replaceChildren(
      h("span", { class: "k", text: "Status" }),
      statusV,
      ...kv("Origin", s.spawned ? "claude-web" : s.running ? "other terminal" : "transcript"),
      ...(s.pid ? kv("pid", String(s.pid)) : []),
      ...(s.memoryBytes ? kv("Memory", fmtBytes(s.memoryBytes)) : []),
      ...(st.model ? kv("Model", st.model) : []),
      ...(s.gitBranch ? kv("Branch", s.gitBranch) : []),
      ...(s.version ? kv("Claude Code", s.version) : []),
      ...kv("Prompts", String(st.prompts)),
      ...kv("Tool calls", String(st.tools)),
      ...kv("Entries", String(state.entries.length)),
      ...(s.agentConnected ? kv("Plugin", "connected") : []),
    );
    const pct = st.lastInput ? Math.min(100, Math.round((st.lastInput / MAX_CONTEXT_TOKENS) * 100)) : 0;
    el.ctxText.textContent = `${fmtNum(st.lastInput)} / ${fmtNum(MAX_CONTEXT_TOKENS)}`;
    el.ctxPct.textContent = `${pct}%`;
    el.ctxFill.style.width = `${pct}%`;
    el.ctxFill.classList.toggle("warn", pct >= 80);
    el.detailUsage.replaceChildren(...kv("Input", fmtNum(st.input)), ...kv("Cache read", fmtNum(st.cacheRead)), ...kv("Cache write", fmtNum(st.cacheCreate)), ...kv("Output", fmtNum(st.output)));
    el.detailFoot.textContent = `cwd ${s.cwd}\n${s.id}`;
  }

  /* -------------------------------- permissions ------------------------------ */

  function renderPermissions() {
    const list = state.pending[state.selected] || [];
    el.perm.hidden = list.length === 0;
    el.perm.replaceChildren(
      ...list.map((p) =>
        h(
          "div",
          { class: "perm" },
          tag("PERMISSION", "var(--orange)"),
          h("b", { text: p.toolName }),
          h("span", { text: p.description }),
          h("code", { text: short(p.inputPreview, 200) }),
          h("span", { class: "spacer" }),
          h("button", { class: "primary", text: "Allow", onclick: () => decide(state.selected, p.requestId, "allow") }),
          h("button", { class: "danger", text: "Deny", onclick: () => decide(state.selected, p.requestId, "deny") }),
        ),
      ),
    );
  }
  async function decide(sessionId, requestId, behavior) {
    if (!sessionId) return;
    try {
      await api("POST", `/api/sessions/${encodeURIComponent(sessionId)}/permission`, { request_id: requestId, behavior });
    } catch (err) {
      toast(`permission: ${err.message}`);
    }
  }

  /* ---------------------------------- stream --------------------------------- */

  function resetStream() {
    state.entries = [];
    state.turns = [];
    state.lastTs = 0;
    state.current = -1;
    el.timeline.replaceChildren();
    el.ticks.replaceChildren();
    el.truncated.hidden = true;
  }

  // Which entries are conversation turns, and which are "activity" rows that
  // go into a grouped card between turns.
  function isUserTurn(e) {
    return e.kind === "prompt" && !e.meta && !e.sidechain;
  }
  function isAgentTurn(e) {
    return e.kind === "text" && !e.sidechain;
  }
  function rowVisible(row) {
    const e = row.entry;
    if (e.sidechain && !el.showSidechain.checked) return false;
    if (e.kind === "thinking" && !el.showThinking.checked) return false;
    if (e.kind === "prompt" && e.meta && !el.showMeta.checked) return false;
    if (e.kind === "title") return false; // shown in the header pill
    return true;
  }

  function addEntry(e) {
    state.entries.push(e);
    if (isUserTurn(e)) {
      if (e.ts && (state.lastTs === 0 || e.ts - state.lastTs > SEP_GAP_MS)) el.timeline.append(h("div", { class: "sep", text: fmtSep(e.ts) }));
      const bubble = h("div", { class: "bubble", text: e.text });
      if (e.images?.length) bubble.append(images(e.images));
      addTurn({ kind: "user", ts: e.ts, node: h("div", { class: "turn user" }, bubble), label: "You", title: short(e.text, 90), excerpt: "" });
    } else if (isAgentTurn(e)) {
      addTurn({ kind: "agent", ts: e.ts, node: h("div", { class: "turn agent" }, markdown(e.text)), label: "Claude", title: short(e.text, 90), excerpt: short(e.text.slice(90), 200) });
    } else {
      addRow(e);
    }
    if (e.ts) state.lastTs = e.ts;
  }

  function addTurn(t) {
    t.id = state.turns.length;
    t.node.id = `turn-${t.id}`;
    state.turns.push(t);
    el.timeline.append(t.node);
    el.ticks.append(h("div", { class: "tick", onmouseenter: () => peek(t), onclick: () => jump(t) }, h("span")));
  }

  // Activity rows: consecutive tool calls, results, thinking, system notices
  // and injected context between two turns share one card, headed by a
  // centered caption like the mock's iteration separators.
  function addRow(e) {
    let g = state.turns[state.turns.length - 1];
    if (!g || g.kind !== "group") {
      const card = h("div", { class: "card" });
      const sep = h("div", { class: "sep group" });
      g = { kind: "group", ts: e.ts, node: h("div", { class: "turn group" }, sep, card), card, sep, rows: [], byUse: new Map(), label: "Activity", title: "", excerpt: "" };
      addTurn(g);
    }
    if (e.kind === "tool_result") {
      const owner = g.byUse.get(e.toolUseId) || (state.turns[state.turns.length - 2]?.byUse || new Map()).get(e.toolUseId);
      if (owner) {
        owner.result = e;
        updateRow(owner);
        return;
      }
    }
    const row = { entry: e, result: null, open: false };
    row.node = h("div", { class: "row" }, h("div", { class: "row-head", onclick: () => toggleRow(row) }, h("span", { class: "row-time" }), h("span", { class: "row-tag" }), h("span", { class: "row-text" }), h("span", { class: "row-meta" })));
    g.rows.push(row);
    if (e.kind === "tool_use") g.byUse.set(e.toolUseId, row);
    g.card.append(row.node);
    updateRow(row);
    if (!g.title) g.title = rowTitle(row);
    updateGroupCaption(g);
  }

  function rowTitle(row) {
    const e = row.entry;
    if (e.kind === "tool_use") return `${e.name} ${short(inputHint(e.input), 70)}`;
    return short(e.text, 80);
  }

  function updateGroupCaption(g) {
    const tools = g.rows.filter((r) => r.entry.kind === "tool_use").length;
    const visible = g.rows.filter(rowVisible).length;
    g.sep.textContent = `${visible} entr${visible === 1 ? "y" : "ies"}${tools ? ` · ${tools} tool call${tools === 1 ? "" : "s"}` : ""}`;
    g.excerpt = g.rows.slice(0, 3).map(rowTitle).join(" · ");
    g.node.classList.toggle("hidden", visible === 0);
  }

  function updateRow(row) {
    const e = row.entry;
    const [time, tagWrap, text, meta] = row.node.firstChild.children;
    time.textContent = fmtRowTime(e.ts);
    let label, color, hint, metaText = "", isErr = false;
    switch (e.kind) {
      case "tool_use":
        label = e.name.toUpperCase();
        color = tagColor(e.name);
        hint = inputHint(e.input);
        if (row.result) {
          isErr = row.result.isError;
          const n = row.result.images?.length || 0;
          metaText = isErr ? "error" : n ? `${n} image${n > 1 ? "s" : ""}` : row.result.text ? `${fmtNum(row.result.text.length)} chars` : "done";
        } else metaText = "running";
        break;
      case "tool_result":
        label = "RESULT";
        color = e.isError ? "var(--red)" : "var(--text-tertiary)";
        hint = e.text;
        isErr = e.isError;
        break;
      case "thinking":
        label = "THINK";
        color = "var(--text-tertiary)";
        hint = e.text;
        break;
      case "system":
        label = "SYSTEM";
        color = "var(--text-tertiary)";
        hint = `${e.subtype} — ${e.text}`;
        break;
      case "compact":
        label = "COMPACT";
        color = "var(--orange)";
        hint = "context was compacted; summary inside";
        break;
      case "prompt":
        label = e.sidechain ? "SUBAGENT" : "CONTEXT";
        color = e.sidechain ? "var(--indigo)" : "var(--text-tertiary)";
        hint = e.text;
        break;
      case "text":
        label = "SUBAGENT";
        color = "var(--indigo)";
        hint = e.text;
        break;
      default:
        label = e.kind.toUpperCase();
        color = "var(--text-tertiary)";
        hint = e.text || "";
    }
    tagWrap.replaceChildren(tag(label, color));
    text.textContent = short(hint, 160);
    meta.textContent = metaText;
    meta.classList.toggle("error", isErr);
    row.node.classList.toggle("hidden", !rowVisible(row));
    if (row.open) renderDetail(row);
  }

  function toggleRow(row) {
    row.open = !row.open;
    if (row.open) renderDetail(row);
    else {
      row.detail?.remove();
      row.detail = null;
    }
  }

  function renderDetail(row) {
    const e = row.entry;
    const d = row.detail || (row.detail = h("div", { class: "row-detail" }));
    d.replaceChildren();
    if (e.kind === "tool_use") {
      d.append(h("b", { text: "input" }), document.createTextNode(pretty(e.input)));
      if (row.result) {
        d.append(h("b", { text: row.result.isError ? "result (error)" : "result" }), document.createTextNode(row.result.text || (row.result.images?.length ? "" : "(empty)")));
        if (row.result.images?.length) d.append(images(row.result.images));
      }
    } else {
      d.append(document.createTextNode(e.text || ""));
      if (e.images?.length) d.append(images(e.images));
    }
    if (!d.isConnected) row.node.append(d);
  }

  function applyFilters() {
    for (const g of state.turns) {
      if (g.kind !== "group") continue;
      for (const r of g.rows) r.node.classList.toggle("hidden", !rowVisible(r));
      updateGroupCaption(g);
    }
  }

  function markdown(text) {
    const body = h("div", { class: "md" });
    try {
      body.append(window.renderMarkdown(text));
    } catch {
      body.textContent = text;
    }
    return body;
  }

  // Inline images from a prompt or a tool result. Click toggles full size.
  function images(list) {
    const wrap = h("div", { class: "images" });
    for (const im of list) {
      const img = h("img", { src: `data:${im.mediaType};base64,${im.data}`, alt: "image", loading: "lazy" });
      img.addEventListener("click", (ev) => {
        ev.stopPropagation();
        img.classList.toggle("full");
      });
      wrap.append(img);
    }
    return wrap;
  }

  function scrollToBottom() {
    el.stream.scrollTop = el.stream.scrollHeight;
  }

  /* -------------------------------- turn rail -------------------------------- */

  function peek(t) {
    el.peekLabel.textContent = t.label;
    el.peekTime.textContent = fmtClock(t.ts);
    el.peekTitle.textContent = t.title || "";
    el.peekExcerpt.textContent = t.excerpt || "";
    el.peek.hidden = false;
  }
  function jump(t) {
    el.follow.checked = false;
    el.stream.scrollTo({ top: t.node.offsetTop - el.stream.offsetTop - 84, behavior: "smooth" });
  }
  function updateCurrent() {
    const mid = el.stream.scrollTop + el.stream.clientHeight * 0.45;
    let cur = -1;
    for (const t of state.turns) if (t.node.offsetTop - el.stream.offsetTop <= mid) cur = t.id;
    if (cur === state.current) return;
    state.current = cur;
    const ticks = el.ticks.children;
    for (let i = 0; i < ticks.length; i++) ticks[i].classList.toggle("current", i === cur);
  }
  document.getElementById("turn-rail").addEventListener("mouseleave", () => (el.peek.hidden = true));

  /* -------------------------------- terminal -------------------------------- */

  let term = null;
  let fit = null;
  function ensureTerminal() {
    if (term) return term;
    term = new window.Terminal({ convertEol: false, scrollback: 5000, fontSize: 13, theme: { background: "#101014" } });
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
  function setTerm(on) {
    state.showTerm = on;
    el.term.hidden = !on;
    el.chipTerm.setAttribute("aria-pressed", String(on));
    if (on) {
      ensureTerminal();
      requestAnimationFrame(() => {
        fit && fit.fit();
        term && term.focus();
      });
    } else if (el.follow.checked) scrollToBottom();
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
      autosize();
    } catch (err) {
      toast(`send: ${err.message}`);
    } finally {
      renderHeader();
    }
  }
  async function stopTurn() {
    const s = current();
    if (!s) return;
    try {
      await api("POST", `/api/sessions/${encodeURIComponent(s.id)}/stop`);
    } catch (err) {
      toast(`stop: ${err.message}`);
    }
  }
  function autosize() {
    el.msg.rows = Math.min(6, Math.max(1, el.msg.value.split("\n").length));
  }

  el.send.addEventListener("click", () => (el.msg.value.trim() ? sendMessage() : stopTurn()));
  el.stop.addEventListener("click", stopTurn);
  el.msg.addEventListener("input", () => {
    autosize();
    const s = current();
    if (s) updateSendButton(s.spawned && s.running, (s.spawned && s.running) || s.agentConnected);
  });
  el.msg.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      sendMessage();
    }
  });
  el.resume.addEventListener("click", async () => {
    const s = current();
    if (!s) return;
    el.resume.disabled = true;
    try {
      await api("POST", `/api/sessions/${encodeURIComponent(s.id)}/resume`);
      setTerm(true); // startup dialogs, if any, show up here first
    } catch (err) {
      toast(`resume: ${err.message}`);
    } finally {
      el.resume.disabled = false;
    }
  });
  el.kill.addEventListener("click", async () => {
    const s = current();
    if (!s) return;
    const verb = s.running ? "Kill" : "Remove";
    if (!confirm(`${verb} "${s.title || s.id.slice(0, 8)}"?`)) return;
    try {
      await api("DELETE", `/api/sessions/${encodeURIComponent(s.id)}`);
    } catch (err) {
      toast(`${verb.toLowerCase()}: ${err.message}`);
    }
  });
  el.chipTerm.addEventListener("click", () => setTerm(!state.showTerm));
  el.stream.addEventListener("scroll", () => {
    updateCurrent();
    // Scrolling up pauses follow; scrolling back to the bottom resumes it.
    const atBottom = el.stream.scrollHeight - el.stream.scrollTop - el.stream.clientHeight < 40;
    if (!atBottom && el.follow.checked) el.follow.checked = false;
    else if (atBottom && !el.follow.checked) el.follow.checked = true;
  });
  for (const c of [el.showThinking, el.showMeta, el.showSidechain]) c.addEventListener("change", applyFilters);

  /* ------------------------------ inspector wiring --------------------------- */

  el.inspectorToggle.addEventListener("click", () => setInspector(!state.inspector));
  el.pill.addEventListener("click", () => setInspector(!(state.inspector && state.pane === "sessions"), "sessions"));
  for (const b of el.inspector.querySelectorAll(".seg button")) b.addEventListener("click", () => setInspector(true, b.dataset.pane));
  try {
    el.showEmpty.checked = localStorage.getItem("claude-web.showEmpty") === "1";
    const saved = JSON.parse(localStorage.getItem("claude-web.inspector") || "null");
    if (saved) {
      state.inspector = !!saved.open;
      state.pane = saved.pane === "sessions" ? "sessions" : "details";
    }
  } catch {}
  el.showEmpty.addEventListener("change", () => {
    try {
      localStorage.setItem("claude-web.showEmpty", el.showEmpty.checked ? "1" : "0");
    } catch {}
    renderSessions();
  });

  /* ------------------------------- new session ------------------------------- */

  el.newToggle.addEventListener("click", () => {
    el.newDialog.showModal();
    el.newForm.elements.cwd.focus();
  });
  el.newCancel.addEventListener("click", () => el.newDialog.close());
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
      el.newDialog.close();
      if (!state.sessions.some((x) => x.id === s.id)) state.sessions.unshift(s);
      select(s.id);
      setTerm(true);
    } catch (err) {
      toast(`start: ${err.message}`);
    }
  });

  /* -------------------------------- websocket -------------------------------- */

  function renderAll() {
    renderSessions();
    renderHeader();
    renderPermissions();
    if (state.inspector) renderDetails();
  }

  function send(frame) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(frame));
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ui`);
    state.ws = ws;
    ws.onopen = () => {
      if (state.selected) {
        resetStream();
        resetTerminal();
        send({ type: "subscribe", id: state.selected });
      }
    };
    ws.onclose = () => {
      el.pillStatus.textContent = "Disconnected, retrying";
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
          renderAll();
          break;
        case "history":
          if (frame.id !== state.selected) return;
          resetStream();
          el.truncated.hidden = !frame.truncated;
          for (const e of frame.entries) addEntry(e);
          renderHeader();
          if (state.inspector) renderDetails();
          if (el.follow.checked) scrollToBottom();
          updateCurrent();
          break;
        case "entry":
          if (frame.id !== state.selected) return;
          addEntry(frame.entry);
          renderHeader();
          if (state.inspector) renderDetails();
          if (el.follow.checked) scrollToBottom();
          break;
        case "pty":
          if (frame.id === state.selected) writePty(frame.data);
          break;
        case "session_removed":
          state.sessions = state.sessions.filter((s) => s.id !== frame.id);
          delete state.pending[frame.id];
          if (state.selected === frame.id) {
            state.selected = null;
            resetStream();
          }
          renderAll();
          break;
        case "permission_request":
          (state.pending[frame.id] ||= []).push(frame.request);
          renderSessions();
          if (frame.id === state.selected) renderPermissions();
          break;
        case "permission_resolved":
          state.pending[frame.id] = (state.pending[frame.id] || []).filter((p) => p.requestId !== frame.request_id);
          renderSessions();
          if (frame.id === state.selected) renderPermissions();
          break;
        case "permissions_cleared":
          delete state.pending[frame.id];
          renderSessions();
          if (frame.id === state.selected) renderPermissions();
          break;
      }
    };
  }

  /* ---------------------------------- boot ----------------------------------- */

  fetch("/api/root")
    .then((r) => (r.ok ? r.json() : { root: "" }))
    .then((j) => (el.root.textContent = j.root || ""))
    .catch(() => {})
    .finally(() => {
      const hash = location.hash.slice(1);
      if (hash) state.selected = hash;
      setInspector(state.inspector, state.pane);
      connect();
    });
  window.addEventListener("hashchange", () => {
    const id = location.hash.slice(1);
    if (id && id !== state.selected) select(id);
  });
  window.addEventListener("resize", () => state.showTerm && fit && fit.fit());
})();
