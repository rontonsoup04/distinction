/* Distinction: PDF and image viewer with pen drawing and text notes.
   Tutors can only draw and add text notes on the student's own document. No file uploads. */
(function () {
  if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  const MAX_PAGES = 12, RENDER_W = 1100, NOTE_MAX = 300;
  const COLORS = ["#D7263D", "#1B6FD1", "#118A4E", "#17212B"];

  function blankAnn() { return { pages: {} }; }
  function pageAnn(ann, n) { return ann.pages[n] || (ann.pages[n] = { strokes: [], notes: [] }); }

  async function mount(container, opts) {
    const editable = !!opts.editable;
    let ann = normalise(opts.annotations);
    let tool = editable ? "pen" : null, color = COLORS[0];
    const history = [];
    const pages = []; // {n, el, base, ink}

    container.innerHTML = `<div class="pages"><div class="boot" style="min-height:120px"><span><span class="spin"></span>Loading document…</span></div></div>`;
    const wrap = container.querySelector(".pages");

    try {
      if (opts.type === "application/pdf") {
        const doc = await window.pdfjsLib.getDocument({ url: opts.url }).promise;
        wrap.innerHTML = "";
        const count = Math.min(doc.numPages, MAX_PAGES);
        for (let n = 1; n <= count; n++) {
          const page = await doc.getPage(n);
          const vp1 = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: RENDER_W / vp1.width });
          const p = makePage(n, vp.width, vp.height, count > 1);
          await page.render({ canvasContext: p.base.getContext("2d"), viewport: vp }).promise;
          redraw(p);
        }
        if (doc.numPages > MAX_PAGES) wrap.insertAdjacentHTML("beforeend", `<p class="muted" style="font-size:13px">Only the first ${MAX_PAGES} pages are shown.</p>`);
      } else {
        const img = await loadImage(opts.url);
        wrap.innerHTML = "";
        const s = Math.min(1, 1600 / img.naturalWidth);
        const p = makePage(1, Math.round(img.naturalWidth * s), Math.round(img.naturalHeight * s), false);
        p.base.getContext("2d").drawImage(img, 0, 0, p.base.width, p.base.height);
        redraw(p);
      }
    } catch (e) {
      wrap.innerHTML = `<div class="status err">The document couldn't be opened. ${UI.esc(e.message || "")}</div>`;
    }

    function makePage(n, w, h, label) {
      if (label) wrap.insertAdjacentHTML("beforeend", `<div class="page-label">Page ${n}</div>`);
      const el = document.createElement("div");
      el.className = "page" + (editable ? " mode-" + tool : " readonly");
      el.dataset.page = n;
      const base = document.createElement("canvas"); base.width = w; base.height = h;
      const ink = document.createElement("canvas"); ink.width = w; ink.height = h; ink.className = "ink";
      el.append(base, ink);
      wrap.append(el);
      const p = { n, el, base, ink };
      pages.push(p);
      if (editable) bindDrawing(p);
      return p;
    }

    function loadImage(url) {
      return new Promise((res, rej) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = () => rej(new Error("Image failed to load")); i.src = url; });
    }

    function redraw(p) {
      const ctx = p.ink.getContext("2d"), W = p.ink.width, H = p.ink.height;
      ctx.clearRect(0, 0, W, H);
      const pa = ann.pages[p.n]; if (!pa) { renderNotes(p); return; }
      for (const s of pa.strokes) drawStroke(ctx, s, W, H);
      renderNotes(p);
    }
    function drawStroke(ctx, s, W, H) {
      if (!s.p || s.p.length === 0) return;
      ctx.save();
      ctx.strokeStyle = s.c; ctx.lineWidth = s.w * W; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.globalAlpha = s.h ? 0.32 : 1;
      ctx.beginPath(); ctx.moveTo(s.p[0][0] * W, s.p[0][1] * H);
      for (let i = 1; i < s.p.length; i++) ctx.lineTo(s.p[i][0] * W, s.p[i][1] * H);
      if (s.p.length === 1) ctx.lineTo(s.p[0][0] * W + 0.1, s.p[0][1] * H);
      ctx.stroke(); ctx.restore();
    }
    function renderNotes(p) {
      p.el.querySelectorAll(".note").forEach(n => n.remove());
      const pa = ann.pages[p.n]; if (!pa) return;
      pa.notes.forEach((note, i) => {
        const d = document.createElement("div");
        d.className = "note"; d.style.left = (note.x * 100) + "%"; d.style.top = (note.y * 100) + "%";
        d.textContent = note.t;
        if (editable) {
          d.contentEditable = "true"; d.spellcheck = true;
          d.addEventListener("pointerdown", e => e.stopPropagation());
          d.addEventListener("input", () => { if (d.textContent.length > NOTE_MAX) { d.textContent = d.textContent.slice(0, NOTE_MAX); placeCaretEnd(d); } note.t = d.textContent; opts.onChange && opts.onChange(); });
          d.addEventListener("paste", e => { e.preventDefault(); const t = (e.clipboardData.getData("text/plain") || "").slice(0, 120); document.execCommand("insertText", false, t); if ((e.clipboardData.getData("text/plain") || "").length > 120) UI.toast("Pasting is limited to short snippets. Type your explanation instead."); });
          d.addEventListener("drop", e => e.preventDefault());
          d.addEventListener("blur", () => { if (!d.textContent.trim()) { pa.notes.splice(pa.notes.indexOf(note), 1); renderNotes(p); opts.onChange && opts.onChange(); } });
          const del = document.createElement("button"); del.className = "del"; del.type = "button"; del.textContent = "×"; del.setAttribute("aria-label", "Delete note"); del.contentEditable = "false";
          del.addEventListener("pointerdown", e => { e.stopPropagation(); e.preventDefault(); pa.notes.splice(pa.notes.indexOf(note), 1); renderNotes(p); opts.onChange && opts.onChange(); });
          d.append(del);
        }
        p.el.append(d);
      });
    }
    function placeCaretEnd(el) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }

    function bindDrawing(p) {
      let cur = null;
      const pos = e => { const r = p.ink.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; };
      p.el.addEventListener("pointerdown", e => {
        if (e.button !== 0) return;
        if (tool === "note") {
          if (e.target.closest(".note")) return;
          const [x, y] = pos(e);
          const pa = pageAnn(ann, p.n);
          const note = { x: Math.min(x, 0.8), y: Math.min(y, 0.95), t: "" };
          pa.notes.push(note); history.push({ page: p.n, kind: "note", item: note });
          renderNotes(p);
          const els = p.el.querySelectorAll(".note"); const d = els[els.length - 1];
          setTimeout(() => { d.focus(); }, 0);
          return;
        }
        if (tool !== "pen" && tool !== "highlight") return;
        e.preventDefault(); p.el.setPointerCapture(e.pointerId);
        cur = { c: color, w: tool === "highlight" ? 0.018 : 0.0035, h: tool === "highlight" ? 1 : 0, p: [pos(e)] };
      });
      p.el.addEventListener("pointermove", e => {
        if (!cur) return;
        const pt = pos(e), last = cur.p[cur.p.length - 1];
        if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 0.0015) return;
        cur.p.push(pt);
        const ctx = p.ink.getContext("2d"), W = p.ink.width, H = p.ink.height;
        ctx.save(); ctx.strokeStyle = cur.c; ctx.lineWidth = cur.w * W; ctx.lineCap = "round"; ctx.globalAlpha = cur.h ? 0.32 : 1;
        ctx.beginPath(); ctx.moveTo(last[0] * W, last[1] * H); ctx.lineTo(pt[0] * W, pt[1] * H); ctx.stroke(); ctx.restore();
      });
      const end = () => {
        if (!cur) return;
        cur.p = cur.p.map(([x, y]) => [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000]);
        pageAnn(ann, p.n).strokes.push(cur); history.push({ page: p.n, kind: "stroke", item: cur });
        cur = null; redraw(p); opts.onChange && opts.onChange();
      };
      p.el.addEventListener("pointerup", end); p.el.addEventListener("pointercancel", end);
      p.el.addEventListener("drop", e => e.preventDefault()); p.el.addEventListener("dragover", e => e.preventDefault());
    }

    const api = {
      get annotations() { return clean(ann); },
      setAnnotations(a) { ann = normalise(a); pages.forEach(redraw); },
      setTool(t) { tool = t; pages.forEach(p => p.el.className = "page mode-" + t); },
      setColor(c) { color = c; },
      undo() {
        const h = history.pop(); if (!h) return;
        const pa = ann.pages[h.page]; if (!pa) return;
        const arr = h.kind === "stroke" ? pa.strokes : pa.notes; const i = arr.indexOf(h.item); if (i >= 0) arr.splice(i, 1);
        const p = pages.find(x => x.n === h.page); p && redraw(p); opts.onChange && opts.onChange();
      },
      clear() { ann = blankAnn(); history.length = 0; pages.forEach(redraw); opts.onChange && opts.onChange(); },
      COLORS
    };
    return api;
  }

  function normalise(a) {
    const out = blankAnn();
    if (a && a.pages) for (const [k, v] of Object.entries(a.pages)) out.pages[k] = { strokes: Array.isArray(v.strokes) ? v.strokes : [], notes: Array.isArray(v.notes) ? v.notes : [] };
    return out;
  }
  function clean(a) {
    const out = { pages: {} };
    for (const [k, v] of Object.entries(a.pages)) {
      const notes = v.notes.filter(n => n.t && n.t.trim()).map(n => ({ x: n.x, y: n.y, t: n.t.trim().slice(0, NOTE_MAX) }));
      if (v.strokes.length || notes.length) out.pages[k] = { strokes: v.strokes, notes };
    }
    return out;
  }
  const count = a => { let s = 0, n = 0; for (const v of Object.values((a && a.pages) || {})) { s += (v.strokes || []).length; n += (v.notes || []).length; } return { strokes: s, notes: n }; };

  window.DocView = { mount, count, COLORS };
})();
