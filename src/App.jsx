import { useEffect, useState } from "react";
import { DAYS, TH, LB, TM, COL, ALL, parseSlots, owner, ruleCols, ruleHits, clashes } from "./slots";
import courseCatalog from "./courseCatalog.json";
import { onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut as firebaseSignOut } from "firebase/auth";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { auth, db, FIREBASE_CONFIGURED } from "./firebase";

const KEY = "ffcs-v1";
const uid = () => Math.random().toString(36).slice(2, 9);
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };

function profileFromAuth(authUser) {
  return {
    n: authUser?.displayName || authUser?.email?.split("@")[0] || "Student",
    r: "",
    email: authUser?.email || "",
  };
}

function App() {
  const cached = load();
  const [session, setSession] = useState(null);
  const [authInitialized, setAuthInitialized] = useState(!FIREBASE_CONFIGURED);
  const [user, setUser] = useState(cached.user || null);
  const [tts, setTts] = useState(Array.isArray(cached.tts) ? cached.tts : []);
  const [customCatalog, setCustomCatalog] = useState(Array.isArray(cached.customCatalog) ? cached.customCatalog : []);
  const [hiddenCatalogCodes, setHiddenCatalogCodes] = useState(Array.isArray(cached.hiddenCatalogCodes) ? cached.hiddenCatalogCodes : []);
  const [cur, setCur] = useState(null);
  const [dataReady, setDataReady] = useState(!FIREBASE_CONFIGURED);
  const [cloudLoadError, setCloudLoadError] = useState("");
  const [cloudStatus, setCloudStatus] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  // Firebase restores a signed-in Google account automatically on page reload.
  useEffect(() => {
    if (!FIREBASE_CONFIGURED) {
      setAuthInitialized(true);
      return undefined;
    }
    const unsubscribe = onAuthStateChanged(auth, (authUser) => {
      setSession(authUser || null);
      setAuthInitialized(true);
      setAuthError("");
      if (authUser) {
        setDataReady(false);
        setCloudLoadError("");
        setCloudStatus("Loading account…");
      } else {
        setDataReady(true);
        setCloudStatus("");
      }
    }, (error) => {
      setAuthError(error.message || "Could not check your Google sign-in status.");
      setAuthInitialized(true);
      setDataReady(true);
    });
    return unsubscribe;
  }, []);

  // Load this Google account's private document from Firestore. Existing browser
  // progress is imported on the first sign-in when no cloud document exists.
  useEffect(() => {
    if (!FIREBASE_CONFIGURED || !authInitialized || !session?.uid) return undefined;
    let alive = true;
    setDataReady(false);
    setCloudLoadError("");
    setCloudStatus("Loading account…");

    const loadCloudData = async () => {
      try {
        const record = await getDoc(doc(db, "users", session.uid));
        const saved = record.exists() ? record.data() : null;
        const browserData = load();
        const hasBrowserProgress = Boolean(browserData.user || (Array.isArray(browserData.tts) && browserData.tts.length));
        const selectedUser = saved?.user
          ? { ...profileFromAuth(session), ...saved.user, email: saved.user.email || session.email || "" }
          : (!record.exists() && browserData.user
            ? { ...browserData.user, email: session.email || "" }
            : profileFromAuth(session));
        const selectedTimetables = Array.isArray(saved?.tts)
          ? saved.tts
          : (!record.exists() && Array.isArray(browserData.tts) ? browserData.tts : []);
        const selectedCustomCatalog = Array.isArray(saved?.customCatalog)
          ? saved.customCatalog
          : (!record.exists() && Array.isArray(browserData.customCatalog) ? browserData.customCatalog : []);
        const selectedHiddenCatalogCodes = Array.isArray(saved?.hiddenCatalogCodes)
          ? saved.hiddenCatalogCodes
          : (!record.exists() && Array.isArray(browserData.hiddenCatalogCodes) ? browserData.hiddenCatalogCodes : []);

        // Don't leave a previous account's local cache on a shared browser once
        // a cloud record is present. A new account's local progress is kept until
        // the first Firestore save succeeds.
        if (record.exists() || !hasBrowserProgress) {
          try { localStorage.removeItem(KEY); } catch {}
        }
        if (alive) {
          setUser(selectedUser);
          setTts(selectedTimetables);
          setCustomCatalog(selectedCustomCatalog);
          setHiddenCatalogCodes(selectedHiddenCatalogCodes);
          setDataReady(true);
          setCloudStatus("Account connected");
        }
      } catch (error) {
        if (alive) {
          setCloudLoadError(error.message || "Unable to load your cloud timetable. Check Firestore setup and security rules.");
          setCloudStatus("Sync needs attention");
        }
      }
    };
    loadCloudData();
    return () => { alive = false; };
  }, [authInitialized, session?.uid, loadAttempt]);

  // Keep guest progress in this browser only. Signed-in accounts use Firestore.
  useEffect(() => {
    if (!session && user) {
      try { localStorage.setItem(KEY, JSON.stringify({ user, tts, customCatalog, hiddenCatalogCodes })); } catch {}
    }
  }, [session, user, tts, customCatalog, hiddenCatalogCodes]);

  // Debounced cloud autosave; the initial read must finish before writes begin.
  useEffect(() => {
    if (!FIREBASE_CONFIGURED || !session?.uid || !dataReady || !user) return undefined;
    let alive = true;
    setCloudStatus("Saving changes…");
    const timer = window.setTimeout(async () => {
      try {
        await setDoc(doc(db, "users", session.uid), {
          user,
          tts,
          customCatalog,
          hiddenCatalogCodes,
          updatedAt: serverTimestamp(),
        }, { merge: true });
        try { localStorage.removeItem(KEY); } catch {}
        if (alive) setCloudStatus("All changes saved");
      } catch (error) {
        if (alive) setCloudStatus(error.message || "Cloud save failed. Check Firestore security rules.");
      }
    }, 650);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [session?.uid, dataReady, user, tts, customCatalog, hiddenCatalogCodes]);

  const handleGoogleLogin = async () => {
    setAuthError("");
    if (!FIREBASE_CONFIGURED) {
      setAuthError("Google sign-in needs your Firebase web-app configuration. Add the VITE_FIREBASE_* values to .env.local and Vercel, then redeploy. See README.md.");
      return;
    }
    setAuthBusy(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(auth, provider);
    } catch (error) {
      const messages = {
        "auth/popup-closed-by-user": "The Google sign-in window was closed before completion.",
        "auth/unauthorized-domain": "This website domain is not authorized in Firebase Authentication. Add localhost or your Vercel domain to Authorized domains.",
        "auth/popup-blocked": "Your browser blocked the Google sign-in popup. Allow popups for this site and try again.",
      };
      const message = messages[error.code] || error.message || "Could not sign in with Google.";
      setAuthError(message);
      if (user) window.alert(message);
    } finally {
      setAuthBusy(false);
    }
  };

  const logout = async () => {
    if (session) {
      // Clear the signed-in profile before auth state changes, avoiding writing
      // cloud-account data back into guest storage during sign-out.
      setUser(null);
      setTts([]);
      setCustomCatalog([]);
      setHiddenCatalogCodes([]);
      setCur(null);
      try { await firebaseSignOut(auth); } catch (error) { setAuthError(error.message || "Sign-out failed."); }
      setSession(null);
      setDataReady(true);
      setCloudStatus("");
      setCloudLoadError("");
      return;
    }
    setUser(null);
    setCur(null);
  };

  if (FIREBASE_CONFIGURED && !authInitialized) {
    return <div className="center"><div className="card loading-card"><div className="brand-mark">F</div><h2>Opening your planner</h2><p className="mut">Checking your Google account…</p></div></div>;
  }
  if (session && !dataReady) {
    return <div className="center"><div className="card loading-card"><div className="brand-mark">F</div><h2>Opening your planner</h2><p className="mut">Getting your saved timetable from Firebase…</p>{cloudLoadError && <><div className="err cloud-error">{cloudLoadError}</div><button className="btn p" onClick={() => setLoadAttempt((n) => n + 1)}>Try again</button><button className="text-btn" onClick={logout}>Sign out</button></>}</div></div>;
  }

  if (!user) return <Login onLogin={setUser} onGoogleLogin={handleGoogleLogin} authError={authError} authBusy={authBusy} cloudConfigured={FIREBASE_CONFIGURED} />;
  const tt = tts.find((t) => t.id === cur);
  if (!tt) {
    return <Dashboard user={user} tts={tts} logout={logout} open={setCur}
      create={() => { const t = { id: uid(), name: "Timetable " + (tts.length + 1), courses: [] }; setTts([...tts, t]); setCur(t.id); }}
      remove={(id) => window.confirm("Delete this timetable?") && setTts(tts.filter((t) => t.id !== id))}
      cloudMode={Boolean(session)} cloudStatus={cloudStatus} onGoogleLogin={handleGoogleLogin} />;
  }
  return <Planner tt={tt} user={user} back={() => setCur(null)} logout={logout} update={(fn) => setTts((items) => items.map((t) => t.id === tt.id ? fn(t) : t))} customCatalog={customCatalog} onCustomCatalogChange={setCustomCatalog} hiddenCatalogCodes={hiddenCatalogCodes} onHiddenCatalogCodesChange={setHiddenCatalogCodes} cloudMode={Boolean(session)} cloudStatus={cloudStatus} onGoogleLogin={handleGoogleLogin} />;
}

function Login({ onLogin, onGoogleLogin, authError, authBusy, cloudConfigured }) {
  const [n, setN] = useState("");
  const [r, setR] = useState("");
  const [e, setE] = useState("");
  const go = (ev) => {
    ev.preventDefault();
    if (!n.trim() || !r.trim()) return setE("Enter both your name and register number.");
    onLogin({ n: n.trim(), r: r.trim().toUpperCase(), email: "" });
  };

  return (
    <div className="auth-page">
      <div className="auth-glow glow-one" /><div className="auth-glow glow-two" />
      <div className="auth-layout">
        <section className="welcome-panel">
          <div className="brand-lockup"><div className="brand-mark">F</div><span>FFCS <b>Planner</b></span></div>
          <div className="eyebrow"><span className="status-dot" /> MADE FOR VIT VELLORE</div>
          <h1>Your semester,<br /><em>beautifully</em> organised.</h1>
          <p className="welcome-copy">Build a clash-free weekly timetable, keep an eye on credits, and make FFCS choices with a little more confidence.</p>
          <div className="feature-stack">
            <div className="feature-item"><span className="feature-icon">▦</span><span><b>Your week at a glance</b><small>Every slot in one clear timetable</small></span></div>
            <div className="feature-item"><span className="feature-icon">✳</span><span><b>Catch clashes early</b><small>Slot conflicts and custom rules</small></span></div>
            <div className="feature-item"><span className="feature-icon">↗</span><span><b>Pick up where you left off</b><small>Google sign-in with cloud sync</small></span></div>
          </div>
          <div className="welcome-footer">A calmer way to plan your semester <span>✦</span></div>
        </section>

        <section className="auth-panel card">
          <div className="auth-panel-top"><span className="mut">WELCOME BACK</span><span className="secure-label"><span>●</span> STUDENT SPACE</span></div>
          <h2>Sign in to your planner</h2>
          <p className="mut intro">Use your Google account to save your timetable securely and continue on any device. No custom backend is required.</p>

          <div className="google-login-block">
            <button className="btn google-btn full-btn" type="button" onClick={onGoogleLogin} disabled={authBusy || !cloudConfigured}>
              <span className="google-g" aria-hidden="true">G</span>{authBusy ? "Connecting to Google…" : "Continue with Google"}
            </button>
            {!cloudConfigured && <div className="setup-hint">Google sign-in becomes active after adding your Firebase web-app configuration and setting up Firestore. See <b>README.md</b> for the one-time setup.</div>}
            {authError && <div className="err auth-error">{authError}</div>}
            <p className="fine-print">Your timetables are saved to your private Firebase account.</p>
          </div>

          <div className="or-divider"><span /> <small>OR CONTINUE LOCALLY</small> <span /></div>
          <form className="guest-form" onSubmit={go}>
            <div className="row2">
              <label>Full name<input value={n} onChange={(ev) => { setN(ev.target.value); setE(""); }} placeholder="Your name" autoComplete="name" /></label>
              <label>Register number<input value={r} onChange={(ev) => { setR(ev.target.value); setE(""); }} placeholder="25BCE0000" /></label>
            </div>
            <div className="err">{e}</div>
            <button className="btn secondary-btn full-btn" type="submit">Continue on this device</button>
            <p className="fine-print">Local progress stays in this browser. Sign in with Google for cross-device backup.</p>
          </form>
        </section>
      </div>
    </div>
  );
}

function AppHeader({ user, logout, cloudMode, cloudStatus, children, onGoogleLogin }) {
  return (
    <header className="app-header">
      <div className="brand-lockup compact"><div className="brand-mark">F</div><span>FFCS <b>Planner</b></span></div>
      {children}
      <span className="header-spacer" />
      {cloudMode && <span className="cloud-indicator" title={cloudStatus}><span className={cloudStatus === "All changes saved" ? "cloud-dot saved" : "cloud-dot"} />{cloudStatus || "Cloud account"}</span>}
      {!cloudMode && onGoogleLogin && <button className="btn s google-connect-btn" onClick={onGoogleLogin}>↗ Connect Google</button>}
      <div className="profile-chip"><span className="avatar">{(user.n || user.email || "S").slice(0, 1).toUpperCase()}</span><span className="profile-text"><b>{user.n || "Student"}</b><small>{user.email || user.r || "Local account"}</small></span></div>
      <button className="btn s ghost-btn" onClick={logout}>Sign out</button>
    </header>
  );
}

function Dashboard({ user, tts, logout, open, create, remove, cloudMode, cloudStatus, onGoogleLogin }) {
  const totalCourses = tts.reduce((sum, t) => sum + t.courses.length, 0);
  const totalCredits = tts.reduce((sum, t) => sum + t.courses.reduce((a, c) => a + c.credits, 0), 0);
  return (
    <>
      <AppHeader user={user} logout={logout} cloudMode={cloudMode} cloudStatus={cloudStatus} onGoogleLogin={onGoogleLogin} />
      <div className="wrap dashboard-wrap">
        <div className="dashboard-hero"><div><div className="eyebrow">YOUR ACADEMIC WORKSPACE</div><h1>Good to have you here{user.n ? `, ${user.n.split(" ")[0]}` : ""}.</h1><p className="mut">Plan your semester around the classes that matter.</p></div><button className="btn p create-btn" onClick={create}>＋ Create timetable</button></div>
        <div className="stats-row">
          <div className="stat-card"><span className="stat-label">TIMETABLES</span><b>{tts.length.toString().padStart(2, "0")}</b><small>semester plans</small></div>
          <div className="stat-card"><span className="stat-label">COURSES ADDED</span><b>{totalCourses.toString().padStart(2, "0")}</b><small>across all timetables</small></div>
          <div className="stat-card"><span className="stat-label">TOTAL CREDITS</span><b>{totalCredits}</b><small>planned credits</small></div>
        </div>
        <div className="section-heading"><div><h2>Your timetables</h2><p className="mut">Open a plan to edit slots, courses and preferences.</p></div><span className="section-count">{tts.length} {tts.length === 1 ? "plan" : "plans"}</span></div>
        <div className="timetable-cards">
          {tts.length === 0 && <div className="empty-state"><div className="empty-icon">▦</div><h3>Your first plan starts here</h3><p className="mut">Create a timetable and begin adding courses. Slot clashes are checked as you go.</p><button className="btn p" onClick={create}>Create your first timetable →</button></div>}
          {tts.map((t, index) => (
            <div key={t.id} className="timetable-card" onClick={() => open(t.id)} role="button" tabIndex={0} onKeyDown={(ev) => { if (ev.key === "Enter") open(t.id); }}>
              <div className="timetable-card-top"><span className={`timetable-symbol symbol-${index % 4}`}>▦</span><button className="icon-button delete-button" title="Delete timetable" onClick={(ev) => { ev.stopPropagation(); remove(t.id); }}>✕</button></div>
              <h3>{t.name}</h3><p className="mut">{t.courses.length} courses · {t.courses.reduce((x, c) => x + c.credits, 0)} credits</p>
              <div className="card-footer"><span>{t.courses.length ? `${t.courses.length} courses planned` : "Ready to set up"}</span><span className="arrow-circle">↗</span></div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

const blank = { code: "", title: "", credits: "", faculty: "", venue: "" };

function SearchableSelect({ label, options, value, onChange, placeholder, searchPlaceholder, disabled = false, emptyMessage = "No matching options found." }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) setQuery(selected?.label || "");
  }, [selected?.label, open]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredOptions = options.filter((option) => {
    if (!normalizedQuery) return true;
    return `${option.label} ${option.searchText || ""} ${option.meta || ""}`.toLocaleLowerCase().includes(normalizedQuery);
  });

  return (
    <div className={`search-select${open ? " is-open" : ""}${disabled ? " is-disabled" : ""}`}>
      <span className="picker-label">{label}</span>
      <div className="search-select-control">
        <input
          type="text"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-autocomplete="list"
          placeholder={searchPlaceholder || placeholder}
          value={query}
          disabled={disabled}
          onFocus={() => { setQuery(""); setOpen(true); }}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onBlur={() => window.setTimeout(() => {
            setOpen(false);
            setQuery(selected?.label || "");
          }, 120)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              setQuery(selected?.label || "");
              event.currentTarget.blur();
            }
            if (event.key === "Enter" && open && filteredOptions.length === 1) {
              event.preventDefault();
              onChange(filteredOptions[0].value);
              setQuery(filteredOptions[0].label);
              setOpen(false);
              event.currentTarget.blur();
            }
          }}
        />
        <span className="search-select-icon" aria-hidden="true">⌕</span>
      </div>
      {open && !disabled && (
        <div className="search-select-menu" role="listbox" aria-label={`${label} options`}>
          <div className="search-select-count">{filteredOptions.length} {filteredOptions.length === 1 ? "option" : "options"}</div>
          {filteredOptions.length ? filteredOptions.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              key={option.value}
              className={`search-select-option${option.value === value ? " selected" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(option.value);
                setQuery(option.label);
                setOpen(false);
              }}
            >
              <span className="option-copy"><b>{option.label}</b>{option.meta && <small>{option.meta}</small>}</span>
              {option.value === value && <span className="option-check" aria-hidden="true">✓</span>}
            </button>
          )) : <div className="search-select-empty">{emptyMessage}</div>}
        </div>
      )}
    </div>
  );
}

function Planner({ tt, user, back, logout, update, customCatalog, onCustomCatalogChange, hiddenCatalogCodes, onHiddenCatalogCodesChange, cloudMode, cloudStatus, onGoogleLogin }) {
  const [f, setF] = useState(blank);
  const [slots, setSlots] = useState("");
  const [catalogCode, setCatalogCode] = useState("");
  const [catalogOffering, setCatalogOffering] = useState("");
  const [manageCatalogCode, setManageCatalogCode] = useState("");
  const [importSubject, setImportSubject] = useState("");
  const [importTable, setImportTable] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const [catalogManageMessage, setCatalogManageMessage] = useState("");
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const availableCatalog = [...courseCatalog.filter((course) => !hiddenCatalogCodes.includes(course.code)), ...customCatalog.filter((course) => !hiddenCatalogCodes.includes(course.code))];
  const selectedCatalogCourse = availableCatalog.find((c) => c.code === catalogCode);
  const catalogOfferings = selectedCatalogCourse?.offerings || [];
  const subjectOptions = availableCatalog.map((course) => ({
    value: course.code,
    label: `${course.code} — ${course.title}`,
    searchText: `${course.code} ${course.title}`,
    meta: customCatalog.some((item) => item.code === course.code) ? "Personal subject" : "Course catalogue",
  }));
  const offeringOptions = catalogOfferings.map((offering, index) => ({
    value: String(index),
    label: `${offering.faculty} — ${offering.slot}`,
    searchText: `${offering.faculty} ${offering.slot} ${offering.venue} ${offering.type}`,
    meta: [offering.venue, offering.type].filter(Boolean).join(" · "),
  }));
  const manageSubjectOptions = availableCatalog.map((course) => ({
    value: course.code,
    label: `${course.code} — ${course.title}`,
    searchText: `${course.code} ${course.title}`,
    meta: `${course.offerings?.length || 0} faculty/class options · ${customCatalog.some((item) => item.code === course.code) ? "Personal subject" : "Default catalogue"}`,
  }));
  const selectCatalogCourse = (code) => {
    setCatalogCode(code);
    setCatalogOffering("");
    const item = availableCatalog.find((c) => c.code === code);
    setF((old) => ({ ...old, code: item?.code || "", title: item?.title || "", faculty: "", venue: "" }));
    setSlots("");
    setErr("");
  };
  const selectCatalogOffering = (index) => {
    setCatalogOffering(index);
    const item = catalogOfferings[Number(index)];
    if (!item) return;
    setF((old) => ({ ...old, code: selectedCatalogCourse.code, title: selectedCatalogCourse.title, faculty: item.faculty, venue: item.venue }));
    setSlots(item.slot);
    setErr("");
  };
  const rules = tt.rules || {}, cols = ruleCols(rules);
  const bad = tt.courses.filter((c) => ruleHits(c, rules).length);
  const setRule = (k) => update((t) => ({ ...t, rules: { ...(t.rules || {}), [k]: !(t.rules || {})[k] } }));
  const credits = Number(tt.courses.reduce((x, c) => x + Number(c.credits || 0), 0).toFixed(2));
  const parsedSlots = parseSlots(slots);
  const toggle = (s) => { const current = parseSlots(slots); setSlots((current.includes(s) ? current.filter((x) => x !== s) : [...current, s]).join("+")); setErr(""); };

  const add = (ev) => {
    ev?.preventDefault();
    const code = f.code.trim().toUpperCase(), cd = parseFloat(f.credits), sl = parseSlots(slots);
    if (!code && !f.title.trim()) return setErr("Enter a course code or title.");
    if (f.credits === "" || Number.isNaN(cd)) return setErr("Enter the credits.");
    if (!sl.length) return setErr("Enter at least one slot.");
    const unk = sl.filter((s) => !ALL.has(s));
    if (unk.length) return setErr("Unknown slot: " + unk.join(", "));
    const c = { id: uid(), code, title: f.title.trim(), credits: cd, slots: [...new Set(sl)], faculty: f.faculty.trim(), venue: f.venue.trim(), color: COL[tt.courses.length % COL.length] };
    const rh = ruleHits(c, rules);
    if (rh.length) return setErr(`Breaks your timetable rule — class at ${rh.slice(0, 3).join(", ")}${rh.length > 3 ? " …" : ""}.`);
    const cl = clashes(c, tt.courses);
    if (cl.length) return setErr("Slot clash:\n" + cl.slice(0, 3).join("\n") + (cl.length > 3 ? `\n+${cl.length - 3} more` : ""));
    update((t) => ({ ...t, courses: [...t.courses, c] }));
    setF(blank); setSlots(""); setErr(""); setCatalogCode(""); setCatalogOffering("");
  };

  const removeCourse = (id) => update((t) => ({ ...t, courses: t.courses.filter((c) => c.id !== id) }));

  const removeCatalogSubject = () => {
    const subject = availableCatalog.find((course) => course.code === manageCatalogCode);
    if (!subject) return;
    const isCustom = customCatalog.some((course) => course.code === subject.code);
    const confirmed = window.confirm(
      `Remove “${subject.title}” and its ${subject.offerings?.length || 0} faculty/class option(s) from the course dropdown?\n\nThis is separate from removing a class from your timetable. Any class already added to the timetable will stay there. ${isCustom ? "You can import this personal subject again later." : "You can restore hidden default subjects below."}`
    );
    if (!confirmed) return;
    if (isCustom) onCustomCatalogChange((items) => items.filter((course) => course.code !== subject.code));
    else onHiddenCatalogCodesChange((codes) => codes.includes(subject.code) ? codes : [...codes, subject.code]);
    if (catalogCode === subject.code) {
      setCatalogCode("");
      setCatalogOffering("");
      setF((old) => ({ ...old, code: "", title: "", faculty: "", venue: "" }));
      setSlots("");
    }
    setManageCatalogCode("");
    setCatalogManageMessage(`Removed “${subject.title}” and its faculty/class options from the dropdown.`);
  };

  const restoreDefaultSubjects = () => {
    if (!hiddenCatalogCodes.length) return;
    if (window.confirm(`Restore all ${hiddenCatalogCodes.length} hidden default subject(s) to the dropdown?`)) {
      onHiddenCatalogCodesChange([]);
      setCatalogManageMessage("Default subjects restored.");
    }
  };

  return (
    <>
      <AppHeader user={user} logout={logout} cloudMode={cloudMode} cloudStatus={cloudStatus} onGoogleLogin={onGoogleLogin}>
        <button className="btn s ghost-btn back-btn" onClick={back}>← All plans</button>
        <input aria-label="Timetable name" className="t timetable-name" value={tt.name} onChange={(ev) => update((t) => ({ ...t, name: ev.target.value }))} />
        <button className="btn s ghost-btn print-btn" onClick={() => window.print()}>↗ Export / Print</button>
      </AppHeader>
      <div className="wrap planner-wrap">
        <div className="planner-heading"><div><div className="eyebrow">SEMESTER BUILDER</div><h1>Shape your week.</h1><p className="mut">Add your courses first, then use the timetable below to fine-tune each slot.</p></div><div className="heading-metrics"><div><b>{tt.courses.length.toString().padStart(2, "0")}</b><small>COURSES</small></div><div><b>{credits}</b><small>CREDITS</small></div></div></div>

        <section className="card course-builder">
          <div className="builder-top"><div className="builder-title"><span className="builder-icon">＋</span><div><h2>Add a course</h2><p className="mut">Course details and slot selection</p></div></div><span className="builder-note"><span className="tiny-dot" /> Clash checking is on</span></div>
          <div className="catalog-pickers">
            <SearchableSelect
              label="Choose a subject from your document"
              options={subjectOptions}
              value={catalogCode}
              onChange={selectCatalogCourse}
              placeholder="Select a subject…"
              searchPlaceholder="Search course code or name…"
              emptyMessage="No courses match that search."
            />
            <SearchableSelect
              label="Available faculty / class"
              options={offeringOptions}
              value={catalogOffering}
              onChange={selectCatalogOffering}
              disabled={!selectedCatalogCourse}
              placeholder={selectedCatalogCourse ? "Select faculty, slot and venue…" : "Choose a subject first"}
              searchPlaceholder="Search faculty, slot or venue…"
              emptyMessage="No faculty or classes match that search."
            />
            <p className="catalog-help">Selecting a class fills the course code, title, faculty, venue and slot. Credits aren't listed in the document, so enter them manually.</p>
          </div>
          <div className="custom-import-panel">
            <div className="custom-import-heading"><div><h3>Import your own subject faculty list</h3><p className="mut">Paste the subject name and copied table (including Slot Detail, Venue, Faculty and Course Type). We'll parse the rows into your personal dropdown.</p></div><span className="pill">Private to your account</span></div>
            <div className="custom-import-fields">
              <label>Subject name<input value={importSubject} onChange={(ev) => setImportSubject(ev.target.value)} placeholder="e.g. Engineering Mathematics" /></label>
              <label><span className="import-table-label"><span>Paste faculty table</span><button className="text-clear-btn" type="button" onClick={() => { setImportTable(""); setImportMessage(""); }}>Clear pasted content</button></span><textarea value={importTable} onChange={(ev) => setImportTable(ev.target.value)} rows={5} placeholder={`| Slot Detail | Venue | Faculty | Course Type |\n| B1+TB1 | TT620 | BHUVANESWARI M | TH |\n| B2+TB2 | SMV214 | BHUVANESWARI M | TH |`} /></label>
            </div>
            <div className="builder-actions"><div className="mut import-feedback">{importMessage}</div><button className="btn p add-btn" type="button" onClick={() => {
              const title = importSubject.trim();
              if (!title) { setImportMessage("Enter the subject name first."); return; }
              const rows = importTable.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
              const offerings = [];
              for (const line of rows) {
                // Support Markdown, tab-separated spreadsheet data, and plain-text columns.
                let cells;
                if (line.includes("|")) cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
                else if (line.includes("\t")) cells = line.split("\t").map((cell) => cell.trim());
                else cells = line.split(/\s{2,}/).map((cell) => cell.trim());
                cells = cells.map((cell) => cell.replace(/^\*\*(.*)\*\*$/, "$1"));
                if (cells.length < 4 || cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, "")))) continue;
                const normalized = cells.map((cell) => cell.toLowerCase().replace(/[^a-z ]/g, "").trim());
                if (normalized.some((cell) => cell.includes("slot detail") || cell === "venue" || cell === "faculty" || cell.includes("course type"))) continue;
                if (cells.length > 4) cells = [cells[0], cells[1], cells.slice(2, -1).join(" "), cells[cells.length - 1]];
                const [slot, venue, faculty, type] = cells;
                const parsed = parseSlots((slot || "").replace(/\s+/g, ""));
                if (!slot || !faculty || !parsed.length || parsed.some((value) => !ALL.has(value))) continue;
                offerings.push({ slot: parsed.join("+"), venue: venue || "", faculty: faculty || "", type: type || "TH" });
              }
              if (!offerings.length) { setImportMessage("No valid rows found. Paste the table with Slot Detail, Venue, Faculty and Course Type columns."); return; }
              const code = "CUSTOM-" + title.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
              const subject = { code, title, offerings };
              onCustomCatalogChange((old) => [...old.filter((item) => item.code !== code), subject]);
              setCatalogCode(code); setCatalogOffering("");
              setF((old) => ({ ...old, code: "", title, faculty: "", venue: "" })); setSlots("");
              setImportMessage(`Imported ${offerings.length} faculty/class options for “${title}”. Select one from the subject dropdown.`);
            }}>Parse and save subject</button></div>
          </div>

          <div className="catalog-management-panel">
            <div className="catalog-management-heading">
              <div><h3>Manage course dropdown</h3><p className="mut">Remove an unwanted subject and all of its faculty/class options. This does not remove a course already placed in your timetable.</p></div>
              <span className="catalog-count">{availableCatalog.length} subjects</span>
            </div>
            <div className="catalog-management-controls">
              <SearchableSelect
                label="Subject to remove"
                options={manageSubjectOptions}
                value={manageCatalogCode}
                onChange={(code) => { setManageCatalogCode(code); setCatalogManageMessage(""); }}
                placeholder="Choose a subject to manage…"
                searchPlaceholder="Search subject to remove…"
                emptyMessage="No subjects match that search."
              />
              <button className="btn danger-btn remove-catalog-btn" type="button" onClick={removeCatalogSubject} disabled={!manageCatalogCode}>Remove subject + faculty options</button>
            </div>
            <div className="catalog-management-footer">
              <p className="catalog-manage-feedback" role="status">{catalogManageMessage}</p>
              {hiddenCatalogCodes.length > 0 && <button className="text-clear-btn restore-catalog-btn" type="button" onClick={restoreDefaultSubjects}>Restore {hiddenCatalogCodes.length} hidden default subject(s)</button>}
            </div>
          </div>
          <form onSubmit={add}>
            <div className="course-fields">
              <label>Course code<input value={f.code} onChange={set("code")} placeholder="BACSE202" /></label>
              <label>Credits<input type="number" min="0" step="0.5" value={f.credits} onChange={set("credits")} placeholder="3" /></label>
              <label className="title-field">Course title<input value={f.title} onChange={set("title")} placeholder="Data Structures and Algorithms" /></label>
              <label className="slots-field">Slot(s)<input value={slots} onChange={(ev) => { setSlots(ev.target.value); setErr(""); }} placeholder="e.g. A1+TA1 or L3+L4" /></label>
              <label>Faculty<input value={f.faculty} onChange={set("faculty")} placeholder="Faculty name" /></label>
              <label>Venue<input value={f.venue} onChange={set("venue")} placeholder="PRP329" /></label>
            </div>
            <div className="builder-actions"><div className="err builder-error">{err}</div><button className="btn p add-btn" type="submit">＋ Add to timetable</button></div>
          </form>
          {tt.courses.length > 0 && <div className="course-list-wrap"><div className="course-list-heading"><span>ADDED COURSES <b>{tt.courses.length}</b></span><small>Remove a course with ×</small></div><div className="course-list">
            {tt.courses.map((c) => <div className="course-chip" key={c.id}><span className="course-chip-color" style={{ background: c.color }} /><div className="course-chip-text"><b>{c.code || c.title || "Untitled course"}</b><small>{c.title && c.code ? c.title : c.slots.join(" + ")} · {c.credits} cr</small></div><button className="icon-button" onClick={() => removeCourse(c.id)} title={`Remove ${c.code || c.title}`}>×</button></div>)}
          </div></div>}
        </section>

        <section className="schedule-section">
          <div className="schedule-top"><div><div className="eyebrow">WEEKLY VIEW</div><h2>Your timetable</h2><p className="mut">Tap an available slot tag to add it to the course form above.</p></div><div className="schedule-badges"><span className="pill"><span className="pill-dot" /> {tt.courses.length} courses</span><span className="pill">{credits} credits</span></div></div>
          <div className="rule-toolbar">
            <span className="toolbar-label">PREFERENCES</span>
            <label className="sw"><input type="checkbox" checked={!!rules.no8} onChange={() => setRule("no8")} /><i />No 8 AM classes</label>
            <label className="sw"><input type="checkbox" checked={!!rules.noNight} onChange={() => setRule("noNight")} /><i />No night classes (after 7 PM)</label>
            <span className="rule-help">Violations are outlined in red</span>
          </div>
          {bad.length > 0 && <div className="warn">⚠ <b>Rule conflicts:</b> {bad.map((c) => `${c.code || c.title} (${ruleHits(c, rules).join(", ")})`).join("; ")}</div>}
          <div className="tw">
            <table className="timetable">
              <colgroup><col className="day-col" />{TM.map((h) => <col key={h} className={h === "LUNCH" ? "lunch-col" : "time-col"} />)}</colgroup>
              <thead><tr><th className="day-heading">DAY</th>{TM.map((h) => h === "LUNCH" ? <th key={h} className="lun"><span>BREAK</span></th> : <th key={h}>{h}</th>)}</tr></thead>
              <tbody>
                {DAYS.map((d) => (
                  <tr key={d}>
                    <td className="day-name">{d}</td>
                    {TM.map((h, i) => {
                      if (h === "LUNCH") return <td key={h} className="lun lunch-cell"><span>BREAK</span></td>;
                      const theory = TH[d][i], lab = LB[d][i], course = owner(tt.courses, d, i);
                      const tag = (slot) => slot !== "-" && <button type="button" key={slot} className={`tag${!course && parsedSlots.includes(slot) ? " on" : ""}`} disabled={Boolean(course)} onClick={() => toggle(slot)} title={course ? "This time is occupied" : `Use slot ${slot}`}>{slot}</button>;
                      return (
                        <td key={h}>
                          <div className={`cell ${course ? "filled" : "empty"}${course && cols.includes(i) ? " viol" : ""}`} style={course ? { background: course.color } : undefined}>
                            <div className="tags">{tag(theory)}{tag(lab)}</div>
                            {course && <><b title={course.title || course.code}>{course.title || course.code}</b><i title={course.faculty}>{course.faculty}</i>{course.venue && <i title={course.venue}>{course.venue}</i>}<span className="cell-code">{course.code} · {course.credits} cr</span></>}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="schedule-legend"><span><i className="legend-swatch selected" /> Course added</span><span><i className="legend-swatch available" /> Available slot</span><span><i className="legend-swatch conflict" /> Rule conflict</span><span className="legend-spacer" /><span>Tip: combine slots with <b>+</b> (example: A1+TA1)</span></div>
        </section>
        <section className="credit-summary" aria-live="polite">
          <div className="credit-summary-icon" aria-hidden="true">✦</div>
          <div className="credit-summary-copy"><span className="eyebrow">SEMESTER TOTAL</span><h2>Registered credits</h2><p className="mut">Calculated from every subject currently in this timetable.</p></div>
          <div className="credit-summary-value"><b>{credits}</b><span>{credits === 1 ? "credit" : "credits"}</span></div>
          <div className="credit-summary-divider" />
          <div className="credit-summary-courses"><b>{tt.courses.length}</b><span>{tt.courses.length === 1 ? "subject registered" : "subjects registered"}</span></div>
        </section>
      </div>
    </>
  );
}

export default App;
