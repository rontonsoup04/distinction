/* Distinction: a free, open Q&A forum for uni students (Supabase auth, routing and pages) */
(function () {
  const { $, $$, esc, money, initials, ago, toast, status, openModal, closeModal, glassSelect } = UI;
  const cfg = window.DISTINCTION_CONFIG;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" } });
  window.sb = sb;

  const TITLE_MIN = 8, TITLE_MAX = 150, BODY_MIN = 20, BODY_MAX = 4000, REPLY_MAX = 3000, PAGE = 20;
  const YEARS = ["1st year", "2nd year", "3rd year", "4th year", "5th year or later", "Postgraduate"];
  const validCode = c => /^[A-Z0-9]{3,12}$/.test(c || "") && /\d{3}/.test(c || "");
  const POST_COLS = "id,uni_id,course_code,title,body,author_id,author_name,author_uni,reply_count,score,accepted_reply,removed,created_at,last_activity";
  const REPORT_REASONS = [
    ["assessment", "From an assessment that's still open, or asks for a full solution"],
    ["wrong", "Wrong or misleading"],
    ["spam", "Spam or advertising"],
    ["rude", "Rude, harmful or shares someone's personal details"],
    ["other", "Something else"]
  ];

  const S = { session: null, user: null, profile: null, unis: [], uniMap: {}, courses: {}, timers: [], ready: false };

  /* ---------------- data ---------------- */
  async function loadUnis() {
    const { data, error } = await sb.from("universities").select("*").order("name");
    if (error) throw error;
    S.unis = data; S.uniMap = Object.fromEntries(data.map(u => [u.id, u]));
    if (window.I18N) I18N.protect(data.flatMap(u => [u.name, u.short_name, u.id]));
  }
  async function coursesFor(uni) {
    if (!uni) return [];
    if (S.courses[uni]) return S.courses[uni];
    const { data } = await sb.from("courses").select("code,title").eq("uni_id", uni).order("code");
    return (S.courses[uni] = data || []);
  }
  const courseOpts = list => list.map(c => ({ value: c.code, label: c.code, sub: c.title }));
  const uniOpts = () => S.unis.map(u => ({ value: u.id, label: u.name, short: u.short_name, sub: u.state }));
  const uniName = id => (S.uniMap[id] && S.uniMap[id].name) || id || "";
  const uniShort = id => (S.uniMap[id] && S.uniMap[id].short_name) || id || "";
  async function loadProfile() {
    if (!S.user) { S.profile = null; return; }
    let { data, error } = await sb.from("profiles").select("*").eq("id", S.user.id).maybeSingle();
    if (error || !data) {
      // A saved login that no longer works (deleted user, revoked session): sign out cleanly
      const { data: u, error: ue } = await sb.auth.getUser();
      if (ue || !u || !u.user) { await sb.auth.signOut({ scope: "local" }).catch(() => { }); S.session = null; S.user = null; S.profile = null; return; }
      // Signed in but the profile row is missing: create it
      if (!error) { await sb.rpc("ensure_my_profile").catch(() => { }); ({ data } = await sb.from("profiles").select("*").eq("id", S.user.id).maybeSingle()); }
    }
    S.profile = data || null;
    if (data && window.I18N) I18N.setLang(langValue(data.answer_language));
  }
  const displayName = p => (p && (p.display_name || (p.full_name || "").split(" ")[0])) || "Student";
  const errMsg = e => (e && (e.message || e.error_description)) || "Something went wrong. Try again.";
  // Plain text with line breaks kept and web links made clickable
  const richText = s => esc(s).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, u => `<a href="${u}" target="_blank" rel="nofollow ugc noopener noreferrer">${u}</a>`);
  const snippet = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n).replace(/\s+\S*$/, "") + "…" : t; };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;

  /* ---------------- shell ---------------- */
  function renderHeader() {
    const p = S.profile, signedIn = !!S.user;
    const here = location.pathname.split("/")[1] || "";
    const links = [["", "Forum"], ["ask", "Ask a question"], ...(signedIn && p && p.onboarded ? [["my", "My posts"], ...(p.is_admin ? [["admin", "Admin"]] : [])] : [])];
    $("#nav").innerHTML = links.map(([r, l]) => `<a href="/${r}" class="navlink" ${here === r || (r === "" && here === "p") ? 'aria-current="page"' : ""}>${l}</a>`).join("");
    const ZH = "Mandarin (Simplified Chinese)", cur = window.I18N ? I18N.lang : "English";
    const langBtn = `<button class="lang-btn" id="lang-btn" data-notr title="${cur === ZH ? "Switch to English" : "切换到中文"}" aria-label="${cur === ZH ? "Switch to English" : "Switch to Mandarin"}"><svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1.5 8h13M8 1.5c2 2.2 2 10.8 0 13M8 1.5c-2 2.2-2 10.8 0 13" fill="none" stroke="currentColor" stroke-width="1.3"/></svg><span class="${cur === "English" ? "on" : ""}">EN</span><span class="sep">/</span><span class="${cur === ZH ? "on" : ""}">中文</span></button>`;
    $("#auth-area").innerHTML = langBtn + (signedIn
      ? `<button class="avatar-btn" id="me-btn" aria-haspopup="menu"><span class="avatar" aria-hidden="true">${esc(initials(p && p.full_name || S.user.email))}</span><span data-notr>${esc(p ? displayName(p) : "Account")}</span></button>`
      : `<a class="btn ghost sm" href="/login">Log in</a><a class="btn primary sm" href="/signup">Sign up</a>`);
    $("#lang-btn").onclick = async () => {
      const next = (window.I18N && I18N.lang === ZH) ? "English" : ZH;
      if (window.I18N) I18N.setLang(next);
      if (S.user && S.profile) { try { await saveProfile({ answer_language: next }); } catch (e) { } }
      renderHeader(); route();
    };
    const btn = $("#me-btn");
    if (btn) btn.onclick = e => { e.stopPropagation(); const m = $("#menu"); m.hidden = !m.hidden; };
    $("#menu").innerHTML = signedIn ? `<div class="who">Signed in as<br><b style="color:var(--ink)">${esc(S.user.email)}</b></div><a href="/my">My posts</a><a href="/profile">Profile and settings</a><button id="signout">Sign out</button>` : "";
    const so = $("#signout"); if (so) so.onclick = async () => { $("#menu").hidden = true; await sb.auth.signOut(); toast("Signed out"); go("/"); };
  }
  document.addEventListener("click", e => { if (!e.target.closest("#menu") && !e.target.closest("#me-btn")) $("#menu").hidden = true; });
  // nav links styled like tabs
  const navStyle = document.createElement("style");
  navStyle.textContent = `#nav{display:flex;gap:4px;flex-wrap:wrap;flex:1}#nav a{padding:8px 12px;border-radius:8px;color:var(--muted);font-weight:500;text-decoration:none}#nav a:hover{color:var(--ink);background:var(--surface-2)}#nav a[aria-current="page"]{color:var(--ink);background:var(--surface);box-shadow:inset 0 0 0 1px var(--line)}`;
  document.head.append(navStyle);

  const app = () => $("#app");
  function clearTimers() { S.timers.forEach(clearInterval); S.timers = []; }
  // Google Analytics: page views plus a few key events. No personal details are sent.
  const track = (name, params) => { try { window.gtag && gtag("event", name, params || {}); } catch (e) { } };
  function trackPage(parts) {
    const path = "/" + parts.map(x => /^[0-9a-f-]{20,}$/i.test(x) ? ":id" : x).filter(Boolean).join("/");
    track("page_view", { page_location: location.origin + path, page_path: path, page_title: document.title + (path === "/" ? "" : " · " + parts[0]) });
  }
  // Ask signed-out visitors to log in, then bring them back here
  function needLogin(what) {
    openModal(`<h3>Log in to ${esc(what)}</h3><p class="muted" style="font-size:14px">Reading is open to everyone. You need a free account to post, answer, upvote or report.</p><div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Not now</button><a class="btn" href="/login" id="nl-in">Log in</a><a class="btn primary" href="/signup" id="nl-up">Sign up</a></div>`, m => {
      m.querySelectorAll("a").forEach(a => a.addEventListener("click", () => { sessionStorage.setItem("after-login", location.pathname + location.search); closeModal(); }));
    });
  }

  /* ---------------- router ---------------- */
  const curPath = () => (location.pathname || "/") + location.search;
  function go(path, replace) {
    path = String(path || "/").replace(/^#\/?/, "/");
    if (!path.startsWith("/")) path = "/" + path;
    if (path !== curPath()) history[replace ? "replaceState" : "pushState"](null, "", path);
    route();
  }
  const PUBLIC = ["", "p", "login", "signup", "reset", "new-password"];
  // Pages from the old paid version: send people to the forum
  const RETIRED = ["tutor", "credits", "questions", "q", "answer", "alerts-off"];
  async function route() {
    if (!S.ready) return;
    clearTimers(); closeModal(); $("#menu").hidden = true;
    document.title = "Distinction · Uni course Q&A forum";
    const parts = location.pathname.replace(/^\/+/, "").split("/");
    const r = parts[0] || "";
    if (RETIRED.includes(r)) { go(r === "questions" ? (S.user ? "/my" : "/") : "/", true); return; }
    renderHeader();
    window.scrollTo(0, 0);
    trackPage(parts);
    if (!S.user && !PUBLIC.includes(r)) { sessionStorage.setItem("after-login", curPath()); go("/login"); return; }
    if (S.user && ["login", "signup"].includes(r)) { go("/"); return; }
    if (S.user && !S.profile && r !== "new-password") { app().innerHTML = `<div class="empty">We couldn't load your account. <button class="btn sm" id="retry-prof">Try again</button> <button class="btn ghost sm" id="so-prof">Sign out</button></div>`; $("#retry-prof").onclick = async () => { await loadProfile(); route(); }; $("#so-prof").onclick = async () => { await sb.auth.signOut(); go("/login"); }; return; }
    if (S.user && S.profile && !S.profile.onboarded && !["welcome", "new-password", "", "p"].includes(r)) { sessionStorage.setItem("after-welcome", curPath()); go("/welcome"); return; }
    try {
      switch (r) {
        case "": return await pageForum();
        case "p": return await pagePost(parts[1]);
        case "login": return await pageLogin();
        case "signup": return await pageSignup();
        case "reset": return await pageReset();
        case "new-password": return await pageNewPassword();
        case "welcome": return await pageWelcome();
        case "profile": return await pageProfile();
        case "ask": return await pageAsk();
        case "my": return await pageMine();
        case "admin": return await pageAdmin();
        default: app().innerHTML = `<div class="empty">Page not found. <a href="/">Go to the forum</a></div>`;
      }
    } catch (e) { console.error(e); app().innerHTML = `<div class="status err">${esc(errMsg(e))}</div>`; }
  }
  // Old #/ links still work: they're converted on the fly.
  function fromHash() { if (/^#\/?[a-z]/i.test(location.hash) || location.hash === "#/") { history.replaceState(null, "", location.hash.replace(/^#\/?/, "/")); return true; } return false; }
  window.addEventListener("popstate", route);
  window.addEventListener("hashchange", () => { if (fromHash()) route(); });
  document.addEventListener("click", e => {
    const a = e.target.closest("a[href]"); if (!a || e.defaultPrevented) return;
    const href = a.getAttribute("href");
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target === "_blank" || a.hasAttribute("download")) return;
    if (!href.startsWith("/") || href.startsWith("//") || /\.(html|pdf|png|jpe?g|svg)$/i.test(href)) return;
    e.preventDefault(); go(href);
  });

  /* ---------------- auth ---------------- */
  const GOOGLE_SVG = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
  async function google(role) {
    const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + "/" } });
    if (error) toast(/provider is not enabled|Unsupported provider/i.test(error.message) ? "Google sign-in isn't switched on yet. Use email and password for now." : errMsg(error), 5000);
  }
  function pageLogin() {
    app().innerHTML = `<div class="narrow"><form class="panel auth-card" id="f" novalidate>
      <h1>Log in</h1>
      <button type="button" class="btn block google" id="g">${GOOGLE_SVG}Continue with Google</button>
      <div class="divider">or</div>
      <label class="field"><span>Email</span><input type="email" id="email" autocomplete="email" required></label>
      <label class="field"><span>Password</span><input type="password" id="pw" autocomplete="current-password" required></label>
      <div id="st" hidden></div>
      <button class="btn primary block" id="go">Log in</button>
      <div class="row" style="justify-content:space-between"><a href="/reset">Forgot your password?</a><a href="/signup">Create an account</a></div>
    </form></div>`;
    $("#g").onclick = () => google();
    $("#f").onsubmit = async e => {
      e.preventDefault();
      const email = $("#email").value.trim(), password = $("#pw").value;
      if (!email || !password) return status($("#st"), "Enter your email and password.", "err");
      $("#go").disabled = true; status($("#st"), "Logging in…", "", true);
      const { error } = await sb.auth.signInWithPassword({ email, password });
      $("#go").disabled = false;
      if (error) return status($("#st"), /Email not confirmed/i.test(error.message) ? "Confirm your email first. Check your inbox for the link we sent." : /Invalid login/i.test(error.message) ? "That email and password don't match. Try again or reset your password." : errMsg(error), "err");
    };
  }
  function pageSignup() {
    app().innerHTML = `<div class="narrow"><form class="panel auth-card" id="f" novalidate>
      <h1>Create your account</h1>
      <p class="muted" style="font-size:14px">Anyone can read the forum. An account lets you ask questions, answer them and upvote. It's free.</p>
      <button type="button" class="btn block google" id="g">${GOOGLE_SVG}Sign up with Google</button>
      <div class="divider">or</div>
      <label class="field"><span>Full name</span><input type="text" id="name" autocomplete="name" required></label>
      <label class="field"><span>Email</span><input type="email" id="email" autocomplete="email" required><small>Use any email. Your uni email works well.</small></label>
      <label class="field"><span>Password</span><input type="password" id="pw" autocomplete="new-password" minlength="8" required><small>At least 8 characters.</small></label>
      <div id="st" hidden></div>
      <button class="btn primary block" id="go">Create account</button>
      <div class="row" style="justify-content:center"><span class="muted">Already have an account?</span><a href="/login">Log in</a></div>
    </form></div>`;
    $("#g").onclick = () => google();
    $("#f").onsubmit = async e => {
      e.preventDefault();
      const full_name = $("#name").value.trim(), email = $("#email").value.trim(), password = $("#pw").value;
      if (!full_name) return status($("#st"), "Enter your full name.", "err");
      if (!/^\S+@\S+\.\S+$/.test(email)) return status($("#st"), "Enter a valid email address.", "err");
      if (password.length < 8) return status($("#st"), "Use a password of at least 8 characters.", "err");
      $("#go").disabled = true; status($("#st"), "Creating your account…", "", true);
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { full_name }, emailRedirectTo: location.origin + "/" } });
      $("#go").disabled = false;
      if (error) return status($("#st"), /already registered/i.test(error.message) ? "There's already an account with that email. Log in instead." : errMsg(error), "err");
      track("sign_up", { method: "email" });
      if (!data.session) {
        app().innerHTML = `<div class="narrow"><div class="panel auth-card"><h1>Check your email</h1><p>We sent a confirmation link to <b>${esc(email)}</b>. Open it to finish creating your account. You can close this tab.</p><p class="muted" style="font-size:14px">Can't find it? Check your spam folder.</p></div></div>`;
      }
    };
  }
  function pageReset() {
    app().innerHTML = `<div class="narrow"><form class="panel auth-card" id="f" novalidate><h1>Reset your password</h1><p class="muted">We'll email you a link to set a new password.</p>
      <label class="field"><span>Email</span><input type="email" id="email" autocomplete="email" required></label><div id="st" hidden></div>
      <button class="btn primary block" id="go">Send reset link</button><a href="/login">Back to log in</a></form></div>`;
    $("#f").onsubmit = async e => {
      e.preventDefault();
      const email = $("#email").value.trim(); if (!email) return status($("#st"), "Enter your email.", "err");
      $("#go").disabled = true;
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + "/" });
      $("#go").disabled = false;
      status($("#st"), error ? errMsg(error) : "If there's an account for that email, a reset link is on its way.", error ? "err" : "ok");
    };
  }
  function pageNewPassword() {
    app().innerHTML = `<div class="narrow"><form class="panel auth-card" id="f" novalidate><h1>Set a new password</h1>
      <label class="field"><span>New password</span><input type="password" id="pw" autocomplete="new-password" minlength="8" required></label><div id="st" hidden></div>
      <button class="btn primary block" id="go">Save password</button></form></div>`;
    $("#f").onsubmit = async e => {
      e.preventDefault();
      const password = $("#pw").value; if (password.length < 8) return status($("#st"), "Use at least 8 characters.", "err");
      const { error } = await sb.auth.updateUser({ password });
      if (error) return status($("#st"), errMsg(error), "err");
      toast("Password updated"); go("/");
    };
  }

  /* ---------------- profile forms ---------------- */
  const DEGREES = [
    "Bachelor of Commerce", "Bachelor of Information Systems", "Bachelor of Computer Science", "Bachelor of Software Engineering", "Bachelor of Engineering (Honours)",
    "Bachelor of Information Technology", "Bachelor of Data Science", "Bachelor of Science", "Bachelor of Advanced Science", "Bachelor of Mathematics",
    "Bachelor of Actuarial Studies", "Bachelor of Economics", "Bachelor of Business", "Bachelor of Business Analytics", "Bachelor of Finance", "Bachelor of Accounting",
    "Bachelor of Marketing", "Bachelor of Management", "Bachelor of Arts", "Bachelor of Media and Communication", "Bachelor of Design", "Bachelor of Architecture",
    "Bachelor of Laws", "Bachelor of Psychology", "Bachelor of Psychological Science", "Bachelor of Medical Science", "Bachelor of Biomedical Science",
    "Bachelor of Health Science", "Bachelor of Nursing", "Bachelor of Pharmacy", "Bachelor of Exercise Science", "Bachelor of Physiotherapy", "Doctor of Medicine",
    "Bachelor of Education", "Bachelor of Social Work", "Bachelor of Music", "Bachelor of Fine Arts", "Bachelor of International Studies", "Bachelor of Politics, Philosophy and Economics",
    "Bachelor of Commerce / Bachelor of Laws", "Bachelor of Commerce / Bachelor of Information Systems", "Bachelor of Commerce / Bachelor of Computer Science",
    "Bachelor of Engineering (Honours) / Bachelor of Commerce", "Bachelor of Science / Bachelor of Arts",
    "Master of Information Technology", "Master of Business Administration", "Master of Professional Accounting", "Master of Data Science", "Master of Commerce",
    "Master of Engineering", "Master of Finance", "Juris Doctor", "Diploma", "Foundation studies"
  ];
  const LANGS = [
    ["English", "English"], ["Mandarin (Simplified Chinese)", "Mandarin · 简体中文"], ["Cantonese (Traditional Chinese)", "Cantonese · 繁體中文"], ["Hindi", "Hindi · हिन्दी"],
    ["Vietnamese", "Vietnamese · Tiếng Việt"], ["Korean", "Korean · 한국어"], ["Japanese", "Japanese · 日本語"], ["Indonesian", "Indonesian · Bahasa Indonesia"],
    ["Arabic", "Arabic · العربية"], ["Spanish", "Spanish · Español"], ["Thai", "Thai · ไทย"], ["Nepali", "Nepali · नेपाली"], ["Urdu", "Urdu · اردو"],
    ["Punjabi", "Punjabi · ਪੰਜਾਬੀ"], ["Malay", "Malay · Bahasa Melayu"]
  ];
  const langValue = v => LANGS.some(l => l[0] === v) ? v : "English";
  // parts: about (names), studies (uni, degree, year), prefs (language, heard)
  async function profileFields(root, p, opts = {}) {
    const parts = opts.parts || ["about", "studies", "prefs"];
    const has = k => parts.includes(k);
    root.innerHTML = `
      ${has("about") ? `<div class="two">
        <label class="field"><span>Full name</span><input type="text" id="pf-name" value="${esc(p.full_name || "")}" autocomplete="name"></label>
        <label class="field"><span>Display name</span><input type="text" id="pf-display" value="${esc(p.display_name || "")}" placeholder="e.g. Alex C." maxlength="30"><small>Shown next to your posts. Your full name and email aren't shown.</small></label>
      </div>` : ""}
      ${has("studies") ? `<div class="field"><span id="pf-uni-lbl">University</span><div id="pf-uni" data-label="pf-uni-lbl"></div></div>
      <div class="field"><span id="pf-degree-lbl">Degree</span><div id="pf-degree" data-label="pf-degree-lbl"></div><small>Can't find yours? Type it in the search box.</small></div>
      <div class="field"><span id="pf-year-lbl">Year of study</span><div id="pf-year" data-label="pf-year-lbl"></div></div>` : ""}
      ${has("bio") ? `<label class="field"><span>Short intro for students</span><textarea class="prose" id="pf-bio" maxlength="400" placeholder="What you're good at explaining.">${esc(p.bio || "")}</textarea></label>` : ""}
      ${has("prefs") ? `<div class="field"><span id="pf-lang-lbl">Language</span><div id="pf-lang" data-label="pf-lang-lbl" data-notr></div><small>The whole site switches to this language. Questions and answers written in other languages are translated into it, and you can always tap "Show original".</small></div>
      <label class="field"><span>How did you hear about us? (optional)</span><input type="text" id="pf-heard" value="${esc(p.heard_from || "")}" maxlength="80"></label>` : ""}`;
    let uniSel, degSel, yearSel, langSel;
    if (has("studies")) {
      uniSel = glassSelect($("#pf-uni", root), { options: uniOpts(), value: p.uni_id || null, placeholder: "Choose your university", search: "Search universities", hideSub: true });
      const degOpts = DEGREES.map(d => ({ value: d, label: d }));
      if (p.degree && !DEGREES.includes(p.degree)) degOpts.unshift({ value: p.degree, label: p.degree });
      degSel = glassSelect($("#pf-degree", root), { options: degOpts, value: p.degree || null, placeholder: "Choose your degree", search: "Search or type your degree", freeText: t => t.length >= 4, keepCase: true, freeTextLabel: "Use this degree", emptyText: "Keep typing to use your own degree name." });
      yearSel = glassSelect($("#pf-year", root), { options: YEARS.map(y => ({ value: y, label: y })), value: p.year_of_study || null, placeholder: "Choose" });
    }
    if (has("prefs")) langSel = glassSelect($("#pf-lang", root), { options: LANGS.map(([v, l]) => ({ value: v, label: l })), value: langValue(p.answer_language), search: "Search languages" });
    return () => {
      const v = {};
      if (has("about")) { v.full_name = $("#pf-name", root).value.trim(); v.display_name = $("#pf-display", root).value.trim(); }
      if (has("studies")) { v.uni_id = uniSel.value; v.degree = degSel.value; v.year_of_study = yearSel.value; }
      if (has("bio")) v.bio = $("#pf-bio", root).value.trim();
      if (has("prefs")) { v.answer_language = langSel.value; if ($("#pf-heard", root)) v.heard_from = $("#pf-heard", root).value.trim(); }
      return v;
    };
  }
  function checkProfile(v) {
    if ("full_name" in v && !v.full_name) return "Enter your full name.";
    if ("display_name" in v && !v.display_name) return "Enter a display name, such as your first name and last initial.";
    if ("uni_id" in v && !v.uni_id) return "Choose your university.";
    if ("degree" in v && !v.degree) return "Choose your degree.";
    if ("year_of_study" in v && !v.year_of_study) return "Choose your year of study.";
    return null;
  }
  async function saveProfile(v) {
    const { data, error } = await sb.from("profiles").update(v).eq("id", S.user.id).select().single();
    if (error) throw error;
    const langChanged = S.profile && langValue(S.profile.answer_language) !== langValue(data.answer_language);
    S.profile = data; renderHeader();
    if (langChanged && window.I18N) I18N.setLang(langValue(data.answer_language));
    return data;
  }

  /* Account set-up: three short steps */
  async function pageWelcome() {
    const p = S.profile;
    const W = { step: 1 };
    const STEPS = [["About you", ["about"], "This is the name other students see on your posts."], ["Your studies", ["studies"], "Your university is shown next to your posts and picked by default when you ask."], ["Preferences", ["prefs"], "Choose your language. The whole site is shown in it, and questions and answers written in other languages are translated for you."]];
    app().innerHTML = `<div class="medium"><div class="col">
      <div><span class="eyebrow">Welcome</span><h1 style="font-size:30px;margin-top:4px">Set up your account</h1></div>
      <div class="steps" id="steps"></div><div class="panel" id="body"></div>
      </div></div>`;
    async function render() {
      $("#steps").innerHTML = STEPS.map((s, i) => `<span class="${i + 1 === W.step ? "on" : i + 1 < W.step ? "done" : ""}">${i + 1}. ${s[0]}</span>`).join("");
      const [title, parts, sub] = STEPS[W.step - 1];
      $("#body").innerHTML = `<h2>${title}</h2><p class="muted" style="font-size:14px">${sub}</p><div id="fields" class="col"></div><div id="st" hidden></div>
        <div class="row" style="justify-content:space-between">${W.step > 1 ? '<button class="btn ghost" id="back">Back</button>' : "<span></span>"}<button class="btn primary" id="next">${W.step === STEPS.length ? "Finish" : "Continue"}</button></div>`;
      const cur = { ...p, ...S.profile, display_name: S.profile.display_name || suggestDisplay(S.profile.full_name) };
      const read = await profileFields($("#fields"), cur, { parts });
      if ($("#back")) $("#back").onclick = () => { W.step--; render(); };
      $("#next").onclick = async () => {
        const v = read(); const bad = checkProfile(v); if (bad) return status($("#st"), bad, "err");
        $("#next").disabled = true;
        try {
          const last = W.step === STEPS.length;
          await saveProfile(last ? { ...v, is_student: true, onboarded: true } : v);
          if (last) { return finished(); }
          else { W.step++; render(); }
        } catch (e) { status($("#st"), errMsg(e), "err"); $("#next").disabled = false; }
      };
      window.scrollTo(0, 0);
    }
    function finished() {
      const after = sessionStorage.getItem("after-welcome") || "/ask"; sessionStorage.removeItem("after-welcome");
      $("#steps").innerHTML = STEPS.map((s, i) => `<span class="done">${i + 1}. ${s[0]}</span>`).join("");
      $("#body").innerHTML = `<div class="pending-card"><span class="status-pill approved">Account ready</span>
        <h2 style="font-size:26px">You're all set, ${esc(displayName(S.profile))}</h2>
        <p class="muted">You can now ask and answer questions about any course. It's free.</p>
        <div class="row"><a class="btn primary" href="${esc(after)}">${after === "/ask" ? "Ask a question" : "Continue"}</a><a class="btn" href="/${S.profile.uni_id ? "?uni=" + encodeURIComponent(S.profile.uni_id) : ""}">Browse questions at your uni</a></div></div>`;

      window.scrollTo(0, 0);
    }
    render();
  }
  const suggestDisplay = n => { const w = String(n || "").trim().split(/\s+/); return w.length > 1 ? `${w[0]} ${w[w.length - 1][0]}.` : (w[0] || ""); };

  async function pageProfile() {
    const p = S.profile;
    app().innerHTML = `<div class="medium"><div class="panel"><div><span class="eyebrow">Account</span><h1 style="font-size:30px;margin-top:4px">Profile and settings</h1><p class="muted">${esc(S.user.email)}</p></div>
      <div id="fields" class="col"></div>
      <div id="st" hidden></div>
      <div class="row" style="justify-content:space-between"><button class="btn ghost" id="out">Sign out</button><button class="btn primary" id="save">Save changes</button></div></div></div>`;
    const read = await profileFields($("#fields"), p, { parts: ["about", "studies", "prefs"] });
    $("#out").onclick = async () => { await sb.auth.signOut(); go("/"); };
    $("#save").onclick = async () => {
      const v = read(); const bad = checkProfile(v); if (bad) return status($("#st"), bad, "err");
      try { await saveProfile({ ...v, is_student: true, onboarded: true }); status($("#st"), "Saved.", "ok"); } catch (e) { status($("#st"), errMsg(e), "err"); }
    };
  }

  /* ---------------- auto translation ---------------- */
  // Elements with data-tr inside a data-trg group are translated into the viewer's preferred language.
  const TR = new Map();
  const TR_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M2 3h7v1.5H7.4c-.3 1.6-1 3-2 4.1.6.5 1.3.9 2.1 1.2l-.5 1.4c-1-.4-1.9-.9-2.6-1.6-.8.7-1.8 1.2-2.9 1.6l-.5-1.4c.9-.3 1.7-.7 2.4-1.3-.6-.8-1.1-1.7-1.4-2.7h1.6c.2.6.5 1.2.9 1.7.6-.8 1.1-1.8 1.3-3H2V3zm9.3 3h1.5l3 8h-1.6l-.7-2h-3l-.7 2H8.3l3-8zm-.3 4.6h2l-1-2.9-1 2.9z"/></svg>';
  async function autoTranslate(root) {
    if (!root || !S.profile) return;
    const lang = langValue(S.profile.answer_language);
    const items = [];
    root.querySelectorAll("[data-trg]:not([data-trdone])").forEach(g => {
      g.dataset.trdone = "1";
      g.querySelectorAll("[data-tr]").forEach(el => {
        const orig = el.textContent;
        if (!orig.trim()) return;
        if (lang === "English" && !/[^\x00-\x7F\u2000-\u206F\u20A0-\u20CF]/.test(orig)) return; // plain English text: skip
        items.push({ el, g, orig });
      });
    });
    if (!items.length) return;
    const need = [...new Set(items.map(i => i.orig).filter(t => !TR.has(lang + "\u0000" + t)))];
    for (let i = 0; i < need.length; i += 20) {
      const batch = need.slice(i, i + 20);
      try {
        const { data, error } = await sb.functions.invoke("translate", { body: { texts: batch, target: lang } });
        if (error || !data || !data.results) break;
        batch.forEach((t, k) => TR.set(lang + "\u0000" + t, data.results[k]));
      } catch (e) { break; }
    }
    const groups = new Map();
    items.forEach(({ el, g, orig }) => {
      const r = TR.get(lang + "\u0000" + orig);
      if (!r || r.same || !r.translated) return;
      el.dataset.orig = orig; el.dataset.trans = r.translated; el.textContent = r.translated;
      groups.set(g, r.detected || "another language");
    });
    groups.forEach((from, g) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "tr-toggle";
      const label = shown => `${TR_ICON}<span>${shown ? `Translated from ${esc(from)} · Show original` : "Show translation"}</span>`;
      b.innerHTML = label(true); let translated = true;
      b.onclick = e => { e.preventDefault(); translated = !translated; g.querySelectorAll("[data-tr][data-orig]").forEach(el => el.textContent = translated ? el.dataset.trans : el.dataset.orig); b.innerHTML = label(translated); };
      (g.querySelector("[data-trslot]") || g).append(b);
    });
  }

  /* ---------------- forum: list, search and browse ---------------- */
  const forumUrl = f => {
    const q = new URLSearchParams();
    if (f.uni) q.set("uni", f.uni);
    if (f.uni && f.course) q.set("course", f.course);
    if (f.q) q.set("q", f.q);
    if (f.sort && f.sort !== "new") q.set("sort", f.sort);
    const s = q.toString();
    return "/" + (s ? "?" + s : "");
  };
  const SORTS = [["new", "Newest"], ["active", "Active"], ["top", "Top"], ["unanswered", "Unanswered"]];

  function postCard(p) {
    const done = !!p.accepted_reply;
    return `<a class="post-card" href="/p/${p.id}" data-trg>
      <div class="pc-stats" aria-hidden="true"><span><b>${p.score}</b>${p.score === 1 ? "vote" : "votes"}</span><span class="pc-ans${p.reply_count ? " has" : ""}${done ? " done" : ""}"><b>${p.reply_count}</b>${p.reply_count === 1 ? "answer" : "answers"}</span></div>
      <div class="pc-main">
        <div class="pc-tags"><span class="q-code" data-notr>${esc(p.course_code)}</span><span class="tagchip" data-notr>${esc(uniShort(p.uni_id))}</span>${done ? '<span class="best-chip">✓ Answered</span>' : ""}${p.removed ? '<span class="status-pill rejected">Removed</span>' : ""}</div>
        <h3 class="pc-title" data-tr>${esc(p.title)}</h3>
        <p class="pc-snip" data-tr>${esc(snippet(p.body, 180))}</p>
        <div class="pc-meta"><span data-notr>${esc(p.author_name || "Student")}</span> · ${ago(p.created_at)} · <span class="sr-only">${plural(p.score, "vote")}, ${plural(p.reply_count, "answer")}</span></div>
      </div></a>`;
  }

  async function pageForum() {
    const qs = new URLSearchParams(location.search);
    const F = { uni: S.uniMap[qs.get("uni")] ? qs.get("uni") : "", course: (qs.get("course") || "").toUpperCase().replace(/[^A-Z0-9]/g, ""), q: (qs.get("q") || "").trim().slice(0, 120), sort: SORTS.some(s => s[0] === qs.get("sort")) ? qs.get("sort") : "new" };
    if (!F.uni) F.course = "";
    const landing = !S.user && !F.uni && !F.q;
    const heading = F.course ? `<span data-notr>${esc(F.course)}</span> <span class="muted" style="font-weight:500">at ${esc(uniShort(F.uni))}</span>` : F.uni ? `<span data-notr>${esc(uniName(F.uni))}</span>` : F.q ? "Search results" : "All questions";
    app().innerHTML = `<section class="view forum">
      ${landing ? `<div class="forum-hero">
        <p class="tagline">Let's succeed as a generation.</p>
        <h1>Ask about any course. Get answers from students who've <em>done it</em>.</h1>
        <p class="muted">A free Q&amp;A forum for Australian uni students. Search questions by uni and course, or post your own. Anyone can answer.</p>
        <div class="cta-row"><a class="btn primary" href="/ask">Ask a question</a><a class="btn" href="/signup">Create a free account</a></div>
      </div>` : ""}
      <form class="filters" id="ff" role="search">
        <label class="search-box"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><input type="search" id="f-q" value="${esc(F.q)}" placeholder="Search questions, e.g. pointers, IRAC, normalisation" aria-label="Search questions" maxlength="120"></label>
        <div id="f-uni" class="f-sel" aria-label="University"></div>
        <div id="f-course" class="f-sel" aria-label="Course"></div>
        <button class="btn primary" id="f-go">Search</button>
      </form>
      <div class="forum-layout">
        <div class="col">
          <div class="results-head"><h1 class="forum-title">${heading}</h1>${(F.uni || F.q) ? `<a href="/" class="muted" style="font-size:14px">Clear filters</a>` : ""}</div>
          ${F.course ? `<p class="muted" id="course-title" style="margin-top:-8px"></p>` : ""}
          <div class="row" style="justify-content:space-between"><div class="seg sorts" role="radiogroup" aria-label="Sort">${SORTS.map(([v, l]) => `<label><input type="radio" name="sort" value="${v}" ${F.sort === v ? "checked" : ""}><span>${l}</span></label>`).join("")}</div><span class="muted" id="count" style="font-size:13px"></span></div>
          <div class="col" id="list"><div class="boot">Loading…</div></div>
          <div class="row" style="justify-content:center"><button class="btn" id="more" hidden>Load more</button></div>
        </div>
        <aside class="col forum-side" id="side"></aside>
      </div>
      ${landing ? FAQ : ""}
    </section>`;

    // Filters
    const apply = patch => go(forumUrl({ ...F, ...patch }));
    glassSelect($("#f-uni"), { options: [{ value: "", label: "All universities" }, ...uniOpts()], value: F.uni, placeholder: "All universities", search: "Search universities", hideSub: true, onChange: v => apply({ uni: v || "", course: "" }) });
    const courseList = await coursesFor(F.uni);
    const cOpts = [{ value: "", label: "All courses" }, ...courseOpts(courseList)];
    if (F.course && !courseList.some(c => c.code === F.course)) cOpts.push({ value: F.course, label: F.course });
    glassSelect($("#f-course"), { options: F.uni ? cOpts : [], value: F.uni ? F.course : null, placeholder: F.uni ? "All courses" : "Choose a uni first", search: "Search or type a course code", mono: true, freeText: c => !!F.uni && validCode(c), emptyText: F.uni ? "No matches. Type the full course code." : "Choose a university first.", hideSub: true, onChange: v => apply({ course: v || "" }) });
    if (F.course && $("#course-title")) { const c = courseList.find(x => x.code === F.course); $("#course-title").textContent = c && c.title ? c.title : ""; }
    $("#ff").onsubmit = e => { e.preventDefault(); apply({ q: $("#f-q").value.trim() }); };
    document.querySelectorAll('input[name="sort"]').forEach(r => r.onchange = () => apply({ sort: r.value }));

    // Results
    let off = 0;
    async function load() {
      let q = sb.from("forum_posts").select(POST_COLS, { count: "exact" }).eq("removed", false);
      if (F.uni) q = q.eq("uni_id", F.uni);
      if (F.course) q = q.eq("course_code", F.course);
      if (F.q) q = q.textSearch("search", F.q, { type: "websearch", config: "english" });
      if (F.sort === "unanswered") q = q.eq("reply_count", 0);
      q = F.sort === "top" ? q.order("score", { ascending: false }).order("created_at", { ascending: false })
        : F.sort === "active" ? q.order("last_activity", { ascending: false })
          : q.order("created_at", { ascending: false });
      const { data, count, error } = await q.range(off, off + PAGE - 1);
      if (error) { $("#list").innerHTML = `<div class="status err">${esc(errMsg(error))}</div>`; return; }
      if (!off) $("#list").innerHTML = "";
      $("#list").insertAdjacentHTML("beforeend", data.map(postCard).join(""));
      if (!off && !data.length) {
        $("#list").innerHTML = `<div class="empty empty-cta"><b>${F.q ? "No questions match that search." : F.course ? `No questions in ${esc(F.course)} yet.` : F.uni ? `No questions at ${esc(uniShort(F.uni))} yet.` : "No questions yet."}</b><span>Be the first to ask. Someone who's done the course can answer.</span><a class="btn primary" href="/ask${F.uni ? `?uni=${encodeURIComponent(F.uni)}${F.course ? `&course=${encodeURIComponent(F.course)}` : ""}` : ""}">Ask a question</a></div>`;
      }
      off += data.length;
      $("#count").textContent = count ? plural(count, "question") : "";
      $("#more").hidden = off >= (count || 0);
      autoTranslate($("#list"));
    }
    $("#more").onclick = async () => { $("#more").disabled = true; await load(); $("#more").disabled = false; };
    await load();
    renderSide(F);
  }

  async function renderSide(F) {
    const side = $("#side"); if (!side) return;
    const rules = `<div class="panel side-rules"><h3>Forum rules</h3><ul>
      <li>Ask to understand: concepts, course content, how to study, what a unit is like.</li>
      <li>Don't post questions from an assignment, quiz or exam that's still open, and don't share full solutions.</li>
      <li>Be kind, and keep personal details out of posts.</li></ul></div>`;
    if (F.uni) {
      const { data } = await sb.rpc("forum_courses", { p_uni: F.uni });
      side.innerHTML = `<div class="panel side-list"><h3>Courses at <span data-notr>${esc(uniShort(F.uni))}</span></h3>${data && data.length ? `<ul>${data.map(c => `<li><a href="${forumUrl({ uni: F.uni, course: c.course_code })}" ${c.course_code === F.course ? 'aria-current="page"' : ""}><span class="mono" data-notr>${esc(c.course_code)}</span><span class="side-sub">${esc(c.title || "")}</span><b>${c.posts}</b></a></li>`).join("")}</ul>` : `<p class="muted" style="font-size:14px">No questions here yet.</p>`}</div>${rules}`;
    } else {
      const { data } = await sb.rpc("forum_unis");
      side.innerHTML = `<div class="panel side-list"><h3>Browse by university</h3>${data && data.length ? `<ul>${data.map(u => `<li><a href="${forumUrl({ uni: u.uni_id })}"><span data-notr>${esc(uniName(u.uni_id))}</span><b>${u.posts}</b></a></li>`).join("")}</ul>` : `<p class="muted" style="font-size:14px">No questions yet.</p>`}<p class="muted" style="font-size:13px">Or pick any university in the filter above.</p></div>${rules}`;
    }
  }

  const FAQ = `<div class="faq"><h2>Common questions</h2>
    <details class="faq-item"><summary>Is it free?</summary><p>Yes. Reading is open to everyone, and posting questions and answers is free with an account.</p></details>
    <details class="faq-item"><summary>Who answers?</summary><p>Any student with an account. Upvotes show which answers other students found useful, and whoever asked can mark the best answer. Answers come from students, so check anything important against your course materials.</p></details>
    <details class="faq-item"><summary>Can I post my assignment question?</summary><p>No. Distinction is for understanding a topic, not getting answers to hand in. Don't post questions from an assignment, quiz or exam that's still open, and don't share full solutions. Posts that break this rule are removed, and every post is public. Always follow your university's academic integrity rules.</p></details>
    <details class="faq-item"><summary>What's shown about me?</summary><p>Your display name and university appear next to your posts. Your email and full name aren't shown.</p></details>
    <details class="faq-item"><summary>Can I read and post in another language?</summary><p>Yes. Choose your language in your profile and the site switches to it. Posts written in other languages are translated for you automatically, with a Show original button.</p></details>
  </div>`;

  /* ---------------- a single post and its answers ---------------- */
  const voteBtn = (kind, id, score, on, own) => `<button type="button" class="vote-btn${on ? " on" : ""}" data-vote="${kind}:${id}" aria-pressed="${on}" ${own ? 'disabled title="You can\'t upvote your own post"' : ""} aria-label="Upvote, ${score} so far"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2l4.5 6h-9z" fill="currentColor"/></svg><b>${score}</b></button>`;

  async function pagePost(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id || "")) { app().innerHTML = `<div class="empty">Post not found. <a href="/">Back to the forum</a></div>`; return; }
    const [{ data: p, error }, { data: reps }] = await Promise.all([
      sb.from("forum_posts").select("*").eq("id", id).maybeSingle(),
      sb.from("forum_replies").select("*").eq("post_id", id).order("created_at")
    ]);
    if (error) throw error;
    if (!p) { app().innerHTML = `<div class="empty">This post doesn't exist or has been removed. <a href="/">Back to the forum</a></div>`; return; }
    const me = S.user && S.user.id, admin = !!(S.profile && S.profile.is_admin), mine = p.author_id === me;
    const replies = (reps || []).sort((a, b) => (b.id === p.accepted_reply) - (a.id === p.accepted_reply) || b.score - a.score || new Date(a.created_at) - new Date(b.created_at));
    const voted = new Set();
    if (me) {
      const ids = replies.map(r => r.id);
      const { data: v } = await sb.from("forum_votes").select("post_id,reply_id").eq("user_id", me).or(`post_id.eq.${id}${ids.length ? `,reply_id.in.(${ids.join(",")})` : ""}`);
      (v || []).forEach(x => voted.add(x.post_id || x.reply_id));
    }
    document.title = `${p.course_code}: ${p.title} · Distinction`;
    const back = forumUrl({ uni: p.uni_id, course: p.course_code });
    const tools = (kind, row) => {
      const own = row.author_id === me, out = [];
      if (own) out.push(`<button type="button" class="link-btn" data-edit="${kind}:${row.id}">Edit</button>`, `<button type="button" class="link-btn" data-del="${kind}:${row.id}">Delete</button>`);
      if (!own) out.push(`<button type="button" class="link-btn" data-report="${kind}:${row.id}">Report</button>`);
      if (admin) out.push(`<button type="button" class="link-btn danger" data-mod="${kind}:${row.id}:${row.removed ? 0 : 1}">${row.removed ? "Restore" : "Remove"}</button>`);
      return out.join("");
    };
    app().innerHTML = `<div class="medium post-page">
      <a href="${back}" class="back-link">← <span data-notr>${esc(p.course_code)}</span> at <span data-notr>${esc(uniShort(p.uni_id))}</span></a>
      <article class="panel post-full" data-trg>
        ${p.removed ? `<div class="status err">This post has been removed by a moderator${mine ? ", so only you can see it" : ""}.</div>` : ""}
        <div class="pc-tags"><a class="q-code" href="${back}" data-notr>${esc(p.course_code)}</a><a class="tagchip" href="${forumUrl({ uni: p.uni_id })}" data-notr>${esc(uniShort(p.uni_id))}</a></div>
        <h1 class="post-title" data-tr>${esc(p.title)}</h1>
        <div class="pc-meta">Asked by <b data-notr>${esc(p.author_name || "Student")}</b>${p.author_uni ? ` <span data-notr>(${esc(uniShort(p.author_uni))})</span>` : ""} · ${ago(p.created_at)}${p.edited_at ? " · edited" : ""}</div>
        <div class="post-body" data-tr>${richText(p.body)}</div>
        <div class="post-actions" data-trslot>${voteBtn("post", p.id, p.score, voted.has(p.id), mine)}<span class="tools">${me ? tools("post", p) : ""}</span></div>
      </article>
      <h2 class="ans-count">${replies.length ? plural(replies.length, "answer") : "No answers yet"}</h2>
      <div class="col" id="replies">${replies.map(r => {
        const best = r.id === p.accepted_reply;
        return `<div class="reply${best ? " best" : ""}${r.removed ? " removed" : ""}" id="r-${r.id}" data-trg>
          ${best ? '<span class="best-chip">✓ Best answer</span>' : ""}${r.removed ? '<span class="status-pill rejected">Removed</span>' : ""}
          <div class="post-body" data-tr>${richText(r.body)}</div>
          <div class="reply-foot" data-trslot>${voteBtn("reply", r.id, r.score, voted.has(r.id), r.author_id === me)}
            <span class="pc-meta"><b data-notr>${esc(r.author_name || "Student")}</b>${r.author_uni ? ` <span data-notr>(${esc(uniShort(r.author_uni))})</span>` : ""} · ${ago(r.created_at)}${r.edited_at ? " · edited" : ""}</span>
            <span class="tools">${mine && !r.removed ? `<button type="button" class="link-btn strong" data-best="${best ? "" : r.id}">${best ? "Unmark best answer" : "Mark as best answer"}</button>` : ""}${me ? tools("reply", r) : ""}</span></div>
        </div>`;
      }).join("")}</div>
      <div class="panel composer-box" id="compose"></div>
    </div>`;

    // Reply box
    const box = $("#compose");
    if (p.removed) box.remove();
    else if (S.user && !(S.profile && S.profile.onboarded)) box.innerHTML = `<h3>Know the answer?</h3><p class="muted" style="font-size:14px">Finish setting up your account to answer. It takes a minute.</p><div class="row"><a class="btn primary" href="/welcome" id="to-welcome">Finish setting up</a></div>`;
    else if (!S.user) box.innerHTML = `<h3>Know the answer?</h3><p class="muted" style="font-size:14px">Log in or create a free account to answer.</p><div class="row"><a class="btn primary" href="/signup" data-after>Sign up</a><a class="btn" href="/login" data-after>Log in</a></div>`;
    else {
      box.innerHTML = `<h3>Your answer</h3>
        <textarea class="prose" id="rp" maxlength="${REPLY_MAX}" placeholder="Explain it the way you'd want it explained. Point to the lecture, week or textbook section if you can."></textarea>
        <div class="row" style="justify-content:space-between"><small class="muted">Explain the idea. Don't post full solutions to assessment tasks. <span id="rp-n" class="mono"></span></small><button class="btn primary" id="rp-go">Post answer</button></div><div id="rp-st" hidden></div>`;
      const ta = $("#rp"), n = () => $("#rp-n").textContent = ta.value.length > REPLY_MAX - 300 ? `${ta.value.length}/${REPLY_MAX}` : "";
      ta.oninput = n;
      $("#rp-go").onclick = async () => {
        const body = ta.value.trim();
        if (body.length < 2) return status($("#rp-st"), "Write your answer first.", "err");
        $("#rp-go").disabled = true;
        const { data, error } = await sb.from("forum_replies").insert({ post_id: p.id, author_id: me, body }).select("id").single();
        $("#rp-go").disabled = false;
        if (error) return status($("#rp-st"), errMsg(error), "err");
        track("post_answer", { course: p.course_code });
        toast("Answer posted");
        await pagePost(p.id);
        const el = $("#r-" + data.id); if (el) el.scrollIntoView({ block: "center" });
      };
    }
    if ($("#to-welcome")) $("#to-welcome").addEventListener("click", () => sessionStorage.setItem("after-welcome", location.pathname));
    box && box.querySelectorAll("[data-after]").forEach(a => a.addEventListener("click", () => sessionStorage.setItem("after-login", location.pathname)));

    // Actions
    const reload = () => pagePost(p.id);
    const findRow = (kind, rid) => kind === "post" ? p : replies.find(r => r.id === rid);
    app().querySelector(".post-page").onclick = async e => {
      const t = e.target.closest("[data-vote],[data-edit],[data-del],[data-report],[data-mod],[data-best]"); if (!t) return;
      if (t.dataset.vote) {
        if (!S.user) return needLogin("upvote");
        const [kind, rid] = t.dataset.vote.split(":"), on = t.getAttribute("aria-pressed") === "true", col = kind === "post" ? "post_id" : "reply_id";
        const b = t.querySelector("b"); t.disabled = true;
        const { error } = on ? await sb.from("forum_votes").delete().eq("user_id", me).eq(col, rid) : await sb.from("forum_votes").insert({ [col]: rid, user_id: me });
        t.disabled = false;
        if (error) return toast(errMsg(error));
        t.classList.toggle("on", !on); t.setAttribute("aria-pressed", String(!on)); b.textContent = Math.max(0, +b.textContent + (on ? -1 : 1));
        return;
      }
      if (t.dataset.best !== undefined) {
        const { error } = await sb.from("forum_posts").update({ accepted_reply: t.dataset.best || null }).eq("id", p.id);
        if (error) return toast(errMsg(error));
        toast(t.dataset.best ? "Marked as the best answer" : "Best answer unmarked"); return reload();
      }
      if (t.dataset.edit) {
        const [kind, rid] = t.dataset.edit.split(":"), row = findRow(kind, rid);
        return openModal(`<h3>Edit your ${kind === "post" ? "question" : "answer"}</h3>
          ${kind === "post" ? `<label class="field"><span>Title</span><input type="text" id="ed-t" maxlength="${TITLE_MAX}" value="${esc(row.title)}"></label>` : ""}
          <label class="field"><span>${kind === "post" ? "Details" : "Answer"}</span><textarea class="prose" id="ed-b" maxlength="${kind === "post" ? BODY_MAX : REPLY_MAX}" style="min-height:180px">${esc(row.body)}</textarea></label>
          <div id="ed-st" hidden></div><div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="ed-go">Save</button></div>`, m => {
          $("#ed-go", m).onclick = async () => {
            const body = $("#ed-b", m).value.trim(), patch = { body };
            if (kind === "post") { patch.title = $("#ed-t", m).value.trim(); if (patch.title.length < TITLE_MIN) return status($("#ed-st", m), `Make the title at least ${TITLE_MIN} characters.`, "err"); if (body.length < BODY_MIN) return status($("#ed-st", m), `Add a bit more detail (at least ${BODY_MIN} characters).`, "err"); }
            else if (body.length < 2) return status($("#ed-st", m), "The answer can't be empty.", "err");
            const { error } = await sb.from(kind === "post" ? "forum_posts" : "forum_replies").update(patch).eq("id", rid);
            if (error) return status($("#ed-st", m), errMsg(error), "err");
            closeModal(); toast("Saved"); reload();
          };
        });
      }
      if (t.dataset.del) {
        const [kind, rid] = t.dataset.del.split(":");
        return openModal(`<h3>Delete this ${kind === "post" ? "question" : "answer"}?</h3><p class="muted" style="font-size:14px">${kind === "post" ? "The question and all its answers will be deleted for good." : "Your answer will be deleted for good."}</p><div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="del-go">Delete</button></div>`, m => {
          $("#del-go", m).onclick = async () => {
            const { error } = await sb.from(kind === "post" ? "forum_posts" : "forum_replies").delete().eq("id", rid);
            if (error) return toast(errMsg(error));
            closeModal(); toast("Deleted"); kind === "post" ? go(back) : reload();
          };
        });
      }
      if (t.dataset.report) {
        if (!S.user) return needLogin("report");
        const [kind, rid] = t.dataset.report.split(":");
        return openModal(`<h3>Report this ${kind === "post" ? "question" : "answer"}</h3><p class="muted" style="font-size:14px">A moderator will take a look. Reports are anonymous.</p>
          <div class="col" style="gap:8px">${REPORT_REASONS.map(([v, l], i) => `<label class="check"><input type="radio" name="rr" value="${v}" ${i ? "" : "checked"}> ${l}</label>`).join("")}</div>
          <label class="field"><span>Anything else? (optional)</span><textarea class="prose" id="rr-note" maxlength="500" style="min-height:70px"></textarea></label>
          <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="rr-go">Send report</button></div>`, m => {
          $("#rr-go", m).onclick = async () => {
            const reason = m.querySelector('input[name="rr"]:checked').value;
            const { error } = await sb.from("forum_reports").insert({ [kind === "post" ? "post_id" : "reply_id"]: rid, reason, note: $("#rr-note", m).value.trim() || null, reporter_id: me });
            closeModal();
            if (error) return toast(/duplicate/i.test(error.message) ? "You've already reported this. Thanks." : errMsg(error));
            toast("Thanks. A moderator will review it.");
          };
        });
      }
      if (t.dataset.mod) {
        const [kind, rid, rm] = t.dataset.mod.split(":");
        const { error } = await sb.from(kind === "post" ? "forum_posts" : "forum_replies").update({ removed: rm === "1" }).eq("id", rid);
        if (error) return toast(errMsg(error));
        toast(rm === "1" ? "Removed" : "Restored"); reload();
      }
    };
    autoTranslate(app());
  }

  /* ---------------- ask a question ---------------- */
  async function pageAsk() {
    const p = S.profile, qs = new URLSearchParams(location.search);
    const startUni = S.uniMap[qs.get("uni")] ? qs.get("uni") : (p.uni_id || null);
    app().innerHTML = `<div class="medium"><div class="panel ask-panel">
      <div><span class="eyebrow">New question</span><h1 style="font-size:30px;margin-top:4px">Ask the forum</h1><p class="muted" style="margin-top:6px">Your question is public, so anyone searching for your course can find it and answer.</p></div>
      <div class="two"><div class="field"><span id="a-uni-lbl">University</span><div id="a-uni" data-label="a-uni-lbl"></div></div>
      <div class="field"><span id="a-course-lbl">Course</span><div id="a-course" data-label="a-course-lbl"></div><small>Can't find it? Type the course code.</small></div></div>
      <label class="field"><span>Title</span><input type="text" id="a-title" maxlength="${TITLE_MAX}" placeholder="e.g. Why does my linked list lose the last node when I free it?"><small><span>Sum up your question in one line.</span> <span class="mono" id="a-title-n"></span></small></label>
      <label class="field"><span>Details</span><textarea class="prose" id="a-body" maxlength="${BODY_MAX}" style="min-height:180px" placeholder="What are you stuck on, what have you tried, and which week or topic is it from?"></textarea><small><span>At least ${BODY_MIN} characters.</span> <span class="mono" id="a-body-n"></span></small></label>
      <div class="rules-box"><b>Before you post</b><ul><li>Ask to understand: a concept, course content, how to approach a topic, or what a course is like.</li><li>Don't post questions from an assignment, quiz or exam that's still open, and don't ask for full solutions.</li><li>Posts are public. Leave out personal details like your student number.</li></ul></div>
      <label class="check"><input type="checkbox" id="a-ok"> This isn't from an assessment that's still open, and I'm asking to understand it, not for answers to hand in.</label>
      <div id="st" hidden></div>
      <div class="row" style="justify-content:flex-end"><a class="btn ghost" href="/">Cancel</a><button class="btn primary" id="a-go">Post question</button></div>
    </div></div>`;
    const courseSel = glassSelect($("#a-course"), { options: [], value: null, mono: true, placeholder: "Choose a course", search: "Type a course code or name, e.g. COMP", freeText: validCode, minQuery: 3, minText: "Type at least 3 letters of the course code or name, e.g. COMP or Accounting", emptyText: "No matches. Type the full course code to use it." });
    const fill = async (uni, code) => {
      const opts = courseOpts(await coursesFor(uni));
      if (code && validCode(code) && !opts.some(o => o.value === code)) opts.unshift({ value: code, label: code });
      courseSel.setOptions(opts, code && validCode(code) ? code : null);
    };
    const uniSel = glassSelect($("#a-uni"), { options: uniOpts(), value: startUni, placeholder: "Choose a university", search: "Search universities", hideSub: true, onChange: v => fill(v, null) });
    await fill(startUni, (qs.get("course") || "").toUpperCase().replace(/[^A-Z0-9]/g, "") || null);
    const cnt = (id, max) => { const el = $("#" + id), out = $("#" + id + "-n"); el.oninput = () => out.textContent = `${el.value.length}/${max}`; };
    cnt("a-title", TITLE_MAX); cnt("a-body", BODY_MAX);
    $("#a-go").onclick = async () => {
      const uni = uniSel.value, code = (courseSel.value || "").toUpperCase(), title = $("#a-title").value.trim(), body = $("#a-body").value.trim(), st = $("#st");
      if (!uni) return status(st, "Choose your university.", "err");
      if (!validCode(code)) return status(st, "Choose your course, or type its code (like COMP1511).", "err");
      if (title.length < TITLE_MIN) return status(st, `Write a title of at least ${TITLE_MIN} characters.`, "err");
      if (body.length < BODY_MIN) return status(st, `Add a bit more detail so people know what you're stuck on (at least ${BODY_MIN} characters).`, "err");
      if (!$("#a-ok").checked) return status(st, "Tick the box to confirm this isn't from an open assessment.", "err");
      $("#a-go").disabled = true; status(st, "Posting…", "", true);
      const { data, error } = await sb.from("forum_posts").insert({ uni_id: uni, course_code: code, title, body, author_id: S.user.id }).select("id").single();
      $("#a-go").disabled = false;
      if (error) return status(st, errMsg(error), "err");
      S.courses[uni] = null;
      track("post_question", { course: code, uni });
      toast("Question posted"); go("/p/" + data.id);
    };
  }

  /* ---------------- my posts ---------------- */
  async function pageMine() {
    const tab = new URLSearchParams(location.search).get("tab") === "answers" ? "answers" : "questions";
    app().innerHTML = `<section class="view"><div class="results-head"><h1 style="font-size:30px">My posts</h1><a class="btn primary" href="/ask">Ask a question</a></div>
      <div class="seg" style="max-width:320px"><label><input type="radio" name="mt" value="questions" ${tab === "questions" ? "checked" : ""}><span>My questions</span></label><label><input type="radio" name="mt" value="answers" ${tab === "answers" ? "checked" : ""}><span>My answers</span></label></div>
      <div class="col" id="mine"><div class="boot">Loading…</div></div></section>`;
    document.querySelectorAll('input[name="mt"]').forEach(r => r.onchange = () => go("/my" + (r.value === "answers" ? "?tab=answers" : ""), true));
    const el = $("#mine");
    if (tab === "questions") {
      const { data, error } = await sb.from("forum_posts").select(POST_COLS).eq("author_id", S.user.id).order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      el.innerHTML = data.length ? data.map(postCard).join("") : `<div class="empty empty-cta"><b>You haven't asked anything yet.</b><a class="btn primary" href="/ask">Ask a question</a></div>`;
    } else {
      const { data, error } = await sb.from("forum_replies").select("id,body,score,removed,created_at,post:forum_posts(id,title,course_code,uni_id,accepted_reply)").eq("author_id", S.user.id).order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      el.innerHTML = data.length ? data.map(r => `<a class="post-card" href="/p/${r.post ? r.post.id : ""}#r-${r.id}"><div class="pc-stats" aria-hidden="true"><span><b>${r.score}</b>${r.score === 1 ? "vote" : "votes"}</span></div><div class="pc-main">
        <div class="pc-tags">${r.post ? `<span class="q-code" data-notr>${esc(r.post.course_code)}</span><span class="tagchip" data-notr>${esc(uniShort(r.post.uni_id))}</span>` : ""}${r.post && r.post.accepted_reply === r.id ? '<span class="best-chip">✓ Best answer</span>' : ""}${r.removed ? '<span class="status-pill rejected">Removed</span>' : ""}</div>
        <h3 class="pc-title">${esc(r.post ? r.post.title : "Deleted question")}</h3><p class="pc-snip">${esc(snippet(r.body, 180))}</p><div class="pc-meta">Answered ${ago(r.created_at)}</div></div></a>`).join("") : `<div class="empty empty-cta"><b>You haven't answered anything yet.</b><span>Browse questions in the courses you've done.</span><a class="btn primary" href="/${S.profile.uni_id ? "?uni=" + encodeURIComponent(S.profile.uni_id) : ""}">Browse the forum</a></div>`;
    }
  }

  /* ---------------- admin ---------------- */
  async function pageAdmin() {
    if (!S.profile.is_admin) { app().innerHTML = `<div class="empty">Admins only.</div>`; return; }
    app().innerHTML = `<section class="view"><div class="results-head"><h1 style="font-size:30px">Admin</h1><div class="seg" style="min-width:320px"><label><input type="radio" name="ad" value="open" checked><span>Reports</span></label><label><input type="radio" name="ad" value="done"><span>Resolved</span></label><label><input type="radio" name="ad" value="pay"><span>Old payouts</span></label></div></div><div id="ad-body" class="col"></div></section>`;
    document.querySelectorAll('input[name="ad"]').forEach(r => r.onchange = () => r.value === "pay" ? adminPayouts() : adminReports(r.value === "done"));
    adminReports(false);
  }
  async function adminReports(resolved) {
    const body = $("#ad-body");
    body.innerHTML = `<div class="boot">Loading…</div>`;
    const { data, error } = await sb.from("forum_reports").select("*, post:forum_posts(id,title,body,removed,author_name), reply:forum_replies(id,body,removed,post_id,author_name)").eq("resolved", resolved).order("created_at", { ascending: false }).limit(100);
    if (error) { body.innerHTML = `<div class="status err">${esc(errMsg(error))}</div>`; return; }
    const label = v => (REPORT_REASONS.find(r => r[0] === v) || [, v])[1];
    body.innerHTML = data.length ? data.map(r => {
      const item = r.post || r.reply, kind = r.post ? "post" : "reply", link = r.post ? `/p/${r.post.id}` : r.reply ? `/p/${r.reply.post_id}#r-${r.reply.id}` : "";
      return `<div class="panel" style="gap:10px"><div class="row" style="justify-content:space-between"><b>${esc(label(r.reason))}</b><span class="muted" style="font-size:12px">${ago(r.created_at)}</span></div>
        ${r.note ? `<p class="muted" style="font-size:14px">“${esc(r.note)}”</p>` : ""}
        ${item ? `<div class="reply"><b>${kind === "post" ? esc(r.post.title) : "Answer"}</b> <span class="muted" style="font-size:13px">by ${esc(item.author_name || "Student")}</span>${item.removed ? ' <span class="status-pill rejected">Removed</span>' : ""}<div class="post-body">${esc(snippet(item.body, 500))}</div></div>` : `<p class="muted">The content was deleted.</p>`}
        <div class="row" style="justify-content:flex-end">${link ? `<a class="btn sm ghost" href="${link}">Open</a>` : ""}${item && !item.removed ? `<button class="btn sm" data-rm="${kind}:${item.id}:${r.id}">Remove and resolve</button>` : ""}${resolved ? "" : `<button class="btn sm primary" data-ok="${r.id}">Dismiss</button>`}</div></div>`;
    }).join("") : `<div class="empty">${resolved ? "No resolved reports." : "No reports to review."}</div>`;
    body.onclick = async e => {
      const rm = e.target.closest("[data-rm]"), ok = e.target.closest("[data-ok]");
      if (rm) {
        const [kind, id, rid] = rm.dataset.rm.split(":");
        const { error } = await sb.from(kind === "post" ? "forum_posts" : "forum_replies").update({ removed: true }).eq("id", id);
        if (error) return toast(errMsg(error));
        await sb.from("forum_reports").update({ resolved: true }).eq(kind === "post" ? "post_id" : "reply_id", id);
        toast("Removed"); adminReports(resolved);
      }
      if (ok) {
        const { error } = await sb.from("forum_reports").update({ resolved: true }).eq("id", ok.dataset.ok);
        if (error) return toast(errMsg(error));
        toast("Dismissed"); adminReports(resolved);
      }
    };
  }
  async function adminPayouts() {
    const body = $("#ad-body");
    const { data, error } = await sb.from("payout_requests").select("*, tutor:profiles!payout_requests_tutor_id_fkey(full_name, display_name, uni_id)").order("status").order("created_at", { ascending: false }).limit(100);
    if (error) { body.innerHTML = `<div class="status err">${esc(errMsg(error))}</div>`; return; }
    const pend = data.filter(r => r.status === "pending");
    body.innerHTML = `<p class="muted" style="font-size:14px">${pend.length ? `${pend.length} to pay · ${money(pend.reduce((a, r) => a + Number(r.amount), 0))} total. Pay each one by PayID from your banking app, check the name matches, then mark it paid.` : "Nothing to pay right now."}</p>` +
      (data.length ? `<div class="col">${data.map(r => `<div class="answer-card"><div class="row" style="justify-content:space-between"><span><b>${esc(r.tutor ? r.tutor.full_name || r.tutor.display_name : "Student")}</b> <span class="muted">${esc(uniShort(r.tutor && r.tutor.uni_id))} · ${ago(r.created_at)}</span></span><span class="status-pill ${r.status === "paid" ? "approved" : r.status === "rejected" ? "rejected" : "pending"}">${r.status === "pending" ? "To pay" : r.status === "paid" ? "Paid" : "Rejected"}</span></div>
        <dl class="kv"><dt>Amount</dt><dd><b>${money(Number(r.amount))}</b></dd><dt>PayID</dt><dd>${esc(r.payid)}</dd><dt>Name</dt><dd>${esc(r.payid_name)}</dd><dt>Reference</dt><dd>Distinction ${esc(r.id.slice(0, 8))}</dd></dl>
        ${r.status === "pending" ? `<div class="row" style="justify-content:flex-end"><button class="btn sm" data-pay="${r.id}:0">Reject</button><button class="btn primary sm" data-pay="${r.id}:1">Mark as paid</button></div>` : ""}</div>`).join("")}</div>` : "");
    body.onclick = async e => {
      const b = e.target.closest("[data-pay]"); if (!b) return;
      const [id, paid] = b.dataset.pay.split(":");
      const go = async note => {
        const { error } = await sb.rpc("admin_mark_payout", { p_id: id, p_paid: paid === "1", p_note: note });
        if (error) return toast(errMsg(error));
        closeModal(); toast(paid === "1" ? "Marked as paid" : "Request rejected. The amount is back in their balance."); adminPayouts();
      };
      if (paid === "1") return openModal(`<h3>Mark as paid?</h3><p class="muted" style="font-size:14px">Only do this once the PayID transfer has gone through.</p><div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="pm-go">Mark as paid</button></div>`, m => { $("#pm-go", m).onclick = () => go(null); });
      openModal(`<h3>Reject this withdrawal?</h3><label class="field"><span>Reason (shown to them)</span><textarea class="prose" id="pm-note" maxlength="300" style="min-height:70px" placeholder="For example: the PayID name didn't match"></textarea></label><div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="pm-go">Reject</button></div>`, m => { $("#pm-go", m).onclick = () => go($("#pm-note", m).value.trim() || null); });
    };
  }


  /* ---------------- boot ---------------- */
  async function boot() {
    if (window.I18N) { I18N.start(sb); I18N.setLang(I18N.initialLang()); }
    const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
    const clearSaved = () => { try { Object.keys(localStorage).filter(k => /^sb-.*-auth-token/.test(k)).forEach(k => localStorage.removeItem(k)); } catch (_) { } };
    try { await timeout(loadUnis(), 10000); }
    catch (e) {
      // A stuck saved login blocks every request; clear it and reload once
      if (e.message === "timeout" && !sessionStorage.getItem("boot-reset")) { sessionStorage.setItem("boot-reset", "1"); clearSaved(); location.reload(); return; }
      app().innerHTML = `<div class="status err">Couldn't connect to the database. ${esc(errMsg(e))} <button class="btn sm" onclick="location.reload()">Try again</button></div>`; return;
    }
    sessionStorage.removeItem("boot-reset");
    try {
      const { data: { session } } = await timeout(sb.auth.getSession(), 8000);
      S.session = session; S.user = session ? session.user : null;
      await timeout(loadProfile(), 8000);
    } catch (e) {
      // A stuck saved login: clear it and carry on signed out
      console.warn("Session check failed, signing out locally", e);
      clearSaved();
      S.session = null; S.user = null; S.profile = null;
    }
    // Google sign-ups: carry the role picked before redirect
    localStorage.removeItem("intended-role");
    if (/access_token|error_description|type=recovery/.test(location.hash)) history.replaceState(null, "", location.pathname);
    fromHash();
    S.ready = true;
    const after = sessionStorage.getItem("after-login");
    if (S.user && after) { sessionStorage.removeItem("after-login"); go(after); }
    route();
    // Supabase deadlocks if its own methods are awaited inside this callback, so defer the work
    sb.auth.onAuthStateChange((event, session) => { setTimeout(() => onAuth(event, session), 0); });
    async function onAuth(event, session) {
      const prevUser = S.user && S.user.id;
      S.session = session; S.user = session ? session.user : null;
      if (event === "PASSWORD_RECOVERY") { go("/new-password"); return; }
      if ((S.user && S.user.id) !== prevUser) {
        await loadProfile();
        if (event === "SIGNED_IN") { const a = sessionStorage.getItem("after-login"); sessionStorage.removeItem("after-login"); if (a && a !== curPath()) { go(a); return; } if (["/login", "/signup", "/"].includes(curPath()) || curPath().startsWith("/signup")) { go("/"); return; } }
        route();
      }
    }
  }
  boot();
})();
