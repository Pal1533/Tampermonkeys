// Snapshot of the last App Check token the CustomProvider minted, so
// every deny record can carry token age + TTL to catch worker TTL bugs.
export function appCheckSnapshot() {
    const now = Date.now();
    if (!_lastAppCheckToken) {
        return { present: false, note: "no token minted yet" };
    }
    const { mintedAt, expireTimeMillis, workerExpMillis, jwtExpMillis, len, error } = _lastAppCheckToken;
    const ageMs = mintedAt ? now - mintedAt : null;
    const ttlMsLeft = expireTimeMillis ? expireTimeMillis - now : null;
    return {
        present: true,
        len,
        error: error || null,
        ageMs,
        ttlMsLeft,
        expired: ttlMsLeft != null ? ttlMsLeft <= 0 : null,
        // Both raw sources so we can tell whether the Worker returned
        // expireTimeMillis or we fell back to the JWT exp claim.
        workerExpMs: workerExpMillis || null,
        jwtExpMs: jwtExpMillis || null,
        expSource: workerExpMillis ? "worker" : (jwtExpMillis ? "jwt" : "none"),
    };
}

// Snapshot of the gate/blacklist state we already know from admin/gate.
// We don't fetch admin/blacklist from the HUD (client can't read it
// without being admin), so uid/device fields stay null and just flag
// the check as unavailable. Whatever we DO know we still surface.
export function accessSnapshot() {
    return {
        gateChecked: !!updateRequiredChecked,
        pauseWrites: !!writesPaused,
        updateRequired: !!updateRequired,
        notAllowlisted: !!notAllowlisted,
        clientVersionNum: typeof SCRIPT_VERSION_NUM === "number" ? SCRIPT_VERSION_NUM : null,
    };
}

// Bucket-specific expected keys, mirroring the Firestore rules. Used to
// spot missing/unexpected fields in the payload without having to hand-
// copy rule strings into each deny.
const RULES_REQUIRED_KEYS = {
    leaderboard: ["sourceUserId", "deviceId", "versionNum", "lastWriteAt", "playlist", "name"],
    script_submissions: ["sourceUserId", "deviceId", "versionNum", "lastWriteAt", "nickname", "ratings"],
    match_snapshots: ["sourceUserId", "matchId", "mode", "outcome", "before", "after", "roster"],
};
// Kept in sync with the deployed Firestore rules' isValidScriptEntry
// hasOnly list. Refresh whenever those change or the hint below will
// false-flag legitimate keys the client already writes.
// Last synced: 2026-09-15 ruleset (0b279a06-0852-450c-a084-9705a6945236).
const RULES_ALLOWED_KEYS = {
    leaderboard: [
        "sourceUserId", "playlist", "deviceId", "scriptVersion", "versionNum", "lastWriteAt",
        "name", "mmr", "wins", "matches",
        "rating", "rd", "vol",
        "sessionMmrDelta", "sessionStartedAt", "sessionLastSeen",
        "currentStreak", "rgPlayerId",
        "flag", "icons",
        "dailyWins", "hourlyWins", "reviewFlagged",
        "newMatchIds",
    ],
};

export function payloadKeyDiff(label, data) {
    const bucket = bucketLabel(label);
    const keys = data && typeof data === "object" ? Object.keys(data) : [];
    const required = RULES_REQUIRED_KEYS[bucket] || [];
    const allowed = RULES_ALLOWED_KEYS[bucket];
    const missing = required.filter(k => !keys.includes(k));
    const unexpected = allowed ? keys.filter(k => !allowed.includes(k)) : [];
    return { keys, missing, unexpected };
}

// Hard-common causes for the HUD's red triangle beyond a rule deny —
// e.g. auth not ready, adblocker, quota. Caller supplies err + payload
// and we return an ordered list of the most likely root causes.
export function classifyDeny(err, opts = {}) {
    const causes = [];
    const code = String(err?.code || "").toLowerCase();
    const msg = String(err?.message || "").toLowerCase();
    if (!firebaseAuthUid) causes.push("auth-not-ready: firebaseAuthUid is null");
    if (opts.acc) {
        if (opts.acc.pauseWrites) causes.push("admin/gate.pauseWrites=true (writes globally halted)");
        if (opts.acc.updateRequired) causes.push("client version below admin/gate.minVersion (Tampermonkey update needed)");
        if (opts.acc.notAllowlisted) causes.push("uid not on admin allowlist (admin/gate read denied) — request access");
    }
    if (opts.ac) {
        if (opts.ac.present === false) causes.push("no App Check token has been minted this session");
        else {
            if (opts.ac.error) causes.push(`App Check mint error: ${opts.ac.error}`);
            if (opts.ac.expired === true) causes.push(`App Check token expired ${Math.round((opts.ac.ttlMsLeft ?? 0) / -1000)}s ago`);
            else if (opts.ac.ttlMsLeft != null && opts.ac.ttlMsLeft < 30000) {
                causes.push(`App Check token near expiry (${Math.round(opts.ac.ttlMsLeft / 1000)}s left)`);
            }
        }
    }
    if (opts.keyDiff?.missing?.length) {
        causes.push(`payload missing required keys: ${opts.keyDiff.missing.join(", ")}`);
    }
    if (opts.keyDiff?.unexpected?.length) {
        causes.push(`payload has keys the rule does not allow: ${opts.keyDiff.unexpected.join(", ")}`);
    }
    if (msg.includes("blocked_by_client") || msg.includes("failed to fetch")) {
        causes.push("network blocked (ad blocker / privacy extension / offline)");
    }
    if (msg.includes("quota") || msg.includes("resource-exhausted")) {
        causes.push("Firestore quota exhausted (project-level cap tripped)");
    }
    if (code === "unauthenticated") causes.push("Firebase auth token missing or rejected");
    // Server-side gates the payload cannot self-inspect. Only surface as
    // hints when the client-side checks all passed but the deny persists,
    // so we do not drown the record in speculative reasons for real bugs.
    const noClientCause = causes.length === 0
        && (!opts.keyDiff?.missing?.length)
        && (!opts.keyDiff?.unexpected?.length);
    if (noClientCause && String(opts.label || "").includes("script_submissions")) {
        try {
            if (typeof isFlaggedLocally === "function" && opts.data?.rgPlayerId
                && isFlaggedLocally(opts.data.rgPlayerId)) {
                causes.push("local win-limits store flagged — server likely still has reviewFlagged=true on script_submissions/{uid}. Admin must click 'Clear review' on the leaderboard site.");
            }
        } catch {}
        causes.push("server-side gate the client can't verify: notUnderReview (reviewFlagged), respectsWriteInterval (15s between writes), or hasScriptSubmission");
    }
    if (noClientCause && String(opts.label || "").includes("leaderboard")) {
        causes.push("server-side gate the client can't verify: notUnderReview, respectsWriteInterval, hasScriptSubmission (script_submissions row must exist first), or MMR/matches delta caps");
    }
    return causes;
}

export function logDeny(label, detail = null) {
    const bucket = bucketLabel(label);
    hudSessionDeniesByLabel.set(bucket, (hudSessionDeniesByLabel.get(bucket) || 0) + 1);
    const err = detail?.err;
    const rawReasons = Array.isArray(detail?.reasons) ? detail.reasons : [];
    const reasons = rawReasons.slice(0, 6).map(r => truncateForDeny(r, 160));
    const record = {
        at: new Date().toISOString(),
        bucket,
        path: truncateForDeny(detail?.path ?? label, 120),
        op: truncateForDeny(detail?.op, 10),
        code: truncateForDeny(err?.code, 40),
        msg: truncateForDeny(err?.message, 160),
        subject: truncateForDeny(detail?.subject, 120),
        rule: truncateForDeny(detail?.rule || guessDenyRule(err?.message), 40),
        reasons,
        authUid: firebaseAuthUid || null,
        appCheck: detail?.appCheck || null,
        access: detail?.access || null,
        keyDiff: detail?.keyDiff || null,
        likelyCauses: Array.isArray(detail?.likelyCauses)
            ? detail.likelyCauses.slice(0, 8).map(c => truncateForDeny(c, 160))
            : [],
    };
    hudSessionDenies.push(record);
    if (hudSessionDenies.length > HUD_DENY_RECORD_MAX) hudSessionDenies.shift();
    // Browser console only — do not write a Firestore security
    // collection from the HUD. An attacker would skip or flood it.
    console.warn(`[RG HUD][security] ${JSON.stringify(record)}`);
}


export function firestoreReadBudgetPassed() {
    firestoreBudgetWindow = nextFirestoreBudgetWindow(firestoreBudgetWindow);
    return firestoreBudgetWindow.reads > FIRESTORE_READ_BUDGET;
}


export function logRead(label, count = 1) {
    const charged = Math.max(1, Number(count) || 1);
    firestoreBudgetWindow = nextFirestoreBudgetWindow(firestoreBudgetWindow);
    firestoreReadCount += charged;
    firestoreBudgetWindow.reads += charged;
    const bucket = bucketLabel(label);
    hudSessionReadsByLabel.set(bucket, (hudSessionReadsByLabel.get(bucket) || 0) + charged);
    console.log(`[RG HUD] Firestore read +${charged} #${firestoreReadCount} (${label}; ${firestoreBudgetWindow.reads}/${FIRESTORE_READ_BUDGET} in 10m)`);
    if (!firestoreBudgetWindow.readWarned
        && firestoreBudgetWindow.reads > FIRESTORE_READ_BUDGET) {
        firestoreBudgetWindow.readWarned = true;
        dbgWarn(`Firestore read budget passed (${firestoreBudgetWindow.reads}/${FIRESTORE_READ_BUDGET} in 10m)`);
    }
}


export function logWrite(label) {
    firestoreBudgetWindow = nextFirestoreBudgetWindow(firestoreBudgetWindow);
    firestoreWriteCount++;
    firestoreBudgetWindow.writes++;
    const bucket = bucketLabel(label);
    hudSessionWritesByLabel.set(bucket, (hudSessionWritesByLabel.get(bucket) || 0) + 1);
    console.log(`[RG HUD] Firestore write #${firestoreWriteCount} (${label}; ${firestoreBudgetWindow.writes}/${FIRESTORE_WRITE_BUDGET} in 10m)`);
    if (!firestoreBudgetWindow.writeWarned
        && firestoreBudgetWindow.writes > FIRESTORE_WRITE_BUDGET) {
        firestoreBudgetWindow.writeWarned = true;
        dbgWarn(`Firestore write budget passed (${firestoreBudgetWindow.writes}/${FIRESTORE_WRITE_BUDGET} in 10m)`);
    }
}


export function scheduleHudStatsUpload() {
    if (hudStatsUploadHandle != null) return;
    // First upload happens after the initial interval, giving the HUD a
    // chance to warm up and produce something worth reporting.
    hudStatsUploadHandle = setInterval(() => {
        uploadHudReadStats().catch(() => {});
    }, HUD_STATS_UPLOAD_INTERVAL_MS);
    if (typeof window !== "undefined") {
        const flush = () => { uploadHudReadStats({ final: true }).catch(() => {}); };
        window.addEventListener("beforeunload", flush);
        window.addEventListener("pagehide", flush);
    }
}


export function isAllowlistGatedLabel(label) {
    const s = String(label || "");
    if (/clan/i.test(s)) return false;
    return /leaderboard|script_submissions|hud_read|submission|upsertPlaylist/i.test(s);
}


export async function atlasMutationAllowed(fb, label) {
    await isUpdateRequired(fb);
    if (writesPaused) {
        showWritesPausedUI();
        dbg(`blocked paused-writes mutation: ${label}`);
        return false;
    }
    if (updateRequired) {
        showUpdateRequiredUI();
        dbg(`blocked outdated client mutation: ${label}`);
        return false;
    }
    if (notAllowlisted && isAllowlistGatedLabel(label)) {
        showNotAllowlistedUI();
        dbg(`blocked allow-list mutation: ${label}`);
        return false;
    }
    if (notAllowlisted) showNotAllowlistedUI();
    return true;
}


export function atlasStampedMutationData(ref, data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        return data;
    }
    const deviceId = getDeviceId();
    const stamped = deviceId ? { ...data, deviceId } : { ...data };
    const path = String(ref?.path || "");
    if (!/^clans\/[^/]+$/.test(path)) return stamped;
    return {
        ...stamped,
        scriptVersion: SCRIPT_VERSION,
        versionNum: SCRIPT_VERSION_NUM,
    };
}


// Short "who/what" line for the deny record — e.g. Nickname="Xuuya"
// beats a bare "script_submissions" bucket. Bounded to stay safe.
export function describeWriteSubject(label, data) {
    if (!data || typeof data !== "object") return "";
    const parts = [];
    if (data.playlist) parts.push(`playlist=${String(data.playlist)}`);
    if (data.Nickname) parts.push(`Nickname="${String(data.Nickname).slice(0, 40)}"`);
    else if (data.name) parts.push(`name="${String(data.name).slice(0, 40)}"`);
    if (data.tag) parts.push(`tag=${String(data.tag).slice(0, 16)}`);
    if (data.role) parts.push(`role=${String(data.role).slice(0, 24)}`);
    if (data.clanId) parts.push(`clanId=${String(data.clanId).slice(0, 32)}`);
    if (!parts.length && label) parts.push(`label=${label}`);
    return parts.join(" ").slice(0, 120);
}


export async function atlasSetDoc(fb, label, ref, data, options) {
    if (!firebaseAuthUid) {
        dbg("atlasSetDoc skipped: firebaseAuthUid not ready");
        return false;
    }
    if (!(await atlasMutationAllowed(fb, label))) return false;
    logWrite(label);
    const stamped = atlasStampedMutationData(ref, data);
    const startedAt = Date.now();
    const attempt = {
        at: startedAt,
        label,
        path: ref && ref.path,
        merge: !!(options && options.merge),
        payloadKeys: Object.keys(stamped),
        payload: _sanitizeWriteValue(stamped),
    };
    try {
        if (options === undefined) await fb.setDoc(ref, stamped);
        else await fb.setDoc(ref, stamped, options);
        _pushWriteAttempt({ ...attempt, ok: true, latencyMs: Date.now() - startedAt });
        return true;
    } catch (e) {
        if (e && String(e.code || "").includes("permission-denied")) {
            const docId = ref && ref.id;
            const ac = appCheckSnapshot();
            const acc = accessSnapshot();
            const keyDiff = payloadKeyDiff(label, stamped);
            const reasons = describeDenyReasons(label, stamped, { docId });
            const likelyCauses = classifyDeny(e, {
                ac, acc, keyDiff, data: stamped, label,
            });
            logDeny(label, {
                op: "write",
                path: ref && ref.path,
                err: e,
                subject: describeWriteSubject(label, data),
                reasons,
                appCheck: ac,
                access: acc,
                keyDiff,
                likelyCauses,
            });
        }
        _pushWriteAttempt({
            ...attempt,
            ok: false,
            latencyMs: Date.now() - startedAt,
            errCode: e && e.code,
            errName: e && e.name,
            errMsg: e && e.message,
            serverResponse: e && e.customData && e.customData.serverResponse,
            stack: formatStackTrace(e),
        });
        throw e;
    }
}


export async function atlasDeleteDoc(fb, label, ref) {
    if (!(await atlasMutationAllowed(fb, label))) return false;
    logWrite(label);
    await fb.deleteDoc(ref);
    return true;
}


export async function runAtlasTransaction(fb, label, callback) {
    if (!(await atlasMutationAllowed(fb, label))) return false;
    await fb.runTransaction(fb.db, async transaction => {
        const counted = {
            get: async ref => {
                const snapshot = await transaction.get(ref);
                logRead(ref?.path || `${label} transaction`);
                return snapshot;
            },
            set: (ref, data, ...args) => {
                logWrite(label);
                return transaction.set(
                    ref,
                    atlasStampedMutationData(ref, data),
                    ...args
                );
            },
            update: (ref, data, ...args) => {
                logWrite(label);
                return transaction.update(
                    ref,
                    atlasStampedMutationData(ref, data),
                    ...args
                );
            },
            delete: (...args) => {
                logWrite(label);
                return transaction.delete(...args);
            },
        };
        return callback(counted);
    });
    return true;
}


export function showUpdateRequiredUI() {
    if (updateRequiredUiShown) return;
    updateRequiredUiShown = true;
    showBanner("ATLAS update required — Tampermonkey → Check for updates", "#ffcf5b");
}


export function showWritesPausedUI() {
    if (writesPausedUiShown) return;
    writesPausedUiShown = true;
    showBanner("Writes are paused. Standings are frozen until Pal turns them back on.", "#ffcf5b");
}


export function showNotAllowlistedUI() {
    if (notAllowlistedUiShown) return;
    notAllowlistedUiShown = true;
    createHUD();
    if (!hud || document.getElementById("rgAllowlistNudge")) return;
    const bar = document.createElement("div");
    bar.id = "rgAllowlistNudge";
    bar.style.cssText = `
        position:absolute;
        top:100%;
        margin-top:6px;
        left:0;
        right:0;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:8px;
        padding:6px 10px;
        border:1px solid #ffcf5b;
        border-radius:8px;
        background:rgba(10,14,18,0.95);
        color:#ffcf5b;
        font:600 12px system-ui, sans-serif;
        z-index:5;
    `;
    const link = document.createElement("a");
    link.href = DISCORD_INVITE;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Leaderboard is invite-only — ask Pal or RIS3N on Discord to add you";
    link.style.cssText = "color:#ffcf5b;text-decoration:none;flex:1;cursor:pointer";
    const uid = firebaseAuthUid || "";
    if (uid) link.title = `Your Firebase id: ${uid}`;
    bar.appendChild(link);
    hud.appendChild(bar);
}


export async function isUpdateRequired(fb) {
    if (updateRequiredChecked) return updateRequired || writesPaused;
    try {
        // one read covers version + the halt switch. Pin book stays off
        // this client. A permission-denied here means this uid is not
        // on the allow list — show the invite bar, do not retry the
        // pin doc.
        const snap = await fb.getDoc(fb.doc(fb.db, "admin", "gate"));
        // read went through, so the uid is on the allowlist now
        notAllowlisted = false;
        if (snap.exists()) {
            const data = snap.data() || {};
            if (data.pauseWrites === true) writesPaused = true;
            const minV = data.minVersion;
            if (typeof minV === "number" && SCRIPT_VERSION_NUM < minV) {
                updateRequired = true;
            }
        }
    } catch (e) {
        if (firebaseAuthUid && isDeny(e)) {
            notAllowlisted = true;
        } else {
            dbg("isUpdateRequired read failed (non-fatal): " + getErrMsg(e));
        }
    }
    updateRequiredChecked = true;
    return updateRequired || writesPaused;
}


export async function maybeShowUpdateNudge() {
    if (updateNudgeChecked) return;
    updateNudgeChecked = true;
    try {
        const fb = await initFirebase();
        if (!fb) return;
        const snap = await fb.getDoc(fb.doc(fb.db, "admin", "latest_version"));
        if (!snap.exists()) return;
        const data = snap.data() || {};
        const latest = Number(data.versionNum);
        if (!Number.isFinite(latest) || SCRIPT_VERSION_NUM >= latest) return;

        const dismissedKey = `rgAtlasUpdateDismissed_v${latest}`;
        try { if (localStorage.getItem(dismissedKey) === "1") return; } catch (e) {}

        const updateUrl = typeof data.updateUrl === "string" && /^https:\/\//.test(data.updateUrl)
            ? data.updateUrl
            : DEFAULT_UPDATE_URL;
        showUpdateNudge(String(latest), updateUrl, dismissedKey);
    } catch (e) {
        dbg("maybeShowUpdateNudge failed (non-fatal): " + getErrMsg(e));
    }
}


export function showUpdateNudge(version, url, dismissedKey) {
    createHUD();
    if (!hud || document.getElementById("rgUpdateNudge")) return;
    const bar = document.createElement("div");
    bar.id = "rgUpdateNudge";
    bar.style.cssText = `
        position:absolute;
        top:-38px;
        left:0;
        right:0;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:8px;
        padding:6px 10px;
        border:1px solid #5bb1ff;
        border-radius:8px;
        background:rgba(10,14,18,0.95);
        color:#5bb1ff;
        font:600 12px system-ui, sans-serif;
        z-index:5;
    `;
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = `↓ ATLAS ${version} available. Click to update.`;
    link.style.cssText = "color:#5bb1ff;text-decoration:none;flex:1;cursor:pointer";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "×";
    dismiss.title = "Dismiss until next release";
    dismiss.style.cssText = "all:unset;cursor:pointer;color:#5bb1ff;font-weight:bold;padding:0 4px";
    dismiss.addEventListener("click", () => {
        try { localStorage.setItem(dismissedKey, "1"); } catch (e) {}
        bar.remove();
    });
    bar.appendChild(link);
    bar.appendChild(dismiss);
    hud.appendChild(bar);
}


export async function uploadHudReadStats({ final = false } = {}) {
    if (hudStatsUploadInFlight) {
        if (final) hudStatsPendingFinalFlush = true;
        return;
    }
    const uid = firebaseAuthUid;
    const rgPlayerId = (typeof myUserId === "function") ? myUserId() : null;
    if (!uid) return; // no identity yet — can't authenticate the write
    const fb = firestoreReady;
    if (!fb) return;
    const totalReads = firestoreReadCount;
    const totalWrites = firestoreWriteCount;
    const perLabelReads = Object.fromEntries(hudSessionReadsByLabel);
    const perLabelWrites = Object.fromEntries(hudSessionWritesByLabel);
    const perLabelDenies = Object.fromEntries(hudSessionDeniesByLabel);
    const deniesRecent = hudSessionDenies.slice(-HUD_DENY_RECORD_MAX);
    // Skip identical payloads (a quiet session doesn't spam writes).
    // A `final` flush always uploads so the last state is captured.
    const key = `${totalReads}:${totalWrites}:${JSON.stringify(perLabelReads)}:${JSON.stringify(perLabelWrites)}:${JSON.stringify(perLabelDenies)}:${deniesRecent.length}`;
    if (!final && key === hudStatsLastPayloadKey) return;
    hudStatsUploadInFlight = true;
    try {
        const date = hudStatsToday();
        const docId = `${date}_${uid}`;
        const payload = {
            date,
            sourceUserId: uid,
            deviceId: getDeviceId(),
            scriptVersion: SCRIPT_VERSION,
            versionNum: SCRIPT_VERSION_NUM,
            startedAt: HUD_STATS_SESSION_STARTED_AT,
            updatedAt: new Date().toISOString(),
            readTotal: totalReads,
            writeTotal: totalWrites,
            perLabelReads,
            perLabelWrites,
            perLabelDenies,
            deniesRecent,
            lastWriteAt: fb.serverTimestamp(),
        };
        if (rgPlayerId) payload.rgPlayerId = rgPlayerId;
        const ref = fb.doc(fb.db, "hud_read_stats", docId);
        // atlasSetDoc goes through the blacklist gate + logWrite, so the
        // telemetry write itself is counted. Small overhead (1 write per
        // 5 min per HUD), well below any budget.
        const wrote = await atlasSetDoc(fb, "hud_read_stats", ref, payload, { merge: true });
        if (wrote) hudStatsLastPayloadKey = key;
    } catch (err) {
        dbg("uploadHudReadStats failed (non-fatal): " + getErrMsg(err));
    } finally {
        hudStatsUploadInFlight = false;
        if (hudStatsPendingFinalFlush) {
            hudStatsPendingFinalFlush = false;
            uploadHudReadStats({ final: true }).catch(() => {});
        }
    }
}
