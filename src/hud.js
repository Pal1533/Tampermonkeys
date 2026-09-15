import { createNameForge } from "./name-forge/index.js";

export function bootAtlas() {
    'use strict';

    (function installAtlasAdBlocker() {
        // Quick off-switch for diagnosing false positives. Toggle from
        // DevTools console:  localStorage.setItem('atlas.adblock.off','1');
        // then reload. Set back to '0' or removeItem to re-enable.
        try {
            if (localStorage.getItem("atlas.adblock.off") === "1") return;
        } catch (e) {}

        const selector = ATLAS_AD_SELECTORS.join(",");

        // CSS pass: hides matches so they can't flash before removal.
        try {
            const css = selector + " { display: none !important; visibility: hidden !important; height: 0 !important; width: 0 !important; pointer-events: none !important; }";
            const style = document.createElement("style");
            style.id = "atlasAdBlockerStyle";
            style.textContent = css;
            (document.head || document.documentElement).appendChild(style);
        } catch (e) {}

        // Kill ad script tags already in the document.
        try {
            const scripts = document.querySelectorAll("script[src]");
            for (let i = 0; i < scripts.length; i++) {
                if (isAtlasAdSrc(scripts[i].src)) scripts[i].remove();
            }
        } catch (e) {}

        const removeMatching = (root) => {
            if (!root || !root.querySelectorAll) return;
            try {
                const matches = root.querySelectorAll(selector);
                for (let i = 0; i < matches.length; i++) matches[i].remove();
            } catch (e) {}
        };

        const handleVideoAd = (node) => {
            if (!node) return;
            const videos = node.tagName === "VIDEO"
                ? [node]
                : (node.querySelectorAll ? node.querySelectorAll("video") : []);
            for (let i = 0; i < videos.length; i++) tryDismissAdVideo(videos[i]);
        };

        try {
            const observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    for (const n of m.addedNodes) {
                        if (n.nodeType !== 1) continue;
                        try {
                            if (n.matches && n.matches(selector)) {
                                n.remove();
                                continue;
                            }
                        } catch (e) {}
                        removeMatching(n);
                        handleVideoAd(n);
                        if (n.tagName === "SCRIPT" && n.src && isAtlasAdSrc(n.src)) {
                            n.remove();
                        }
                    }
                }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
        } catch (e) {}

        // Backstop for interstitial video overlays that don't match the
        // static selector list.
        try {
            setInterval(() => {
                const videos = document.querySelectorAll("video");
                for (let i = 0; i < videos.length; i++) tryDismissAdVideo(videos[i]);
            }, 2000);
        } catch (e) {}
    })();

    // dbg() defined up top so early localStorage try/catches can call it
    const oldLog = console.log;
    const RG_DEBUG = true;
    const _rgLogBuf = [];
    const _rgWarnBuf = [];
    const _rgErrorBuf = [];
    // Ring buffer of Firestore write attempts. When a user reports a sync
    // error, this tells us the exact payload, the rule-error code, and
    // Firestore's serverResponse — everything needed to diagnose without
    // having to guess.
    const _rgWriteBuf = [];
    function _sanitizeWriteValue(v) {
        if (v === null || v === undefined) return v;
        if (typeof v === "number" || typeof v === "boolean") return v;
        if (typeof v === "string") return v.length > 512 ? `<str:len=${v.length}>` : v;
        if (Array.isArray(v)) return `<array:len=${v.length}>`;
        if (typeof v === "object") {
            // serverTimestamp() etc are SDK sentinels — mark them so we can see they were used
            if (v.constructor && v.constructor.name && v.constructor.name !== "Object") {
                return `<${v.constructor.name}>`;
            }
            const out = {};
            for (const k of Object.keys(v)) out[k] = _sanitizeWriteValue(v[k]);
            return out;
        }
        return `<${typeof v}>`;
    }
    function _pushWriteAttempt(entry) {
        _rgWriteBuf.push(entry);
        if (_rgWriteBuf.length > 40) _rgWriteBuf.shift();
    }
    function dbg(msg) {
        const line = `[RG HUD ${(performance.now() / 1000).toFixed(2)}s] ${msg}`;
        _rgLogBuf.push(line);
        if (_rgLogBuf.length > 300) _rgLogBuf.shift();
        if (RG_DEBUG) oldLog.call(console, line);
    }
    function dbgWarn(msg) {
        dbg("[WARN] " + msg);
        _rgWarnBuf.push({ msg, at: Date.now() });
        if (_rgWarnBuf.length > 5) _rgWarnBuf.shift();
        const dot = typeof document !== "undefined" && document.getElementById("rgWarnDot");
        if (dot) {
            dot.style.display = "inline";
            dot.title = _rgWarnBuf.map(w => new Date(w.at).toLocaleTimeString() + " — " + w.msg).join("\n");
        }
    }
    function pushError(err, origin) {
        try {
            const message = getErrMsg(err);
            const stack = formatStackTrace(err) || "";
            _rgErrorBuf.push({ origin, msg: message, stack, at: Date.now() });
            if (_rgErrorBuf.length > 20) _rgErrorBuf.shift();
            dbg(`[ERROR:${origin}] ${message}${stack ? " :: " + stack : ""}`);
        } catch (loggingFailed) {
            try { oldLog.call(console, "[RG HUD] pushError failed:", loggingFailed); } catch (e) {}
        }
    }
    // trace focus + first keystroke on an input so "can't type" bugs leave a trail
    function probeInput(el, label) {
        if (!el) { dbg(`probeInput(${label}): element missing`); return; }
        setTimeout(() => {
            try {
                const active = document.activeElement;
                const cs = window.getComputedStyle(el);
                dbg(`${label} probe: activeId=${active?.id || "none"} focused=${active === el} disabled=${el.disabled} readOnly=${el.readOnly} display=${cs.display} visibility=${cs.visibility} pointerEvents=${cs.pointerEvents}`);
            } catch (e) { pushError(e, `probeInput:${label}`); }
        }, 120);
        const onFirstInput = () => {
            dbg(`${label} first keystroke received (len=${el.value.length})`);
            el.removeEventListener("input", onFirstInput);
        };
        const onFirstBlur = () => {
            const active = document.activeElement;
            dbg(`${label} focus lost -> ${active?.id || active?.tagName || "unknown"}`);
            el.removeEventListener("focusout", onFirstBlur);
        };
        el.addEventListener("input", onFirstInput);
        el.addEventListener("focusout", onFirstBlur);
    }

    // expose on page window so DevTools "top" context can call rgDump()
    pageWindow().rgDump =
        () => oldLog.call(console, _rgLogBuf.join("\n"));

    // raw console.log/warn from the game, not just our own dbg. lets us hunt
    // for signals (team assignment, room events) without fragile snippets.
    const _rawLogBuf = [];
    function _rawPush(kind, args) {
        try {
            const parts = [];
            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if (typeof a === "string") parts.push(a);
                else { try { parts.push(JSON.stringify(a)); } catch (e) { parts.push(String(a)); } }
            }
            const line = "[" + (performance.now() / 1000).toFixed(2) + "s " + kind + "] " + parts.join(" ").slice(0, 1200);
            _rawLogBuf.push(line);
            if (_rawLogBuf.length > 800) _rawLogBuf.shift();
        } catch (e) {}
    }
    const _rawOldWarn = pageWindow().console.warn;
    pageWindow().console.warn = function () { _rawPush("warn", arguments); _rawOldWarn.apply(pageWindow().console, arguments); };
    // console.log wrapper gets set later; we install a passthrough hook via oldLog above at line 21
    // by wrapping _rawPush into the existing console.log override at the bottom of the script.

    // fullscreen textarea dump so users can select-copy the raw buffer without
    // clipboard perms or console truncation
    pageWindow().atlasCap = function () {
        const out = _rawLogBuf.join("\n");
        const t = document.createElement("textarea");
        t.value = out;
        t.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999999999;background:#000;color:#0f0;font:12px monospace;padding:8px;";
        const c = document.createElement("button");
        c.textContent = "Close";
        c.style.cssText = "position:fixed;top:8px;right:8px;z-index:9999999999;padding:6px 12px;font-size:14px;";
        c.onclick = function () { t.remove(); c.remove(); };
        document.body.appendChild(t);
        document.body.appendChild(c);
        t.focus();
        t.select();
        return "dumped " + _rawLogBuf.length + " lines";
    };
    pageWindow().atlasCapReset = function () { _rawLogBuf.length = 0; };
    // catch anything a handler throws so it lands in the debug bundle
    if (typeof window !== "undefined") {
        window.addEventListener("error", ev => {
            pushError(ev.error || ev.message || "unknown error", "window.error");
        });
        window.addEventListener("unhandledrejection", ev => {
            pushError(ev.reason || "unhandled rejection", "unhandledrejection");
        });
    }

    let hud;
    const atlasIconHtml = () => `<img src="${ATLAS_ICON_URL}" alt="" style="height:16px;width:16px;vertical-align:middle;margin-right:4px;object-fit:contain;">`;

    let settings = { ...DEFAULT_SETTINGS };
    try {
        settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("rgHudSettings") ?? "{}") };
    } catch (e) {
        pushError(e, "loadSettings");
    }

    const PING_PROBE_INTERVAL_MS = 3000;
    const PING_PROBE_TIMEOUT_MS = 2500;
    let pingTrackerIntervalId = null;
    let pingTrackerProbeInFlight = false;
    let pingTrackerProbeGeneration = 0;
    let pingTrackerSamples = [];
    let pingTrackerLastRtt = null;

    // num form lets server rules do >= checks. never write 11.10 (parseFloat).
    const SCRIPT_VERSION = (typeof GM_info !== "undefined" && GM_info?.script?.version) || "27.2";
    const SCRIPT_VERSION_NUM = parseFloat(SCRIPT_VERSION) || 0;

    // ---------- Win/loss streak tracking ----------
    // game only gives cumulative totals — diff between updates for per-match.
    // +ve = win streak, -ve = loss streak. resets on account change / session end.

    let streakData = null;
    try { streakData = JSON.parse(localStorage.getItem("rgHudStreak") ?? "null"); }
    catch (e) { pushError(e, "loadStreak"); }

    // ---------- Session deltas ----------

    // one continuous play run. resets on account change or SESSION_IDLE_MS.
    // localStorage + timestamp: refresh keeps it, overnight starts fresh.
    const SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // 2h

    let sessionStart = null;
    try { sessionStart = JSON.parse(localStorage.getItem("rgHudSessionStart") ?? "null"); }
    catch (e) { pushError(e, "loadSessionStart"); }


    // ---------- Ranks ----------

    const cachedRanks = new Map();      // playlist -> rank
    const cachedMmrToNext = new Map();  // playlist -> mmr gap to next rank (null if #1)

    // ---------- Crown system ----------
    // KING title while holding any #1. banners on coronation + dethrone.

    const prevRanks = new Map(); // playlist -> last known rank

    const SHUT_EYE_MESSAGES = [
        "😴 Maybe it's time for some shut-eye?",
        "😴 The ball will still be here tomorrow...",
        "🛌 Consider: a strategic nap.",
        "☕ Touch grass? Or at least grab a coffee.",
        "😅 Rough one. Shake it off, champ.",
    ];
    let shutEyeMessage = SHUT_EYE_MESSAGES[Math.floor(Math.random() * SHUT_EYE_MESSAGES.length)];

    // read by applyGlowSettings
    let momentumGlow = { speedMult: 1, intensity: 1 };
    let currentMomentumState = "neutral";

    let bannerTimeout = null;

    // In-memory ring; hydrated from localStorage on first use.
    let _recentMatchesRing = null;
    // Guard against writing the same matchId twice (rehydration / re-fetch).
    const _seenMatchIds = new Set();
    let _pendingNewMatchIds = [];

    function updateHUD(data) {
        createHUD();
        handleMatchSnapshots(lastKnownPlayerData, data);
        lastKnownPlayerData = data;
        // Login/ratings can arrive after Photon roster lines. Resume popup
        // detection now that the local user's uid is finally available.
        if (_inMatch && _liveRoster.length) scheduleRankedRosterPopups();
        captureSessionStart(data);
        updateStreak(data);
        updateMomentum();

        const ratingVal = mode => data.ModesGlicko?.[mode]?.displayRating;
        const rating = mode => {
            const v = ratingVal(mode);
            return typeof v === "number" ? v : "—";
        };

        const wr = mode => {
            const d = data.ModesData?.[mode];
            if (!d || !d.matchesPlayed) return "0.0";
            return (100 * d.wins / d.matchesPlayed).toFixed(1);
        };

        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        const totalWins = modes.reduce((sum, m) => sum + (data.ModesData?.[m]?.wins ?? 0), 0);
        const totalMatches = modes.reduce((sum, m) => sum + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);

        document.getElementById("rgContent").innerHTML = `
            <div style="display:flex;gap:12px;">
                <div style="white-space:nowrap;">
                    <b>🏆 Ratings</b><br>
                    3v3: <span style="color:#00ff66">${rating("Competitive3v3")}</span>${rankBadge("3v3")}${deltaBadge("Competitive3v3", ratingVal("Competitive3v3"))}<br>
                    2v2: <span style="color:#00ff66">${rating("Competitive2v2")}</span>${rankBadge("2v2")}${deltaBadge("Competitive2v2", ratingVal("Competitive2v2"))}<br>
                    1v1: <span style="color:#00ff66">${rating("Competitive1v1")}</span>${rankBadge("1v1")}${deltaBadge("Competitive1v1", ratingVal("Competitive1v1"))}<br>
                    Casual: <span style="color:#00ff66">${rating("Casual")}</span>${deltaBadge("Casual", ratingVal("Casual"))}
                </div>
                <div style="width:1px;background:#00bfff88;flex-shrink:0;"></div>
                <div style="white-space:nowrap;">
                    <b>📊 Win Rates</b><br>
                    3v3 <span style="color:#00ff66">${wr("Competitive3v3")}%</span><br>
                    2v2 <span style="color:#00ff66">${wr("Competitive2v2")}%</span><br>
                    1v1 <span style="color:#00ff66">${wr("Competitive1v1")}%</span><br>
                    Casual <span style="color:#00ff66">${wr("Casual")}%</span>
                </div>
            </div>

            <hr style="border:none;border-top:1px solid #00bfff88;margin:10px 0;">

            <div style="display:flex;justify-content:space-between;align-items:center;">
                <div>
                    Wins: <span style="color:#00ff66">${totalWins}</span><br>
                    Matches Played: <span style="color:#00ff66">${totalMatches}</span>
                </div>
                <div style="font-size:15px;">${streakBadge()}</div>
            </div>
            ${clashMiniBarHtml()}
        `;
    }

    let lastProcessedText = null;
    let lastProcessedKey = null;

    function tryParseAndUpdate(text) {
        // fast path: identical string
        if (text === lastProcessedText) return;

        try {
            const data = JSON.parse(text);
            if (!(data && data.ModesGlicko)) return;

            // fetch + console hooks can emit byte-different strings for the same
            // event. stable key on the ratings themselves. set BEFORE submit
            // fires or the two paths race.
            const key = data.Id + "|"
                + (data.ModesGlicko?.Competitive3v3?.displayRating ?? "") + "|"
                + (data.ModesGlicko?.Competitive2v2?.displayRating ?? "") + "|"
                + (data.ModesGlicko?.Competitive1v1?.displayRating ?? "") + "|"
                + (data.ModesGlicko?.Casual?.displayRating ?? "") + "|"
                + (data.ModesData?.Competitive3v3?.matchesPlayed ?? "") + "|"
                + (data.ModesData?.Competitive2v2?.matchesPlayed ?? "") + "|"
                + (data.ModesData?.Competitive1v1?.matchesPlayed ?? "") + "|"
                + (data.ModesData?.Casual?.matchesPlayed ?? "");
            if (key === lastProcessedKey) return;

            lastProcessedText = text;
            lastProcessedKey = key;
            _lastValidRatingsAt = performance.now(); // watchdog signal
            updateHUD(data);
            submitToLeaderboard(data);
        } catch (e) {
            dbg("tryParseAndUpdate threw: " + getErrMsg(e));
        }
    }

    // ---------- Leaderboard submission ----------

    // public client config, not a secret. null to disable submissions.
    const FIREBASE_CONFIG = {
        apiKey: "AIzaSyD29s2Jku_DZ42keIQAETgKg7HWt__QEwY",
        authDomain: "rgleaderboard.firebaseapp.com",
        projectId: "rgleaderboard",
        storageBucket: "rgleaderboard.firebasestorage.app",
        messagingSenderId: "247848634543",
        appId: "1:247848634543:web:6a7e506d60544d46cc6c5a",
        measurementId: "G-JW3Q972P9T",
    };

    // full dump. site reads the trimmed "leaderboard" collection that
    // syncToRealLeaderboard writes to.
    const LEADERBOARD_COLLECTION = "script_submissions";

    let firestoreReady = null;
    let firestoreInitPromise = null;
    let atlasFirebaseAuth = null;
    // Set by initFirebase() after anon sign-in. Rules bind writes to this.
    let firebaseAuthUid = null;
    let firebaseAuthError = null;
    let firestoreReadCount = 0;
    let firestoreWriteCount = 0;
    const FIRESTORE_READ_BUDGET = 120;
    const FIRESTORE_WRITE_BUDGET = 40;
    const FIRESTORE_BUDGET_WINDOW_MS = 10 * 60 * 1000;
    let firestoreBudgetWindow = {
        startedAt: Date.now(),
        reads: 0,
        writes: 0,
        readWarned: false,
        writeWarned: false,
    };
    // Per-session tallies uploaded to hud_read_stats so we can attribute
    // reads/writes back to specific HUD features without shipping a new
    // build. Session start is fixed for the life of the userscript instance;
    // resets happen when the browser reloads the game page.
    const HUD_STATS_SESSION_STARTED_AT = new Date().toISOString();
    const hudSessionReadsByLabel = new Map();
    const hudSessionWritesByLabel = new Map();
    // Per-label deny count, uploaded with the read-stats payload.
    const hudSessionDeniesByLabel = new Map();
    // Recent deny records so the admin panel can show who/what/which rule,
    // not just a bucket count.
    const HUD_DENY_RECORD_MAX = 25;
    const hudSessionDenies = [];

    // ---------- Persistent read-stats telemetry ----------
    // Every ~5 minutes and on tab unload the HUD uploads its session read/
    // write breakdown to hud_read_stats/{yyyy-mm-dd}_{sourceUserId}. This
    // lets us reconstruct which HUD features drove Firestore reads over
    // a day, not just the aggregate from Firebase's console. Zero-cost
    // when nothing has changed since the last upload.
    const HUD_STATS_UPLOAD_INTERVAL_MS = 5 * 60 * 1000;
    let hudStatsUploadHandle = null;
    let hudStatsUploadInFlight = false;
    let hudStatsPendingFinalFlush = false;
    let hudStatsLastPayloadKey = "";

    // Kick off the uploader after firestoreReady lands. initFirebase() sets
    // firestoreReady synchronously at end-of-init, so a slightly delayed
    // scheduler doesn't miss the boot phase.
    setTimeout(() => scheduleHudStatsUpload(), 15_000);

    // ---------- Proxy KV auth fallback ----------
    //
    // Runs only when the script was injected by the reverse-proxy Worker
    // (no Tampermonkey). Firebase's own IndexedDB survives normal reloads,
    // but any "clear site data" nukes it, and the next boot mints a fresh
    // anonymous uid. That loses the user's stats and clan membership.
    //
    // The Worker exposes /atlas/kv/:sid/atlasFirebaseAuthUser as a tiny
    // ciphertext store. We encrypt the Firebase auth blob with an AES-GCM
    // key held only in the browser (localStorage + cookie mirror), so the
    // Worker never sees plaintext or key.

    const ATLAS_PROXY_KV_KEY_NAME = "atlasFirebaseAuthUser";
    const atlasProxyKvPath = (sid) =>
        "/atlas/kv/" + encodeURIComponent(sid) + "/" + ATLAS_PROXY_KV_KEY_NAME;

    let signInAnonymouslyFn = async () => {
        throw new Error("signInAnonymously is not loaded");
    };

    // ---------- Force-update gate ----------
    // admin/gate has { minVersion, pauseWrites }. The pin book lives on
    // admin/blacklist and is admin-only. Rules still reject sub-min writes
    // from blacklist.minVersion. Check once per session.

    let updateRequiredChecked = false;
    let updateRequired = false;
    let writesPaused = false;
    let notAllowlisted = false;
    let updateRequiredUiShown = false;
    let writesPausedUiShown = false;
    let notAllowlistedUiShown = false;
    const DISCORD_INVITE = "https://discord.gg/MDz7hsrh9m";

    // ---------- Soft update nudge ----------
    // admin/latest_version is the current recommended release. If we're older
    // (and not already dismissed for this exact version), show a persistent
    // click-to-install banner. Non-blocking — the hard gate lives in
    // admin/gate.minVersion and admin/blacklist.minVersion (writes).
    let updateNudgeChecked = false;
    const DEFAULT_UPDATE_URL =
        "https://raw.githubusercontent.com/Pal1533/Tampermonkeys/refs/heads/main/rg_hud.user.js";

    // ---------- In-HUD name modal (replaces window.prompt) ----------

    let nameModalResolve = null;

    ["keydown", "keyup", "keypress"].forEach(type => {
        window.addEventListener(type, e => {
            const active = document.activeElement;
            const dialog = document.getElementById("rgDialog");
            const dialogOpen = isFlexVisible(dialog);
            if (dialogOpen) {
                e.stopImmediatePropagation();
                if (type === "keydown" && e.key === "Escape") {
                    e.preventDefault();
                    const btn = document.getElementById("rgDialogCancel");
                    if (isVisible(btn)) btn.click();
                } else if (type === "keydown" && e.key === "Enter"
                    && (active?.id === "rgDialogInput" || active?.id === "rgDialogOk")) {
                    e.preventDefault();
                    document.getElementById("rgDialogOk")?.click();
                } else if (type === "keydown" && e.key === "Enter" && active?.id === "rgDialogCancel") {
                    e.preventDefault();
                    document.getElementById("rgDialogCancel")?.click();
                }
                return;
            }
            // Name Forge installs its own guard later in this same script. Let
            // it handle undo/redo, Apply, and synthetic text editing before
            // either event can reach the game.
            if (isNameForgeInput(active)) return;
            const inHud = active && hud && hud.contains(active)
                && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")
                && active.type !== "checkbox" && active.type !== "range" && active.type !== "color";
            if (inHud) {
                e.stopImmediatePropagation();
                // Enter saves the name modal
                if (type === "keydown" && e.key === "Enter" && active.id === "rgNameInput") {
                    const saveBtn = document.getElementById("rgNameSave");
                    if (saveBtn && !saveBtn.disabled) saveBtn.click();
                }
            }
        }, true); // capture — must run before Unity's listener
    });

    // ---------- Write-reduction caches ----------
    // read nothing twice per session, write nothing unchanged.

    const cachedDisplayNames = new Map();  // player -> displayName
    const lastSyncSnapshot = new Map();    // player -> last payload JSON

    const SYNC_COOLDOWN_MS = 20000;
    const lastSyncTime = new Map();

    let forceRenamePrompt = false;

    // serialize per-player so races can't double-prompt or double-write
    const submitLocks = new Map();

    // serialize per player+mode so races can't create duplicate docs
    const upsertLocks = new Map();

    // last-written state per player+playlist. a 3v3 match only touches 3v3+wins,
    // so 1v1/2v2 skip. sessionStorage-backed so refresh doesn't full-burst.
    const lastEntryState = new Map(
        (() => {
            try { return JSON.parse(sessionStorage.getItem("rgHudEntryState") ?? "[]"); }
            catch (e) {
                dbg("lastEntryState load failed, starting empty");
                return [];
            }
        })()
    );

    function saveEntryState() {
        try {
            sessionStorage.setItem("rgHudEntryState", JSON.stringify([...lastEntryState]));
        } catch (e) {}
    }
    let opponentStreakCache = {};
    try {
        opponentStreakCache = JSON.parse(
            localStorage.getItem(OPPONENT_STREAK_CACHE_KEY) || "{}"
        ) || {};
    } catch (e) {
        dbg("opponent streak cache load failed");
    }

    // Same-match streak memo: roster + end-of-match popups often re-resolve
    // the same opponent; skip duplicate script_submissions gets for ~60s.
    const STREAK_READ_MEMO_TTL_MS = 60 * 1000;
    const _streakReadMemo = new Map();
    const _streakInFlight = new Map();

    async function resolveOpponentStreak(uid) {
        if (!uid) return { streak: 0, confident: false };
        const memo = _streakReadMemo.get(uid);
        if (memo && Date.now() - memo.at < STREAK_READ_MEMO_TTL_MS) {
            return memo.value;
        }
        if (_streakInFlight.has(uid)) return _streakInFlight.get(uid);
        const pending = (async () => {
            try {
                const fb = await initFirebase();
                if (!fb) return { streak: 0, confident: false };
                const snap = await fb.getDoc(
                    fb.doc(fb.db, LEADERBOARD_COLLECTION, uid)
                );
                if (!snap.exists()) {
                    const miss = { streak: 0, confident: false };
                    _streakReadMemo.set(uid, { at: Date.now(), value: miss });
                    return miss;
                }
                const data = snap.data() || {};
                const totals = submissionTotals(data.stats);
                if (!totals) {
                    const miss = { streak: 0, confident: false };
                    _streakReadMemo.set(uid, { at: Date.now(), value: miss });
                    return miss;
                }
                // Older clients merge their snapshot and leave unknown fields in
                // place, so only trust a streak when this version wrote the doc.
                const supportsPublishedStreak = Number(data.versionNum) >= 16.3;
                const published = supportsPublishedStreak
                    && Number.isFinite(Number(data.currentStreak))
                    ? Number(data.currentStreak)
                    : null;
                const next = advanceOpponentStreak(
                    opponentStreakCache[uid],
                    totals.wins,
                    totals.matches,
                    published,
                );
                opponentStreakCache[uid] = next;
                saveOpponentStreakCache();
                _streakReadMemo.set(uid, { at: Date.now(), value: next });
                return next;
            } catch (e) {
                dbg("opponent streak read failed: " + getErrMsg(e));
                return { streak: 0, confident: false };
            } finally {
                _streakInFlight.delete(uid);
            }
        })();
        _streakInFlight.set(uid, pending);
        return pending;
    }

    let _remoteConfigMemo = null;
    const _lbCacheMemo = new Map();
    const _lbCacheInFlight = new Map();
    const _lbCacheFailUntil = new Map();
    const RG_LB_FAIL_COOLDOWN_MS = 60 * 1000;
    let _matchFormat = null;
    let _matchPlayerCount = 0;
    let _selfTeam = null;
    let _shownPopupsThisMatch = new Set();
    let _matchOpponentStreaks = new Map();
    let _deferredMatch = null;
    let _rosterFired = false;
    let _rosterFiring = false;
    let _rosterFireTimer = null;
    let _matchPopupGeneration = 0;

    // ---------- Rank lookup ----------
    // count aggregation: "how many entries have higher mmr than mine" is one
    // cheap server-side count, not a collection download. cached; force=true
    // after our own writes, otherwise once per session.
    //
    // only re-queries modes whose MMR actually moved since last check. someone
    // else climbing could shuffle you, but not worth 4 reads/match.

    let ranksFetchedThisSession = false;
    const lastRankedMMR = new Map(); // playlist -> mmr at last query
    const lastRankedAt = new Map();  // playlist -> ms timestamp of last query
    // MMR-unchanged skip only trusts a cache younger than this. Rank drifts
    // when other players play, not just when your own MMR moves — so a
    // stale mode (like 3v3 for a mostly-1v1 player) still gets refreshed.
    const RANK_QUERY_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h

    // Site publishes the same JSON blob it renders from every ~15 min via
    // the publish-leaderboard-json workflow. Reading it directly means
    // HUD rank matches site rank exactly (identity dedup, soft-delete
    // filter, and fresh MMR all baked in), and costs zero Firebase reads.
    // The Firestore aggregate can lag 30+ min behind this, which is why a
    // player who just finished a match sees the site update first.
    const SITE_JSON_BASE = "https://raw.githubusercontent.com/Pal1533/rg_player_leaderboard/data/leaderboard";
    const SITE_JSON_TTL_MS = 5 * 60 * 1000; // 5 min in-memory
    const siteJsonCache = new Map(); // playlist -> { rows, fetchedAt }

    // Cache the last-known rank+MMR per account in localStorage so a HUD reload
    // doesn't force a fresh Firestore fetch. Your rank only meaningfully moves
    // when you play — match-end force=true takes care of that. 24h TTL is just
    // a safety net against drift if someone leapfrogs you while you're idle.
    const RANK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

    // ---------- Network capture ----------

    // last-known equipped skin, needed by partial equipSkin responses
    let lastKnownPlayerData = null;

    // ---------- Last-game lobby roster (feeds Forge's Imposter section) ----------
    // game logs "Initialized stats for player X" per player as a match forms.
    // we collect names while the match runs, freeze on matchEnd / LeaveRoom.
    // persisted so a page refresh (Tampermonkey update requires one) doesn't
    // wipe the roster before the user opens Forge — 13.4 shipped that bug
    // and Imposter always showed empty.
    let lastGamePlayers = [];   // frozen roster of the last match: [{name, uid}]
    try { lastGamePlayers = JSON.parse(localStorage.getItem("rgHudLastRoster") ?? "[]"); }
    catch (e) { pushError(e, "loadLastRoster"); }
    let _liveRoster = [];       // in-progress match: [{name, uid}]

    // "are we in a real match right now". set on first init line with a real
    // UserId (warm-up self-inits log empty UserId), cleared on matchEnd /
    // LeaveRoom / new queue. all HUD-restore signals gate on this so a
    // reconnect storm can't resurrect the HUD mid-match.
    // don't substring-match "OnDisconnected" — it also matches
    // "OurOnDisconnected" and restores the HUD on every reconnect.
    let _inMatch = false;

    // watchdog timestamps:
    //   _lastInitLineAt      : last real init line, proves console hook is alive
    //   _lastRecoverySignalAt: last menu/reconnect signal
    //   _lastValidRatingsAt  : last successful ModesGlicko parse, proves matchEnd
    //                          shape hasn't changed
    let _lastInitLineAt = 0;
    let _lastRecoverySignalAt = 0;
    let _lastValidRatingsAt = 0;
    let _matchEndArmedAt = 0;
    let _matchEndWatchdogTimer = null;

    const API_HOST_FRAGMENT = "us-central1-rocketball-23c12.cloudfunctions.net";

    const gameWindow = pageWindow();
    dbg("page hooks on " + (gameWindow === window ? "window" : "unsafeWindow"));
    const oldFetch = gameWindow.fetch.bind(gameWindow);
    gameWindow.fetch = async function (...args) {
        const response = await oldFetch.apply(this, args);
        try {
            const url = args[0]?.toString?.() ?? "";
            if (!url.includes(API_HOST_FRAGMENT)) return response;

            const clone = response.clone();
            const text = await clone.text();

            if (url.includes("/v0304_player/matchEnd")) {
                // if no valid ratings parse within 30s the game probably changed
                // the response shape — surface it instead of freezing on stale numbers.
                _matchEndArmedAt = performance.now();
                if (_matchEndWatchdogTimer) clearTimeout(_matchEndWatchdogTimer);
                _matchEndWatchdogTimer = setTimeout(() => {
                    if (_lastValidRatingsAt < _matchEndArmedAt) {
                        dbgWarn("matchEnd fired but no valid ratings parse in 30s — game may have updated");
                        showError("Match ratings parse failed — game may have updated. Check rgDump().");
                    }
                }, 30 * 1000);
                // snapshot ratings + opponents before update path mutates them,
                // so writeMatchAudit can diff cleanly
                const prevRatings = {
                    Competitive3v3: lastKnownPlayerData?.ModesGlicko?.Competitive3v3?.displayRating,
                    Competitive2v2: lastKnownPlayerData?.ModesGlicko?.Competitive2v2?.displayRating,
                    Competitive1v1: lastKnownPlayerData?.ModesGlicko?.Competitive1v1?.displayRating,
                    Casual: lastKnownPlayerData?.ModesGlicko?.Casual?.displayRating,
                };
                const opponentsSnapshot = _liveRoster.slice();
                const opponentStreakSnapshot = [..._matchOpponentStreaks.values()]
                    .map(entry => ({ ...entry }));
                tryParseAndUpdate(text);
                const nextRatings = {
                    Competitive3v3: lastKnownPlayerData?.ModesGlicko?.Competitive3v3?.displayRating,
                    Competitive2v2: lastKnownPlayerData?.ModesGlicko?.Competitive2v2?.displayRating,
                    Competitive1v1: lastKnownPlayerData?.ModesGlicko?.Competitive1v1?.displayRating,
                    Casual: lastKnownPlayerData?.ModesGlicko?.Casual?.displayRating,
                };
                maybeShowStreakSnipe(
                    prevRatings,
                    nextRatings,
                    opponentStreakSnapshot,
                );
                // Contribution is event-critical, so it owns a match-end sync.
                // Do not make it depend on the diagnostic audit or leaderboard
                // submission path (both can independently skip/fail).
                syncClanAfterMatch(lastKnownPlayerData);
                dbg(`matchEnd response — roster at ${_liveRoster.length}, restoring HUD`);
                _inMatch = false;
                syncPingTracker();
                freezeRoster();
                setAutoVisible(true);
                // fire-and-forget audit write
                writeMatchAudit(prevRatings, opponentsSnapshot);
                // If Starting was missing, the ratings delta now reveals mode.
                // The function snapshots its inputs before awaiting, so reset
                // immediately and prevent timers/state leaking into a rematch.
                firePostmortemPopupsIfDeferred(prevRatings);
                resetMatchPopupState();
            } else if (url.includes("/v0304_login/login")) {
                tryParseAndUpdate(text);
                try {
                    // Move Forge off its anonymous/default state even when the
                    // player opened it before the login response arrived.
                    syncForgeFromLogin(JSON.parse(text));
                } catch (e) {
                    dbg("login Name Forge sync failed: " + getErrMsg(e));
                }
            } else if (url.includes("/v0304_player/equipSkin")) {
                // response is a bare quoted skin id, e.g. "body.2"
                try {
                    const skinId = JSON.parse(text);
                    if (lastKnownPlayerData) {
                        lastKnownPlayerData.EquippedSkinId = skinId;
                    }
                } catch (e) {
                    dbg("equipSkin parse failed: " + getErrMsg(e));
                }
            }
        } catch (e) {
            dbg("fetch wrapper threw: " + getErrMsg(e));
        }
        return response;
    };

    const pageConsole = gameWindow.console;
    const oldPageLog = pageConsole.log.bind(pageConsole);
    pageConsole.log = function (...args) {
        oldPageLog.apply(pageConsole, args);
        // feed the raw buffer for atlasCap()
        _rawPush("log", args);
        // wrap: a throw in any branch below unwinds the loop and every
        // state transition after it is silently missed.
        try {
            for (const arg of args) {
                if (typeof arg !== "string") continue;

                // ratings can also come in via logged request text (login, echoed
                // matchEnd). tryParseAndUpdate dedupes with the fetch hook.
                if (arg.includes('"ModesGlicko"')) {
                    const json = arg.substring(arg.indexOf("{"));
                    tryParseAndUpdate(json);
                }

                // ---- init line: queue warm-up OR real match forming ----
                // shape: ...for player: <markup>Name<size=0> (UserId: abc123, Team: Orange)
                // UserId is the discriminator: warm-up logs an EMPTY UserId,
                // real match inits always populate it. without this check,
                // warm-up inits restart the roster mid-queue.
                if (arg.includes("[PlayerDataManager] Initialized stats for player")) {
                    // Parse the parenthesized fields independently so empty
                    // warm-up UserIds and future extra fields remain valid.
                    const parsed = parseRosterInitLine(arg);
                    const nm = parsed?.name ?? "";
                    const uid = parsed?.uid ?? "";
                    const team = parsed?.team ?? null;
                    if (uid) {
                        const displayName = nm || "(unnamed)";
                        _lastInitLineAt = performance.now();
                        setAutoVisible(false); // real match — hide HUD
                        if (!_inMatch) {
                            _liveRoster = [];
                            _inMatch = true;
                            syncPingTracker();
                            dbg(`match forming — roster reset, first player "${displayName}"`);
                        }
                        // Dedupe by uid, but accept a later corrected team/name
                        // before firing. Photon can re-emit after rebalancing.
                        const existing = _liveRoster.find(player => player.uid === uid);
                        if (!existing) {
                            const entry = { name: displayName, uid, team };
                            _liveRoster.push(entry);
                            dbg(`roster +1 "${displayName}"${team ? ` (${team})` : ""} (${_liveRoster.length} total)`);
                            // fire the leaderboard-opponent popup check
                            onRosterEntry(entry);
                        } else {
                            const nameChanged = nm && nm !== existing.name;
                            const teamChanged = team && team !== existing.team;
                            if (nameChanged) existing.name = nm;
                            if (teamChanged) existing.team = team;
                            if (nameChanged || teamChanged) {
                                dbg(`roster corrected "${existing.name}"${existing.team ? ` (${existing.team})` : ""}`);
                                onRosterEntry(existing);
                            }
                        }
                    } else if (nm) {
                        dbg(`warm-up init "${nm}" (empty uid) — ignored, inMatch=${_inMatch}`);
                    } else {
                        // canary: if this line ever fails, the game format changed.
                        // yellow dot so users notice without DevTools.
                        dbgWarn(`init line FAILED to parse — game format may have changed`);
                        dbg(`init line raw: ${arg.slice(0, 120)}`);
                    }
                }

                // "Starting game with N players" fires right before the real
                // uid inits. tells us format when it's unambiguous (2, 5, 6).
                if (arg.includes("Starting game with") && arg.includes("players")) {
                    const m = arg.match(/Starting game with\s+(\d+)\s+players/);
                    if (m) {
                        // A fresh start line is the clean boundary even if the
                        // previous match never sent its normal ending signal.
                        resetMatchPopupState();
                        _matchPlayerCount = parseInt(m[1], 10);
                        _matchFormat = derivedFormatFromPlayerCount(_matchPlayerCount);
                        dbg(`match player count = ${_matchPlayerCount}, format = ${_matchFormat || "unknown"}`);
                        // Pre-warm only the active playlist.
                        if (_matchFormat) getLeaderboardCache(_matchFormat);
                        if (_matchFormat) {
                            // Late Starting line: live roster now owns delivery;
                            // discard deferred state to prevent match-end duplicates.
                            _deferredMatch = null;
                            scheduleRankedRosterPopups();
                        }
                    }
                }

                // ---- left match another way (rage-quit, back-out) ----
                // LeaveRoom / fresh queue can't coexist with mid-match. freeze
                // so Imposter survives early exits.
                if (arg.includes("PhotonNetwork:LeaveRoom") ||
                    arg.includes("Set player matchmaking start time")) {
                    if (_inMatch) {
                        dbg(`left mid-match — roster frozen at ${_liveRoster.length}`);
                        freezeRoster();
                    }
                    _inMatch = false;
                    syncPingTracker();
                    // new match is being queued — clear popup state
                    resetMatchPopupState();
                    // Private matches fire their recovery signal (SetNickname
                    // / OurOnConnectedToMaster) BEFORE LeaveRoom, so the HUD
                    // restore up in that handler got suppressed as
                    // mid-match. Now that _inMatch is finally false, put
                    // the HUD back — no waiting for the ticker.
                    setAutoVisible(true);
                }

                // ---- return-to-menu / recovery signals ----
                // "OnJoinedRoom"/"OnLeftRoom" never appear and "OnDisconnected"
                // only shows up as a substring of "OurOnDisconnected". these
                // are the actual strings. word-boundaries on Our* to avoid
                // the same substring-match trap.
                // gate restore on !_inMatch or a reconnect storm respawns the HUD.
                // "Starting SetNickname" covers practice/private, which emit
                // no room strings on exit.
                if (/\bOurOnDisconnected\b/.test(arg) || arg.includes("Starting SetNickname") ||
                    /\bOurOnConnectedToMaster\b/.test(arg)) {
                    _lastRecoverySignalAt = performance.now();
                    if (!_inMatch) setAutoVisible(true);
                    else dbg(`recovery signal suppressed (mid-match): ${arg.slice(0, 60)}`);
                }

                // Private matches don't emit LeaveRoom, so _inMatch was
                // never getting cleared and none of the recovery signals
                // above could restore the HUD. "Showing PlayGama banners"
                // is the ad banner the game logs when the main menu is
                // back on screen — treat that as authoritative end-of-match.
                if (arg.includes("Showing PlayGama banners") && _inMatch) {
                    dbg("PlayGama banners visible — treating as match-end");
                    _inMatch = false;
                    syncPingTracker();
                    resetMatchPopupState();
                    setAutoVisible(true);
                }
            }
        } catch (e) {
            dbg("console.log hook threw: " + getErrMsg(e));
        }
    };

    // ---------- Clan events (Clan Clash) ----------
    // config lives in events/current (admin-only). timing uses serverTimestamp
    // so device clocks can't spoof it. each member's baseline MMR is captured
    // on their first sync after the event starts. score = sum(current - baseline).

    let eventConfig = null;       // { name, startTime(ms), endTime(ms) } or null
    let eventConfigLoaded = false;
    let serverNowOffset = null;   // (serverTime - deviceTime), ms
    let clanRolePerms = null;        // stored overrides from admin/clanPerms, or null
    let clanRolePermsLoaded = false;

    // 1s tick. target/phase live on data-* attrs so it no-ops when the span
    // isn't in the DOM. crossing a phase boundary triggers a full re-render.
    let countdownIntervalId = null;

    // ---------- Clans (Stage 1: create / browse / request / approve) ----------

    let myClan = null;          // the clan doc this player belongs to, or null
    let clanDirectory = [];     // lightweight list of all clans for browsing
    let clanLoaded = false;
    let clanLoadedForAccount = null; // which account the above was loaded for
    let clanLoadInFlight = null;     // shared promise so parallel callers dedupe
    let clanLoadInFlightAccount = null;
    let clanLoadInFlightForce = false;
    let clanLoadFailedAt = 0;        // ms; skip retries until cooldown passes
    const CLAN_LOAD_FAILURE_COOLDOWN_MS = 60_000;

    // live clan-doc listener. attach while Clan tab is open, detach on close.
    // callback renders straight from the snapshot — refetching triples reads.
    let _clanUnsub = null;
    let _clanListenerId = null;
    let _clanAttaching = false; // guard against re-entry during init await

    // throttled rebuild for routine MMR updates. structural changes still call
    // refreshDirectory directly. my own HUD stays live via patchMyClanInDirectory.
    let lastDirRefreshAt = 0;
    const DIR_REFRESH_THROTTLE_MS = 3 * 60 * 1000;

    let clanNoticeTimer = null;

    // themed alert/confirm/prompt
    let toastTimeout = null;

    // ---------- Boot ----------

    const wait = setInterval(() => {
        if (document.body) {
            clearInterval(wait);
            createHUD();
            maybeShowUpdateNudge();
            console.log("[RG HUD] loaded and running, waiting for login/matchEnd data...");
        }
    }, 100);

    // watchdog for _inMatch: if the game silently reconnects without emitting
    // matchEnd/LeaveRoom, the HUD stays hidden forever. 10min exceeds any
    // real match so we won't clobber legit state.
    const INMATCH_STALE_MS = 10 * 60 * 1000;
    setInterval(() => {
        if (!_inMatch) return;
        const now = performance.now();
        const initStale = (now - _lastInitLineAt) > INMATCH_STALE_MS;
        const recoveryRecent = _lastRecoverySignalAt > 0
            && (now - _lastRecoverySignalAt) < 60 * 1000;
        if (initStale && recoveryRecent) {
            dbg(`_inMatch watchdog: stale for ${((now - _lastInitLineAt) / 60000).toFixed(1)}m + recent recovery signal -- clearing`);
            _inMatch = false;
            syncPingTracker();
            setAutoVisible(true);
        }
    }, 60 * 1000);

    // Private matches don't fire the recovery signals we key restore on,
    // so the HUD stayed hidden after coming back to the menu. Cheap
    // ticker: if we're not in a match and the HUD is hidden or detached,
    // put it back. Idempotent — no-op when the HUD is already visible.
    setInterval(() => {
        if (_inMatch) return;
        if (!hud) return;
        if (!hud.isConnected || !isVisible(hud)) {
            setAutoVisible(true);
        }
    }, 2000);


    const RGNF = createNameForge({
        dbg,
        getErrMsg,
        stripLeadingClanTagMarkup,
    });
    if (RGNF.setPrefixProvider) RGNF.setPrefixProvider(getClanTagPrefix);
    if (RGNF.setPrefixTargetProvider) RGNF.setPrefixTargetProvider(clanTagPositionPref);
    if (RGNF.setTagStripper) RGNF.setTagStripper(stripLeadingClanTagMarkup);

}
