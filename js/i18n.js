/* Distinction: interface translation.
   Translates the site's own text (menus, buttons, labels, messages) into the viewer's preferred language.
   User-written content (questions, answers, names, codes) is skipped here; it is translated separately and only
   when it's in a different language, with a "Show original" toggle. */
(function () {
  const SKIP = "script,style,textarea,code,pre,[data-notr],[data-tr],.q-text,.bubble,.q-code,.code,.mono,.page,.fchip,.review p,.kv dd,.avatar,.gsel-sub,.o-main.mono,.balance,.amt,.earn-amt,.rating-big";
  const HAS_LETTERS = /\p{L}{2,}/u;
  const ONLY_CODEY = /^[\s\d$.,:;%·•()+\-–—/×#@|<>"'!?&*_=]*$|^[A-Z]{2,5}\d{3,5}[A-Z]?$/;
  let lang = "English", sb = null, observer = null;
  const done = new WeakMap();            // text node -> {orig, shown}
  const touched = new Set();             // nodes and elements we changed, so a language switch can restore them
  const pending = new Map();             // original text -> [nodes or attr targets]
  let cache = {}, timer = null;
  const attrs = ["placeholder", "aria-label", "title"];

  function loadCache() { try { cache = JSON.parse(localStorage.getItem("ui-tr:" + lang) || "{}"); } catch (e) { cache = {}; } }
  function saveCache() { try { localStorage.setItem("ui-tr:" + lang, JSON.stringify(cache)); } catch (e) { } }

  function skip(el) { return !el || (el.closest && el.closest(SKIP)); }
  function wanted(t) { const s = t.trim(); return s.length > 1 && s.length < 600 && HAS_LETTERS.test(s) && !ONLY_CODEY.test(s); }

  // Numbers become {0}, {1}... so "Closes in 12 min" and "Closes in 13 min" share one translation
  function tmpl(t) { const nums = []; const key = t.replace(/\d+(?:[.,]\d+)*/g, m => "{" + (nums.push(m) - 1) + "}"); return { key, nums }; }
  function fill(tr, nums) { return tr.replace(/\{(\d+)\}/g, (m, i) => nums[+i] ?? m); }
  function queue(key, target) { if (!pending.has(key)) pending.set(key, []); pending.get(key).push(target); }
  function applyTo(target, orig, trKey) {
    const tr = fill(trKey, tmpl(orig).nums);
    if (target.node) {
      const n = target.node; const cur = n.nodeValue; const lead = cur.match(/^\s*/)[0], trail = cur.match(/\s*$/)[0];
      if (cur.trim() !== orig) return;              // text changed since queued
      n.nodeValue = lead + tr + trail; done.set(n, { orig, shown: tr }); touched.add(n);
    } else { const { el, attr } = target; if ((el.getAttribute(attr) || "").trim() === orig) { el["_tro_" + attr] = orig; el["_tr_" + attr] = tr; el.setAttribute(attr, tr); touched.add(el); } }
  }

  function scan(root) {
    if (lang === "English" || !root) return;
    if (root.nodeType === 3) return scanText(root);
    if (root.nodeType !== 1 || skip(root)) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: n => n.nodeType === 1 ? (skip(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP) : NodeFilter.FILTER_ACCEPT
    });
    scanAttrs(root);
    let n; while ((n = w.nextNode())) scanText(n);
    root.querySelectorAll && root.querySelectorAll("[placeholder],[aria-label],[title]").forEach(e => { if (!skip(e)) scanAttrs(e); });
  }
  function scanText(n) {
    if (skip(n.parentElement)) return;
    const d = done.get(n); const t = n.nodeValue.trim();
    if (d && t === d.shown) return;
    if (!wanted(t)) return;
    const k = tmpl(t).key;
    if (cache[k]) return applyTo({ node: n }, t, cache[k]);
    queue(k, { node: n, orig: t }); schedule();
  }
  function scanAttrs(e) {
    if (e.nodeType !== 1) return;
    attrs.forEach(a => {
      const v = (e.getAttribute(a) || "").trim();
      if (!v || e["_tr_" + a] === v || !wanted(v)) return;
      const k = tmpl(v).key;
      if (cache[k]) return applyTo({ el: e, attr: a }, v, cache[k]);
      queue(k, { el: e, attr: a, orig: v }); schedule();
    });
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(flush, 120); }
  async function flush() {
    if (!pending.size || !sb) return;
    const batch = new Map(pending); pending.clear();
    const texts = [...batch.keys()], forLang = lang;
    const chunks = []; for (let i = 0; i < texts.length; i += 50) chunks.push(texts.slice(i, i + 50));
    await Promise.all(chunks.map(async chunk => {
      try {
        const { data, error } = await sb.functions.invoke("translate", { body: { texts: chunk, target: forLang, mode: "ui" } });
        if (error || !data || !data.results || forLang !== lang) return;
        chunk.forEach((t, i) => { const r = data.results[i]; const tr = r && r.translated ? r.translated : t; cache[t] = tr; (batch.get(t) || []).forEach(target => applyTo(target, target.orig, tr)); });
      } catch (e) { /* leave English */ }
    }));
    if (forLang === lang) saveCache();
  }

  function start(client) {
    sb = client;
    observer = new MutationObserver(muts => {
      if (lang === "English") return;
      for (const m of muts) {
        if (m.type === "characterData") scanText(m.target);
        else if (m.type === "attributes") scanAttrs(m.target);
        else m.addedNodes.forEach(scan);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: attrs });
  }
  function setLang(l) {
    const next = l || "English";
    try { localStorage.setItem("ui-lang", next); } catch (e) { }
    if (next === lang) return;
    // put the English back everywhere before translating into the new language
    const prev = observer ? (observer.takeRecords(), true) : false;
    touched.forEach(n => {
      if (!n.isConnected) return;
      if (n.nodeType === 3) { const d = done.get(n); if (d && n.nodeValue.trim() === d.shown) { const cur = n.nodeValue; n.nodeValue = cur.match(/^\s*/)[0] + d.orig + cur.match(/\s*$/)[0]; } done.delete(n); }
      else attrs.forEach(a => { if (n["_tro_" + a] && n.getAttribute(a) === n["_tr_" + a]) n.setAttribute(a, n["_tro_" + a]); delete n["_tro_" + a]; delete n["_tr_" + a]; });
    });
    touched.clear(); pending.clear();
    if (prev) observer.takeRecords();
    lang = next; document.documentElement.lang = ({ "Mandarin (Simplified Chinese)": "zh-Hans", "Cantonese (Traditional Chinese)": "zh-Hant", Hindi: "hi", Vietnamese: "vi", Korean: "ko", Japanese: "ja", Indonesian: "id", Arabic: "ar", Spanish: "es", Thai: "th", Nepali: "ne", Urdu: "ur", Punjabi: "pa", Malay: "ms" })[lang] || "en";
    document.documentElement.dir = ["Arabic", "Urdu"].includes(lang) ? "rtl" : "ltr";
    loadCache(); scan(document.body);
  }
  function initialLang() { try { return localStorage.getItem("ui-lang") || "English"; } catch (e) { return "English"; } }
  window.I18N = { start, setLang, initialLang, get lang() { return lang; } };
})();
