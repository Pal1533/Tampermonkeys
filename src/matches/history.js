export const MATCH_HISTORY_CAP = 50;
export const MATCH_HISTORY_STORAGE_PREFIX = "rgAtlas.matchHistory.v1.";


// ------------------------------------------------------------------
// Match snapshots — record before/after Glicko + roster per match end
// so we can reverse-engineer the game's display-rating formula.
// ------------------------------------------------------------------
export const RECENT_MATCHES_CAP = 5;
export const MODES_FOR_SNAPSHOTS = [
    "Competitive1v1", "Competitive2v2", "Competitive3v3", "Casual",
];


export function loadMatchHistory(uid) {
    if (!uid) return [];
    try {
        const raw = localStorage.getItem(MATCH_HISTORY_STORAGE_PREFIX + uid);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
}

export function saveMatchHistory(uid, ring) {
    if (!uid) return;
    try {
        const trimmed = ring.slice(-MATCH_HISTORY_CAP);
        localStorage.setItem(MATCH_HISTORY_STORAGE_PREFIX + uid, JSON.stringify(trimmed));
    } catch { /* full storage or private mode — non-fatal */ }
}


// The public rules deny this collection and there is no retention job.
// Keep the call site as a no-op until both exist.
export async function writeMatchAudit(prevRatings, opponents) {
    void prevRatings;
    void opponents;
    dbg("match audit disabled");
}


export async function writeMatchSnapshotDoc(uid, snap) {
    const fb = firestoreReady;
    if (!fb || !uid || !snap?.matchId) return;
    if (!firebaseAuthUid) {
        dbg("writeMatchSnapshotDoc skipped: firebaseAuthUid not ready");
        return;
    }
    if (snap.team !== "Blue" && snap.team !== "Orange") {
        dbg("writeMatchSnapshotDoc skipped: team unknown");
        return;
    }
    try {
        const docId = `${firebaseAuthUid}_${snap.matchId}`;
        const ref = fb.doc(fb.db, "match_snapshots", docId);
        await atlasSetDoc(fb, "match_snapshots", ref, {
            sourceUserId: firebaseAuthUid,
            deviceId: getDeviceId(),
            matchId: snap.matchId,
            mode: snap.mode,
            outcome: snap.outcome,
            team: snap.team,
            at: snap.at,
            before: snap.before,
            after: snap.after,
            roster: snap.roster,
        }, { merge: true });
    } catch (err) {
        dbg("writeMatchSnapshotDoc failed (non-fatal): " + getErrMsg(err));
    }
}


export function handleMatchSnapshots(before, after) {
    try {
        const uid = after?.Id;
        if (!uid) return;
        ensureRingHydrated(uid);
        const snapshots = captureMatchSnapshotsIfAny(before, after);
        if (!snapshots.length) return;
        for (const snap of snapshots) {
            _recentMatchesRing.push(snap);
            _pendingNewMatchIds.push(snap.matchId);
            writeMatchSnapshotDoc(uid, snap); // fire-and-forget
        }
        if (_pendingNewMatchIds.length > 10) {
            _pendingNewMatchIds = _pendingNewMatchIds.slice(-10);
        }
        if (_recentMatchesRing.length > MATCH_HISTORY_CAP) {
            _recentMatchesRing = _recentMatchesRing.slice(-MATCH_HISTORY_CAP);
        }
        saveMatchHistory(uid, _recentMatchesRing);
    } catch (err) {
        dbg("handleMatchSnapshots threw: " + getErrMsg(err));
    }
}


export function captureMatchSnapshotsIfAny(before, after) {
    if (!before || !after || !after.Id) return [];
    const uid = after.Id;
    const matchId = String(after.CurrentGameId || "").trim();
    if (!matchId || _seenMatchIds.has(matchId)) return [];
    const roster = rosterSnapshot(uid);
    const myTeam = (roster.find(r => r.uid === uid) || {}).team || null;
    const created = [];
    for (const mode of MODES_FOR_SNAPSHOTS) {
        const bs = statsOf(before, mode);
        const as = statsOf(after, mode);
        const matchesDelta = as.matches - bs.matches;
        if (matchesDelta <= 0) continue; // no new match this mode
        // 6+ matches in one poll is the endpoint-loop signature. Flag it.
        if (matchesDelta > 5) {
            dbg(`match snapshot suspicious: ${mode} matchesDelta=${matchesDelta}, flagging for review`);
            reconcileFlagFromServer(uid, true);
            continue;
        }
        if (matchesDelta > 1) {
            dbg(`match snapshot skipped: ${mode} matchesDelta=${matchesDelta} looks like a catch-up sync`);
            continue;
        }
        const outcome = outcomeFromDelta(bs, as);
        if (!outcome) continue;
        created.push({
            at: new Date().toISOString(),
            mode,
            outcome,
            matchId,
            team: myTeam,
            before: glickoOf(before, mode),
            after: glickoOf(after, mode),
            roster,
        });
    }
    if (created.length) _seenMatchIds.add(matchId);
    return created;
}

export function rosterSnapshot(selfUid) {
    // Opponent display MMR is best-effort — only known when they're
    // in the top ~100 leaderboard cache the HUD already keeps warm.
    // Sync read from the in-memory memo, no Firestore call.
    const seenTop = new Map();
    try {
        for (const memo of _lbCacheMemo.values()) {
            const modes = memo?.modes || {};
            for (const entries of Object.values(modes)) {
                if (!Array.isArray(entries)) continue;
                for (const e of entries) {
                    if (e?.uid && typeof e.mmr === "number") seenTop.set(e.uid, e.mmr);
                }
            }
        }
    } catch { /* cache may be off */ }
    return _liveRoster.map(p => {
        const entry = { uid: p.uid || "", name: (p.name || "").slice(0, 40), team: p.team || null };
        const dr = seenTop.get(p.uid);
        if (typeof dr === "number") entry.dr = dr;
        return entry;
    });
}

export function ensureRingHydrated(uid) {
    if (_recentMatchesRing === null) _recentMatchesRing = loadMatchHistory(uid);
}


export async function refreshRanks(fb, data, force = false) {
    // Paint from cache so the badge isn't blank, but still let the
    // query below run so a stale rank gets corrected.
    if (!ranksFetchedThisSession && data?.Id && hydrateRankCache(data.Id)) {
        if (lastKnownPlayerData) updateHUD(lastKnownPlayerData);
    }
    if (!force && ranksFetchedThisSession) return;

    const modeToPlaylist = {
        Competitive1v1: "1v1",
        Competitive2v2: "2v2",
        Competitive3v3: "3v3",
    };

    try {
        for (const [mode, playlist] of Object.entries(modeToPlaylist)) {
            const mmr = data.ModesGlicko?.[mode]?.displayRating;
            if (typeof mmr !== "number") continue;

            let rank = null;
            let siteGapMmr = null;

            // Prefer the site JSON blob — it's the same file the site
            // renders from, updated every ~15 min, identity-deduped, and
            // free (public GitHub). Rank read here matches site exactly.
            try {
                const siteRows = await fetchSiteLeaderboardRows(playlist);
                if (siteRows) {
                    const uid = firebaseAuthUid || "";
                    const rgId = data?.Id || "";
                    const me = siteRows.find((r) =>
                        (uid && (r.uid === uid || r.sourceUserId === uid))
                        || (rgId && r.rgPlayerId === rgId)
                    );
                    if (me && typeof me.rank === "number") {
                        rank = me.rank;
                        if (rank > 1) {
                            const above = siteRows.find((r) => r.rank === rank - 1);
                            if (above && typeof above.mmr === "number") {
                                siteGapMmr = Math.max(0, above.mmr - mmr + 1);
                            }
                        }
                    }
                }
            } catch (e) {
                dbg(`refreshRanks: site JSON lookup failed for ${playlist} (non-fatal)`);
            }

            // Site JSON gave us a rank — cache and skip Firebase entirely.
            if (rank != null) {
                cachedRanks.set(playlist, rank);
                lastRankedMMR.set(playlist, mmr);
                lastRankedAt.set(playlist, Date.now());
                if (siteGapMmr != null) cachedMmrToNext.set(playlist, siteGapMmr);
                continue;
            }

            // Fallback: Firestore aggregate. Still catches drift when
            // the site JSON fetch failed (CDN hiccup, offline, etc.).
            const AGG_FRESH_MS = 60 * 60 * 1000; // 1h
            try {
                const aggSnap = await fb.getDoc(
                    fb.doc(fb.db, LEADERBOARD_CACHE_COLLECTION, playlist)
                );
                if (aggSnap.exists()) {
                    const aggData = aggSnap.data() || {};
                    const builtAt = Date.parse(aggData.builtAt || "") || Number(aggData.builtAt) || 0;
                    const aggFresh = builtAt && (Date.now() - builtAt) < AGG_FRESH_MS;
                    if (aggFresh) {
                        const rows = aggData.rows || [];
                        const uid = firebaseAuthUid || "";
                        const rgId = data?.Id || "";
                        const me = rows.find((r) =>
                            (uid && (r.uid === uid || r.sourceUserId === uid))
                            || (rgId && r.rgPlayerId === rgId)
                        );
                        if (me && typeof me.rank === "number") rank = me.rank;
                    }
                }
            } catch (e) {
                dbg(`refreshRanks: aggregate lookup failed for ${playlist} (non-fatal)`);
            }

            // If the aggregate gave us a rank, use it and move on.
            if (rank != null) {
                cachedRanks.set(playlist, rank);
                lastRankedMMR.set(playlist, mmr);
                lastRankedAt.set(playlist, Date.now());
                continue;
            }

            // Aggregate stale, missing, or user below top-100: use the
            // MMR-freshness skip to save reads on the expensive count
            // path. Rank at low placement drifts by ±1-3 without dedup
            // but that rarely matters visually.
            const queriedAt = lastRankedAt.get(playlist) || 0;
            const isFresh = Date.now() - queriedAt < RANK_QUERY_MAX_AGE_MS;
            if (isFresh && lastRankedMMR.get(playlist) === mmr) continue;

            {
                const q = fb.query(
                    fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                    fb.where("playlist", "==", playlist),
                    fb.where("mmr", ">", mmr)
                );
                const snapshot = await fb.getCountFromServer(q);
                let deletedAbove = 0;
                try {
                    const deletedQ = fb.query(
                        fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                        fb.where("playlist", "==", playlist),
                        fb.where("mmr", ">", mmr),
                        fb.where("deleted", "==", true)
                    );
                    const deletedSnap = await fb.getCountFromServer(deletedQ);
                    deletedAbove = deletedSnap.data().count;
                } catch (e) {
                    dbg(`refreshRanks: deleted-count lookup failed for ${playlist} (index?): ` + getErrMsg(e));
                }
                rank = Math.max(1, snapshot.data().count - deletedAbove + 1);
            }
            cachedRanks.set(playlist, rank);
            lastRankedMMR.set(playlist, mmr);
            lastRankedAt.set(playlist, Date.now());

            // gap to next rank up: lowest-MMR entry still above us.
            // skipped when already #1. Fetch a small batch so we can
            // skip past any soft-deleted rows client-side.
            if (rank > 1) {
                try {
                    const nextQ = fb.query(
                        fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                        fb.where("playlist", "==", playlist),
                        fb.where("mmr", ">", mmr),
                        fb.orderBy("mmr", "asc"),
                        fb.limit(5)
                    );
                    const nextSnap = await fb.getDocs(nextQ);
                    const firstLive = nextSnap.docs.find(d => d.data().deleted !== true);
                    if (firstLive) {
                        const nextMmr = firstLive.data().mmr;
                        cachedMmrToNext.set(playlist, Math.max(0, nextMmr - mmr + 1));
                    }
                } catch (e) {
                    // gap is nice-to-have, ignore failures
                    dbg(`refreshRanks: mmr-to-next lookup failed for ${playlist}`);
                }
            } else {
                cachedMmrToNext.delete(playlist);
            }
        }

        ranksFetchedThisSession = true;
        persistRankCache(data?.Id);

        checkRankTransitions();

        // re-render with fresh ranks
        if (lastKnownPlayerData) updateHUD(lastKnownPlayerData);
    } catch (e) {
        // rank display is nice-to-have, don't crash on failure
        dbg("refreshRanks failed: " + getErrMsg(e));
        console.warn("[RG HUD] Rank lookup failed:", e);
    }
}


export function freezeRoster() {
    if (_liveRoster.length) {
        lastGamePlayers = _liveRoster.slice();
        try { localStorage.setItem("rgHudLastRoster", JSON.stringify(lastGamePlayers)); }
        catch (e) { pushError(e, "saveLastRoster"); }
        dbg(`Imposter roster captured: ${lastGamePlayers.length} player(s): ${lastGamePlayers.map(p => p.name).join(", ")}`);
        // repaint Forge if it's open. no focus-steal risk mid-match,
        // the user can't be typing in Forge while playing.
        const fv = document.getElementById("rgForgeView");
        if (isVisible(fv) && typeof RGNF !== "undefined" && RGNF.refresh) {
            RGNF.refresh();
        }
        // clear so a stray second freeze (matchEnd fetch + logged response)
        // can't re-capture stale data
        _liveRoster = [];
    }
}


export function syncForgeFromLogin(loginData) {
    const userId = String(loginData?.Id ?? "").trim();
    if (!userId || typeof RGNF === "undefined") return false;
    const rawNick = String(loginData?.Nickname ?? "");
    const unprefixed = stripLeadingClanTagMarkup(rawNick);
    if (RGNF.syncToCurrentPlayer) {
        RGNF.syncToCurrentPlayer(userId, cleanName(unprefixed), unprefixed);
    }
    if (rawNick && RGNF.verifyStolenName) RGNF.verifyStolenName(rawNick);
    return true;
}
