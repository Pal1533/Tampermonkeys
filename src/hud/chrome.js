
// @grant puts Tampermonkey in the isolated world on Chrome. Game
// fetch / console.log live on the page. Always hook that window.
export function pageWindow() {
    try {
        if (typeof unsafeWindow !== "undefined" && unsafeWindow) return unsafeWindow;
    } catch (e) {}
    return window;
}

export function currentUidForDeny() {
    try { return (typeof myUserId === "function" && myUserId()) || ""; }
    catch { return ""; }
}


// ---------- Error indicator ----------

export function formatAtlasError(message) {
    const raw = String(message || "Something failed").trim()
        .replace(/\s*(?:—|--).*$/, "")
        .replace(/\.+$/, "");
    const head = /fail/i.test(raw) ? raw : `${raw} failed`;
    if (/Discord/i.test(head)) return head;
    return `${head}, message RIS3N or Pal on Discord`;
}


// img not emoji, stays crisp cross-OS
export const ATLAS_ICON_URL = 'https://raw.githubusercontent.com/Pal1533/Tampermonkeys/refs/heads/main/atlas/atlas.png';



// ---------- Settings (persisted in localStorage) ----------

export const DEFAULT_SETTINGS = {
    glowEnabled: true,
    glowSpeed: 5,        // 1-10, higher = faster
    glowOpacity: 0.6,    // vibrancy
    glowColor1: "#ff7a00",
    glowColor2: "#00d4ff",
    // brings back the old 🚀 Rocket Goal HUD title
    ogTitle: false,
    // coarse browser estimate; never presented as exact Photon ping
    pingTrackerEnabled: false,
    streakSnipeEnabled: true,
};


export function saveSettings() {
    try { localStorage.setItem("rgHudSettings", JSON.stringify(settings)); }
    catch (e) { pushError(e, "saveSettings"); }
}

export function browserConnection() {
    if (typeof navigator === "undefined") return null;
    return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
}


export function ensurePingTracker() {
    let tracker = document.getElementById("rgPingTracker");
    if (tracker || !document.body) return tracker;
    tracker = document.createElement("div");
    tracker.id = "rgPingTracker";
    tracker.setAttribute("aria-live", "off");
    tracker.style.cssText = `
        display:none;
        position:fixed;
        top:12px;
        left:12px;
        z-index:999999997;
        pointer-events:none;
        user-select:none;
        align-items:center;
        gap:5px;
        padding:0;
        border:0;
        background:transparent;
        color:#cbd5e1;
        font:600 11px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
        font-variant-numeric:tabular-nums;
        letter-spacing:.04em;
        opacity:.78;
        text-shadow:0 1px 2px #000,0 0 5px rgba(0,0,0,.85);
    `;
    tracker.innerHTML = `
        <span data-rg-rtt-dot style="width:5px;height:5px;border-radius:50%;background:#94a3b8;box-shadow:0 0 4px currentColor;"></span>
        <span data-rg-rtt-value>NET —</span>
    `;
    document.body.appendChild(tracker);
    return tracker;
}


export function renderPingTracker(rtt = pingTrackerLastRtt, source = "active site probe") {
    const tracker = ensurePingTracker();
    if (!tracker) return;
    if (!settings.pingTrackerEnabled || !_inMatch) {
        tracker.style.display = "none";
        return;
    }
    const dot = tracker.querySelector("[data-rg-rtt-dot]");
    const value = tracker.querySelector("[data-rg-rtt-value]");
    tracker.style.display = "flex";
    if (!Number.isFinite(rtt) || rtt <= 0) {
        if (value) value.textContent = "NET —";
        if (dot) dot.style.background = "#94a3b8";
        tracker.style.color = "#cbd5e1";
        tracker.title = "Network RTT estimate is unavailable";
        return;
    }
    const rounded = Math.round(rtt);
    const color = rounded <= 60 ? "#4ade80" : rounded <= 120 ? "#facc15" : "#fb7185";
    if (value) value.textContent = `${rounded} ms`;
    if (dot) dot.style.background = color;
    tracker.style.color = color;
    tracker.title = `${source}; not exact Photon server ping`;
}


export async function probePingTracker(generation) {
    if (pingTrackerProbeInFlight || generation !== pingTrackerProbeGeneration
        || !settings.pingTrackerEnabled || !_inMatch) return;
    pingTrackerProbeInFlight = true;
    let timeoutId = null;
    try {
        const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        if (controller) {
            timeoutId = setTimeout(() => controller.abort(), PING_PROBE_TIMEOUT_MS);
        }
        const startedAt = performance.now();
        const target = new URL("/favicon.ico", location.origin);
        target.searchParams.set("atlas_rtt", Date.now().toString(36));
        await fetch(target.href, {
            method: "HEAD",
            cache: "no-store",
            credentials: "omit",
            signal: controller?.signal,
        });
        if (generation !== pingTrackerProbeGeneration
            || !settings.pingTrackerEnabled || !_inMatch) return;
        const sample = Math.max(1, Math.round(performance.now() - startedAt));
        pingTrackerSamples.push(sample);
        if (pingTrackerSamples.length > 3) pingTrackerSamples.shift();
        pingTrackerLastRtt = medianPingSample(pingTrackerSamples);
        renderPingTracker(pingTrackerLastRtt, "Active RTT estimate to rocketgoal.io");
    } catch (e) {
        if (generation !== pingTrackerProbeGeneration
            || !settings.pingTrackerEnabled || !_inMatch) return;
        const fallback = Number(browserConnection()?.rtt);
        pingTrackerLastRtt = Number.isFinite(fallback) && fallback > 0 ? fallback : null;
        renderPingTracker(pingTrackerLastRtt, "Browser connection RTT fallback");
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
        pingTrackerProbeInFlight = false;
    }
}


export function syncPingTracker() {
    pingTrackerProbeGeneration++;
    pingTrackerSamples = [];
    pingTrackerLastRtt = null;
    renderPingTracker();
    if (pingTrackerIntervalId) {
        clearInterval(pingTrackerIntervalId);
        pingTrackerIntervalId = null;
    }
    if (settings.pingTrackerEnabled && _inMatch) {
        const generation = pingTrackerProbeGeneration;
        probePingTracker(generation);
        pingTrackerIntervalId = setInterval(
            () => probePingTracker(generation),
            PING_PROBE_INTERVAL_MS,
        );
    }
}


export function clampHudOnScreen() {
    if (!hud) return;
    // hidden HUD returns zeros from getBoundingClientRect and we'd
    // persist top-left as the "corrected" pos. re-clamps on show.
    if (!isVisible(hud) || hud.offsetWidth === 0) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const MARGIN = 40;
    hud.style.maxWidth = Math.max(0, Math.min(340, vw - 16)) + "px";
    const rect = hud.getBoundingClientRect();

    let left = Math.max(8, Math.min(rect.left, vw - rect.width - 8));
    let top = rect.top;

    if (top < 0) top = 0;
    if (top > vh - MARGIN) top = vh - MARGIN;

    if (left !== rect.left || top !== rect.top) {
        hud.style.left = left + "px";
        hud.style.top = top + "px";
        hud.style.right = "auto";
        try {
            localStorage.setItem("rgHudPos", JSON.stringify({
                top: hud.style.top,
                left: hud.style.left,
            }));
        } catch (e) {}
    }
}


export function dragElement(el, handle) {
    let dx = 0, dy = 0;

    // addEventListener instead of document.onmousemove= so we don't
    // clobber any other drag handler the page or game already set.
    handle.onmousedown = e => {
        if (e.target.closest(".rgIconBtn")) return;
        e.preventDefault();
        dx = e.clientX;
        dy = e.clientY;
        const onUp = () => {
            document.removeEventListener("mousemove", drag);
            document.removeEventListener("mouseup", onUp);
            try {
                localStorage.setItem("rgHudPos", JSON.stringify({
                    top: el.style.top,
                    left: el.style.left,
                }));
            } catch (err) {
                dbg("rgHudPos save on drag-end failed");
            }
        };
        document.addEventListener("mousemove", drag);
        document.addEventListener("mouseup", onUp);
    };

    function drag(e) {
        e.preventDefault();
        const moveX = dx - e.clientX;
        const moveY = dy - e.clientY;
        dx = e.clientX;
        dy = e.clientY;
        // clamp: title bar is the only drag handle, off-screen strands the HUD
        const MARGIN = 40;
        let newTop = el.offsetTop - moveY;
        let newLeft = el.offsetLeft - moveX;
        newTop = Math.max(0, Math.min(newTop, window.innerHeight - MARGIN));
        newLeft = Math.max(8, Math.min(newLeft, window.innerWidth - el.offsetWidth - 8));
        el.style.top = newTop + "px";
        el.style.left = newLeft + "px";
        el.style.right = "auto";
    }
}


export function manualToggle() {
    const body = document.getElementById("rgBody");
    const visible = isVisible(body);
    body.style.display = visible ? "none" : "block";
    document.getElementById("rgMinimize").textContent = visible ? "+" : "–";
    document.getElementById("rgMinimize").title = visible ? "Restore" : "Minimize";
}


export function setAutoVisible(visible) {
    if (!hud) return;
    // Private-match → main-menu tears down our parent. Re-attach if
    // we got orphaned, otherwise setting display on it is a no-op.
    if (!hud.isConnected) {
        try { document.body.appendChild(hud); } catch { /* ignore */ }
    }
    hud.style.display = visible ? "block" : "none";
    if (!visible) {
        // tooltip lives on body, kill it or it strands over the game
        const tip = document.getElementById("rgTooltip");
        if (tip) tip.style.opacity = "0";
    }
    // re-clamp on show, window may have resized while hidden
    if (visible) clampHudOnScreen();
}


export function showError(message) {
    const text = formatAtlasError(message);
    const dot = document.getElementById("rgErrDot");
    if (!dot) return;
    dot.style.display = "inline";

    // dedupe by origin+message so four identical rows collapse to one row x4
    const seen = new Map();
    for (const e of _rgErrorBuf.slice(-20)) {
        const key = `${e.origin || ""}:${(e.msg || "").slice(0, 120)}`;
        const prev = seen.get(key);
        if (prev) prev.count += 1;
        else seen.set(key, { ...e, count: 1 });
    }
    const rows = [...seen.values()].slice(-4).map(e => ({
        when: e.at ? new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "",
        origin: e.origin || "",
        msg: e.msg || "",
        count: e.count,
    }));

    ensureErrorTooltipStyles();
    let tip = document.getElementById("rgErrTip");
    if (!tip) {
        tip = document.createElement("div");
        tip.id = "rgErrTip";
        tip.className = "rgErrTip";
        document.body.appendChild(tip);
        dot.addEventListener("mouseenter", () => positionErrorTooltip(dot, tip));
        dot.addEventListener("mouseleave", () => { tip.style.opacity = "0"; tip.style.pointerEvents = "none"; });
    }
    dot.removeAttribute("title");
    tip.innerHTML = renderErrorTooltipHtml(text, rows);
    if (tip.matches(":hover")) positionErrorTooltip(dot, tip);
}

function ensureErrorTooltipStyles() {
    if (document.getElementById("rgErrTipCss")) return;
    const style = document.createElement("style");
    style.id = "rgErrTipCss";
    style.textContent = `
        .rgErrTip{position:fixed;z-index:2147483647;max-width:340px;padding:10px 12px;border-radius:10px;
            background:rgba(20,10,10,0.96);border:1px solid #ff6b6b;color:#ffdada;
            font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
            box-shadow:0 8px 24px rgba(0,0,0,0.5);opacity:0;pointer-events:none;
            transition:opacity 120ms ease;}
        #rgErrDot:hover ~ .rgErrTip,.rgErrTip:hover{opacity:1;pointer-events:auto;}
        .rgErrTip .rgErrHead{font-weight:600;color:#ff8b8b;margin-bottom:6px;letter-spacing:.02em;}
        .rgErrTip .rgErrRow{display:flex;gap:6px;margin-top:4px;align-items:baseline;font-size:11px;}
        .rgErrTip .rgErrWhen{color:#8a6f6f;flex-shrink:0;font-variant-numeric:tabular-nums;}
        .rgErrTip .rgErrOrigin{color:#ffb08a;flex-shrink:0;}
        .rgErrTip .rgErrMsg{color:#ffe0e0;overflow-wrap:anywhere;}
        .rgErrTip .rgErrCount{color:#ff8b8b;font-weight:600;flex-shrink:0;}
        .rgErrTip .rgErrHint{margin-top:8px;color:#a89898;font-size:11px;font-style:italic;}
    `;
    document.head.appendChild(style);
    const dot = document.getElementById("rgErrDot");
    if (dot) {
        dot.addEventListener("mouseenter", () => {
            const t = document.getElementById("rgErrTip");
            if (!t) return;
            t.style.opacity = "1";
            t.style.pointerEvents = "auto";
        });
    }
}

function renderErrorTooltipHtml(head, rows) {
    const esc = (s) => String(s || "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    }[c]));
    const rowsHtml = rows.map(r => {
        const parts = [];
        if (r.when) parts.push(`<span class="rgErrWhen">${esc(r.when)}</span>`);
        if (r.origin) parts.push(`<span class="rgErrOrigin">[${esc(r.origin)}]</span>`);
        parts.push(`<span class="rgErrMsg">${esc(r.msg)}</span>`);
        if (r.count > 1) parts.push(`<span class="rgErrCount">×${r.count}</span>`);
        return `<div class="rgErrRow">${parts.join(" ")}</div>`;
    }).join("");
    return `<div class="rgErrHead">${esc(head)}</div>${rowsHtml}<div class="rgErrHint">Run rgDump() or download debug bundle in Settings for full details.</div>`;
}

function positionErrorTooltip(dot, tip) {
    const r = dot.getBoundingClientRect();
    tip.style.opacity = "1";
    tip.style.pointerEvents = "auto";
    tip.style.top = `${Math.min(window.innerHeight - 200, r.bottom + 6)}px`;
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - 360, r.right - 340))}px`;
}


export function clearError() {
    const dot = document.getElementById("rgErrDot");
    if (dot) dot.style.display = "none";
}


export function saveStreak() {
    try { localStorage.setItem("rgHudStreak", JSON.stringify(streakData)); }
    catch (e) { pushError(e, "saveStreak"); }
}


export function resetStreak(accountId, totalWins, totalMatches) {
    streakData = { accountId, streak: 0, lastWins: totalWins, lastMatches: totalMatches };
    saveStreak();
}


export function updateStreak(data) {
    const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
    const totalWins = modes.reduce((s, m) => s + (data.ModesData?.[m]?.wins ?? 0), 0);
    const totalMatches = modes.reduce((s, m) => s + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);

    // first observation, baseline only
    if (!streakData || streakData.accountId !== data.Id) {
        resetStreak(data.Id, totalWins, totalMatches);
        return;
    }

    const matchDiff = totalMatches - streakData.lastMatches;
    const winDiff = totalWins - streakData.lastWins;

    if (matchDiff <= 0) return;

    const priorStreak = Number(streakData.streak) || 0;

    // no way to know interleaving. pure win/loss block extends the streak,
    // mixed collapses to net sign, magnitude 1
    const losses = matchDiff - winDiff;
    if (winDiff > 0 && losses === 0) {
        streakData.streak = streakData.streak > 0 ? streakData.streak + winDiff : winDiff;
    } else if (losses > 0 && winDiff === 0) {
        streakData.streak = streakData.streak < 0 ? streakData.streak - losses : -losses;
    } else {
        streakData.streak = winDiff >= losses ? 1 : -1;
    }

    // Persist the run to player_streaks whenever it is (a) still climbing
    // above the prior PR, or (b) just broke. Mid-run writes protect against
    // tab crashes, lockouts, and closed browsers eating an in-flight PR;
    // maybeWriteStreakPR itself no-ops when the run isn't beating the prior
    // best, so wins that don't advance the PR cost nothing.
    if (priorStreak > 0 && streakData.streak <= 0) {
        maybeWriteStreakPR(priorStreak, data.Id);
    } else if (streakData.streak > 0) {
        maybeWriteStreakPR(streakData.streak, data.Id);
    }

    streakData.lastWins = totalWins;
    streakData.lastMatches = totalMatches;
    saveStreak();
    return {
        matches: matchDiff,
        wins: Math.max(0, Math.min(matchDiff, winDiff)),
        losses: Math.max(0, Math.min(matchDiff, losses)),
        streak: streakData.streak,
    };
}


// ---------- All-time streak record (persisted to player_streaks/{uid}) ----------
//
// Local cache lives in localStorage so we never re-read the server just
// to decide whether the current session broke a PR. The server-side
// aggregate (leaderboard_cache/streak_records) is built by a scheduled
// script — clients only write their own doc, and only when a positive
// streak ends above their prior best.
let bestWinStreakLocal = (() => {
    try { return JSON.parse(localStorage.getItem("rgHudBestStreak") ?? "null"); }
    catch { return null; }
})();
let bestStreakServerLoaded = false;
let bestStreakLoadInflight = null;

export function bestStreakForAccount(accountId) {
    if (!bestWinStreakLocal || bestWinStreakLocal.accountId !== accountId) return 0;
    return Number(bestWinStreakLocal.best) || 0;
}

async function loadBestStreakFromServer(accountId) {
    if (bestStreakServerLoaded) return;
    if (bestStreakLoadInflight) return bestStreakLoadInflight;
    if (!firebaseAuthUid || !firestoreReady) return;
    const fb = firestoreReady;
    bestStreakLoadInflight = (async () => {
        try {
            const ref = fb.doc(fb.db, "player_streaks", firebaseAuthUid);
            const snap = await fb.getDoc(ref);
            if (snap.exists()) {
                const d = snap.data() || {};
                const serverBest = Number(d.bestWinStreak) || 0;
                const localBest = Number(bestWinStreakLocal?.best) || 0;
                // Server wins on higher value (another device may have set a
                // bigger PR); local wins otherwise so a stale server read
                // doesn't clobber an in-flight write.
                if (serverBest >= localBest) {
                    bestWinStreakLocal = {
                        accountId,
                        best: serverBest,
                        at: Number(d.bestAt) || 0,
                        displayName: d.displayName || "",
                    };
                    try { localStorage.setItem("rgHudBestStreak", JSON.stringify(bestWinStreakLocal)); }
                    catch {}
                }
            }
            bestStreakServerLoaded = true;
        } catch (e) {
            pushError(e, "loadBestStreak");
        } finally {
            bestStreakLoadInflight = null;
        }
    })();
    return bestStreakLoadInflight;
}

function resolveMyDisplayName(accountId) {
    try {
        const cached = cachedDisplayNames.get(accountId);
        if (cached) return cached;
    } catch {}
    try {
        const stored = readStoredDisplayName(atlasTmStorage(), accountId);
        if (stored) return stored;
    } catch {}
    try {
        const nick = lastKnownPlayerData?.Nickname;
        if (nick) return cleanName(nick);
    } catch {}
    return "";
}

export function maybeWriteStreakPR(streakLength, accountId) {
    const run = Math.trunc(Number(streakLength) || 0);
    if (run <= 0) return;
    if (!firebaseAuthUid || !firestoreReady) return;

    // Fire-and-forget so we don't block the HUD render path.
    (async () => {
        try {
            await loadBestStreakFromServer(accountId);
            const prior = bestStreakForAccount(accountId);
            if (run <= prior) return;

            const fb = firestoreReady;
            const ref = fb.doc(fb.db, "player_streaks", firebaseAuthUid);
            const displayName = resolveMyDisplayName(accountId);
            const now = Date.now();
            const payload = {
                accountId,
                displayName,
                bestWinStreak: run,
                bestAt: now,
                sourceUserId: firebaseAuthUid,
            };
            const wrote = await atlasSetDoc(fb, "player_streaks", ref, payload, { merge: true });
            if (wrote) {
                bestWinStreakLocal = { accountId, best: run, at: now, displayName };
                try { localStorage.setItem("rgHudBestStreak", JSON.stringify(bestWinStreakLocal)); }
                catch {}
            }
        } catch (e) {
            pushError(e, "streakPR");
        }
    })();
}


export function streakBadge() {
    if (!streakData || streakData.streak === 0) return "";
    const n = streakData.streak;
    const pr = bestStreakForAccount(streakData.accountId);
    const prTip = pr > 0 ? `. All-time best: ${pr} wins.` : "";
    if (n > 0) {
        return `<span class="rgHasTip rgNoUnderline rgStreakBadge" data-tip="${n}-win streak this session${prTip} Click to see records." style="color:#ff7a00;font-weight:bold;cursor:pointer;">🔥x${n}</span>`;
    }
    return `<span class="rgHasTip rgNoUnderline rgStreakBadge" data-tip="${-n}-loss streak this session${prTip} Click to see records." style="color:#7ec8ff;font-weight:bold;cursor:pointer;">❄️x${-n}</span>`;
}


// ---------- Streak records modal ----------
//
// One cache-doc read per open (leaderboard_cache/streak_records). We
// keep a short-lived in-memory copy so repeated opens within the same
// session don't re-fetch.
const STREAK_RECORDS_CACHE_TTL_MS = 5 * 60 * 1000;
let _streakRecordsCache = null; // { at, rows, updatedAt }

async function fetchStreakRecords() {
    const now = Date.now();
    if (_streakRecordsCache && (now - _streakRecordsCache.at) < STREAK_RECORDS_CACHE_TTL_MS) {
        return _streakRecordsCache;
    }
    if (!firestoreReady) throw new Error("Firestore not ready");
    const fb = firestoreReady;
    const ref = fb.doc(fb.db, "leaderboard_cache", "streak_records");
    const snap = await fb.getDoc(ref);
    if (!snap.exists()) {
        _streakRecordsCache = { at: now, rows: [], updatedAt: 0 };
        return _streakRecordsCache;
    }
    const d = snap.data() || {};
    const rows = Array.isArray(d.rows) ? d.rows : [];
    _streakRecordsCache = {
        at: now,
        rows,
        updatedAt: Number(d.updatedAt) || 0,
    };
    return _streakRecordsCache;
}

function renderStreakRecordsRows(rows, myAccountId) {
    if (!rows.length) {
        return `<div style="color:#9aa5ad;padding:12px 0;text-align:center;">No records yet. End a win streak to seed the board.</div>`;
    }
    const items = rows.slice(0, 50).map((r, i) => {
        const rank = i + 1;
        const streak = Math.trunc(Number(r.bestWinStreak) || 0);
        const name = String(r.displayName || "Unknown").slice(0, 32);
        const when = r.bestAt ? new Date(Number(r.bestAt)).toLocaleDateString() : "";
        const mine = myAccountId && r.accountId === myAccountId;
        const rankColor = rank === 1 ? "#ffd700" : rank <= 3 ? "#c77dff" : rank <= 10 ? "#00d4ff" : "#9aa5ad";
        const rowBg = mine ? "background:rgba(255,122,0,0.12);" : "";
        return `<div style="display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:4px;${rowBg}">
            <span style="color:${rankColor};font-weight:bold;min-width:24px;">#${rank}</span>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name}${mine ? " <span style=\"color:#ff7a00;font-size:10px;\">(you)</span>" : ""}</span>
            <span style="color:#ff7a00;font-weight:bold;">🔥 ${streak}</span>
            <span style="color:#9aa5ad;font-size:10px;min-width:64px;text-align:right;">${when}</span>
        </div>`;
    }).join("");
    return items;
}

export async function openStreakRecordsModal() {
    const modal = document.getElementById("rgStreakRecords");
    const body = document.getElementById("rgStreakRecordsBody");
    const foot = document.getElementById("rgStreakRecordsFoot");
    if (!modal || !body) return;
    modal.style.display = "flex";
    body.innerHTML = "Loading…";
    if (foot) foot.textContent = "";
    try {
        const result = await fetchStreakRecords();
        const myAccountId = lastKnownPlayerData?.Id || null;
        body.innerHTML = renderStreakRecordsRows(result.rows, myAccountId);
        if (foot) {
            const stamp = result.updatedAt ? new Date(result.updatedAt).toLocaleString() : "unknown";
            foot.textContent = `updated ${stamp}`;
        }
    } catch (e) {
        pushError(e, "openStreakRecordsModal");
        body.innerHTML = `<div style="color:#ff6b6b;">Couldn't load records — try again in a bit.</div>`;
    }
}

export function closeStreakRecordsModal() {
    const modal = document.getElementById("rgStreakRecords");
    if (modal) modal.style.display = "none";
}


export function captureSessionStart(data) {
    const now = Date.now();
    const sameAccount = sessionStart && sessionStart.accountId === data.Id;
    const idledOut = sessionStart && (now - (sessionStart.lastSeen ?? 0)) > SESSION_IDLE_MS;

    if (sameAccount && !idledOut) {
        // same session, bump timestamp
        sessionStart.lastSeen = now;
        try { localStorage.setItem("rgHudSessionStart", JSON.stringify(sessionStart)); }
        catch (e) { pushError(e, "saveSessionStart"); }
        return;
    }

    // new session, fresh baseline, drop inherited momentum
    sessionStart = {
        accountId: data.Id,
        startedAt: now,
        lastSeen: now,
        Competitive3v3: data.ModesGlicko?.Competitive3v3?.displayRating ?? null,
        Competitive2v2: data.ModesGlicko?.Competitive2v2?.displayRating ?? null,
        Competitive1v1: data.ModesGlicko?.Competitive1v1?.displayRating ?? null,
        Casual: data.ModesGlicko?.Casual?.displayRating ?? null,
    };
    try { localStorage.setItem("rgHudSessionStart", JSON.stringify(sessionStart)); } catch (e) {}
    currentMomentumState = "neutral";
    resetAccountRankState();

    // reset streak, don't count pre-session matches. Flush any in-flight
    // positive run as a PR candidate first — session idle-out shouldn't
    // silently drop a running win streak.
    if (streakData && streakData.accountId === data.Id && Number(streakData.streak) > 0) {
        maybeWriteStreakPR(Number(streakData.streak), data.Id);
    }
    const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
    const tw = modes.reduce((s, m) => s + (data.ModesData?.[m]?.wins ?? 0), 0);
    const tm = modes.reduce((s, m) => s + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);
    resetStreak(data.Id, tw, tm);

    // bust clan cache on account change
    clanLoaded = false;
    clanLoadedForAccount = null;
    myClan = null;
    scheduleClanNoticeCheck();
    const clanView = document.getElementById("rgClanView");
    if (isVisible(clanView)) {
        renderClanView();
    }
}


export function deltaBadge(mode, current) {
    if (!sessionStart || typeof current !== "number" || typeof sessionStart[mode] !== "number") return "";
    const diff = current - sessionStart[mode];
    if (diff === 0) return "";
    const color = diff > 0 ? "#00ff66" : "#ff6b6b";
    const sign = diff > 0 ? "+" : "";
    return ` <span style="color:${color};font-size:10px;">(${sign}${diff})</span>`;
}


export function rankBadge(playlist) {
    const r = cachedRanks.get(playlist);
    if (!r) return "";

    // gold top 3, purple top 10, cyan top 25, gray beyond
    let color;
    if (r <= 3) color = "#ffd700";
    else if (r <= 10) color = "#c77dff";
    else if (r <= 25) color = "#00d4ff";
    else color = "#9aa5ad";

    const gap = cachedMmrToNext.get(playlist);
    let tip;
    if (r === 1) tip = "You're #1! 👑";
    else if (typeof gap === "number") tip = `+${gap} MMR to reach #${r - 1}`;
    else tip = `Rank #${r}`;

    return ` <span class="rgHasTip" data-tip="${tip}" style="color:${color};font-size:10px;font-weight:bold;">#${r}</span>`;
}


export function netSessionMMR() {
    if (!sessionStart || !lastKnownPlayerData) return 0;
    const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
    let net = 0;
    for (const m of modes) {
        const cur = lastKnownPlayerData.ModesGlicko?.[m]?.displayRating;
        const start = sessionStart[m];
        if (typeof cur === "number" && typeof start === "number") net += cur - start;
    }
    return net;
}


// priority: crown > clash lead > momentum > default
export function resolveTitle() {
    const holdingAnyFirst = [...cachedRanks.values()].some(r => r === 1);
    if (holdingAnyFirst) return { text: "👑 Rocket Goal KING", color: "#ffd700" };
    if (isMyClanLeadingClash()) return { text: "👑 Leading the Clash", color: "#ffd700" };

    switch (currentMomentumState) {
        case "shutEye":   return { text: shutEyeMessage, color: "#9aa5ad" };
        case "cold":      return { text: "❄️ Ice Cold", color: "#7ec8ff" };
        case "flowState": return { text: "🏄 Flow State", color: "#b14bff" };
        case "onFire":    return { text: "🔥 ON FIRE", color: "#ff5b1f" };
        case "heatingUp": return { text: "🔥 Heating Up", color: "#ff9a3c" };
        default:
            if (settings.ogTitle) return { text: "🚀 Rocket Goal HUD", color: "#00bfff" };
            return { text: atlasIconHtml() + "ATLAS", color: "#00bfff", html: true };
    }
}


export function applyTitle() {
    const titleEl = document.getElementById("rgTitle");
    if (!titleEl) return;
    const { text, color, html } = resolveTitle();
    // html:true only for the ATLAS default (own img)
    if (html) titleEl.innerHTML = text;
    else titleEl.textContent = text;
    titleEl.style.color = color;
}


export function updateMomentum(forceState = null) {
    const newState = forceState ?? computeMomentumState(netSessionMMR());
    const changed = newState !== currentMomentumState;
    currentMomentumState = newState;

    switch (newState) {
        case "flowState": momentumGlow = { speedMult: 3.0, intensity: 1.8 }; break;
        case "onFire":    momentumGlow = { speedMult: 2.2, intensity: 1.5 }; break;
        case "heatingUp": momentumGlow = { speedMult: 1.5, intensity: 1.2 }; break;
        case "cold":      momentumGlow = { speedMult: 0.5, intensity: 0.7 }; break;
        case "shutEye":   momentumGlow = { speedMult: 0.35, intensity: 0.55 }; break;
        default:          momentumGlow = { speedMult: 1, intensity: 1 };
    }

    applyGlowSettings();
    applyTitle();

    if (changed) {
        if (newState === "flowState") showBanner("🏄 FLOW STATE ACHIEVED!", "#b14bff");
        else if (newState === "onFire") showBanner("🔥 YOU'RE ON FIRE!", "#ff5b1f");
        else if (newState === "shutEye") {
            shutEyeMessage = SHUT_EYE_MESSAGES[Math.floor(Math.random() * SHUT_EYE_MESSAGES.length)];
            showBanner(shutEyeMessage, "#9aa5ad");
        }
    }
}


export function showBanner(text, color) {
    createHUD();
    let banner = document.getElementById("rgBanner");
    if (!banner) {
        banner = document.createElement("div");
        banner.id = "rgBanner";
        banner.style.cssText = `
            position:absolute;
            top:-38px;
            left:0;
            right:0;
            text-align:center;
            font-weight:bold;
            font-size:13px;
            padding:6px 8px;
            border-radius:8px;
            background:rgba(10,14,18,0.95);
            border:1px solid;
            opacity:0;
            transition:opacity 0.4s ease, transform 0.4s ease;
            transform:translateY(6px);
            pointer-events:none;
        `;
        hud.appendChild(banner);
    }

    banner.textContent = text;
    banner.style.color = color;
    banner.style.borderColor = color;

    requestAnimationFrame(() => {
        banner.style.opacity = "1";
        banner.style.transform = "translateY(0)";
    });

    clearTimeout(bannerTimeout);
    bannerTimeout = setTimeout(() => {
        banner.style.opacity = "0";
        banner.style.transform = "translateY(6px)";
    }, 3500);
}


export function checkRankTransitions() {
    for (const [playlist, rank] of cachedRanks) {
        const prev = prevRanks.get(playlist);

        // need a prior non-#1 baseline, else this fires on session start
        if (rank === 1 && typeof prev === "number" && prev !== 1) {
            showBanner(`👑 NEW #1 IN ${playlist.toUpperCase()}!`, "#ffd700");
        }

        if (prev === 1 && rank !== 1) {
            showBanner(`⚔️ Dethroned in ${playlist.toUpperCase()}!`, "#ff6b6b");
        }

        prevRanks.set(playlist, rank);
    }

    applyTitle();
}


export function applyGlowSettings() {
    if (!hud) return;
    let styleEl = document.getElementById("rgGlowStyle");
    if (!styleEl) {
        styleEl = document.createElement("style");
        styleEl.id = "rgGlowStyle";
        document.head.appendChild(styleEl);
    }

    if (!settings.glowEnabled) {
        styleEl.textContent = "";
        hud.style.animation = "none";
        hud.style.boxShadow = "0 0 15px #00bfff55";
        return;
    }

    const c1 = hexToRgba(settings.glowColor1, Math.min(1, settings.glowOpacity * momentumGlow.intensity));
    const c2 = hexToRgba(settings.glowColor2, Math.min(1, settings.glowOpacity * momentumGlow.intensity));
    const R = 8, BLUR = 14 * momentumGlow.intensity, SPREAD = 3 * momentumGlow.intensity;

    let frames = "";
    for (let i = 0; i <= 8; i++) {
        const pct = (i * 12.5).toFixed(1);
        const angle = (i / 8) * 2 * Math.PI;
        const x = (Math.cos(angle) * R).toFixed(1);
        const y = (Math.sin(angle) * R).toFixed(1);
        frames += `${pct}% { box-shadow: ${x}px ${y}px ${BLUR.toFixed(1)}px ${SPREAD.toFixed(1)}px ${c1}, ${-x}px ${-y}px ${BLUR.toFixed(1)}px ${SPREAD.toFixed(1)}px ${c2}; }\n`;
    }

    styleEl.textContent = `@keyframes rgGlowSpin {\n${frames}}`;
    // speed 1-10 -> ~20s..1.5s
    const baseDuration = 22 - (settings.glowSpeed * 2.05);
    const duration = baseDuration / momentumGlow.speedMult;
    hud.style.boxShadow = "";
    hud.style.animation = `rgGlowSpin ${duration.toFixed(2)}s linear infinite`;
}


// Unity swallows printable keys in capture phase. we intercept earlier
// and stopImmediatePropagation while a HUD input is focused, so the
// game never sees the event.
export function isNameForgeInput(el) {
    return Boolean(el?.closest?.(".rgnf-panel"));
}


// ---------- HUD ----------

export function createHUD() {
    if (hud) return;

    hud = document.createElement("div");
    hud.id = "rgHUD";

    let pos = { top: "110px", left: "", right: "20px" };
    try {
        const saved = JSON.parse(localStorage.getItem("rgHudPos") ?? "null");
        if (saved && saved.top && saved.left) {
            pos = { top: saved.top, left: saved.left, right: "auto" };
        }
    } catch (e) {
        dbg("rgHudPos parse failed, falling back to default");
    }

    hud.style.cssText = `
        position:fixed;
        top:${pos.top};
        ${pos.left ? `left:${pos.left};` : ""}
        right:${pos.right};
        width:max-content;
        min-width:min(250px, calc(100vw - 16px));
        max-width:min(340px, calc(100vw - 16px));
        box-sizing:border-box;
        background:rgba(18,18,22,.88);
        color:white;
        border:2px solid #00bfff;
        border-radius:12px;
        font-family:Arial,sans-serif;
        padding:10px;
        z-index:999999999;
        user-select:none;
    `;

    hud.innerHTML = `
        <style>
            #rgHUD .rgBtn {
                flex: 1;
                font-size: 11px;
                padding: 6px 2px;
                background: linear-gradient(180deg, #1c2b3a, #10181f);
                color: #d7f3ff;
                border: 1px solid #00bfff88;
                border-radius: 6px;
                cursor: pointer;
                white-space: nowrap;
                transition: background 0.15s ease, border-color 0.15s ease, transform 0.05s ease;
            }
            #rgHUD .rgBtn:hover {
                background: linear-gradient(180deg, #26405a, #16222c);
                border-color: #00bfff;
            }
            #rgHUD .rgBtn:active { transform: scale(0.96); }
            #rgHUD .rgIconBtn {
                background: none;
                border: 1px solid #00bfff88;
                color: #00bfff;
                border-radius: 4px;
                width: 22px;
                height: 22px;
                font-size: 13px;
                line-height: 1;
                cursor: pointer;
                flex-shrink: 0;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 0;
                text-align: center;
            }
            #rgHUD .rgSettingRow {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 6px;
                margin: 5px 0;
                font-size: 12px;
            }
            #rgHUD input[type="range"] { width: 110px; }
            /* scroll inside the HUD so buttons don't fall off the bottom */
            #rgBody { max-height: calc(100vh - 170px); overflow-y: auto; overflow-x: hidden; }
            #rgHUD input[type="color"] {
                width: 30px; height: 20px; padding: 0; border: none; background: none; cursor: pointer;
            }
            #rgNameModal {
                position: absolute;
                inset: 0;
                background: rgba(10,14,18,0.96);
                border-radius: 10px;
                display: none;
                flex-direction: column;
                justify-content: center;
                gap: 8px;
                padding: 14px;
                z-index: 10;
            }
            #rgNameModal input[type="text"] {
                background: #10181f;
                border: 1px solid #00bfff88;
                border-radius: 6px;
                color: #d7f3ff;
                padding: 6px 8px;
                font-size: 13px;
                outline: none;
                user-select: text;
                -webkit-user-select: text;
            }
            #rgNameError { color: #ff6b6b; font-size: 11px; min-height: 14px; }
            #rgToast {
                position: absolute;
                left: 10px; right: 10px; bottom: 10px;
                background: linear-gradient(180deg, #1c2b3a, #0d141b);
                border: 1px solid #00bfff;
                border-radius: 8px;
                color: #d7f3ff;
                font-size: 12px;
                text-align: center;
                padding: 8px 10px;
                opacity: 0;
                transition: opacity 0.2s ease, transform 0.2s ease;
                transform: translateY(8px);
                pointer-events: none;
                z-index: 20;
            }
            #rgDialog {
                position: absolute;
                inset: 0;
                background: rgba(10,14,18,0.96);
                border-radius: 10px;
                display: none;
                flex-direction: column;
                justify-content: center;
                gap: 8px;
                padding: 14px;
                z-index: 30;
            }
            #rgDialog .rgDlgMsg { font-size: 13px; color: #d7f3ff; }
            #rgDialog input[type="text"] {
                background: #10181f; border: 1px solid #00bfff88; border-radius: 6px;
                color: #d7f3ff; padding: 6px 8px; font-size: 13px; outline: none;
                user-select: text; -webkit-user-select: text;
            }
            #rgTooltip {
                position: fixed;
                z-index: 9999999999;
                background: linear-gradient(180deg, #1c2b3a, #0d141b);
                color: #d7f3ff;
                border: 1px solid #00bfff;
                border-radius: 6px;
                padding: 5px 9px;
                font-family: Arial, sans-serif;
                font-size: 11px;
                font-weight: bold;
                white-space: nowrap;
                pointer-events: none;
                box-shadow: 0 2px 10px rgba(0,0,0,0.5);
                opacity: 0;
                transition: opacity 0.12s ease;
            }
            #rgHUD .rgHasTip { cursor: help; border-bottom: 1px dotted currentColor; }
            #rgHUD .rgNoUnderline { border-bottom: none; }
        </style>
        <div style="display:flex;align-items:center;justify-content:space-between;cursor:move;gap:8px;" id="rgDragHandle">
            <span id="rgTitle" style="font-size:16px;font-weight:bold;color:#00bfff;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><img src="${ATLAS_ICON_URL}" alt="" style="height:16px;width:16px;vertical-align:middle;margin-right:4px;object-fit:contain;">ATLAS</span>
            <div style="display:flex;align-items:center;gap:5px;flex-shrink:0;">
                <span id="rgErrDot" style="display:none;color:#ff5555;font-weight:bold;font-size:14px;cursor:pointer;">⚠</span>
                <span id="rgWarnDot" title="" style="display:none;color:#ffbb33;font-weight:bold;font-size:14px;cursor:help;" data-tip="ATLAS saw something unexpected (hover for details, or run rgDump() for full log)">⚑</span>
                <button id="rgClanBtn" class="rgIconBtn" title="Clans">🛡️</button>
                <button id="rgForgeBtn" class="rgIconBtn" title="Name Forge">🎨</button>
                <button id="rgSettingsBtn" class="rgIconBtn" title="Settings">⚙</button>
                <button id="rgMinimize" class="rgIconBtn" title="Minimize">–</button>
            </div>
        </div>
        <hr>
        <div id="rgBody">
            <div id="rgStatsView">
                <div id="rgContent">Waiting for data...</div>
                <div id="rgSettingsPanel" style="display:none;border-top:1px solid #00bfff44;margin-top:8px;padding-top:6px;">
                    <div class="rgSettingRow"><span title="Bring back the original 🚀 Rocket Goal HUD title">OG Title</span><input type="checkbox" id="rgSetOgTitle"></div>
                    <div class="rgSettingRow"><span title="Active RTT estimate to rocketgoal.io every 3 seconds; not exact Photon server ping">Network RTT</span><input type="checkbox" id="rgSetPingTracker"></div>
                    <div class="rgSettingRow"><span>Glow</span><input type="checkbox" id="rgSetGlow"></div>
                    <div class="rgSettingRow"><span>Speed</span><input type="range" id="rgSetSpeed" min="1" max="10" step="0.5"></div>
                    <div class="rgSettingRow"><span>Vibrancy</span><input type="range" id="rgSetOpacity" min="0.1" max="1" step="0.05"></div>
                    <div class="rgSettingRow"><span>Color 1</span><input type="color" id="rgSetColor1"></div>
                    <div class="rgSettingRow"><span>Color 2</span><input type="color" id="rgSetColor2"></div>
                    <div class="rgSettingRow"><span title="Show the animation after you end a tracked opponent streak">Streak snipe</span><input type="checkbox" id="rgSetStreakSnipe"></div>
                    <div class="rgSettingRow" style="flex-wrap:wrap;gap:6px;">
                        <span title="Send this to Pal or RIS3N if you need to be added to the board">Firebase id</span>
                        <code id="rgSetAuthUid" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:#8E9BC2;">signing in…</code>
                    </div>
                    <div class="rgSettingRow" style="flex-wrap:wrap;gap:6px;">
                        <span title="Tied to your Firebase id. Writes from another device are denied.">Device id</span>
                        <code id="rgSetDeviceId" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:#8E9BC2;"></code>
                    </div>
                    <button type="button" id="rgSetCopyIds" class="rgBtn" style="width:100%;margin-top:4px;">Copy ids</button>
                    <button id="rgSetReset" class="rgBtn" style="width:100%;margin-top:4px;">Reset to defaults</button>
                    <button id="rgSetCopyDebug" class="rgBtn" style="width:100%;margin-top:4px;">⬇ Download debug bundle</button>
                </div>
            </div>
            <div id="rgClanView" style="display:none;">Loading clans...</div>
            <div id="rgForgeView" style="display:none;max-height:min(70vh,640px);overflow-y:auto;overflow-x:hidden;"></div>
            <div id="rgActionRow" style="margin-top:6px;display:flex;gap:4px;">
                <button id="rgRename" class="rgBtn" style="flex:1;">✏️ Rename</button>
                <button id="rgSub" class="rgBtn" style="flex:1;">📺 Sub</button>
                <button id="rgLeaderboard" class="rgBtn" style="flex:2;">🏆 Leaderboard</button>
            </div>
        </div>
        <div id="rgNameModal">
            <div id="rgNameTitle" style="font-size:13px;font-weight:bold;color:#00bfff;"></div>
            <input type="text" id="rgNameInput" maxlength="15">
            <div id="rgNameError"></div>
            <div style="display:flex;gap:6px;">
                <button id="rgNameSave" class="rgBtn">Save</button>
                <button id="rgNameCancel" class="rgBtn">Cancel</button>
            </div>
        </div>
        <div id="rgDialog" role="dialog" aria-modal="true" aria-labelledby="rgDialogMsg">
            <div id="rgDialogMsg" class="rgDlgMsg"></div>
            <input type="text" id="rgDialogInput" style="display:none;" maxlength="200">
            <div style="display:flex;gap:6px;">
                <button id="rgDialogOk" class="rgBtn">OK</button>
                <button id="rgDialogCancel" class="rgBtn">Cancel</button>
            </div>
        </div>
        <div id="rgToast" role="status" aria-live="polite" aria-atomic="true"></div>
        <div id="rgStreakRecords" role="dialog" aria-modal="true" aria-labelledby="rgStreakRecordsTitle" style="
            position:absolute; inset:0;
            background: rgba(10,14,18,0.97);
            border-radius: 10px;
            display:none; flex-direction:column;
            padding: 12px 12px 10px;
            z-index: 12;
            overflow: hidden;
        ">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                <div id="rgStreakRecordsTitle" style="font-size:13px;font-weight:bold;color:#ff7a00;flex:1;">🔥 All-time Win-Streak Records</div>
                <button id="rgStreakRecordsClose" class="rgBtn" style="padding:2px 8px;">Close</button>
            </div>
            <div id="rgStreakRecordsBody" style="flex:1;overflow-y:auto;font-size:12px;color:#d7f3ff;">Loading…</div>
            <div id="rgStreakRecordsFoot" style="font-size:10px;color:#9aa5ad;margin-top:6px;text-align:right;"></div>
        </div>
    `;

    document.body.appendChild(hud);
    clampHudOnScreen();
    window.addEventListener("resize", clampHudOnScreen);
    dragElement(hud, document.getElementById("rgDragHandle"));
    applyGlowSettings();

    // one shared tooltip, replaces native title=
    let tooltipEl = document.getElementById("rgTooltip");
    if (!tooltipEl) {
        tooltipEl = document.createElement("div");
        tooltipEl.id = "rgTooltip";
        document.body.appendChild(tooltipEl);
    }
    hud.addEventListener("mouseover", e => {
        const target = e.target.closest("[data-tip]");
        if (!target) return;
        tooltipEl.textContent = target.getAttribute("data-tip");
        tooltipEl.style.opacity = "1";
    });
    hud.addEventListener("mousemove", e => {
        if (tooltipEl.style.opacity !== "1") return;
        // above-right of cursor, kept on-screen
        const pad = 14;
        let x = e.clientX + pad;
        let y = e.clientY - tooltipEl.offsetHeight - 6;
        if (x + tooltipEl.offsetWidth > window.innerWidth) x = e.clientX - tooltipEl.offsetWidth - pad;
        if (y < 0) y = e.clientY + pad;
        tooltipEl.style.left = x + "px";
        tooltipEl.style.top = y + "px";
    });
    hud.addEventListener("mouseout", e => {
        const target = e.target.closest("[data-tip]");
        if (target) tooltipEl.style.opacity = "0";
    });
    // re-renders can yank the hovered element mid-hover
    hud.addEventListener("mouseleave", () => {
        tooltipEl.style.opacity = "0";
    });

    // blur on mouse click so spacebar in queue reaches the game, not the
    // last tabbed button. keyboard clicks (detail === 0) keep focus.
    hud.addEventListener("click", (e) => {
        const btn = e.target.closest("button");
        if (btn && e.detail !== 0) btn.blur();
        const streakBadgeEl = e.target.closest(".rgStreakBadge");
        if (streakBadgeEl) {
            e.preventDefault();
            openStreakRecordsModal();
        }
    });
    const streakCloseBtn = document.getElementById("rgStreakRecordsClose");
    if (streakCloseBtn) streakCloseBtn.onclick = () => closeStreakRecordsModal();

    document.getElementById("rgMinimize").onclick = () => manualToggle();
    document.getElementById("rgSub").onclick = () => {
        window.open("https://www.youtube.com/@RootedEngineering", "_blank", "noopener");
    };
    document.getElementById("rgLeaderboard").onclick = () => {
        const onClanTab = isVisible(document.getElementById("rgClanView"));
        const url = onClanTab
            ? "https://pal1533.github.io/RG_Clan_Leaderboard/"
            : "https://pal1533.github.io/rg_player_leaderboard/";
        window.open(url, "_blank", "noopener");
    };
    document.getElementById("rgRename").onclick = () => {
        dbg(`Rename me clicked (hasPlayer=${!!lastKnownPlayerData})`);
        if (!lastKnownPlayerData) {
            showNameModal("Play a match or log in first!", "", false, () => {});
            hideNameModalSoon();
            return;
        }
        forceRenamePrompt = true;
        submitToLeaderboard(lastKnownPlayerData);
    };

    const statsView = document.getElementById("rgStatsView");
    const clanView = document.getElementById("rgClanView");
    const panel = document.getElementById("rgSettingsPanel");
    const forgeView = document.getElementById("rgForgeView");
    const body = document.getElementById("rgBody");
    const actionRow = document.getElementById("rgActionRow");
    function showStatsOnly() {
        clanView.style.display = "none";
        forgeView.style.display = "none";
        panel.style.display = "none";
        statsView.style.display = "block";
        actionRow.style.display = "flex";
        body.scrollTop = 0;
        // drop clan listener when nobody's looking
        detachClanListener();
    }
    document.getElementById("rgClanBtn").onclick = () => {
        const showingClan = isVisible(clanView);
        dbg(`Clan panel ${showingClan ? "closed" : "opened"}`);
        if (showingClan) { showStatsOnly(); return; }
        showStatsOnly();
        statsView.style.display = "none";
        clanView.style.display = "block";
        renderClanView(); // listener attaches once myClan is known
    };

    document.getElementById("rgForgeBtn").onclick = () => {
        const showingForge = isVisible(forgeView);
        dbg(`Forge panel ${showingForge ? "closed" : "opened"}`);
        if (showingForge) { showStatsOnly(); return; }
        showStatsOnly();
        statsView.style.display = "none";
        forgeView.style.display = "block";
        actionRow.style.display = "none"; // hide leaderboard/sub in forge
        if (RGNF.setPrefixProvider) RGNF.setPrefixProvider(getClanTagPrefix);
        if (RGNF.setPrefixTargetProvider) RGNF.setPrefixTargetProvider(clanTagPositionPref);
        if (RGNF.setTagStripper) RGNF.setTagStripper(stripLeadingClanTagMarkup);
        // tag prefix needs myClan; a prior failed reload used to wipe it
        loadClanData().then(() => { if (RGNF.refresh) RGNF.refresh(); }).catch(() => {});
        // imposter roster: last game's players minus you, minus profanity
        if (RGNF.setRosterProvider) RGNF.setRosterProvider(
            () => lastGamePlayers
                .filter(p => !p.uid || p.uid !== myUserId())
                .filter(p => p.name !== (lastKnownPlayerData?.Nickname ?? ""))
                .filter(p => !containsProfanity(p.name.replace(/<[^>]*>/g, "")))
                .map(p => p.name)
        );
        // fresh install / cached state can otherwise greet the wrong name
        if (RGNF.syncToCurrentPlayer) RGNF.syncToCurrentPlayer(myUserId(), myGameNamePlain() || myName(), stripLeadingClanTagMarkup(lastKnownPlayerData?.Nickname ?? ""));
        RGNF.mountIn(forgeView);
        // syncToCurrentPlayer only renders on account change
        if (RGNF.refresh) RGNF.refresh();
    };

    // route through showStatsOnly so opening from Forge doesn't stack views
    document.getElementById("rgSettingsBtn").onclick = () => {
        const opening = !isVisible(panel);
        dbg(`Settings panel ${opening ? "opened" : "closed"}`);
        showStatsOnly();
        if (opening) {
            panel.style.display = "block";
            paintAuthUid();
            initFirebase().then(paintAuthUid).catch(() => paintAuthUid());
        }
    };

    const setGlow = document.getElementById("rgSetGlow");
    const setSpeed = document.getElementById("rgSetSpeed");
    const setOpacity = document.getElementById("rgSetOpacity");
    const setColor1 = document.getElementById("rgSetColor1");
    const setColor2 = document.getElementById("rgSetColor2");

    const setOgTitle = document.getElementById("rgSetOgTitle");
    const setPingTracker = document.getElementById("rgSetPingTracker");
    const setStreakSnipe = document.getElementById("rgSetStreakSnipe");
    function syncSettingInputs() {
        setOgTitle.checked = !!settings.ogTitle;
        setPingTracker.checked = !!settings.pingTrackerEnabled;
        setStreakSnipe.checked = settings.streakSnipeEnabled !== false;
        setGlow.checked = settings.glowEnabled;
        setSpeed.value = settings.glowSpeed;
        setOpacity.value = settings.glowOpacity;
        setColor1.value = settings.glowColor1;
        setColor2.value = settings.glowColor2;
    }
    syncSettingInputs();

    setOgTitle.onchange = () => {
        settings.ogTitle = setOgTitle.checked;
        saveSettings();
        applyTitle();
    };
    setPingTracker.onchange = () => {
        settings.pingTrackerEnabled = setPingTracker.checked;
        saveSettings();
        syncPingTracker();
    };
    setStreakSnipe.onchange = () => {
        settings.streakSnipeEnabled = setStreakSnipe.checked;
        saveSettings();
    };
    const bindGlow = (el, key, readValue, evt = "oninput") => {
        el[evt] = () => { settings[key] = readValue(el); saveSettings(); applyGlowSettings(); };
    };
    bindGlow(setGlow, "glowEnabled", el => el.checked, "onchange");
    bindGlow(setSpeed, "glowSpeed", el => parseFloat(el.value));
    bindGlow(setOpacity, "glowOpacity", el => parseFloat(el.value));
    bindGlow(setColor1, "glowColor1", el => el.value);
    bindGlow(setColor2, "glowColor2", el => el.value);
    const copyIds = document.getElementById("rgSetCopyIds");
    paintAuthUid();
    if (copyIds) {
        copyIds.onclick = async () => {
            if (!firebaseAuthUid) {
                showToast("Wait until Firebase id finishes signing in.");
                return;
            }
            const deviceId = getDeviceId();
            if (!deviceId) return;
            try {
                await navigator.clipboard.writeText(
                    `Firebase ID: ${firebaseAuthUid}\nDevice ID: ${deviceId}`
                );
                showTempFeedback(copyIds, "Copied", 1600, "Copy ids");
            } catch (e) {
                showTempFeedback(copyIds, "Fail", 1600, "Copy ids");
            }
        };
    }

    document.getElementById("rgSetReset").onclick = () => {
        dbg("Settings reset to defaults");
        settings = { ...DEFAULT_SETTINGS };
        saveSettings();
        syncSettingInputs();
        applyGlowSettings();
        applyTitle();
        syncPingTracker();
    };

    // trim player data, don't dump the whole login blob
    document.getElementById("rgSetCopyDebug").onclick = () => {
        dbg("Download debug bundle clicked");
        try {
            const trimmedPlayer = lastKnownPlayerData ? {
                Id: lastKnownPlayerData.Id,
                Nickname: lastKnownPlayerData.Nickname,
                ModesGlicko: lastKnownPlayerData.ModesGlicko,
                ModesData: lastKnownPlayerData.ModesData,
            } : null;
            // snapshot of what the user is looking at, so "click didn't work"
            // bugs show whether the dialog was even visible.
            const ui = (() => {
                const q = id => document.getElementById(id);
                const dlg = q("rgDialog");
                return {
                    hudExists: !!q("rgHUD"),
                    clanViewOpen: isVisible(q("rgClanView")),
                    forgeViewOpen: isVisible(q("rgForgeView")),
                    settingsOpen: isVisible(q("rgSettingsPanel")),
                    dialogOpen: isFlexVisible(dlg),
                };
            })();
            // Enough layout detail to reproduce UI bugs without a device fingerprint.
            const device = (() => {
                const n = typeof navigator !== "undefined" ? navigator : {};
                const s = typeof screen !== "undefined" ? screen : {};
                return {
                    deviceClass: (n.maxTouchPoints ?? 0) > 0 ? "touch" : "pointer",
                    touch: (n.maxTouchPoints ?? 0) > 0,
                    screen: `${s.width || 0}x${s.height || 0}`,
                    viewport: `${window.innerWidth || 0}x${window.innerHeight || 0}`,
                    pixelRatio: window.devicePixelRatio || 1,
                };
            })();
            const bundle = {
                version: SCRIPT_VERSION,
                versionNum: SCRIPT_VERSION_NUM,
                firebaseId: firebaseAuthUid || "",
                deviceId: getDeviceId() || "",
                device,
                timestamp: new Date().toISOString(),
                settings: settings,
                player: trimmedPlayer,
                state: {
                    _inMatch,
                    _liveRoster: _liveRoster.length,
                    lastGamePlayers: lastGamePlayers.length,
                    _lastInitLineAt,
                    _lastRecoverySignalAt,
                    _lastValidRatingsAt,
                    networkRttEstimateMs: pingTrackerLastRtt,
                },
                firestore: {
                    reads: firestoreReadCount,
                    writes: firestoreWriteCount,
                    windowReads: firestoreBudgetWindow.reads,
                    windowWrites: firestoreBudgetWindow.writes,
                    windowMinutes: FIRESTORE_BUDGET_WINDOW_MS / 60000,
                    readBudget: FIRESTORE_READ_BUDGET,
                    writeBudget: FIRESTORE_WRITE_BUDGET,
                },
                ui,
                clan: myClan ? {
                    id: myClan.id,
                    name: myClan.name,
                    tag: myClan.tag,
                    role: myClanRole?.(),
                    memberCount: clanMembers(myClan).length,
                    eventScore: computeClanEventScore(myClan),
                } : null,
                event: eventConfig ? {
                    name: eventConfig.name,
                    phase: eventPhase(),
                } : null,
                warnings: _rgWarnBuf,
                errors: _rgErrorBuf,
                firestoreWrites: _rgWriteBuf,
                firestoreDenies: (typeof hudSessionDenies === "object" && Array.isArray(hudSessionDenies))
                    ? hudSessionDenies.slice(-25)
                    : [],
                appCheckNow: typeof appCheckSnapshot === "function" ? appCheckSnapshot() : null,
                gateNow: typeof accessSnapshot === "function" ? accessSnapshot() : null,
                log: _rgLogBuf.slice(-100),
            };
            const redactions = [
                typeof navigator !== "undefined" ? navigator.userAgent : "",
                lastKnownPlayerData?.Id,
            ];
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const filename = `atlas-debug-${stamp}.txt`;
            const payload = {
                bundle,
                rgDump: _rgLogBuf.slice(),
            };
            const text = JSON.stringify(payload, null, 2);
            const safeText = redactSupportText(text, redactions);
            const url = URL.createObjectURL(new Blob([safeText], {
                type: "text/plain;charset=utf-8",
            }));
            const link = document.createElement("a");
            link.href = url;
            link.download = filename;
            link.style.display = "none";
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 0);
            showToast(`Downloaded ${filename}`);
        } catch (e) {
            pushError(e, "downloadDebugBundle");
            console.error("[RG HUD] Download debug bundle failed:", e);
            showToast("Download failed — see console");
        }
    };

    // handler early-returns when no banner is up
    if (!countdownIntervalId) {
        countdownIntervalId = setInterval(tickCountdown, 1000);
    }
}


export function showNameModal(title, defaultValue, isRealPrompt, resolve) {
    createHUD();
    const modal = document.getElementById("rgNameModal");
    const input = document.getElementById("rgNameInput");
    document.getElementById("rgNameTitle").textContent = title;
    document.getElementById("rgNameError").textContent = "";
    input.value = defaultValue;
    modal.style.display = "flex";
    nameModalResolve = isRealPrompt ? resolve : null;
    if (isRealPrompt) {
        setTimeout(() => input.focus(), 50);
        probeInput(input, "rgNameInput");
    }
}


export function hideNameModal() {
    const modal = document.getElementById("rgNameModal");
    if (modal) modal.style.display = "none";
    nameModalResolve = null;
}


export function hideNameModalSoon() {
    setTimeout(hideNameModal, 1600);
}


export function paintAuthUid() {
    const uidLabel = document.getElementById("rgSetAuthUid");
    if (uidLabel) {
        if (firebaseAuthUid) uidLabel.textContent = firebaseAuthUid;
        else if (firebaseAuthError) uidLabel.textContent = "sign-in failed — tap Settings to retry";
        else uidLabel.textContent = "signing in…";
    }
    const deviceLabel = document.getElementById("rgSetDeviceId");
    if (deviceLabel) deviceLabel.textContent = getDeviceId();
}
