// Minimal Markdown → DOM renderer for the conversation timeline.
//
// Builds nodes with textContent only (never innerHTML), so transcript text
// cannot inject markup. Covers what Claude Code output actually uses: fenced
// code, headings, bullet/numbered lists (nested by indent), blockquotes,
// tables, horizontal rules, paragraphs with hard line breaks, and inline
// code / bold / italic / strikethrough / links / bare URLs.
//
// Exposed as window.renderMarkdown(text) → DocumentFragment.
(() => {
  "use strict";

  const SAFE_HREF = /^(https?:|mailto:)/i;

  function el(tag, cls) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  /* --------------------------------- inline --------------------------------- */

  // Tokens in priority order; code spans win over everything inside them.
  const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+?)\*\*|__([^_]+?)__|~~([^~]+?)~~|(?<![\w*])\*([^*\n]+?)\*(?![\w*])|(?<![\w_])_([^_\n]+?)_(?![\w_])|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>)\]]+[^\s<>)\].,;:!?'"])/g;

  function inline(text, into) {
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
      if (m.index > last) appendText(into, text.slice(last, m.index));
      if (m[2] !== undefined) {
        const code = el("code");
        code.textContent = m[2];
        into.append(code);
      } else if (m[3] !== undefined || m[4] !== undefined) {
        const b = el("strong");
        inline(m[3] ?? m[4], b);
        into.append(b);
      } else if (m[5] !== undefined) {
        const s = el("s");
        inline(m[5], s);
        into.append(s);
      } else if (m[6] !== undefined || m[7] !== undefined) {
        const i = el("em");
        inline(m[6] ?? m[7], i);
        into.append(i);
      } else if (m[8] !== undefined) {
        into.append(link(m[9], m[8]));
      } else if (m[10] !== undefined) {
        into.append(link(m[10], m[10], true));
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) appendText(into, text.slice(last));
  }

  // `plain` keeps the label verbatim: a bare URL's label is the URL itself,
  // and running it through inline() again would match it as a link forever.
  function link(href, label, plain = false) {
    const node = SAFE_HREF.test(href) ? el("a") : el("span");
    if (node.tagName === "A") {
      node.href = href;
      node.target = "_blank";
      node.rel = "noopener noreferrer";
    }
    if (plain) node.textContent = label;
    else inline(label, node);
    return node;
  }

  // Hard line breaks inside a paragraph are kept: Claude's lists of facts
  // often rely on them.
  function appendText(into, text) {
    const parts = text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) into.append(el("br"));
      if (part) into.append(document.createTextNode(part));
    });
  }

  /* --------------------------------- blocks --------------------------------- */

  const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
  const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
  const QUOTE = /^\s*>\s?(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function render(text) {
    const frag = document.createDocumentFragment();
    blocks(String(text ?? "").replace(/\r\n?/g, "\n").split("\n"), frag);
    return frag;
  }

  function blocks(lines, into) {
    let i = 0;
    let para = [];
    const flush = () => {
      if (!para.length) return;
      const p = el("p");
      inline(para.join("\n"), p);
      into.append(p);
      para = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if ((m = FENCE.exec(line))) {
        flush();
        const fence = m[2];
        const lang = m[3];
        const body = [];
        i++;
        while (i < lines.length && !(lines[i].trim().startsWith(fence) && lines[i].trim().length >= fence.length && /^[`~\s]*$/.test(lines[i]))) body.push(lines[i++]);
        i++; // closing fence (or EOF)
        const pre = el("pre");
        const code = el("code");
        if (lang) code.dataset.lang = lang;
        code.textContent = body.join("\n");
        pre.append(code);
        into.append(pre);
        continue;
      }
      if (!line.trim()) {
        flush();
        i++;
        continue;
      }
      if ((m = HEADING.exec(line))) {
        flush();
        const hN = el("h" + m[1].length);
        inline(m[2], hN);
        into.append(hN);
        i++;
        continue;
      }
      if (HR.test(line)) {
        flush();
        into.append(el("hr"));
        i++;
        continue;
      }
      if (LIST.test(line)) {
        flush();
        i = list(lines, i, into);
        continue;
      }
      if (QUOTE.test(line)) {
        flush();
        const inner = [];
        while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])[1]);
        const q = el("blockquote");
        blocks(inner, q);
        into.append(q);
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        flush();
        i = table(lines, i, into);
        continue;
      }
      para.push(line);
      i++;
    }
    flush();
  }

  // Nested lists by indent: a deeper indent than the current item opens a
  // sublist inside it. Lines that are neither items nor blank continue the
  // current item as a hard-wrapped paragraph.
  function list(lines, i, into) {
    const m0 = LIST.exec(lines[i]);
    const indent = m0[1].length;
    const ordered = /\d/.test(m0[2]);
    const root = el(ordered ? "ol" : "ul");
    if (ordered) {
      const start = parseInt(m0[2], 10);
      if (start !== 1) root.start = start;
    }
    const sameKind = (m) => /\d/.test(m[2]) === ordered;
    let li = null;
    let body = [];
    const flushBody = () => {
      if (li && body.length) {
        inline(body.join("\n"), li);
        body = [];
      }
    };
    while (i < lines.length) {
      const line = lines[i];
      const m = LIST.exec(line);
      if (m && m[1].length === indent && !sameKind(m)) break; // "- a" then "1. b": a new list
      if (m && m[1].length === indent) {
        flushBody();
        li = el("li");
        root.append(li);
        body.push(m[3]);
        i++;
      } else if (m && m[1].length > indent && li) {
        flushBody();
        i = list(lines, i, li);
      } else if (!line.trim()) {
        // A blank line ends the list unless another item at this indent follows.
        const next = lines[i + 1];
        const nm = next !== undefined ? LIST.exec(next) : null;
        if (nm && nm[1].length >= indent && (nm[1].length > indent || sameKind(nm))) {
          i++;
          continue;
        }
        break;
      } else if (li && !FENCE.test(line) && !HEADING.test(line)) {
        body.push(line.trim());
        i++;
      } else break;
    }
    flushBody();
    into.append(root);
    return i;
  }

  function cells(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
  }

  function table(lines, i, into) {
    const t = el("table");
    const head = cells(lines[i]);
    const thead = el("thead");
    const tr = el("tr");
    for (const c of head) {
      const th = el("th");
      inline(c, th);
      tr.append(th);
    }
    thead.append(tr);
    t.append(thead);
    const tbody = el("tbody");
    i += 2;
    while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
      const row = el("tr");
      for (const c of cells(lines[i])) {
        const td = el("td");
        inline(c, td);
        row.append(td);
      }
      tbody.append(row);
      i++;
    }
    t.append(tbody);
    const wrap = el("div", "table-wrap");
    wrap.append(t);
    into.append(wrap);
    return i;
  }

  window.renderMarkdown = render;
})();
