/* Distinction: shared UI helpers */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = n => "$" + (Math.round(n * 100) % 100 ? Number(n).toFixed(2) : String(Math.round(n)));
  const words = s => (String(s).trim().match(/\S+/g) || []).length;
  const initials = n => String(n || "?").trim().split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
  const kb = b => b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
  const ago = t => { const m = Math.round((Date.now() - new Date(t)) / 60e3); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  const left = t => { const m = Math.round((new Date(t) - Date.now()) / 60e3); if (m <= 0) return "Closed"; return m < 60 ? `Closes in ${m} min` : `Closes in ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`; };
  const mins = ms => Math.max(0, Math.ceil(ms / 60e3));
  const gradeFor = m => m >= 85 ? "HD" : m >= 75 ? "DN" : m >= 65 ? "CR" : m >= 50 ? "PS" : "FL";
  const gcls = g => g === "HD" ? "HD" : /^D/.test(g || "") ? "DN" : "CR";
  const stars = (n, size) => { const r = Math.round(n || 0); return `<span class="stars"${size ? ` style="font-size:${size}px"` : ""} aria-label="${(n || 0).toFixed ? Number(n || 0).toFixed(1) : n} out of 5">${[1, 2, 3, 4, 5].map(i => `<span class="${i <= r ? "" : "off"}">★</span>`).join("")}</span>`; };

  function toast(msg, ms = 3200) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, ms); }
  function status(el, msg, kind, busy) { if (!el) return; el.hidden = !msg; el.className = "status" + (kind ? " " + kind : ""); el.innerHTML = (busy ? '<span class="spin"></span>' : "") + esc(msg); }

  function openModal(html, bind) {
    $("#modal").innerHTML = html; $("#overlay").hidden = false; bind && bind($("#modal"));
    const f = $("#modal").querySelector("textarea,input,button"); f && f.focus();
  }
  function closeModal() { $("#overlay").hidden = true; $("#modal").innerHTML = ""; }
  document.addEventListener("click", e => { if (e.target.id === "overlay" || e.target.closest("[data-close]")) closeModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#overlay").hidden) closeModal(); });

  /* Glass dropdown with optional search and free text entry */
  const CHEV = '<svg class="gsel-chev" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 5l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const openSels = new Set();
  document.addEventListener("pointerdown", e => { openSels.forEach(s => { if (!s.el.contains(e.target)) s.close(false); }); });
  function glassSelect(el, cfg) {
    let options = cfg.options || [], value = cfg.value ?? null, active = 0, query = "", extra = null;
    const id = el.id, lbl = el.dataset.label || "";
    el.classList.add("gsel");
    el.innerHTML = `<button type="button" class="gsel-btn" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="${lbl} ${id}-val"><span class="gsel-val" id="${id}-val"></span>${CHEV}</button>
      <div class="gsel-pop">${cfg.search ? `<input type="text" class="gsel-search" id="${id}-search" placeholder="${esc(cfg.search)}" autocomplete="off" spellcheck="false">` : ""}<ul class="gsel-list" role="listbox" id="${id}-list" tabindex="-1"></ul></div>`;
    const btn = el.querySelector(".gsel-btn"), list = el.querySelector(".gsel-list"), srch = el.querySelector(".gsel-search"), val = el.querySelector(".gsel-val");
    const find = v => options.find(o => o.value === v) || (extra && extra.value === v ? extra : null);
    function shown() {
      const q = query.trim().toUpperCase();
      let out = q ? options.filter(o => (o.value + " " + o.label + " " + (o.sub || "")).toUpperCase().includes(q)) : options.slice();
      if (cfg.freeText && q && cfg.freeText(q) && !options.some(o => o.value === q)) out.push({ value: q, label: q, sub: "Use this course code", custom: true });
      return out.slice(0, 300);
    }
    function paint() {
      const o = find(value);
      val.innerHTML = o ? `<span class="${cfg.mono ? "mono" : ""}">${esc(o.short || o.label)}</span>${o.sub && !o.custom && !cfg.hideSub ? `<span class="gsel-sub">${esc(o.sub)}</span>` : ""}` : `<span class="muted">${esc(cfg.placeholder || "Choose")}</span>`;
      const items = shown(); if (active >= items.length) active = items.length - 1; if (active < 0) active = 0;
      list.innerHTML = items.length ? items.map((o, i) => `<li role="option" id="${id}-o${i}" data-i="${i}" aria-selected="${o.value === value}" class="${i === active ? "active" : ""}"><span class="o-main${cfg.mono ? " mono" : " wrap"}">${esc(o.label)}</span>${o.sub ? `<span class="o-sub">${esc(o.sub)}</span>` : "<span></span>"}<svg class="o-tick" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7.5l2.5 2.5L11 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></li>`).join("") : `<li class="gsel-empty">${esc(cfg.emptyText || "No matches.")}</li>`;
      list.setAttribute("aria-activedescendant", items.length ? `${id}-o${active}` : "");
      list._items = items;
    }
    const scrollActive = () => { const li = list.querySelector("li.active"); li && li.scrollIntoView({ block: "nearest" }); };
    function open() {
      if (el.classList.contains("open")) return;
      query = ""; if (srch) srch.value = "";
      active = Math.max(0, shown().findIndex(o => o.value === value)); paint();
      el.classList.add("open"); btn.setAttribute("aria-expanded", "true"); openSels.add(api);
      (srch || list).focus({ preventScroll: true }); scrollActive();
    }
    function close(refocus = true) { if (!el.classList.contains("open")) return; el.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); openSels.delete(api); if (refocus) btn.focus({ preventScroll: true }); }
    function pick(o) { if (!o) return; if (o.custom) extra = { ...o, sub: "" }; value = o.value; paint(); close(); cfg.onChange && cfg.onChange(value); }
    btn.addEventListener("click", () => el.classList.contains("open") ? close() : open());
    btn.addEventListener("keydown", e => { if (["ArrowDown", "ArrowUp"].includes(e.key)) { e.preventDefault(); open(); } });
    list.addEventListener("pointerdown", e => e.preventDefault());
    list.addEventListener("click", e => { const li = e.target.closest("li[data-i]"); if (li) pick(list._items[+li.dataset.i]); });
    if (srch) srch.addEventListener("input", () => { query = srch.value; active = 0; paint(); });
    el.addEventListener("keydown", e => {
      if (!el.classList.contains("open")) return;
      const n = (list._items || []).length;
      if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(n - 1, active + 1); paint(); scrollActive(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); paint(); scrollActive(); }
      else if (e.key === "Enter") { e.preventDefault(); pick(list._items[active]); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "Tab") close(false);
    });
    const api = { el, close, get value() { return value; }, set(v) { value = v; paint(); }, setOptions(opts, v) { options = opts; if (v !== undefined) value = v; extra = null; paint(); } };
    paint();
    return api;
  }

  /* Chips input for picking several course codes */
  function chipsInput(el, cfg) {
    let values = [...(cfg.values || [])];
    el.classList.add("chips-input");
    function render() {
      el.innerHTML = values.map((v, i) => `<span class="chip-x">${esc(v)}<button type="button" data-rm="${i}" aria-label="Remove ${esc(v)}">×</button></span>`).join("") +
        `<input type="text" list="${el.id}-dl" placeholder="${esc(cfg.placeholder || "Type a code and press Enter")}" autocomplete="off" spellcheck="false"><datalist id="${el.id}-dl">${(cfg.suggest ? cfg.suggest() : []).map(o => `<option value="${esc(o.value)}">${esc(o.sub || "")}</option>`).join("")}</datalist>`;
      const inp = el.querySelector("input");
      inp.addEventListener("keydown", e => {
        if ((e.key === "Enter" || e.key === ",") && inp.value.trim()) { e.preventDefault(); add(inp.value); }
        else if (e.key === "Backspace" && !inp.value && values.length) { values.pop(); render(); el.querySelector("input").focus(); }
      });
      inp.addEventListener("change", () => { if (inp.value.trim()) add(inp.value); });
    }
    function add(v) { v = v.toUpperCase().replace(/\s+/g, ""); if (v && !values.includes(v) && values.length < 12) values.push(v); render(); el.querySelector("input").focus(); }
    el.addEventListener("click", e => { const b = e.target.closest("[data-rm]"); if (b) { values.splice(+b.dataset.rm, 1); render(); } });
    render();
    return { get values() { return values; }, refresh: render };
  }

  window.UI = { $, $$, esc, money, words, initials, kb, ago, left, mins, gradeFor, gcls, stars, toast, status, openModal, closeModal, glassSelect, chipsInput };
})();
