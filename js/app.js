/* Distinction: app logic (Supabase auth, routing and pages) */
(function () {
  const { $, $$, esc, money, words, initials, kb, ago, left, mins, gradeFor, gcls, stars, toast, status, openModal, closeModal, glassSelect, chipsInput } = UI;
  const cfg = window.DISTINCTION_CONFIG;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" } });
  window.sb = sb;

  const WORD_LIMIT = 50, MAX_FILE = 5 * 1024 * 1024, CLAIM_MIN = 2, URGENT_MIN = 20, PAY = 1.10, URGENT_PAY = 1.70;
  const FILE_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
  const YEARS = ["1st year", "2nd year", "3rd year", "4th year", "5th year or later", "Postgraduate"];
  const DURS = [{ value: "1", label: "1 hour" }, { value: "3", label: "3 hours" }, { value: "6", label: "6 hours" }, { value: "12", label: "12 hours" }, { value: "24", label: "1 day", sub: "Most answers" }];
  // "What are you after?" on the Ask page
  const GOALS = [
    { v: "answer", label: "Answers", hint: "Just the answer, quickly" },
    { v: "explanation", label: "Explanation", hint: "Walk me through why it works" },
    { v: "expertise", label: "Expertise", hint: "Deeper know-how on the topic" },
    { v: "experience", label: "Experience", hint: "How you studied it, what the exam or assignment was like" },
    { v: "check_work", label: "Check my work", hint: "Look over my working or draft and point out mistakes" },
    { v: "course_specific", label: "Course-specific", hint: "Only tutors from my uni, in this course or a very close one" },
  ];
  const goalLabel = v => (GOALS.find(g => g.v === v) || {}).label || v;
  const goalChips = gs => (gs || []).map(v => `<span class="goalchip${v === "course_specific" ? " uni" : ""}">${esc(goalLabel(v))}</span>`).join("");
  const validCode = c => /^[A-Z0-9]{3,12}$/.test(c || "") && /\d{3}/.test(c || "");

  const S = { names: {}, session: null, user: null, profile: null, unis: [], uniMap: {}, courses: {}, timers: [], ready: false };

  /* ---------------- data ---------------- */
  async function loadUnis() {
    const { data, error } = await sb.from("universities").select("*").order("name");
    if (error) throw error;
    S.unis = data; S.uniMap = Object.fromEntries(data.map(u => [u.id, u]));
  }
  async function coursesFor(uni) {
    if (!uni) return [];
    if (S.courses[uni]) return S.courses[uni];
    const { data } = await sb.from("courses").select("code,title,similar_group").eq("uni_id", uni).order("code");
    return (S.courses[uni] = data || []);
  }
  const courseOpts = list => list.map(c => ({ value: c.code, label: c.code, sub: c.title }));
  const uniOpts = () => S.unis.map(u => ({ value: u.id, label: u.name, short: u.short_name, sub: u.state }));
  const PRICE = { 2: 3, 3: 4.5, 5: 7.5 }, URGENT_FEE = 0.75, HD_FEE = 0.5;
  const priceFor = (n, urgent, hd) => PRICE[n] + (urgent ? URGENT_FEE * n : 0) + (hd ? HD_FEE * n : 0);
  async function refreshCredits() { if (!S.user) return; const { data } = await sb.from("profiles").select("credits").eq("id", S.user.id).single(); if (data && S.profile) { S.profile.credits = Number(data.credits); renderHeader(); } }
  async function settle() { const { data } = await sb.rpc("settle_my_questions"); if (Number(data) > 0) { toast(`${money(Number(data))} refunded to your credits for unanswered spots`); await refreshCredits(); } }
  const uniName = id => (S.uniMap[id] && S.uniMap[id].name) || id || "";
  const uniShort = id => (S.uniMap[id] && S.uniMap[id].short_name) || id || "";
  async function ensureCourse(uni, code) {
    const list = await coursesFor(uni);
    if (list.some(c => c.code === code)) return;
    await sb.from("courses").insert({ uni_id: uni, code, title: "", source: "user" });
    list.push({ code, title: "" });
  }
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

  /* ---------------- shell ---------------- */
  function renderHeader() {
    const p = S.profile, signedIn = !!S.user;
    const route = location.hash.split("/")[1] || "";
    const links = signedIn && p && p.onboarded ? [
      ["ask", "Ask a question"], ["questions", "My questions"], ["tutor", p.tutor_status === "approved" ? "Tutor" : "Become a tutor"], ["credits", "Credits"],
      ...(p.is_admin ? [["admin", "Admin"]] : [])
    ] : [];
    $("#nav").innerHTML = links.map(([r, l]) => `<a href="#/${r}" class="navlink" ${route === r || (r === "tutor" && route === "answer") ? 'aria-current="page"' : ""}>${l}</a>`).join("");
    $("#auth-area").innerHTML = signedIn
      ? `${p && p.onboarded ? `<a class="credit-pill" href="#/credits" title="Your credits">Credits <b>${money(Number(p.credits || 0))}</b></a>` : ""}<button class="avatar-btn" id="me-btn" aria-haspopup="menu"><span class="avatar" aria-hidden="true">${esc(initials(p && p.full_name || S.user.email))}</span><span data-notr>${esc(p ? displayName(p) : "Account")}</span></button>`
      : `<a class="btn ghost sm" href="#/login">Log in</a><a class="btn primary sm" href="#/signup">Sign up</a>`;
    const btn = $("#me-btn");
    if (btn) btn.onclick = e => { e.stopPropagation(); const m = $("#menu"); m.hidden = !m.hidden; };
    $("#menu").innerHTML = signedIn ? `<div class="who">Signed in as<br><b style="color:var(--ink)">${esc(S.user.email)}</b></div><a href="#/profile">Profile and settings</a><a href="#/tutor">Tutor profile</a><button id="signout">Sign out</button>` : "";
    const so = $("#signout"); if (so) so.onclick = async () => { $("#menu").hidden = true; await sb.auth.signOut(); toast("Signed out"); location.hash = "#/"; };
  }
  document.addEventListener("click", e => { if (!e.target.closest("#menu") && !e.target.closest("#me-btn")) $("#menu").hidden = true; });
  // nav links styled like tabs
  const navStyle = document.createElement("style");
  navStyle.textContent = `#nav{display:flex;gap:4px;flex-wrap:wrap;flex:1}#nav a{padding:8px 12px;border-radius:8px;color:var(--muted);font-weight:500;text-decoration:none}#nav a:hover{color:var(--ink);background:var(--surface-2)}#nav a[aria-current="page"]{color:var(--ink);background:var(--surface);box-shadow:inset 0 0 0 1px var(--line)}`;
  document.head.append(navStyle);

  const app = () => $("#app");
  function clearTimers() { S.timers.forEach(clearInterval); S.timers = []; }
  const clock = ms => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
  function every(ms, fn) { S.timers.push(setInterval(fn, ms)); }
  const refreshBtn = id => `<button type="button" class="btn ghost sm refresh" id="${id}" aria-label="Refresh"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Refresh</span></button>`;
  function wireRefresh(id, fn) {
    const b = $("#" + id); if (!b) return;
    b.onclick = async () => { b.classList.add("busy"); b.disabled = true; try { await fn(); } finally { setTimeout(() => { b.classList.remove("busy"); b.disabled = false; }, 400); } };
    every(15000, () => document.querySelectorAll("[data-updated]").forEach(el => { const t = +el.dataset.updated; if (t) el.textContent = Date.now() - t < 20000 ? "Updated just now" : `Updated ${ago(t)}`; }));
  }

  /* ---------------- router ---------------- */
  const PUBLIC = ["", "login", "signup", "reset", "new-password", "alerts-off"];
  async function route() {
    if (!S.ready) return;
    clearTimers(); closeModal(); $("#menu").hidden = true;
    const parts = location.hash.replace(/^#\/?/, "").split("/");
    const r = parts[0] || "";
    renderHeader();
    window.scrollTo(0, 0);
    if (!S.user && !PUBLIC.includes(r)) { sessionStorage.setItem("after-login", location.hash); location.hash = "#/login"; return; }
    if (S.user && ["login", "signup"].includes(r)) { location.hash = "#/"; return; }
    if (S.user && !S.profile && r !== "new-password") { app().innerHTML = `<div class="empty">We couldn't load your account. <button class="btn sm" id="retry-prof">Try again</button> <button class="btn ghost sm" id="so-prof">Sign out</button></div>`; $("#retry-prof").onclick = async () => { await loadProfile(); route(); }; $("#so-prof").onclick = async () => { await sb.auth.signOut(); location.hash = "#/login"; }; return; }
    if (S.user && S.profile && !S.profile.onboarded && !["welcome", "new-password"].includes(r)) { location.hash = "#/welcome"; return; }
    try {
      switch (r) {
        case "": return S.user ? (location.hash = "#/ask") : pageHome();
        case "login": return await pageLogin();
        case "signup": return await pageSignup();
        case "reset": return await pageReset();
        case "new-password": return await pageNewPassword();
        case "welcome": return await pageWelcome();
        case "profile": return await pageProfile();
        case "ask": return await pageAsk();
        case "questions": return await pageMyQuestions();
        case "q": return await pageQuestion(parts[1]);
        case "tutor": return await (parts[1] === "apply" ? pageTutorApply() : pageTutor());
        case "answer": return await pageAnswer(parts[1]);
        case "admin": return await pageAdmin();
        case "credits": return await pageCredits();
        case "alerts-off": return await pageAlertsOff(parts[1], parts[2]);
        default: app().innerHTML = `<div class="empty">Page not found. <a href="#/">Go home</a></div>`;
      }
    } catch (e) { console.error(e); app().innerHTML = `<div class="status err">${esc(errMsg(e))}</div>`; }
  }
  window.addEventListener("hashchange", route);

  /* ---------------- landing ---------------- */
  function pageHome() {
    app().innerHTML = `<section class="view">
      <div class="hero-land">
        <div>
          <p class="tagline">Let's succeed as a generation.</p>
          <h1>Ask about any course. Students with an <em>HD</em> answer.</h1>
          <p class="fast"><span class="pulse" aria-hidden="true"></span>Receive an answer in a couple of minutes</p>
          <p class="muted" style="max-width:52ch;margin-top:12px">Pick your uni and course, ask a short question, and it goes to students who got a Distinction or High Distinction in that exact course, and in similar courses at other unis. Standard questions are usually answered within an hour. Urgent ones within 20 minutes.</p>
          <div class="cta-row"><a class="btn primary" href="#/signup">Sign up to ask</a><a class="btn" href="#/signup">Sign up to tutor</a><a class="btn ghost" href="#/login">Log in</a></div>
        </div>
        <div class="q demo-q" aria-hidden="true">
          <div class="q-top"><span class="row" style="gap:6px"><span class="q-code">INFS2608</span><span class="q-time">UNSW · 2 min ago</span></span><span class="q-exp live">Urgent</span></div>
          <p class="q-text">When normalising to 3NF, how do I tell a transitive dependency apart from a normal one?</p>
          <div class="ans"><div class="ans-head"><span class="ord">1st</span><b>Tom N.</b><span class="grade">92<span class="badge HD">HD</span></span><span class="eq">✓ My eQuals</span></div>
          <div class="bubbles"><div class="bubble">Check whether a non-key column depends on another non-key column.</div><div class="bubble">If CourseTitle depends on CourseCode, split them into their own table.</div></div></div>
        </div>
      </div>
      <div class="two-up">
        <div class="panel feature"><span class="eyebrow">For students</span><h2>Answers from people who aced your course</h2><ul><li>Pick your uni and course from 40 Australian universities</li><li>50-word questions with one PDF or image</li><li>Every tutor with a D or HD in your course, or a similar one, can see and claim it</li><li>Get 2, 3 or 5 answers. Rate each one.</li></ul><a class="btn primary" href="#/signup" style="align-self:flex-start">Sign up as a student</a></div>
        <div class="panel feature"><span class="eyebrow">For tutors</span><h2>Earn $1 to $2 for every 3-minute answer</h2><ul><li>Upload your transcript. We read it and approve your D and HD courses. Add My eQuals for a verified checkmark.</li><li>Claim a question, then answer with text and by drawing on the student's document</li><li>$1.10 per answer, or $1.70 as an early bird when you answer within 20 minutes of the question being posted</li></ul><p class="muted" style="font-size:13px">Create a free account first, then apply to tutor from your account.</p><a class="btn" href="#/signup" style="align-self:flex-start">Create an account</a></div>
      </div>
      <div class="faq"><h2>Common questions</h2><details class="faq-item"><summary>How accurate and reliable are the answers?</summary><p>Every tutor got a Distinction (75+) or High Distinction (85+) in your course, or a very similar one, read straight from their transcript by our AI. You can choose HD only if you want the top scorers. Each answer shows the tutor's mark and rating, and you can get 2, 3 or 5 answers to compare. Tutors are students, so double-check anything important against your course materials.</p></details><details class="faq-item"><summary>Is it safe to hand in my transcript?</summary><p>Yes. Our AI only reads the course codes and marks. It's set up to ignore your name, student number, address and date of birth, and the file is deleted from our records as soon as it's read. Only your courses and marks are kept, and they're only shown next to your answers.</p></details><details class="faq-item"><summary>How fast will I get an answer?</summary><p>Tutors get 2 minutes to answer once they claim your question, so answers often arrive within minutes. Standard questions are usually answered within an hour. Tick Urgent and answers come within 20 minutes.</p></details><details class="faq-item"><summary>What does it cost, and what if nobody answers?</summary><p>Questions start at $3 for 2 answers. You only pay for answers you receive: when your question closes, any unanswered spots are refunded to your credits automatically. You can close a question early at any time.</p></details><details class="faq-item"><summary>Is this cheating?</summary><p>No. Distinction is for understanding: explaining a concept, spotting a mistake, or hearing how someone approached the course. Tutors won't write assessable work for you, and questions are capped at 50 words to keep them focused. Always follow your university's academic integrity rules.</p></details><details class="faq-item"><summary>How do you stop AI-written answers?</summary><p>Tutors have to type every answer themselves. Pasting is turned off, the question can't be copied, and they only get 2 minutes. Every answer is also checked for AI writing. Flagged answers are reviewed, and tutors with repeated flags are paused.</p></details><details class="faq-item"><summary>Who can become a tutor, and how do they get paid?</summary><p>Anyone with a D or HD in a course can tutor it. Upload your transcript and our AI approves you in about 20 seconds. Tutors earn $1.10 per answer, or $1.70 as an early bird, and can turn on email alerts for new questions. Earnings are tracked from your first answer, and payouts to your bank account are being set up.</p></details><details class="faq-item"><summary>Can I ask in another language?</summary><p>Yes. Choose your language in your profile and the whole site switches to it. Questions and answers written in other languages are translated for you automatically, with a Show original button.</p></details></div>
    </section>`;
  }

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
      <div class="row" style="justify-content:space-between"><a href="#/reset">Forgot your password?</a><a href="#/signup">Create an account</a></div>
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
      <p class="muted" style="font-size:14px">Every account starts as a student account. Once you're set up, you can apply to tutor the courses you aced.</p>
      <button type="button" class="btn block google" id="g">${GOOGLE_SVG}Sign up with Google</button>
      <div class="divider">or</div>
      <label class="field"><span>Full name</span><input type="text" id="name" autocomplete="name" required></label>
      <label class="field"><span>Email</span><input type="email" id="email" autocomplete="email" required><small>Use any email. Your uni email works well.</small></label>
      <label class="field"><span>Password</span><input type="password" id="pw" autocomplete="new-password" minlength="8" required><small>At least 8 characters.</small></label>
      <div id="st" hidden></div>
      <button class="btn primary block" id="go">Create account</button>
      <div class="row" style="justify-content:center"><span class="muted">Already have an account?</span><a href="#/login">Log in</a></div>
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
      if (!data.session) {
        app().innerHTML = `<div class="narrow"><div class="panel auth-card"><h1>Check your email</h1><p>We sent a confirmation link to <b>${esc(email)}</b>. Open it to finish creating your account. You can close this tab.</p><p class="muted" style="font-size:14px">Can't find it? Check your spam folder.</p></div></div>`;
      }
    };
  }
  function pageReset() {
    app().innerHTML = `<div class="narrow"><form class="panel auth-card" id="f" novalidate><h1>Reset your password</h1><p class="muted">We'll email you a link to set a new password.</p>
      <label class="field"><span>Email</span><input type="email" id="email" autocomplete="email" required></label><div id="st" hidden></div>
      <button class="btn primary block" id="go">Send reset link</button><a href="#/login">Back to log in</a></form></div>`;
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
      toast("Password updated"); location.hash = "#/";
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
  // parts: about (names), studies (uni, degree, year), prefs (language, heard), bio (tutor intro)
  async function profileFields(root, p, opts = {}) {
    const parts = opts.parts || ["about", "studies", "prefs"];
    const has = k => parts.includes(k);
    root.innerHTML = `
      ${has("about") ? `<div class="two">
        <label class="field"><span>Full name</span><input type="text" id="pf-name" value="${esc(p.full_name || "")}" autocomplete="name"></label>
        <label class="field"><span>Display name</span><input type="text" id="pf-display" value="${esc(p.display_name || "")}" placeholder="e.g. Alex C." maxlength="30"><small>This is what ${opts.tutor ? "students" : "tutors"} see.</small></label>
      </div>` : ""}
      ${has("studies") ? `<div class="field"><span id="pf-uni-lbl">University</span><div id="pf-uni" data-label="pf-uni-lbl"></div></div>
      <div class="field"><span id="pf-degree-lbl">Degree</span><div id="pf-degree" data-label="pf-degree-lbl"></div><small>Can't find yours? Type it in the search box.</small></div>
      <div class="field"><span id="pf-year-lbl">Year of study</span><div id="pf-year" data-label="pf-year-lbl"></div></div>` : ""}
      ${has("bio") ? `<label class="field"><span>Short intro for students</span><textarea class="prose" id="pf-bio" maxlength="400" placeholder="What you're good at explaining.">${esc(p.bio || "")}</textarea></label>` : ""}
      ${has("prefs") ? `<div class="field"><span id="pf-lang-lbl">Language</span><div id="pf-lang" data-label="pf-lang-lbl" data-notr></div><small>The whole site switches to this language. Questions and answers written in other languages are translated into it, and you can always tap "Show original".</small></div>
      ${opts.tutor ? "" : `<label class="field"><span>How did you hear about us? (optional)</span><input type="text" id="pf-heard" value="${esc(p.heard_from || "")}" maxlength="80"></label>`}` : ""}`;
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

  /* Student sign-up: three short steps, like the tutor application */
  async function pageWelcome() {
    const p = S.profile;
    const W = { step: 1 };
    const STEPS = [["About you", ["about"], "What should tutors call you?"], ["Your studies", ["studies"], "This helps us send your questions to the right people."], ["Preferences", ["prefs"], "Choose your language. The whole site is shown in it, and questions and answers written in other languages are translated for you."]];
    app().innerHTML = `<div class="medium"><div class="col">
      <div><span class="eyebrow">Student sign-up</span><h1 style="font-size:30px;margin-top:4px">Set up your student account</h1></div>
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
      $("#steps").innerHTML = STEPS.map((s, i) => `<span class="done">${i + 1}. ${s[0]}</span>`).join("");
      $("#body").innerHTML = `<div class="pending-card"><span class="status-pill approved">Account ready</span>
        <h2 style="font-size:26px">You're all set, ${esc(displayName(S.profile))}</h2>
        <p class="muted">You can now ask questions about any course. Questions are paid with credits, starting at $3 for 2 answers.</p>
        <a class="btn primary" href="#/ask">Ask a question</a></div>`;
      $("#body").insertAdjacentHTML("afterend", `<div class="panel" style="gap:10px"><span class="eyebrow">Optional</span><h2 style="font-size:22px">Got a D or HD in a course? Earn by tutoring it.</h2>
        <p class="muted" style="font-size:14px">Answer short questions from students in the courses you aced. Earn $1 to $2 for every 3-minute answer. Upload your transcript and our AI approves you in about 20 seconds.</p>
        <div class="row"><a class="btn" href="#/tutor/apply">Apply to tutor</a><a class="btn ghost" href="#/ask">Maybe later</a></div></div>`);
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
    const read = await profileFields($("#fields"), p, { tutor: p.tutor_status !== "none", parts: p.tutor_status !== "none" ? ["about", "studies", "bio", "prefs"] : ["about", "studies", "prefs"] });
    $("#out").onclick = async () => { await sb.auth.signOut(); location.hash = "#/"; };
    $("#save").onclick = async () => {
      const v = read(); const bad = checkProfile(v); if (bad) return status($("#st"), bad, "err");
      try { await saveProfile({ ...v, is_student: true, onboarded: true }); status($("#st"), "Saved.", "ok"); } catch (e) { status($("#st"), errMsg(e), "err"); }
    };
  }

  /* ---------------- ask ---------------- */
  async function pageAsk() {
    const p = S.profile;
    app().innerHTML = `<section class="view">
      <div class="intro" style="align-items:start">
        <div>
          <p class="tagline">Let's succeed as a generation.</p>
          <h1>Ask about any course. Students with an <em>HD</em> answer.</h1>
          <p class="fast"><span class="pulse" aria-hidden="true"></span>Receive an answer in a couple of minutes</p>
          <p>Your question goes to every student who got a Distinction or High Distinction in that course, or a similar course at your uni or another. Standard questions are usually answered within an hour. Tick Urgent for answers within 20 minutes.</p>
          <div class="how" style="margin-top:22px">
            <div><span class="stepno">1 · PICK</span><b>Uni and course</b><p>Choose your uni and course, write up to 50 words and attach one file.</p></div>
            <div><span class="stepno">2 · CHOOSE</span><b>Who answers</b><p>Everyone who got a D or HD in that course or a similar one, or HD only if you prefer.</p></div>
            <div><span class="stepno">3 · GET</span><b>Answers</b><p>Tutors reply in short messages and can mark up your PDF or image directly.</p></div>
          </div>
          <a class="recruit" href="#/tutor"><span><b>Got an HD?</b> Earn $1 to $2 for every 3-minute answer in the courses you aced.</span><span class="recruit-go">Start earning →</span></a>
        </div>
        <form class="panel composer" id="compose" novalidate>
          <div class="two tight">
            <div class="field"><span id="a-uni-lbl">University</span><div id="a-uni" data-label="a-uni-lbl"></div></div>
            <div class="field"><span id="a-course-lbl">Course</span><div class="pop-right" id="a-course" data-label="a-course-lbl"></div></div>
          </div>
          <div class="field"><span>Who can answer</span>
            <div class="seg" role="radiogroup" aria-label="Minimum grade"><label><input type="radio" name="a-grade" value="75" checked><span>Distinction and HD</span></label><label><input type="radio" name="a-grade" value="85"><span>HD only <em class="plus-cr" id="a-hd-fee">+${money(HD_FEE * 2)}</em></span></label></div>
            <p class="speed-note stack-note" id="a-grade-note">${[0, 1, 2, 3].map(i => `<span data-v="${i}"${i ? " hidden-note" : ""}></span>`).join("")}</p>
          </div>
          <fieldset class="field goals"><legend>What are you after? <small class="muted">Tick any</small></legend>
            <div class="goal-grid">${GOALS.map(g => `<label class="goal"><input type="checkbox" name="a-goal" value="${g.v}"><span><b>${g.label}</b><small>${g.hint}</small></span></label>`).join("")}</div>
          </fieldset>
          <div class="field">
            <div class="row" style="justify-content:space-between"><label for="a-text" style="font-size:13px;font-weight:500">Your question</label><span class="words" id="a-words">0 / ${WORD_LIMIT} words</span></div>
            <textarea class="prose" id="a-text" style="min-height:76px" placeholder="Keep it short: what you're stuck on and which week or assignment it's from."></textarea>
            <div class="attach"><label class="linkbtn attach-btn" for="a-file" id="a-file-btn">+ Attach a file</label><input type="file" id="a-file" accept="${FILE_TYPES.join(",")}" hidden><span id="a-file-chip"></span><small class="muted">1 image or PDF, up to 5 MB</small></div>
          </div>
          <div class="field"><span>How many answers</span>
            <div class="boxes" role="radiogroup" aria-label="Number of answers">
              ${[2, 3, 5].map((n, i) => `<label><input type="radio" name="a-count" value="${n}" ${i === 0 ? "checked" : ""}><span class="box"><b>${n}</b><small>answers</small><em>${money(PRICE[n])}</em></span></label>`).join("")}
            </div>
            <p class="speed-note">Standard questions are usually answered within an hour.</p>
            <label class="check urgent-check"><input type="checkbox" id="a-urgent"><span><b>Urgent</b>: answers within 20 minutes <em class="plus-cr" id="a-urgent-fee">+${money(URGENT_FEE * 2)}</em></span></label>
          </div>
          <div class="post-row"><div class="field dur"><span id="a-dur-lbl">Open for</span><div id="a-dur" data-label="a-dur-lbl"></div><small class="muted">Closes automatically after this time. You can close it earlier whenever you want.</small></div><div class="total" id="a-cost"></div><button class="btn primary" id="a-post">Post question</button></div>
          <div class="price-row muted"><span>Your balance: <b class="mono" style="color:var(--ink)">${money(Number(p.credits || 0))}</b></span><span>Unanswered spots are refunded when the question closes.</span></div>
          <div id="a-status" hidden></div>
        </form>
      </div>
      <div class="col"><div class="results-head"><h2>Your recent questions</h2><div class="row" style="gap:8px"><span class="muted upd" data-updated></span>${refreshBtn("ref-recent")}<a href="#/questions">See all</a></div></div><div class="qgrid" id="recent"></div></div>
    </section>`;

    const courseSel = glassSelect($("#a-course"), { options: [], value: null, mono: true, placeholder: "Choose a course", search: "Type a course code or name, e.g. COMP", freeText: validCode, minQuery: 3, minText: "Type at least 3 letters of the course code or name, e.g. COMP or Accounting", emptyText: "No matches. Type the full course code to use it." });
    async function loadCourses(uni) {
      const list = courseOpts(await coursesFor(uni));
      const mine = (p.current_courses || []).filter(c => uni === p.uni_id);
      mine.forEach(c => { if (!list.some(o => o.value === c)) list.unshift({ value: c, label: c, sub: "Your course" }); });
      list.sort((a, b) => (mine.includes(b.value) - mine.includes(a.value)) || a.value.localeCompare(b.value));
      courseSel.setOptions(list, mine[0] || null);
    }
    const uniSel2 = glassSelect($("#a-uni"), { options: uniOpts(), value: p.uni_id, search: "Search universities", hideSub: true, onChange: u => { loadCourses(u); paintReach(); } });
    function paintCost() {
      const n = +document.querySelector('input[name="a-count"]:checked').value, urgent = $("#a-urgent").checked, hd = isHD();
      document.querySelectorAll('input[name="a-count"]').forEach(r => r.parentElement.querySelector("em").textContent = money(priceFor(+r.value, urgent, hd)));
      $("#a-urgent-fee").textContent = "+" + money(URGENT_FEE * n);
      $("#a-hd-fee").textContent = "+" + money(HD_FEE * n);
      $("#a-cost").innerHTML = `<small>${n} answers${hd ? " + HD only" : ""}${urgent ? " + urgent" : ""}</small><b class="mono">${money(priceFor(n, urgent, hd))}</b>`;
    }
    const isHD = () => +document.querySelector('input[name="a-grade"]:checked').value >= 85;
    document.querySelectorAll('input[name="a-count"], #a-urgent, input[name="a-grade"]').forEach(el => el.addEventListener("change", paintCost));
    const goalsPicked = () => [...document.querySelectorAll('input[name="a-goal"]:checked')].map(el => el.value);
    function paintReach() {
      const hd = +document.querySelector('input[name="a-grade"]:checked').value >= 85, uniOnly = goalsPicked().includes("course_specific");
      // every variant is laid out in the same spot, so the tallest one sets the height and nothing below moves
      const uni = uniShort(uniSel2.value) || "your uni";
      const variants = [[false, false], [true, false], [false, true], [true, true]].map(([h, u]) =>
        `${h ? "Only tutors who got an HD (85+)" : "Tutors who got a D or HD"} ${u ? `in this course at ${uni}, or a very close course there` : "in this course, or a similar course at any uni"}, can see and claim it.${h || u ? " Fewer tutors, so answers may take a little longer." : ""}`);
      const cur = (hd ? 1 : 0) + (uniOnly ? 2 : 0);
      $$("#a-grade-note span").forEach((el, i) => { el.textContent = variants[i]; el.toggleAttribute("hidden-note", i !== cur); });
    }
    document.querySelectorAll('input[name="a-grade"], input[name="a-goal"]').forEach(el => el.addEventListener("change", paintReach));
    paintCost(); paintReach();
    await loadCourses(p.uni_id);
    const durSel = glassSelect($("#a-dur"), { options: DURS, value: "24" });

    let attach = null;
    $("#a-file").onchange = e => {
      const f = e.target.files[0]; e.target.value = ""; if (!f) return;
      if (!FILE_TYPES.includes(f.type)) return toast("Attach a PDF or an image (PNG, JPG or WebP).");
      if (f.size > MAX_FILE) return toast(`That file is ${kb(f.size)}. The limit is 5 MB.`);
      attach = f; renderAttach();
    };
    function renderAttach() {
      $("#a-file-chip").innerHTML = attach ? `<span class="fchip">${attach.type === "application/pdf" ? "PDF" : "IMG"} · ${esc(attach.name)} · ${kb(attach.size)} <button type="button" class="linkbtn" id="a-file-rm">Remove</button></span>` : "";
      $("#a-file-btn").hidden = !!attach;
      const rm = $("#a-file-rm"); if (rm) rm.onclick = () => { attach = null; renderAttach(); };
    }
    $("#a-text").oninput = () => { const w = words($("#a-text").value); const el = $("#a-words"); el.textContent = `${w} / ${WORD_LIMIT} words`; el.classList.toggle("over", w > WORD_LIMIT); };

    $("#compose").onsubmit = async e => {
      e.preventDefault();
      const st = $("#a-status");
      const code = courseSel.value, uni = uniSel2.value, text = $("#a-text").value.trim(), w = words(text);
      if (!uni) return status(st, "Choose your university.", "err");
      if (!validCode(code)) return status(st, "Pick a course from the list, or type its code in the search box.", "err");
      if (w < 5) return status(st, "Write a bit more so tutors know what you're stuck on.", "err");
      if (w > WORD_LIMIT) return status(st, `Your question is ${w} words. Cut it to ${WORD_LIMIT} or fewer.`, "err");
      const cost = priceFor(+document.querySelector('input[name="a-count"]:checked').value, $("#a-urgent").checked, isHD());
      if (cost > Number(p.credits || 0)) return status(st, `This question costs ${money(cost)} and you have ${money(Number(p.credits || 0))}. Top up on the Credits page or choose fewer answers.`, "err");
      const btn = $("#a-post"); btn.disabled = true; status(st, attach ? "Uploading your file…" : "Posting…", "", true);
      try {
        let att = {};
        if (attach) {
          const path = `${S.user.id}/${Date.now()}-${attach.name.replace(/[^\w.\-]+/g, "_").slice(-80)}`;
          const { error } = await sb.storage.from("attachments").upload(path, attach, { contentType: attach.type, upsert: false });
          if (error) throw error;
          att = { attachment_path: path, attachment_name: attach.name, attachment_type: attach.type, attachment_size: attach.size };
        }
        await ensureCourse(uni, code).catch(() => { });
        const hours = +durSel.value;
        const row = {
          asker_id: S.user.id, uni_id: uni, course_code: code, body: text, ...att,
          min_mark: +document.querySelector('input[name="a-grade"]:checked').value, verified_only: false, wide: !goalsPicked().includes("course_specific"), goals: goalsPicked(), urgent: $("#a-urgent").checked,
          slots: +document.querySelector('input[name="a-count"]:checked').value,
          expires_at: new Date(Date.now() + hours * 3600e3).toISOString()
        };
        const { data, error } = await sb.from("questions").insert(row).select("id").single();
        if (error) throw error;
        await refreshCredits();
        sb.functions.invoke("notify-tutors", { body: { question_id: data.id } }).catch(() => { });
        toast(`Question posted. ${money(cost)} used from your credits.`);
        location.hash = "#/q/" + data.id;
      } catch (err) { status(st, errMsg(err), "err"); btn.disabled = false; }
    };
    wireRefresh("ref-recent", () => renderRecent($("#recent"), 4));
    renderRecent($("#recent"), 4);
    every(8000, () => renderRecent($("#recent"), 4));
    settle();
  }

  async function myQuestions(limit) {
    let q = sb.from("questions").select("id, uni_id, course_code, body, slots, urgent, min_mark, verified_only, expires_at, created_at, attachment_name, answers(id, position, bubbles, tutor_id, created_at)").eq("asker_id", S.user.id).order("created_at", { ascending: false });
    if (limit) q = q.limit(limit);
    const { data, error } = await q; if (error) throw error;
    const ids = [...new Set(data.flatMap(x => (x.answers || []).map(a => a.tutor_id)))];
    if (ids.length) { const { data: ts } = await sb.from("profiles").select("id, display_name, full_name").in("id", ids); (ts || []).forEach(t => S.names[t.id] = displayName(t)); }
    return data;
  }
  function qSummary(q) {
    const ans = (q.answers || []).slice().sort((a, b) => a.position - b.position);
    const n = ans.length, closed = new Date(q.expires_at) < new Date();
    return `<a class="q-link" href="#/q/${q.id}"><article class="q${closed ? " closed" : ""}">
      <div class="q-top"><span class="row" style="gap:6px"><span class="q-code">${esc(q.course_code)}</span><span class="q-time">${esc(uniShort(q.uni_id))} · ${ago(q.created_at)}</span></span><span class="q-exp${closed ? "" : " live"}">${left(q.expires_at)}</span></div>
      <p class="q-text">${esc(q.body)}</p>
      <div class="q-pay"><span class="slotbar">${Array.from({ length: q.slots }, (_, i) => `<i class="${i < n ? "on" : ""}"></i>`).join("")}</span><span>${n} of ${q.slots} answers</span>${q.urgent ? '<span class="tagchip">Urgent</span>' : ""}${q.attachment_name ? '<span class="tagchip">Attachment</span>' : ""}</div>
      ${ans.length ? `<div class="ans-preview">${ans.map(a => `<div class="ap"><b data-notr>${esc(S.names[a.tutor_id] || "Tutor")}</b><span>${esc((a.bubbles || []).join(" ").slice(0, 140))}${(a.bubbles || []).join(" ").length > 140 ? "…" : ""}</span></div>`).join("")}</div>` : ""}
      ${S.drafting && S.drafting[q.id] ? `<div class="drafting"><span class="spin"></span><span>${esc(S.drafting[q.id].join(", "))} ${S.drafting[q.id].length > 1 ? "are" : "is"} drafting up the answer<span class="dots"></span></span></div>` : ""}
      <span class="q-open">${n ? "Open to see full answers" : "Open question"} →</span>
    </article></a>`;
  }
  async function renderRecent(el, limit) {
    if (!el || !el.isConnected) return;
    const [qs, dr] = await Promise.all([myQuestions(limit), sb.rpc("my_drafting")]);
    if (!el.isConnected) return;
    const stamp = el.parentElement && el.parentElement.querySelector("[data-updated]"); if (stamp) { stamp.dataset.updated = Date.now(); stamp.textContent = "Updated just now"; }
    S.drafting = {}; ((dr && dr.data) || []).forEach(d => { (S.drafting[d.question_id] = S.drafting[d.question_id] || []).push(d.tutor_name); });
    el.innerHTML = qs.length ? qs.map(qSummary).join("") : `<div class="empty">You haven't asked anything yet.</div>`;
  }
  async function pageMyQuestions() {
    app().innerHTML = `<section class="view"><div class="results-head"><h1 style="font-size:30px">My questions</h1><div class="row" style="gap:8px"><span class="muted upd" data-updated></span>${refreshBtn("ref-list")}<a class="btn primary" href="#/ask">Ask a question</a></div></div><div class="qgrid" id="list"><div class="boot">Loading…</div></div></section>`;
    wireRefresh("ref-list", () => renderRecent($("#list")));
    await renderRecent($("#list"));
    settle();
    every(8000, () => renderRecent($("#list")));
  }

  /* AI transcript scan: animated progress while the scan-transcript function runs (10 to 20 seconds) */
  function scanAnimation(el) {
    const STEPS = ["Opening your transcript", "Finding course codes", "Reading marks and grades", "Checking which courses you can tutor"];
    el.innerHTML = `<div class="scan" role="status" aria-live="polite">
      <div class="scan-doc" aria-hidden="true">${Array.from({ length: 9 }, (_, i) => `<i style="width:${[80, 55, 70, 62, 76, 48, 68, 58, 72][i]}%"></i>`).join("")}<div class="scan-beam"></div></div>
      <div class="scan-body"><div class="scan-title"><span class="ai-spark" aria-hidden="true">✦</span> AI is reading your transcript</div>
        <ul class="scan-steps">${STEPS.map((t, i) => `<li data-s="${i}">${esc(t)}</li>`).join("")}</ul>
        <div class="scan-bar"><i></i></div><small class="muted">Usually 10 to 20 seconds · <span class="scan-t">0s</span></small></div></div>`;
    const t0 = Date.now(), bar = el.querySelector(".scan-bar i"), tt = el.querySelector(".scan-t"), lis = [...el.querySelectorAll(".scan-steps li")];
    const at = [0, 3, 8, 14];
    const paint = done => {
      const sec = (Date.now() - t0) / 1000;
      tt.textContent = Math.floor(sec) + "s";
      bar.style.width = (done ? 100 : Math.min(94, 94 * (1 - Math.exp(-sec / 9)))) + "%";
      const cur = done ? STEPS.length : at.filter(x => sec >= x).length - 1;
      lis.forEach((li, i) => li.className = i < cur ? "done" : i === cur ? "active" : "");
    };
    paint(false); const iv = setInterval(() => paint(false), 250);
    return { finish: ok => new Promise(res => { clearInterval(iv); paint(true); el.querySelector(".scan-title").innerHTML = ok ? '<span class="ai-spark" aria-hidden="true">✦</span> Done. Here\'s what the AI found' : "Scan finished"; setTimeout(() => { el.innerHTML = ""; res(); }, 900); }) };
  }

  /* ---------------- question detail (student) ---------------- */
  async function signedUrl(bucket, path) {
    const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, 3600);
    if (error) throw error; return data.signedUrl;
  }
  async function pageQuestion(id) {
    app().innerHTML = `<div class="boot">Loading question…</div>`;
    const { data: q, error } = await sb.from("questions").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!q) { app().innerHTML = `<div class="empty">This question doesn't exist or you don't have access to it.</div>`; return; }
    const mine = q.asker_id === S.user.id;
    app().innerHTML = `<section class="view">
      <a href="#/questions">← My questions</a>
      <div class="answer-layout">
        <div class="col">
          <article class="q">
            <div class="q-top"><span class="row" style="gap:6px"><span class="q-code">${esc(q.course_code)}</span><span class="q-time">${esc(uniName(q.uni_id))} · ${ago(q.created_at)}</span></span><span class="q-exp" data-exp="${q.expires_at}">${left(q.expires_at)}</span></div>
            <p class="q-text" style="font-size:17px">${esc(q.body)}</p>
            ${mine && new Date(q.expires_at) > new Date() ? `<div class="row" style="justify-content:space-between"><span class="muted" style="font-size:13px">Closes automatically ${left(q.expires_at).replace("Closes in", "in")}. Got what you needed?</span><button class="btn sm" id="close-q">Close question</button></div>` : ""}
            <div class="q-pay">${[q.urgent ? "Urgent" : null, q.min_mark >= 85 ? "HD only" : "Open to D and HD tutors", q.wide === false ? "Your uni only" : "Similar courses included"].filter(Boolean).map(t => `<span class="tagchip">${t}</span>`).join("")}</div>
            ${(q.goals || []).length ? `<div class="goals-row"><span class="muted">You're after</span>${goalChips(q.goals)}</div>` : ""}
          </article>
          ${q.attachment_path ? `<div class="answer-tabs" id="ann-tabs"></div><div id="doc"></div>` : ""}
        </div>
        <aside class="answer-side"><div class="results-head"><h2>Answers <span class="muted" id="count" style="font-size:15px;font-weight:500"></span></h2>${refreshBtn("ref-ans")}</div><div id="drafting"></div><div class="col" id="answers"></div></aside>
      </div></section>`;
    let doc = null;
    if (q.attachment_path) {
      try { doc = await DocView.mount($("#doc"), { url: await signedUrl("attachments", q.attachment_path), type: q.attachment_type, editable: false }); }
      catch (e) { $("#doc").innerHTML = `<div class="status err">${esc(errMsg(e))}</div>`; }
    }
    let shownAnswer = null, lastIds = "";
    async function loadDrafting() {
      if (!mine) return;
      const { data } = await sb.rpc("my_drafting");
      const names = (data || []).filter(d => d.question_id === id).map(d => d.tutor_name);
      $("#drafting").innerHTML = names.length ? `<div class="drafting"><span class="spin"></span><span><b>${esc(names.join(", "))}</b> ${names.length > 1 ? "are" : "is"} drafting up the answer<span class="dots"></span></span></div>` : "";
    }
    async function load() {
      loadDrafting();
      const { data: ans } = await sb.from("answers").select("*").eq("question_id", id).order("position");
      const answers = ans || [];
      $("#count").textContent = `${answers.length} of ${q.slots}`;
      const ids = answers.map(a => a.id).join();
      if (ids === lastIds && answers.length) return; lastIds = ids;
      const tutorIds = [...new Set(answers.map(a => a.tutor_id))];
      const [{ data: tutors }, { data: tcs }, { data: revs }] = await Promise.all([
        tutorIds.length ? sb.from("profiles").select("id, display_name, full_name, uni_id, equals_verified").in("id", tutorIds) : { data: [] },
        tutorIds.length ? sb.from("tutor_courses").select("tutor_id, uni_id, code, mark, grade").in("tutor_id", tutorIds).eq("status", "approved") : { data: [] },
        answers.length ? sb.from("reviews").select("answer_id, stars, comment").in("answer_id", answers.map(a => a.id)) : { data: [] }
      ]);
      const tMap = Object.fromEntries((tutors || []).map(t => [t.id, t]));
      const closed = new Date(q.expires_at) < new Date();
      $("#answers").innerHTML = answers.length ? answers.map((a, i) => {
        const t = tMap[a.tutor_id] || {}, tc = (tcs || []).filter(x => x.tutor_id === a.tutor_id);
        const course = tc.find(x => x.uni_id === q.uni_id && x.code === q.course_code) || tc[0];
        const rv = (revs || []).find(r => r.answer_id === a.id);
        const c = DocView.count(a.annotations);
        return `<div class="answer-card${shownAnswer === a.id ? " active" : ""}" data-a="${a.id}" data-trg>
          <div class="ans-head"><span class="ord">${["1st", "2nd", "3rd", "4th", "5th"][i]}</span><b data-notr>${esc(displayName(t))}</b>${course ? `<span class="grade">${course.mark}<span class="badge ${gcls(course.grade || gradeFor(course.mark))}">${esc(course.grade || gradeFor(course.mark))}</span></span>` : ""}${course && (course.uni_id !== q.uni_id || course.code !== q.course_code) ? `<span class="simchip"><b>${esc(uniShort(course.uni_id))}</b> ${esc(course.code)}</span>` : ""}${t.equals_verified ? '<span class="eq">✓ My eQuals</span>' : ""}<span class="muted">${ago(a.created_at)}</span></div>
          <div class="bubbles" data-trslot>${(a.bubbles || []).map(b => `<div class="bubble" data-tr>${esc(b)}</div>`).join("")}</div>
          ${c.strokes || c.notes ? `<button class="btn sm" data-show="${a.id}">${shownAnswer === a.id ? "Hide" : "Show"} markup on your document (${c.notes} note${c.notes === 1 ? "" : "s"}, ${c.strokes} drawing${c.strokes === 1 ? "" : "s"})</button>` : ""}
          ${mine ? (rv ? `<div class="muted" style="font-size:13px">You rated ${stars(rv.stars)}</div>` : `<div class="row" style="justify-content:space-between"><span class="stars-in" role="group" aria-label="Rate this answer">${[1, 2, 3, 4, 5].map(n => `<button data-rate="${a.id}:${a.tutor_id}:${n}" aria-label="${n} star${n > 1 ? "s" : ""}">★</button>`).join("")}</span><button class="linkbtn" data-report="${a.id}">Report</button></div>`) : ""}
        </div>`;
      }).join("") : `<div class="empty">${closed ? "This question closed without answers." : `<span class="spin"></span> Waiting for answers. ${q.urgent ? "Urgent questions usually get answers within 20 minutes." : "Most questions are answered within an hour."}`}</div>`;
      window._answers = answers;
      autoTranslate($("#answers"));
    }
    $("#answers").addEventListener("click", async e => {
      const sh = e.target.closest("[data-show]");
      if (sh && doc) {
        const a = (window._answers || []).find(x => x.id === sh.dataset.show);
        shownAnswer = shownAnswer === a.id ? null : a.id;
        doc.setAnnotations(shownAnswer ? a.annotations : {});
        lastIds = ""; await load();
        if (shownAnswer) $("#doc").scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      const r = e.target.closest("[data-rate]");
      if (r) {
        const [answer_id, tutor_id, n] = r.dataset.rate.split(":");
        openModal(`<h3>Rate this answer ${stars(+n, 20)}</h3><label class="field"><span>Comment (optional)</span><textarea class="prose" id="rv-c" maxlength="300" placeholder="What made it helpful?"></textarea></label><div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="rv-go">Submit rating</button></div>`, m => {
          $("#rv-go", m).onclick = async () => {
            const { error } = await sb.from("reviews").insert({ answer_id, tutor_id, student_id: S.user.id, stars: +n, comment: $("#rv-c", m).value.trim() || null });
            if (error) return toast(errMsg(error));
            closeModal(); toast("Thanks for rating"); lastIds = ""; load();
          };
        });
        return;
      }
      const rp = e.target.closest("[data-report]");
      if (rp) {
        openModal(`<h3>Report this answer</h3><p class="muted" style="font-size:14px">Tell us what's wrong. We review every report.</p><label class="field"><span>Reason</span><textarea class="prose" id="rp-r" maxlength="500" placeholder="For example: wrong, off-topic, or looks like a copied assignment."></textarea></label><div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="rp-go">Send report</button></div>`, m => {
          $("#rp-go", m).onclick = async () => {
            const reason = $("#rp-r", m).value.trim(); if (!reason) return toast("Add a short reason.");
            const { error } = await sb.from("reports").insert({ answer_id: rp.dataset.report, reporter_id: S.user.id, reason });
            if (error) return toast(errMsg(error)); closeModal(); toast("Report sent. Thanks.");
          };
        });
      }
    });
    const cq = $("#close-q");
    if (cq) cq.onclick = () => openModal(`<h3>Close this question?</h3><p class="muted" style="font-size:14px">Tutors won't be able to answer it any more. Answers you've already received stay here, and credits for unanswered spots are refunded to you now.</p><div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Keep it open</button><button class="btn primary" id="cq-go">Close question</button></div>`, m => {
      $("#cq-go", m).onclick = async () => {
        const { data, error } = await sb.rpc("close_question", { q_id: id });
        if (error) return toast(errMsg(error));
        closeModal(); await refreshCredits();
        toast(Number(data) > 0 ? `Question closed. ${money(Number(data))} refunded to your credits.` : "Question closed.");
        pageQuestion(id);
      };
    });
    await load();
    wireRefresh("ref-ans", () => { lastIds = ""; return load(); });
    every(8000, () => { const el = $("[data-exp]"); if (el) el.textContent = left(el.dataset.exp); if (new Date(q.expires_at) > new Date()) load(); });
    if (mine) settle();
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

  /* ---------------- credits ---------------- */
  async function pageCredits() {
    await settle(); await refreshCredits();
    const { data: tx } = await sb.from("credit_tx").select("*").eq("user_id", S.user.id).order("created_at", { ascending: false }).limit(30);
    const bal = Number(S.profile.credits || 0);
    app().innerHTML = `<section class="view"><div class="wallet-grid">
      <div class="panel">
        <div class="eyebrow">Your balance</div>
        <div><span class="balance">${money(bal)}</span> <span class="muted">in credits</span></div>
        <p class="muted" style="font-size:14px">1 credit = $1. Unanswered spots are refunded when a question closes, and so is the urgent fee for any answer that takes over 20 minutes.</p>
        <div class="eyebrow" style="margin-top:6px">What questions cost</div>
        <div class="table-wrap"><table style="min-width:0"><thead><tr><th>Answers</th><th>Standard</th><th>Urgent</th></tr></thead><tbody>
          ${[2, 3, 5].map(n => `<tr><td>${n} answers</td><td class="num">${money(priceFor(n, false))}</td><td class="num">${money(priceFor(n, true))}</td></tr>`).join("")}
        </tbody></table></div>
        <p class="muted" style="font-size:13px">HD only adds ${money(HD_FEE)} per answer.</p>
        <div class="eyebrow" style="margin-top:6px">Top up</div>
        <div class="packs">${[[10, "$10", "Starter"], [21, "$20", "+1 bonus credit"], [55, "$50", "+5 bonus credits"]].map(([c, pr, note]) => `<button class="pack" data-topup="${c}"><b>${c}</b><span>credits · ${pr}</span><small>${note}</small></button>`).join("")}</div>
        <div class="status" id="topup-st">Test mode: top-ups are free for now and no payment is taken.</div>
      </div>
      <div class="panel"><div class="eyebrow">History</div>
        <ul class="list">${(tx || []).map(t => `<li><span>${esc(t.label)} <span class="muted" style="font-size:12px">${ago(t.created_at)}</span></span><span class="amt ${t.amount > 0 ? "pos" : ""}">${t.amount > 0 ? "+" : ""}${money(Number(t.amount))}</span></li>`).join("") || '<li class="muted">No activity yet.</li>'}</ul>
      </div></div></section>`;
    $$("[data-topup]").forEach(b => b.onclick = async () => {
      b.disabled = true;
      const { error } = await sb.rpc("test_topup", { p_credits: +b.dataset.topup });
      b.disabled = false;
      if (error) return status($("#topup-st"), errMsg(error), "err");
      toast(`Added ${b.dataset.topup} credits`);
      pageCredits();
    });
  }

  /* One-click unsubscribe from an alert email */
  async function pageAlertsOff(uid, token) {
    app().innerHTML = `<div class="boot">Turning off email alerts…</div>`;
    const { data, error } = await sb.rpc("unsubscribe_alerts", { p_user: uid, p_token: token });
    if (S.user && S.user.id === uid && data) await loadProfile();
    app().innerHTML = `<div class="medium"><div class="panel pending-card">${!error && data
      ? `<span class="status-pill approved">Done</span><h1 style="font-size:26px">Email alerts are off</h1><p class="muted">You won't get emails about new questions any more. You can turn them back on from your tutor profile whenever you like.</p>`
      : `<span class="status-pill rejected">Link didn't work</span><h1 style="font-size:26px">We couldn't turn off alerts from this link</h1><p class="muted">Log in and switch off email alerts on your tutor profile instead.</p>`}
      <a class="btn" href="#/tutor">Go to tutor profile</a></div></div>`;
  }

  /* Warning shown when an answer looks AI-written */
  function aiWarning(score) {
    openModal(`<h3>⚠ This answer looked AI-written</h3>
      <p style="font-size:14px">Our check rated your last answer <b>${score}% likely to be AI-generated</b>. Answers on Distinction must be your own words, typed by you.</p>
      <p class="muted" style="font-size:14px">The answer was still sent and paid, but it's been flagged. <b>3 flags within 30 days pauses your tutoring</b> until we review it.</p>
      <div class="row" style="justify-content:flex-end"><button class="btn primary" data-close id="ai-ok">I understand</button></div>`, m => { $("#ai-ok", m).addEventListener("click", () => sb.rpc("dismiss_ai_warnings")); });
  }

  /* Ask tutors (once) whether they want emails about new questions */
  function askAlerts() {
    openModal(`<h3>Get an email when a question comes in?</h3>
      <p class="muted" style="font-size:14px">We'll email ${esc(S.user.email)} when a student asks a question in one of your courses, so you don't have to keep checking the site. First to claim gets the spot. At most one email every few minutes, and you can turn this off anytime.</p>
      <div class="row" style="justify-content:flex-end"><button class="btn ghost" id="al-no">Not now</button><button class="btn primary" id="al-yes">Yes, email me</button></div>`, m => {
      const set = async on => { try { await saveProfile({ email_alerts: on, alerts_asked: true, email_alerts_at: on ? new Date().toISOString() : null }); closeModal(); toast(on ? "Email alerts are on" : "No problem. You can turn alerts on from your tutor profile."); if ($("#al-toggle")) $("#al-toggle").checked = on; } catch (e) { toast(errMsg(e)); } };
      $("#al-yes", m).onclick = () => set(true);
      $("#al-no", m).onclick = () => set(false);
    });
  }

  /* ---------------- tutor ---------------- */
  async function pageTutor() {
    const p = S.profile;
    if (!p.onboarded || p.tutor_status === "none") return tutorPitch();
    if (p.tutor_status === "pending") return tutorPending();
    if (p.tutor_status === "rejected") return tutorRejected();
    if (p.tutor_paused) return tutorPaused();
    return tutorDashboard();
  }
  function tutorPitch() {
    app().innerHTML = `<section class="view"><div class="intro"><div>
      <h1>Earn $1 to $2 for every 3-minute answer.</h1>
      <p>Upload your transcript and our AI reads your marks in about 20 seconds. Every course where you got a Distinction (75+) or High Distinction becomes a course you can tutor, straight away. Then answer short questions from students for $1.10 each, or $1.70 as an early bird. Turn on email alerts and answer between classes.</p>
      <div class="cta-row"><a class="btn primary" href="#/tutor/apply">Apply to tutor</a></div></div>
      <div class="how"><div><span class="stepno">STEP 1</span><b>Profile</b><p>Your uni, degree and a short intro.</p></div><div><span class="stepno">STEP 2</span><b>Transcript</b><p>Upload it. AI reads your courses and marks, then the file is deleted.</p></div><div><span class="stepno">STEP 3</span><b>Start tutoring</b><p>Approved instantly for every course at 75 or above.</p></div></div>
    </div></section>`;
  }
  async function tutorPending() {
    const { data: tcs } = await sb.from("tutor_courses").select("*").eq("tutor_id", S.user.id).order("mark", { ascending: false });
    app().innerHTML = `<div class="medium"><div class="panel pending-card"><span class="status-pill pending">Under review</span><h1 style="font-size:28px">We're checking your transcript</h1>
      <p class="muted">We'll approve your courses once we've matched them to your transcript, usually within 48 hours. You can keep asking questions in the meantime.</p>
      <ul class="courses" style="width:100%">${(tcs || []).map(x => `<li><span class="code">${esc(x.code)}</span><span class="ttl">${esc(x.title)}</span><span class="grade">${x.mark}<span class="badge ${gcls(x.grade || gradeFor(x.mark))}">${esc(x.grade || gradeFor(x.mark))}</span></span></li>`).join("")}</ul>
      <a class="btn" href="#/ask">Ask a question</a></div></div>`;
  }
  async function tutorRejected() {
    const { data: apps } = await sb.from("tutor_applications").select("admin_notes, reviewed_at").eq("user_id", S.user.id).order("submitted_at", { ascending: false }).limit(1);
    app().innerHTML = `<div class="medium"><div class="panel pending-card"><span class="status-pill rejected">Not approved</span><h1 style="font-size:28px">Your application was rejected</h1>
      ${apps && apps[0] && apps[0].admin_notes ? `<p>${esc(apps[0].admin_notes)}</p>` : `<p class="muted">We couldn't match your courses to your transcript.</p>`}
      <a class="btn primary" href="#/tutor/apply">Apply again</a></div></div>`;
  }

  function tutorPaused() {
    app().innerHTML = `<div class="medium"><div class="panel pending-card"><span class="status-pill rejected">Tutoring paused</span><h1 style="font-size:28px">Your tutoring is paused</h1>
      <p>Three of your answers in the last 30 days were flagged as likely AI-written, so you can't see or claim questions for now. Answers on Distinction must be your own words, typed by you.</p>
      <p class="muted">Think this is a mistake? Email <a href="mailto:support@hdistinction.live">support@hdistinction.live</a> and we'll review your answers. Your earnings so far are safe, and you can still ask questions.</p>
      <a class="btn" href="#/ask">Ask a question</a></div></div>`;
  }

  async function tutorDashboard() {
    const p = S.profile;
    app().innerHTML = `<div class="boot">Loading your tutor profile…</div>`;
    const [{ data: st }, { data: tcs }, { data: revs }] = await Promise.all([
      sb.rpc("tutor_stats", { t: S.user.id }),
      sb.from("tutor_courses").select("*").eq("tutor_id", S.user.id).eq("status", "approved").order("mark", { ascending: false }),
      sb.from("reviews").select("stars, comment, created_at, student_id").eq("tutor_id", S.user.id).order("created_at", { ascending: false }).limit(8)
    ]);
    const s = (st && st[0]) || {};
    app().innerHTML = `<div class="tutor-layout">
      <aside class="col">
        <div class="panel prof">
          <div class="t-head"><div class="avatar lg" aria-hidden="true">${esc(initials(p.full_name))}</div>
            <div style="min-width:0"><h2 style="font-size:22px" data-notr>${esc(displayName(p))}</h2><div class="t-meta">${esc(uniName(p.uni_id))}</div><div class="t-meta">${esc(p.degree || "")}</div>
            ${p.equals_verified ? '<div class="verified">✓ Verified with My eQuals</div>' : '<div class="verified" style="color:var(--muted)">Transcript checked</div>'}</div></div>
          <div class="rating-row"><span class="rating-big">${s.reviews_count ? Number(s.rating).toFixed(1) : "New"}</span><div>${stars(Number(s.rating || 0), 20)}<div class="muted" style="font-size:13px">${s.reviews_count || 0} review${s.reviews_count === 1 ? "" : "s"}</div></div></div>
          <div class="stats"><div><b>${s.answers_count || 0}</b><span>Answers</span></div><div><b>${money(Number(s.earned || 0))}</b><span>Earned</span></div><div><b>${s.answers_count ? Math.round((s.urgent_count || 0) / s.answers_count * 100) + "%" : "—"}</b><span>Early bird</span></div></div>
          ${p.bio ? `<p style="font-size:14px">${esc(p.bio)}</p>` : `<a href="#/profile">Add a short intro</a>`}
        </div>
        <div class="panel" style="gap:8px"><h3 style="font-size:18px">Question alerts</h3>
          <label class="check"><input type="checkbox" id="al-toggle" ${p.email_alerts ? "checked" : ""}><span>Email me at <b>${esc(S.user.email)}</b> when a question comes in for my courses</span></label>
          <small class="muted">Be first to claim it. At most one email every few minutes.</small></div>
        ${p.equals_verified ? "" : `<div class="panel" style="gap:10px"><h3 style="font-size:18px">Get the ✓ My eQuals checkmark</h3>
          <p class="muted" style="font-size:14px">${p.myequals_link ? "Thanks. We're checking your link and will add the checkmark once it matches your transcript." : "Share your transcript from My eQuals and paste the link. Verified tutors stand out to students."}</p>
          <div class="row"><input type="url" id="eq-link" value="${esc(p.myequals_link || "")}" placeholder="https://www.myequals.edu.au/…" style="flex:1;min-width:180px"><button class="btn sm" id="eq-save">${p.myequals_link ? "Update" : "Save link"}</button></div>
          <details><summary style="cursor:pointer;font-size:13px">How do I get a My eQuals link?</summary><ol style="margin:8px 0 0;padding-left:20px;font-size:13px;display:flex;flex-direction:column;gap:4px"><li>Order an official transcript from your uni. At UNSW, current students pay $20 and it's ready within 5 working days.</li><li>Open the email from My eQuals and sign in at myequals.edu.au.</li><li>Open your transcript, choose Share, then Public link (no PIN), with at least 30 days' expiry.</li><li>Copy the link and paste it here.</li></ol></details>
          <div id="eq-st" hidden></div></div>`}
        <div class="panel" style="gap:10px"><div class="row" style="justify-content:space-between"><h3 style="font-size:18px">Courses I can tutor</h3><a href="#/tutor/apply">Add courses</a></div>
          <ul class="courses">${(tcs || []).map(x => `<li><span class="code">${esc(x.code)}</span><span class="ttl" title="${esc(x.title)}">${esc(x.title)}</span><span class="grade">${x.mark}<span class="badge ${gcls(x.grade || gradeFor(x.mark))}">${esc(x.grade || gradeFor(x.mark))}</span></span></li>`).join("")}</ul>
          <small class="muted">You'll see questions in these courses and in similar courses at any uni.</small></div>
        <div class="panel" style="gap:4px"><h3 style="font-size:18px;margin-bottom:6px">Reviews</h3>
          ${(revs || []).length ? revs.map(v => `<div class="review"><div class="row" style="justify-content:space-between">${stars(v.stars)}<span class="muted" style="font-size:12px">${ago(v.created_at)}</span></div>${v.comment ? `<p style="font-size:14px">${esc(v.comment)}</p>` : ""}</div>`).join("") : `<p class="muted" style="font-size:14px">Reviews from students you help will appear here.</p>`}</div>
      </aside>
      <div class="col">
        <div class="earn-strip"><div><div class="eyebrow" style="color:inherit;opacity:.7">Earned so far</div><div class="earn-amt">${money(Number(s.earned || 0))}</div></div>
          <div class="earn-rules"><span><b>$1.10</b> per answer</span><span class="ebr"><b>$1.70</b> early bird, on marked questions answered within 20 min</span><span>Payouts start when payments launch. Your earnings are tracked from today.</span></div></div>
        <div class="pitch"><div class="pitch-main"><span class="eyebrow">Your earning potential</span><div class="pitch-big"><b>$1–2</b> every 3 minutes</div><p>Questions are 50 words or less, and you get 2 minutes to answer once you claim one. Look for the early bird tag to earn $1.70. Turn on email alerts and answer from your phone between classes.</p><div class="pitch-now">This week: <b>${s.week_count || 0}</b> answer${s.week_count === 1 ? "" : "s"}</div></div>
          <div class="goals"><div class="goal"><div class="row" style="justify-content:space-between"><b>Weekly goal</b><span class="mono">${Math.min(20, s.week_count || 0)}/20</span></div><div class="meter"><i style="width:${Math.min(100, (s.week_count || 0) * 5)}%"></i></div><small>Answer 20 questions this week to hit your goal.</small></div></div></div>
        <div id="ai-banner"></div>
        <div class="results-head"><h2>Pending questions</h2><span class="muted" style="font-size:13px">You can hold one question at a time</span></div>
        <div class="col" id="feed"><div class="boot" style="min-height:80px">Loading questions…</div></div>
      </div></div>`;
    $("#al-toggle").onchange = async e => { const on = e.target.checked; try { await saveProfile({ email_alerts: on, alerts_asked: true, email_alerts_at: on ? new Date().toISOString() : null }); toast(on ? "Email alerts are on" : "Email alerts are off"); } catch (err) { e.target.checked = !on; toast(errMsg(err)); } };
    if (!p.alerts_asked) setTimeout(askAlerts, 600);
    sb.from("answer_checks").select("ai_score, created_at").eq("flagged", true).eq("seen", false).order("created_at", { ascending: false }).then(({ data }) => {
      if (!data || !data.length || !$("#ai-banner")) return;
      $("#ai-banner").innerHTML = `<div class="status err ai-banner"><span><b>${data.length === 1 ? "One of your answers" : data.length + " of your answers"} looked AI-written</b> (up to ${Math.max(...data.map(x => x.ai_score))}%). Answers must be your own words. 3 flags within 30 days pauses your tutoring.</span><button class="btn sm" id="ai-dismiss">Got it</button></div>`;
      $("#ai-dismiss").onclick = async () => { await sb.rpc("dismiss_ai_warnings"); $("#ai-banner").innerHTML = ""; };
    });
    const eqSave = $("#eq-save");
    if (eqSave) eqSave.onclick = async () => {
      const link = $("#eq-link").value.trim();
      if (link && !/^https:\/\/([\w-]+\.)*myequals\.(edu\.au|net|org)\//i.test(link)) return status($("#eq-st"), "That doesn't look like a My eQuals link.", "err");
      try { await saveProfile({ myequals_link: link || null }); status($("#eq-st"), link ? "Saved. We'll check it and add your checkmark." : "Link removed.", "ok"); } catch (e) { status($("#eq-st"), errMsg(e), "err"); }
    };
    await renderFeed();
    every(20000, renderFeed);
    $("#feed").addEventListener("click", async e => {
      const c = e.target.closest("[data-claim]");
      if (c) {
        c.disabled = true;
        const { error } = await sb.rpc("claim_question", { q_id: c.dataset.claim });
        if (error) { toast(errMsg(error), 5000); c.disabled = false; return renderFeed(); }
        location.hash = "#/answer/" + c.dataset.claim;
      }
    });
  }
  async function renderFeed() {
    const el = $("#feed"); if (!el) return;
    const { data, error } = await sb.rpc("tutor_feed");
    if (error) { el.innerHTML = `<div class="status err">${esc(errMsg(error))}</div>`; return; }
    const now = Date.now();
    const holding = data.find(q => q.my_claim_expires && new Date(q.my_claim_expires) > now && q.my_position == null);
    const rank = q => (q.my_position != null ? 3 : 0) + (q.answer_count >= q.slots ? 2 : 0) + (q.urgent && new Date(q.created_at).getTime() + URGENT_MIN * 60e3 > now ? 0 : 1);
    data.sort((a, b) => rank(a) - rank(b) || new Date(b.created_at) - new Date(a.created_at));
    el.innerHTML = data.length ? data.map(q => feedCard(q, holding)).join("") : `<div class="empty">No open questions in your courses right now. New ones show up here automatically.</div>`;
    autoTranslate(el);
  }
  function feedCard(q, holding) {
    const now = Date.now(), ebEnd = new Date(q.created_at).getTime() + URGENT_MIN * 60e3;
    const eb = q.urgent && ebEnd > now;
    const full = q.answer_count >= q.slots, answered = q.my_position != null;
    const claimed = q.my_claim_expires && new Date(q.my_claim_expires) > now;
    const spots = q.slots - q.answer_count - q.held_by_others;
    const similar = q.match_code && (q.match_uni !== q.uni_id || q.match_code !== q.course_code);
    let action;
    if (answered) action = `<div class="elig yes">✓ You answered ${["1st", "2nd", "3rd", "4th", "5th"][q.my_position - 1]} · ${money(Number(q.my_payout))}${Number(q.my_payout) > PAY ? " (early bird)" : ""}</div>`;
    else if (new Date(q.expires_at) <= now) action = `<div class="muted" style="font-size:13px">This question has closed.</div>`;
    else if (claimed) action = `<div class="row" style="justify-content:space-between"><span class="muted" style="font-size:13px">Held for you · ${clock(new Date(q.my_claim_expires) - now)} left</span><a class="btn primary sm" href="#/answer/${q.id}">Continue answering</a></div>`;
    else if (full) action = `<div class="muted" style="font-size:13px">All ${q.slots} spots have been answered.</div>`;
    else if (spots <= 0) action = `<div class="muted" style="font-size:13px">All remaining spots are held by other tutors. Check back in a few minutes.</div>`;
    else action = `<div class="row" style="justify-content:space-between"><span class="muted" style="font-size:13px">${holding ? `Finish or release your <span class="mono">${esc(holding.course_code)}</span> question to claim this one` : `${spots} of ${q.slots} spot${q.slots > 1 ? "s" : ""} left`}</span><button class="btn primary sm" data-claim="${q.id}" ${holding ? "disabled" : ""}>Claim · 2 min to answer</button></div>`;
    return `<article class="q tq${answered || full ? " done" : ""}" data-trg>
      <div class="tq-head"><div class="avatar sm" aria-hidden="true">${esc(initials(q.asker_name))}</div>
        <div style="min-width:0;flex:1"><b data-notr>${esc(q.asker_name)}</b><div class="q-time">${esc(uniName(q.uni_id))} · ${ago(q.created_at)}</div></div>
        <div class="reward-box${eb ? " eb" : ""}">${eb ? `<span class="eb-tag">Early bird</span><b>${money(URGENT_PAY)}</b><small>${mins(ebEnd - now)} min left, then ${money(PAY)}</small>` : `<b>${money(PAY)}</b><small>Reward</small>`}</div></div>
      <div class="row" style="gap:6px"><span class="q-code">${esc(q.course_code)}</span><span class="muted" style="font-size:13px">${esc(q.course_title)}</span>${similar ? `<span class="simchip">Similar to your ${esc(q.match_code)}</span>` : ""}</div>
      ${(q.goals || []).length ? `<div class="goals-row"><span class="muted">After</span>${goalChips(q.goals)}</div>` : ""}
      <div data-trslot><p class="q-text" data-tr>${esc(q.body)}</p></div>
      ${q.attachment_name ? `<span class="fchip">${q.attachment_type === "application/pdf" ? "PDF" : "IMG"} · ${esc(q.attachment_name)} · ${kb(q.attachment_size || 0)}</span>` : ""}
      ${action}
    </article>`;
  }

  /* ---------------- answer editor (tutor) ---------------- */
  const drafts = {};
  async function pageAnswer(id) {
    app().innerHTML = `<div class="boot">Loading question…</div>`;
    const { data, error } = await sb.rpc("tutor_feed"); if (error) throw error;
    const q = data.find(x => x.id === id);
    if (!q) { app().innerHTML = `<div class="empty">This question isn't available to you. <a href="#/tutor">Back to questions</a></div>`; return; }
    if (q.my_position != null) { toast("You've already answered this question"); location.hash = "#/tutor"; return; }
    let claimUntil = q.my_claim_expires ? new Date(q.my_claim_expires) : null;
    const d = drafts[id] || (drafts[id] = { bubbles: [""], ann: null });
    const eb = () => q.urgent && new Date(q.created_at).getTime() + URGENT_MIN * 60e3 > Date.now();
    app().innerHTML = `<section class="view">
      <a href="#/tutor">← Pending questions</a>
      <div class="${q.attachment_path ? "answer-layout" : "medium"}">
        ${q.attachment_path ? `<div class="doc-wrap"><div class="doc-toolbar" role="toolbar" aria-label="Markup tools">
            <button class="tool" data-tool="pen" aria-pressed="true">Pen</button><button class="tool" data-tool="highlight" aria-pressed="false">Highlighter</button><button class="tool" data-tool="note" aria-pressed="false">Text note</button>
            <span style="width:8px"></span>${DocView.COLORS.map((c, i) => `<button class="swatch" data-color="${c}" style="background:${c}" aria-label="Colour ${i + 1}" aria-pressed="${i === 0}"></button>`).join("")}
            <span style="flex:1"></span><button class="tool" id="undo">Undo</button><button class="tool" id="clear">Clear</button></div>
            <p class="muted" style="font-size:13px">Draw or add text notes directly on the student's document. You can't upload files.</p>
            <div id="doc"></div></div>` : ""}
        <div class="${q.attachment_path ? "answer-side" : "col"}">
          <article class="q">
            <div class="tq-head"><div class="avatar sm" aria-hidden="true">${esc(initials(q.asker_name))}</div><div style="flex:1;min-width:0"><b data-notr>${esc(q.asker_name)}</b><div class="q-time">${esc(uniName(q.uni_id))} · ${ago(q.created_at)}</div></div>
              <div class="reward-box${eb() ? " eb" : ""}" id="reward"></div></div>
            <div class="row" style="gap:6px"><span class="q-code">${esc(q.course_code)}</span><span class="muted" style="font-size:13px">${esc(q.course_title)}</span></div>
            <div data-trslot><p class="q-text" style="font-size:16px" data-tr>${esc(q.body)}</p></div>
            ${(q.goals || []).length ? `<div class="goals-row"><span class="muted">The student is after</span>${goalChips(q.goals)}</div>` : ""}
          </article>
          <div class="panel" style="gap:12px">
            <div class="row" style="justify-content:space-between"><h3 style="font-size:18px">Your answer</h3><span class="claim-clock" id="claim-state"></span></div>
            <p class="muted" style="font-size:13px">You have <b>2 minutes</b> from claiming. Type it yourself: pasting is turned off, the question can't be copied, and every answer is checked for AI writing.</p>
            <div class="composer-bubbles" id="bubbles"></div>
            <div class="row" style="justify-content:space-between"><button class="btn sm" id="add-b">+ Add another message</button><span class="counter" id="total"></span></div>
            <div id="st" hidden></div>
            <div class="row" style="justify-content:space-between"><button class="btn ghost" id="release">Release question</button><button class="btn primary" id="submit">Submit answer</button></div>
          </div>
        </div>
      </div></section>`;
    // claim if not yet held
    async function ensureClaim() {
      if (claimUntil && claimUntil > new Date()) return true;
      const { data: until, error } = await sb.rpc("claim_question", { q_id: id });
      if (error) { status($("#st"), errMsg(error), "err"); return false; }
      claimUntil = new Date(until); paintClaim(); return true;
    }
    function paintClaim() {
      const el = $("#claim-state"); if (!el) return;
      const leftMs = claimUntil ? claimUntil - Date.now() : 0;
      el.className = "claim-clock" + (leftMs > 0 && leftMs < 30e3 ? " low" : "") + (leftMs <= 0 ? " over" : "");
      el.textContent = leftMs > 0 ? `${clock(leftMs)} left to answer` : "Time's up. Submitting still works if a spot is free.";
      $("#reward").innerHTML = eb() ? `<span class="eb-tag">Early bird</span><b>${money(URGENT_PAY)}</b><small>${mins(new Date(q.created_at).getTime() + URGENT_MIN * 60e3 - Date.now())} min left, then ${money(PAY)}</small>` : `<b>${money(PAY)}</b><small>Reward</small>`;
    }
    const qa = app().querySelector("article.q"); if (qa) { qa.setAttribute("data-trg", ""); autoTranslate(app()); }
    await ensureClaim(); paintClaim();
    every(1000, paintClaim);

    function renderBubbles() {
      $("#bubbles").innerHTML = d.bubbles.map((b, i) => `<div class="b-row"><textarea class="prose" data-b="${i}" maxlength="800" placeholder="${i === 0 ? "Start with the key idea…" : "Add more detail…"}" aria-label="Message ${i + 1}">${esc(b)}</textarea>${d.bubbles.length > 1 ? `<button class="btn ghost sm" data-rm="${i}" aria-label="Remove message ${i + 1}">×</button>` : ""}</div>`).join("");
      updateTotal();
    }
    function updateTotal() { const t = d.bubbles.reduce((a, b) => a + b.length, 0); const el = $("#total"); el.textContent = `${t} / 2500 characters`; el.classList.toggle("over", t > 2500); }
    $("#bubbles").addEventListener("input", e => { const i = e.target.dataset.b; if (i != null) { d.bubbles[+i] = e.target.value; updateTotal(); } });
    // Typing only: no pasting, dropping or inserting text any other way. Count what's actually typed.
    d.typed = d.typed || 0;
    $("#bubbles").addEventListener("beforeinput", e => {
      const t = e.inputType || "";
      if (/^insertFrom(Paste|Drop|Yank|PasteAsQuotation)$/.test(t)) { e.preventDefault(); toast("Pasting is turned off. Type your answer yourself."); return; }
      if (/^insert(Text|CompositionText|ReplacementText)$/.test(t) && e.data) d.typed += e.data.length;
      if (/^insert(LineBreak|Paragraph)$/.test(t)) d.typed += 1;
    });
    ["paste", "drop"].forEach(ev => $("#bubbles").addEventListener(ev, e => { e.preventDefault(); toast("Pasting is turned off. Type your answer yourself."); }));
    // The question can't be copied either
    const lock = el => { if (!el) return; el.classList.add("nocopy"); ["copy", "cut", "contextmenu", "selectstart", "dragstart"].forEach(ev => el.addEventListener(ev, e => { e.preventDefault(); if (ev === "copy" || ev === "cut") toast("Questions can't be copied."); })); };
    lock(app().querySelector("article.q")); lock($("#doc"));
    $("#bubbles").addEventListener("click", e => { const r = e.target.closest("[data-rm]"); if (r) { d.bubbles.splice(+r.dataset.rm, 1); renderBubbles(); } });
    $("#add-b").onclick = () => { if (d.bubbles.length >= 10) return toast("Up to 10 messages per answer."); d.bubbles.push(""); renderBubbles(); $$("#bubbles textarea").pop().focus(); };
    renderBubbles();

    let docApi = null;
    if (q.attachment_path) {
      try {
        docApi = await DocView.mount($("#doc"), { url: await signedUrl("attachments", q.attachment_path), type: q.attachment_type, editable: true, annotations: d.ann, onChange: () => { d.ann = docApi.annotations; } });
      } catch (e) { $("#doc").innerHTML = `<div class="status err">${esc(errMsg(e))}</div>`; }
      $$(".doc-toolbar [data-tool]").forEach(b => b.onclick = () => { $$(".doc-toolbar [data-tool]").forEach(x => x.setAttribute("aria-pressed", x === b)); docApi && docApi.setTool(b.dataset.tool); });
      $$(".doc-toolbar [data-color]").forEach(b => b.onclick = () => { $$(".doc-toolbar [data-color]").forEach(x => x.setAttribute("aria-pressed", x === b)); docApi && docApi.setColor(b.dataset.color); });
      $("#undo").onclick = () => docApi && docApi.undo();
      $("#clear").onclick = () => { if (!docApi) return; openModal(`<h3>Clear all markup?</h3><p class="muted">This removes every drawing and note on the document.</p><div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="cl-go">Clear markup</button></div>`, m => { $("#cl-go", m).onclick = () => { docApi.clear(); closeModal(); }; }); };
    }

    $("#release").onclick = async () => { await sb.rpc("release_claim", { q_id: id }); delete drafts[id]; toast("Question released"); location.hash = "#/tutor"; };
    $("#submit").onclick = async () => {
      const bubbles = d.bubbles.map(b => b.trim()).filter(Boolean);
      const total = bubbles.reduce((a, b) => a + b.length, 0);
      if (!bubbles.length || total < 30) return status($("#st"), "Write at least 30 characters so the answer is useful.", "err");
      if (total > 2500) return status($("#st"), "Keep the whole answer under 2,500 characters.", "err");
      $("#submit").disabled = true; status($("#st"), "Submitting…", "", true);
      const { data: row, error } = await sb.rpc("submit_answer", { q_id: id, p_bubbles: bubbles, p_annotations: docApi ? docApi.annotations : {} });
      $("#submit").disabled = false;
      if (error) return status($("#st"), errMsg(error), "err");
      const r = Array.isArray(row) ? row[0] : row;
      const typed = Math.min(d.typed || 0, total);
      delete drafts[id];
      toast(`Answer sent. ${money(Number(r && r.payout || PAY))} added to your earnings${r && r.urgent_rate ? " (early bird)" : ""}.`, 4500);
      // AI-writing check runs in the background; a flagged answer gets a warning straight away
      if (r && r.id) sb.functions.invoke("check-answer", { body: { answer_id: r.id, typed, total } }).then(({ data }) => {
        if (data && data.flagged) aiWarning(data.ai_score);
      }).catch(() => { });
      location.hash = "#/tutor";
    };
  }

  /* ---------------- tutor application ---------------- */
  async function pageTutorApply() {
    const p = S.profile;
    const A = { step: 1, courses: [], file: null, path: null, myequals: "", agree: [false, false, false] };
    app().innerHTML = `<div class="medium"><div class="col">
      <div><span class="eyebrow">Tutor application</span><h1 style="font-size:30px;margin-top:4px">Become a Distinction tutor</h1></div>
      <div class="steps" id="steps"></div><div class="panel" id="body"></div></div></div>`;
    const STEPS = ["Tutor profile", "Transcript", "Verification", "Submit"];
    const paintSteps = () => $("#steps").innerHTML = STEPS.map((s, i) => `<span class="${i + 1 === A.step ? "on" : i + 1 < A.step ? "done" : ""}">${i + 1}. ${s}</span>`).join("");
    let readProfile = null;

    async function step1() {
      const pr = S.profile;
      $("#body").innerHTML = `<h2>Your tutor profile</h2>
        <p class="muted" style="font-size:14px">Students see your display name, uni, degree and this intro. You can change your details anytime in <a href="#/profile">Profile and settings</a>.</p>
        <dl class="kv"><dt>Display name</dt><dd>${esc(pr.display_name || "")}</dd><dt>University</dt><dd>${esc(uniName(pr.uni_id))}</dd><dt>Degree</dt><dd>${esc(pr.degree || "")}</dd></dl>
        <div id="fields" class="col"></div><div id="st" hidden></div><div class="row" style="justify-content:flex-end"><button class="btn primary" id="next">Continue</button></div>`;
      readProfile = await profileFields($("#fields"), pr, { tutor: true, parts: ["bio"] });
      $("#next").onclick = async () => {
        const v = readProfile();
        if (!v.bio || v.bio.length < 20) return status($("#st"), "Write a short intro of at least 20 characters, like what you're good at explaining.", "err");
        try { await saveProfile(v); A.step = A.path ? 3 : 2; render(); } catch (e) { status($("#st"), errMsg(e), "err"); }
      };
    }
    function step2() {
      $("#body").innerHTML = `<h2>Upload your transcript</h2>
        <p class="muted" style="font-size:14px">Upload your official academic transcript or statement as a PDF or screenshot. Marks come straight from the document and can't be typed in or changed.</p>
        <div class="ai-note"><span class="ai-spark" aria-hidden="true">✦</span><span><b>Our AI reads your transcript for you.</b> It scans the document and pulls out every course code and mark. This takes about 10 to 20 seconds, so keep this page open.</span></div>
        <div class="ai-note privacy"><span class="ai-spark" aria-hidden="true">🔒</span><span><b>Your personal details are scrubbed.</b> The AI is set up to ignore your name, student number, address, date of birth and any other personal information. Your transcript file is deleted from our records as soon as it has been read. Only your courses and their marks are saved.</span></div>
        <label class="drop" id="drop" for="tfile"><strong>${A.file ? esc(A.file.name) : "Drop your transcript here"}</strong><span class="muted" style="font-size:14px">PDF or image, up to 10 MB. Or click to choose a file.</span><input type="file" id="tfile" accept="${FILE_TYPES.join(",")}" hidden></label>
        <div id="st" hidden></div>
        <div id="tbl"></div>
        <div class="row" style="justify-content:space-between"><button class="btn ghost" id="back">Back</button><button class="btn primary" id="next">Continue</button></div>`;
      const drop = $("#drop");
      ["dragover", "dragenter"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
      ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
      drop.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) take(f); });
      $("#tfile").onchange = e => { const f = e.target.files[0]; if (f) take(f); };
      let busy = false;
      async function take(f) {
        if (busy) return;
        if (!FILE_TYPES.includes(f.type)) return status($("#st"), "Upload a PDF or an image (PNG, JPG or WebP).", "err");
        if (f.size > 10 * 1024 * 1024) return status($("#st"), "That file is over 10 MB.", "err");
        busy = true; $("#next").disabled = true;
        A.file = f; A.path = null; A.courses = []; A.scanned = false; drop.querySelector("strong").textContent = f.name; table();
        status($("#st"), "Uploading your transcript…", "", true);
        const path = `${S.user.id}/${Date.now()}-${f.name.replace(/[^\w.\-]+/g, "_").slice(-80)}`;
        const up = await sb.storage.from("transcripts").upload(path, f, { contentType: f.type });
        if (up.error) { A.file = null; busy = false; $("#next").disabled = false; return status($("#st"), errMsg(up.error), "err"); }
        A.path = path;
        status($("#st"), "");
        const scan = scanAnimation($("#tbl"));
        try {
          const { data, error } = await sb.functions.invoke("scan-transcript", { body: { path } });
          A.scanResult = data || null;
          if (!error && data && Array.isArray(data.courses)) { A.courses = data.courses.sort((a, b) => b.mark - a.mark); A.scanned = true; }
        } catch (e) { /* handled below */ }
        await scan.finish(A.courses.length > 0);
        busy = false; $("#next").disabled = false;
        const n = A.courses.filter(c => c.mark >= 75).length;
        A.duplicate = !!(A.scanResult && A.scanResult.duplicate);
        if (A.duplicate) status($("#st"), "This transcript is already registered to another Distinction account, so it can't be used again. Each tutor must use their own transcript.", "err");
        else if (!A.courses.length) status($("#st"), "The AI couldn't find any courses with marks in that file. Try a clearer PDF or a full-page screenshot of your transcript. Your file has already been deleted.", "err");
        else if (!n) status($("#st"), `The AI found ${A.courses.length} courses, but none has a mark of 75 or more yet, so there's nothing to tutor. Your file has been deleted.`, "err");
        else status($("#st"), `Done. Your file has been deleted. The AI found ${A.courses.length} courses, and ${n} ${n === 1 ? "has" : "have"} a mark of 75 or more, so you can tutor ${n === 1 ? "it" : "them"}.`, "ok");
        table();
      }
      function table() {
        if (!A.courses.length) { $("#tbl").innerHTML = ""; return; }
        $("#tbl").innerHTML = `<p style="font-size:14px;margin:0"><b>What the AI read from your transcript</b></p><div class="table-wrap"><table><thead><tr><th>Code</th><th>Course</th><th>Mark</th><th>Grade</th><th></th></tr></thead><tbody>
          ${A.courses.map(c => `<tr class="${c.mark >= 75 ? "" : "ineligible"}"><td class="mono">${esc(c.code)}</td><td>${esc(c.title)}</td><td class="num">${c.mark}</td><td><span class="badge ${gcls(c.grade || gradeFor(c.mark))}">${esc(c.grade || gradeFor(c.mark))}</span></td><td>${c.mark >= 75 ? '<span class="elig yes">Can tutor</span>' : '<span class="elig">Below 75</span>'}</td></tr>`).join("")}
          </tbody></table></div>
          <p class="muted" style="font-size:13px">Something missing or wrong? Upload a clearer copy and the AI will read it again.</p>`;
      }
      table();
      $("#back").onclick = () => { A.step = 1; render(); };
      $("#next").onclick = () => {
        if (busy) return;
        if (!A.path) return status($("#st"), "Upload your transcript first.", "err");
        if (A.duplicate) return status($("#st"), "This transcript is already registered to another account, so it can't be used again.", "err");
        if (!A.courses.some(c => c.mark >= 75)) return status($("#st"), "You need at least one course with a mark of 75 or more to tutor. Upload a different transcript if this one's wrong.", "err");
        A.step = 3; render();
      };
    }
    function step3() {
      const rules = ["I'll explain concepts in my own words and won't complete assessable work for students.", "I won't share past assignments, exam answers or files. I'll only answer with text and markup on the student's document.", "The transcript I uploaded is my own, official and unedited. Using someone else's transcript gets my account removed."];
      $("#body").innerHTML = `<h2>Verification</h2>
        <p class="muted" style="font-size:14px">Add a My eQuals link to get a <b>✓ My eQuals</b> checkmark on your profile. My eQuals is the official digital transcript service used by Australian universities. It's optional: you can skip it now and add it later from your tutor profile.</p>
        <div class="panel" style="background:var(--surface-2);gap:10px;padding:16px">
          <b style="font-family:var(--display);font-size:17px">How to get your My eQuals link</b>
          <ol style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px;font-size:14px">
            <li><b>Order an official transcript from your uni.</b> Most Australian universities issue transcripts through My eQuals. Graduates may already have one in their account. At UNSW, current students order a Standard Academic Transcript online for $20, and it's ready within 5 working days. Other unis vary, so check your uni's transcript page.</li>
            <li><b>Open the email from My eQuals</b> when your transcript is ready, and create your account or sign in at <a href="https://www.myequals.edu.au/" target="_blank" rel="noopener noreferrer">myequals.edu.au</a>.</li>
            <li><b>Open your academic transcript and choose Share.</b> Pick <b>Public link</b> (without a PIN) and set the expiry to at least 30 days, so our reviewer can open it.</li>
            <li><b>Copy the link</b> and paste it below.</li>
          </ol>
          <small class="muted">Waiting on your My eQuals transcript? Skip this for now and add the link later from your tutor profile.</small>
        </div>
        <label class="field"><span>My eQuals share link (optional)</span><input type="url" id="eq" value="${esc(A.myequals)}" placeholder="https://www.myequals.edu.au/…"></label>
        <div class="agree">${rules.map((r, i) => `<label class="check"><input type="checkbox" data-ag="${i}" ${A.agree[i] ? "checked" : ""}><span>${r}</span></label>`).join("")}</div>
        <div id="st" hidden></div>
        <div class="row" style="justify-content:space-between"><button class="btn ghost" id="back">Back</button><button class="btn primary" id="next">Continue</button></div>`;
      $("#body").onchange = e => { if (e.target.dataset.ag != null) A.agree[+e.target.dataset.ag] = e.target.checked; };
      $("#back").onclick = () => { A.myequals = $("#eq").value.trim(); A.step = 2; render(); };
      $("#next").onclick = () => {
        A.myequals = $("#eq").value.trim();
        if (A.myequals && !/^https:\/\/([\w-]+\.)*myequals\.(edu\.au|net|org)\//i.test(A.myequals)) return status($("#st"), "That doesn't look like a My eQuals link. It should start with https://www.myequals.edu.au/ or https://myequals.org/", "err");
        if (A.agree.some(x => !x)) return status($("#st"), "Tick all three boxes to continue.", "err");
        A.step = 4; render();
      };
    }
    function step4() {
      const good = A.courses.filter(c => c.mark >= 75);
      $("#body").innerHTML = `<h2>Review and submit</h2>
        <dl class="kv"><dt>Name</dt><dd>${esc(S.profile.full_name || "")} (${esc(S.profile.display_name || "")})</dd><dt>University</dt><dd>${esc(uniName(S.profile.uni_id))}</dd><dt>Degree</dt><dd>${esc(S.profile.degree || "")}</dd><dt>Transcript</dt><dd>Read by AI, then deleted</dd><dt>My eQuals</dt><dd>${A.myequals ? "Link provided" : "Not yet. You can add it later for the checkmark."}</dd></dl>
        ${good.length ? `<p style="font-size:14px"><b>You'll be approved to tutor these ${good.length} course${good.length === 1 ? "" : "s"} straight away</b></p><ul class="courses">${good.map(c => `<li><span class="code">${esc(c.code)}</span><span class="ttl">${esc(c.title)}</span><span class="grade">${c.mark}<span class="badge ${gcls(c.grade || gradeFor(c.mark))}">${esc(c.grade || gradeFor(c.mark))}</span></span></li>`).join("")}</ul>` : `<div class="status err">No courses with a mark of 75 or more. Go back and upload your transcript.</div>`}
        <div id="st" hidden></div>
        <div class="row" style="justify-content:space-between"><button class="btn ghost" id="back">Back</button><button class="btn primary" id="go" ${good.length ? "" : "disabled"}>Submit and start tutoring</button></div>`;
      $("#back").onclick = () => { A.step = 3; render(); };
      $("#go").onclick = async () => {
        $("#go").disabled = true; status($("#st"), "Submitting…", "", true);
        const { data, error } = await sb.rpc("submit_tutor_application", { p_transcript_path: A.path, p_transcript_name: A.file.name, p_myequals: A.myequals });
        if (error) { $("#go").disabled = false; return status($("#st"), errMsg(error), "err"); }
        await loadProfile(); renderHeader();
        if (!data) { toast("Application rejected"); location.hash = "#/tutor"; return; }
        toast("You're approved. Welcome aboard!"); location.hash = "#/tutor";
      };
    }
    function render() { paintSteps(); ({ 1: step1, 2: step2, 3: step3, 4: step4 })[A.step](); window.scrollTo(0, 0); }
    // Resume: reuse the most recent scanned transcript so tutors can come back once their My eQuals link arrives
    const { data: last } = await sb.from("transcript_scans").select("path, courses, created_at").eq("user_id", S.user.id).order("created_at", { ascending: false }).limit(1);
    if (last && last[0] && Date.now() - new Date(last[0].created_at) < 60 * 864e5) {
      A.path = last[0].path; A.courses = (last[0].courses || []).sort((a, b) => b.mark - a.mark);
      A.file = { name: last[0].path.split("/").pop().replace(/^\d+-/, "") };
    }
    render();
  }

  async function pdfText(file) {
    const doc = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    let out = "";
    for (let n = 1; n <= Math.min(doc.numPages, 10); n++) {
      const page = await doc.getPage(n); const tc = await page.getTextContent();
      // rebuild rows: group text pieces by vertical position, then read left to right
      const rows = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const y = it.transform[5], x = it.transform[4];
        let row = rows.find(r => Math.abs(r.y - y) < 3);
        if (!row) rows.push(row = { y, items: [] });
        row.items.push({ x, s: it.str });
      }
      rows.sort((a, b) => b.y - a.y);
      out += rows.map(r => r.items.sort((a, b) => a.x - b.x).map(i => i.s).join(" ")).join("\n") + "\n";
    }
    return out.replace(/\b([A-Z]{4})\s(\d{4})\b/g, "$1$2");
  }
  function parseTranscript(text) {
    const out = [], seen = new Set();
    const codeRe = /\b([A-Z]{2,5}\d{3,5}[A-Z]?|[A-Z]{3}\d[A-Z]{2,3}|\d{5,6})\b/;
    for (const raw of text.split(/\n/)) {
      const line = raw.replace(/\s+/g, " ").trim(); const m = line.match(codeRe); if (!m) continue;
      const code = m[1]; if (seen.has(code) || /^(19|20)\d\d$/.test(code)) continue;
      const after = line.slice(line.indexOf(code) + code.length);
      const gradeM = after.match(/\b(HD|DN|DI|D|CR|C|PS|P|FL|F|N|H1|H2A|H2B|H3)\b(?!.*\b(HD|DN|DI|CR|PS|FL)\b)/);
      const nums = [...after.matchAll(/(?<![\d.])(\d{1,3})(?:\.\d+)?(?![\d.])/g)].map(x => +x[1]).filter(n => n <= 100);
      const mark = nums.length ? nums[nums.length - 1] : null;
      if (mark == null) continue;
      const title = after.replace(/\b20\d\d\b.*$/, "").replace(/\b(T|S|Term|Sem(ester)?)\s?[0-3]\b.*$/i, "").replace(/\d.*$/, "").trim().slice(0, 80);
      seen.add(code);
      out.push({ code, title, mark, grade: gradeM ? gradeM[1] : gradeFor(mark) });
    }
    return out.sort((a, b) => b.mark - a.mark);
  }

  /* ---------------- admin ---------------- */
  async function pageAdmin() {
    if (!S.profile.is_admin) { app().innerHTML = `<div class="empty">Admins only.</div>`; return; }
    app().innerHTML = `<section class="view"><div class="results-head"><h1 style="font-size:30px">Admin</h1><div class="seg" style="min-width:360px"><label><input type="radio" name="ad" value="apps" checked><span>Applications</span></label><label><input type="radio" name="ad" value="equals"><span>My eQuals</span></label><label><input type="radio" name="ad" value="reports"><span>Reports</span></label><label><input type="radio" name="ad" value="ai"><span>AI flags</span></label></div></div><div id="ad-body"></div></section>`;
    document.querySelectorAll('input[name="ad"]').forEach(r => r.onchange = () => r.value === "apps" ? adminApps() : r.value === "equals" ? adminEquals() : r.value === "ai" ? adminAI() : adminReports());
    adminApps();
  }
  async function adminApps(selected) {
    const body = $("#ad-body");
    const { data: apps, error } = await sb.from("tutor_applications").select("*, applicant:profiles!tutor_applications_user_id_fkey(full_name, display_name, uni_id, degree, year_of_study)").eq("status", "pending").order("submitted_at");
    if (error) { body.innerHTML = `<div class="status err">${esc(errMsg(error))}</div>`; return; }
    if (!apps.length) { body.innerHTML = `<div class="empty">No applications waiting for review.</div>`; return; }
    const cur = apps.find(a => a.id === selected) || apps[0];
    body.innerHTML = `<div class="admin-grid"><div class="col"><div id="ad-doc"></div></div><div class="col">
      <div class="app-list">${apps.map(a => `<button class="app-item" data-app="${a.id}" aria-current="${a.id === cur.id}"><span><b>${esc(a.applicant ? a.applicant.full_name : "Unknown")}</b><br><span class="muted" style="font-size:13px">${esc(uniShort(a.applicant && a.applicant.uni_id))} · ${ago(a.submitted_at)}</span></span><span class="status-pill pending">Pending</span></button>`).join("")}</div>
      <div class="panel" id="ad-form"></div></div></div>`;
    body.querySelectorAll("[data-app]").forEach(b => b.onclick = () => adminApps(b.dataset.app));
    const { data: tcs } = await sb.from("tutor_courses").select("*").eq("application_id", cur.id).order("mark", { ascending: false });
    const a = cur.applicant || {};
    $("#ad-form").innerHTML = `<h2 style="font-size:20px">${esc(a.full_name || "")}</h2>
      <dl class="kv"><dt>Display name</dt><dd>${esc(a.display_name || "")}</dd><dt>University</dt><dd>${esc(uniName(a.uni_id))}</dd><dt>Degree</dt><dd>${esc(a.degree || "")} · ${esc(a.year_of_study || "")}</dd><dt>My eQuals</dt><dd>${cur.myequals_link ? `<a href="${esc(cur.myequals_link)}" target="_blank" rel="noopener noreferrer">Open share link ↗</a>` : "Not provided"}</dd></dl>
      <p class="muted" style="font-size:13px">Tick the courses that match the transcript.</p>
      <div class="table-wrap"><table><thead><tr><th></th><th>Code</th><th>Course</th><th>Mark</th><th>Grade</th></tr></thead><tbody>
      ${(tcs || []).map(c => `<tr><td><input type="checkbox" data-c="${c.id}" checked aria-label="Approve ${esc(c.code)}"></td><td class="mono">${esc(c.code)}</td><td>${esc(c.title)}</td><td class="num">${c.mark}</td><td>${esc(c.grade || "")}</td></tr>`).join("")}</tbody></table></div>
      <details><summary style="cursor:pointer;font-size:14px;font-weight:500">Add a course the scan missed</summary><div class="row" style="margin-top:8px"><input type="text" id="ad-code" placeholder="Code" style="width:110px;font-family:var(--mono);text-transform:uppercase"><input type="text" id="ad-title" placeholder="Course name" style="flex:1;min-width:140px"><input type="number" id="ad-mark" placeholder="Mark" min="75" max="100" style="width:80px"><input type="text" id="ad-grade" placeholder="Grade" style="width:70px"><button class="btn sm" id="ad-add">Add</button></div></details>
      ${cur.myequals_link ? '<label class="check"><input type="checkbox" id="ad-eq"> I opened the My eQuals link and it matches. Give the ✓ My eQuals checkmark.</label>' : '<input type="checkbox" id="ad-eq" hidden>'}
      <label class="field"><span>Note to applicant (shown if rejected)</span><textarea class="prose" id="ad-notes" style="min-height:60px" maxlength="500"></textarea></label>
      <div id="st" hidden></div>
      <div class="row" style="justify-content:space-between"><button class="btn" id="ad-reject">Reject</button><button class="btn primary" id="ad-approve">Approve ticked courses</button></div>`;
    try {
      const url = await signedUrl("transcripts", cur.transcript_path);
      const type = /\.pdf$/i.test(cur.transcript_path) ? "application/pdf" : "image/png";
      await DocView.mount($("#ad-doc"), { url, type, editable: false });
    } catch (e) { $("#ad-doc").innerHTML = `<div class="status">The transcript file was deleted after the AI read it. The courses and marks below are what it found.</div>`; }
    const decide = async approve => {
      const ids = $$("#ad-form [data-c]").filter(x => x.checked).map(x => +x.dataset.c);
      if (approve && !ids.length) return status($("#st"), "Tick at least one course, or reject the application.", "err");
      const { error } = await sb.rpc("admin_review_application", { p_app: cur.id, p_approve: approve, p_equals: $("#ad-eq").checked, p_course_ids: ids, p_notes: $("#ad-notes").value.trim() || null });
      if (error) return status($("#st"), errMsg(error), "err");
      toast(approve ? "Approved" : "Rejected"); adminApps();
    };
    $("#ad-add").onclick = async () => {
      const { error } = await sb.rpc("admin_add_course", { p_app: cur.id, p_code: $("#ad-code").value.trim(), p_title: $("#ad-title").value.trim(), p_mark: +$("#ad-mark").value, p_grade: $("#ad-grade").value.trim() });
      if (error) return status($("#st"), errMsg(error), "err");
      toast("Course added"); adminApps(cur.id);
    };
    $("#ad-approve").onclick = () => decide(true);
    $("#ad-reject").onclick = () => decide(false);
  }
  async function adminEquals() {
    const body = $("#ad-body");
    const { data, error } = await sb.from("profiles").select("id, full_name, display_name, uni_id, myequals_link, equals_verified").not("myequals_link", "is", null).neq("tutor_status", "none").order("equals_verified");
    if (error) { body.innerHTML = `<div class="status err">${esc(errMsg(error))}</div>`; return; }
    body.innerHTML = data.length ? `<div class="col">${data.map(t => `<div class="answer-card"><div class="row" style="justify-content:space-between"><span><b>${esc(t.full_name || "")}</b> <span class="muted">${esc(uniShort(t.uni_id))}</span></span><span class="status-pill ${t.equals_verified ? "approved" : "pending"}">${t.equals_verified ? "Verified" : "To check"}</span></div>
      <a href="${esc(t.myequals_link)}" target="_blank" rel="noopener noreferrer">Open My eQuals link ↗</a>
      <div class="row" style="justify-content:flex-end">${t.equals_verified ? `<button class="btn sm" data-eqv="${t.id}:0">Remove checkmark</button>` : `<button class="btn primary sm" data-eqv="${t.id}:1">Matches: give checkmark</button>`}</div></div>`).join("")}</div>` : `<div class="empty">No My eQuals links to check.</div>`;
    body.onclick = async e => {
      const b = e.target.closest("[data-eqv]"); if (!b) return;
      const [uid, v] = b.dataset.eqv.split(":");
      const { error } = await sb.rpc("admin_set_equals", { p_user: uid, p_verified: v === "1" });
      if (error) return toast(errMsg(error)); toast(v === "1" ? "Checkmark given" : "Checkmark removed"); adminEquals();
    };
  }
  async function adminReports() {
    const body = $("#ad-body");
    const { data, error } = await sb.from("reports").select("*, answer:answers(bubbles, tutor_id, question_id, created_at)").order("created_at", { ascending: false }).limit(50);
    if (error) { body.innerHTML = `<div class="status err">${esc(errMsg(error))}</div>`; return; }
    body.innerHTML = data.length ? `<div class="col">${data.map(r => `<div class="answer-card"><div class="row" style="justify-content:space-between"><b>Report</b><span class="muted" style="font-size:12px">${ago(r.created_at)}</span></div><p>${esc(r.reason || "")}</p><div class="bubbles">${((r.answer && r.answer.bubbles) || []).map(b => `<div class="bubble">${esc(b)}</div>`).join("")}</div></div>`).join("")}</div>` : `<div class="empty">No reports.</div>`;
  }

  async function adminAI() {
    const body = $("#ad-body");
    const { data, error } = await sb.from("answer_checks").select("ai_score, typed_ratio, reason, created_at, answer:answers(bubbles, question_id), tutor:profiles!answer_checks_tutor_id_fkey(id, full_name, display_name, ai_flags, uni_id, tutor_paused)").eq("flagged", true).order("created_at", { ascending: false }).limit(50);
    if (error) { body.innerHTML = `<div class="status err">${esc(errMsg(error))}</div>`; return; }
    body.innerHTML = data.length ? `<div class="col">${data.map(c => `<div class="answer-card"><div class="row" style="justify-content:space-between"><span><b>${esc(c.tutor ? c.tutor.full_name || c.tutor.display_name : "Tutor")}</b> <span class="muted">${esc(uniShort(c.tutor && c.tutor.uni_id))} · ${c.tutor ? c.tutor.ai_flags : 0} flag${c.tutor && c.tutor.ai_flags === 1 ? "" : "s"} in total</span></span><span class="row" style="gap:6px">${c.tutor && c.tutor.tutor_paused ? `<span class="status-pill pending">Paused</span><button class="btn sm" data-unpause="${c.tutor.id}">Lift pause</button>` : ""}<span class="status-pill rejected">${c.ai_score}% AI</span></span></div>
      <p class="muted" style="font-size:13px">${esc(c.reason || "")}${c.typed_ratio != null ? ` · ${Math.round(c.typed_ratio * 100)}% typed` : ""} · ${ago(c.created_at)}</p>
      <div class="bubbles">${((c.answer && c.answer.bubbles) || []).map(b => `<div class="bubble">${esc(b)}</div>`).join("")}</div></div>`).join("")}</div>` : `<div class="empty">No answers flagged for AI writing.</div>`;
    body.onclick = async e => {
      const b = e.target.closest("[data-unpause]"); if (!b) return;
      b.disabled = true;
      const { error } = await sb.rpc("admin_unpause_tutor", { p_user: b.dataset.unpause });
      if (error) { toast(errMsg(error)); b.disabled = false; return; }
      toast("Pause lifted. Earlier flags no longer count."); adminAI();
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
    if (/access_token|error_description|type=recovery/.test(location.hash)) history.replaceState(null, "", location.pathname + "#/");
    S.ready = true;
    const after = sessionStorage.getItem("after-login");
    if (S.user && after) { sessionStorage.removeItem("after-login"); location.hash = after; }
    route();
    // Supabase deadlocks if its own methods are awaited inside this callback, so defer the work
    sb.auth.onAuthStateChange((event, session) => { setTimeout(() => onAuth(event, session), 0); });
    async function onAuth(event, session) {
      const prevUser = S.user && S.user.id;
      S.session = session; S.user = session ? session.user : null;
      if (event === "PASSWORD_RECOVERY") { location.hash = "#/new-password"; return; }
      if ((S.user && S.user.id) !== prevUser) {
        await loadProfile();
        if (event === "SIGNED_IN") { const a = sessionStorage.getItem("after-login"); sessionStorage.removeItem("after-login"); if (a && a !== location.hash) { location.hash = a; return; } if (["#/login", "#/signup", "#/signup/student", "#/signup/tutor", ""].includes(location.hash) || location.hash.startsWith("#/signup")) { location.hash = "#/"; return; } }
        route();
      }
    }
  }
  boot();
})();
