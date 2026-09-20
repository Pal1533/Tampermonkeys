
// Match-end and leaderboard submission can reach clan sync concurrently.
// Serialize them per account so the forced match-end refresh lands first,
// while the later leaderboard pass sees the fresh in-memory MMR and skips.
export const clanSyncLocks = new Map();

export function queueClanMMRSync(fb, data, options = {}) {
    const uid = data?.Id;
    if (!uid) return Promise.resolve(null);
    const previous = clanSyncLocks.get(uid) || Promise.resolve();
    const current = previous
        .catch(() => null)
        .then(() => updateMyClanMMR(fb, data, options));
    clanSyncLocks.set(uid, current);
    return current;
}


export async function syncClanAfterMatch(data) {
    if (!data?.Id || !data?.ModesGlicko) return;
    try {
        const fb = await initFirebase();
        if (!fb) {
            dbg("match-end clan sync skipped: Firebase unavailable");
            return;
        }
        // Standings don't move outside an active event, so the write
        // wouldn't affect anything anyone can see. Skip it and save the
        // read+write on every match-end during the ~50 weeks/yr of downtime.
        await loadEventConfig(fb);
        if (eventPhase() !== "active") {
            dbg("match-end clan sync skipped: no active event");
            return;
        }
        const result = await queueClanMMRSync(fb, data, {
            force: true,
            reason: "matchEnd",
        });
        if (result?.synced) {
            dbg(`match-end clan MMR synced at ${result.mmr}`);
            refreshClanViewIfOpen();
        } else if (!result?.clanId) {
            dbg("match-end clan sync skipped: player is not in a clan");
        }
    } catch (e) {
        dbg("match-end clan sync failed: " + getErrMsg(e));
    }
}


// refresh my ranked MMR in the clan doc + recompute totalMMR.
// returns { tag } for the leaderboard name prefix. best-effort.
export async function updateMyClanMMR(
    fb,
    data,
    { force = false, reason = "leaderboard" } = {}
) {
    const uid = data.Id;
    try {
        await loadEventConfig(fb);
        // Normal matches do not read or write clan docs. Cup score
        // only moves during an active event; join/leave/kick use
        // their own write paths.
        if (eventPhase() !== "active") {
            const currentClan = clanLoadedForAccount === uid ? myClan : null;
            const tag = currentClan?.tag ?? "";
            dbg("Clan MMR write skipped: no active event");
            return currentClan
                ? { tag, clanId: currentClan.id, synced: false, mmr: null }
                : null;
        }
        // A cached null can outlive a stale/missed directory read. Match-end
        // must retry discovery instead of silently abandoning contribution.
        if (!clanLoaded || clanLoadedForAccount !== uid || !myClan) await loadClanData(true);
        if (!myClan) return null;

        // capture tag first, leaderboard prefix must not depend on the MMR write
        const tag = myClan.tag ?? "";
        const clanId = myClan.id;

        const g = data.ModesGlicko;
        const rankedModes = ["Competitive3v3", "Competitive2v2", "Competitive1v1"];
        const myMMR = rankedModes.reduce((s, m) =>
            s + (typeof g?.[m]?.displayRating === "number" ? g[m].displayRating : 0), 0);

        await loadClanRolePerms(fb);

        const prevMine = effectiveClanMemberStat(myClan, uid).mmr;
        const deviceId = getDeviceId();
        const deviceNeedsLink = !clanHasDeviceId(myClan, uid, deviceId);
        let synced = false;
        if (force || prevMine !== myMMR || deviceNeedsLink) {
            try {
                // syncedAt: client ms on my member entry so teammates get
                // per-member freshness ("2m ago"). serverTimestamp() isn't
                // allowed inside array elements anyway.
                // Always rebuild from the transaction's fresh server copy.
                // A plain setDoc used our stale in-memory members array and
                // could erase somebody who had just been approved.
                const clanRef = fb.doc(fb.db, "clans", clanId);
                const useReservations = clanReservationsEnabled();
                const directoryRef = clanDirectoryDocRef(fb, clanId);
                const membershipRef = useReservations
                    ? fb.doc(fb.db, "clan_memberships", uid)
                    : null;
                const deviceRef = useReservations
                    ? fb.doc(fb.db, "clan_devices", deviceId)
                    : null;
                const syncedAt = Date.now();
                let committedClan = null;
                let committedDirectory = null;
                let wroteClan = false;
                const writeClanMMR = () => {
                    committedClan = null;
                    committedDirectory = null;
                    wroteClan = false;
                    return runAtlasTransaction(fb, "clan score sync", async tx => {
                        committedClan = null;
                        committedDirectory = null;
                        wroteClan = false;
                        // A device only does this on its first clan sync.
                        // Saving both together stops two accounts racing.
                        const directorySnap = !useReservations && deviceNeedsLink
                            ? await tx.get(directoryRef)
                            : null;
                        const membershipSnap = useReservations
                            ? await tx.get(membershipRef)
                            : null;
                        const deviceSnap = useReservations
                            ? await tx.get(deviceRef)
                            : null;
                        const liveSnap = await tx.get(clanRef);
                        if (!liveSnap.exists()) return;
                        if ((membershipSnap?.exists()
                            && membershipSnap.data().clanId !== clanId)
                            || (deviceSnap?.exists()
                                && deviceSnap.data().clanId !== clanId)) {
                            return;
                        }
                        const liveClan = liveSnap.data();
                        const liveMine = effectiveClanMemberStat(liveClan, uid);
                        if (!force && liveMine.mmr === myMMR
                            && clanHasDeviceId(liveClan, uid, deviceId)) {
                            committedClan = { ...liveClan, id: clanId };
                            return;
                        }
                        const fields = clanMMRWriteFields(
                            liveClan,
                            uid,
                            myMMR,
                            syncedAt,
                            deviceId
                        );
                        if (!fields) return;
                        const nextClan = {
                            ...liveClan,
                            id: clanId,
                            ...fields,
                        };
                        const reservationFields = useReservations
                            ? {
                                memberIds: clanMembers(nextClan).map(
                                    member => member.userId
                                ),
                                deviceIds: clanDeviceIds(nextClan),
                            }
                            : {};
                        tx.set(clanRef,
                            {
                                ...fields,
                                ...reservationFields,
                                lastSyncAt: fb.serverTimestamp(),
                            },
                            { merge: true });
                        committedClan = {
                            ...nextClan,
                            ...reservationFields,
                        };
                        const entry = clanDirectoryEntry(clanId, committedClan);
                        if (useReservations) {
                            tx.set(directoryRef, entry);
                            tx.set(
                                membershipRef,
                                clanMembershipRecord(
                                    clanId,
                                    clanMembers(committedClan).find(
                                        member => member.userId === uid
                                    )?.role ?? "member",
                                    clanMemberDeviceIds(committedClan, uid)
                                )
                            );
                            tx.set(deviceRef, {
                                clanId,
                                userId: uid,
                                updatedAt: new Date().toISOString(),
                            });
                            committedDirectory = putClanInDirectory(
                                clanDirectory,
                                entry
                            );
                        } else if (deviceNeedsLink && directorySnap) {
                            const liveDirectory = directorySnap.exists()
                                ? (directorySnap.data().clans ?? [])
                                : [];
                            committedDirectory = putClanInDirectory(
                                liveDirectory,
                                entry
                            );
                            tx.set(directoryRef, { clans: committedDirectory });
                        }
                        wroteClan = true;
                    });
                };
                try {
                    const ran = await writeClanMMR();
                    if (!ran) return null;
                } catch (firstErr) {
                    // one retry, otherwise a transient fail stalled visible
                    // contribution until the NEXT match
                    console.warn("[RG HUD] Clan MMR write failed, retrying in 5s:", firstErr);
                    await new Promise(r => setTimeout(r, 5000));
                    const ran = await writeClanMMR();
                    if (!ran) return null;
                }
                if (!committedClan) {
                    dbg("Clan MMR transaction skipped: clan missing or player no longer on roster");
                    detachClanListener();
                    myClan = null;
                    clanLoaded = false;
                    return null;
                }
                myClan = sanitizeClanDoc(committedClan);
                if (committedDirectory) clanDirectory = committedDirectory;
                synced = wroteClan;
                if (wroteClan) {
                    dbg(`Clan MMR sync committed (${reason}): ${prevMine ?? "unset"} -> ${myMMR}`);

                    // throttled directory rebuild, instant local, Firestore at most every 3m
                    await refreshDirectoryThrottled(fb);
                }
            } catch (writeErr) {
                // best-effort, never strip the tag on failure
                console.warn("[RG HUD] Clan MMR write failed (tag still applies):", writeErr);
                // surface this — silent failure breaks event scoring for the session
                showError("Clan sync failing — event score may be stale");
            }
        }

        // capture event baseline on first sync during an active event
        await maybeCaptureEventBaseline(fb, uid, myMMR);

        return { tag, clanId, synced, mmr: myMMR };
    } catch (e) {
        console.warn("[RG HUD] Clan lookup failed:", e);
        return null;
    }
}


export async function loadEventConfig(fb, force = false) {
    if (eventConfigLoaded && !force) return eventConfig;
    try {
        const snap = await fb.getDoc(fb.doc(fb.db, "events", "current"));
        if (snap.exists()) {
            const d = snap.data();
            // merge over defaults so partial perms still get safe fallbacks
            const storedPerms = (d.perms && typeof d.perms === "object") ? d.perms : {};
            eventConfig = {
                name: d.name ?? "Clan Event",
                startTime: d.startTime?.toMillis ? d.startTime.toMillis() : (d.startTime ?? 0),
                endTime: d.endTime?.toMillis ? d.endTime.toMillis() : (d.endTime ?? 0),
                // applies outside the event window too
                maxMembers: (typeof d.maxMembers === "number") ? d.maxMembers : null,
                startingLineupSize: (typeof d.startingLineupSize === "number") ? d.startingLineupSize : null,
                // ms to keep the "Ended" banner visible after endTime; then
                // the banner hides itself until the next event. Default 48h.
                postEventGracePeriodMs: (typeof d.postEventGracePeriodMs === "number") ? d.postEventGracePeriodMs : null,
                useClanReservations: d.useClanReservations === true,
                perms: { ...EVENT_PERM_DEFAULTS, ...storedPerms },
            };
        } else {
            eventConfig = null;
        }
        eventConfigLoaded = true;
    } catch (e) {
        dbg("loadEventConfig failed: " + getErrMsg(e));
        console.warn("[RG HUD] Event config load failed:", e);
    }
    return eventConfig;
}


export async function loadClanRolePerms(fb, force = false) {
    if (clanRolePermsLoaded && !force) return;
    try {
        const snap = await fb.getDoc(fb.doc(fb.db, "admin", "clanPerms"));
        clanRolePerms = snap.exists() ? snap.data() : null;
        clanRolePermsLoaded = true;
    } catch (e) {
        dbg("loadClanRolePerms failed (falling back to defaults): " + getErrMsg(e));
        console.warn("[RG HUD] Clan role perms load failed:", e);
    }
}


export async function maybeCaptureEventBaseline(fb, uid, currentMMR) {
    if (!myClan || eventPhase() !== "active"
        || !clanMembers(myClan).some(member => member.userId === uid)) return;
    const evId = currentEventId();
    if (myClan.eventId === evId
        && memberEventBaseline(myClan, uid) != null) return;

    try {
        const clanId = myClan.id;
        let committedBaseline = null;
        const ran = await runAtlasTransaction(
            fb,
            "clan event baseline",
            async tx => {
                committedBaseline = null;
                const ref = fb.doc(fb.db, "clans", clanId);
                const snapshot = await tx.get(ref);
                if (!snapshot.exists()) return;
                const liveClan = snapshot.data();
                if (!clanMembers(liveClan).some(member => member.userId === uid)) return;
                const baseline = liveClan.eventId === evId
                    ? { ...(liveClan.eventBaseline ?? {}) }
                    : {};
                if (liveClan.eventId === evId
                    && memberEventBaseline(liveClan, uid) != null) {
                    committedBaseline = baseline;
                    return;
                }
                if (baseline[uid] != null) {
                    committedBaseline = baseline;
                    return;
                }
                baseline[uid] = currentMMR;
                tx.set(ref, {
                    eventBaseline: baseline,
                    eventId: evId,
                    eventName: eventConfig.name,
                }, { merge: true });
                if (clanReservationsEnabled()) {
                    const nextClan = {
                        ...liveClan,
                        id: clanId,
                        eventBaseline: baseline,
                        eventId: evId,
                        eventName: eventConfig.name,
                    };
                    const entry = clanDirectoryEntry(clanId, nextClan);
                    tx.set(clanDirectoryDocRef(fb, clanId), entry);
                    clanDirectory = putClanInDirectory(clanDirectory, entry);
                }
                committedBaseline = baseline;
            }
        );
        if (!ran || !committedBaseline) return;
        myClan.eventBaseline = committedBaseline;
        myClan.eventId = evId;
    } catch (e) {
        console.warn("[RG HUD] Event baseline capture failed:", e);
        // without this alert, the member's contribution silently stays at 0
        showError("Event baseline capture failed — your contribution won't count until this recovers");
    }
}


// Point reads only. Listing clans_directory billed 17,959 reads per
// Clan-panel open (Virt 2026-08-16) and blew Spark. Standings come
// from the single index doc plus our shard. If the index is missing,
// do not query the junk drawer — that collection is ~18k orphan docs
// and even a limit(50) is 50 wasted reads of garbage.
export async function loadClanDirectoryLite(fb, clanId) {
    const budgetPassed = firestoreReadBudgetPassed();
    if (budgetPassed) {
        dbg("clan directory browse skipped: read budget passed");
    }
    const indexPromise = budgetPassed
        ? Promise.resolve(null)
        : fb.getDoc(fb.doc(fb.db, "clans_directory", "index"));
    const shardPromise = clanId
        ? fb.getDoc(fb.doc(fb.db, "clans_directory", clanId))
        : Promise.resolve(null);
    const [indexSnap, shardSnap] = await Promise.all([
        indexPromise,
        shardPromise,
    ]);
    let clans = budgetPassed ? clanDirectory.slice() : [];
    const indexClans = indexSnap?.exists()
        ? indexSnap.data()?.clans
        : null;
    if (Array.isArray(indexClans) && indexClans.length) {
        clans = indexClans;
    }
    if (clanId && shardSnap?.exists()) {
        clans = putClanInDirectory(clans, {
            id: clanId,
            ...shardSnap.data(),
        });
    }
    return canonicalClanDirectory(clans);
}


export async function attachClanListener() {
    if (!myClan) return;
    if (_clanUnsub && _clanListenerId === myClan.id) return;
    // without this reentry guard two rapid calls both await init then
    // both call onSnapshot, leaking the first listener.
    if (_clanAttaching) return;
    _clanAttaching = true;
    try {
        detachClanListener();
        const fb = await initFirebase();
        if (!fb || !myClan) return;
        // idle tabs drift past the App Check exp; long-lived listeners die silently.
        await ensureFreshAppCheckToken();
        if (!myClan) return;
        const clanId = myClan.id;
        _clanListenerId = clanId;
        _clanUnsub = fb.onSnapshot(
            fb.doc(fb.db, "clans", clanId),
            (snap) => {
                const uid = myUserId();
                // doc gone (disband) or we're off the roster (left/kicked).
                // this is also how a kicked player sees it happen live.
                const stillMember = snap.exists()
                    && clanMembers(snap.data()).some(m => m.userId === uid);
                if (!stillMember) {
                    detachClanListener();
                    myClan = null;
                    clanLoaded = false;
                    refreshClanViewIfOpen();
                    // The kick write lands right after the roster update.
                    scheduleClanNoticeCheck(500);
                    return;
                }
                myClan = sanitizeClanDoc({ id: snap.id, ...snap.data() });
                // Legacy clients may replace the members array with a stale
                // copy. Recompute this client's directory entry from the
                // protected per-member map without another Firestore read.
                patchMyClanInDirectory();
                refreshClanViewIfOpen();
                // repaint main stats too so Clash mini-bar updates live
                if (lastKnownPlayerData) updateHUD(lastKnownPlayerData);
            },
            (err) => {
                // without onError + retry, revoked perms freeze the UI
                // silently, and background tabs get throttled so the
                // listener dies quiet — syncs sit stale for 50+ min.
                dbg("clan listener error, scheduling reconnect: " + getErrMsg(err));
                console.warn("[RG HUD] Clan listener error, will retry in 30s:", err);
                detachClanListener();
                setTimeout(() => {
                    if (myClan) {
                        dbg("clan listener auto-reconnecting");
                        attachClanListener();
                    }
                }, 30 * 1000);
            }
        );
    } catch (e) {
        dbg("attachClanListener failed: " + getErrMsg(e));
        console.warn("[RG HUD] Clan listener attach failed:", e);
        _clanListenerId = null;
    } finally {
        _clanAttaching = false;
    }
}

export function detachClanListener() {
    if (_clanUnsub) {
        try { _clanUnsub(); } catch (e) {}
        _clanUnsub = null;
    }
    _clanListenerId = null;
}


export async function loadClanData(force = false) {
    // Parallel callers (submit + updateMyClanMMR fire together at match-end)
    // share one round trip, but never join a request from another account.
    const uid = myUserId();
    if (clanLoadInFlight && clanLoadInFlightAccount === uid) {
        if (force && !clanLoadInFlightForce) {
            return clanLoadInFlight.then(() => loadClanData(true));
        }
        return clanLoadInFlight;
    }
    const request = loadClanDataInner(force).finally(() => {
        if (clanLoadInFlight === request) {
            clanLoadInFlight = null;
            clanLoadInFlightAccount = null;
            clanLoadInFlightForce = false;
        }
    });
    clanLoadInFlight = request;
    clanLoadInFlightAccount = uid;
    clanLoadInFlightForce = force;
    return request;
}


export async function loadClanDataInner(force = false) {
    const uid = myUserId();
    if (!uid) return;

    // new account since last load, reset (and drop any pending cooldown
    // so a fresh account isn't blocked by the previous one's failure)
    if (clanLoadedForAccount !== uid) {
        force = true;
        myClan = null;
        clanDirectory = [];
        clanLoaded = false;
        clanLoadFailedAt = 0;
    }

    if (clanLoaded && !force) return;

    // Failure cooldown: after a rejected read (e.g. Firebase quota), skip
    // retries for a minute so each match-end doesn't hammer the same failure.
    if (clanLoadFailedAt
        && Date.now() - clanLoadFailedAt < CLAN_LOAD_FAILURE_COOLDOWN_MS) {
        return;
    }

    const fb = await initFirebase();
    if (!fb) return;

    try {
        await loadEventConfig(fb);
        const useReservations = clanReservationsEnabled();
        const deviceId = getDeviceId();
        const previousClan = myClan;
        let nextDirectory = [];
        let nextClan = null;
        let mine = null;
        let membership = null;
        let device = null;
        if (useReservations) {
            const [membershipSnap, deviceSnap] = await Promise.all([
                fb.getDoc(fb.doc(fb.db, "clan_memberships", uid)),
                fb.getDoc(fb.doc(fb.db, "clan_devices", deviceId)),
            ]);
            membership = membershipSnap.exists()
                ? membershipSnap.data()
                : null;
            device = deviceSnap.exists() ? deviceSnap.data() : null;
            const clanId = membership?.clanId || device?.clanId || null;
            nextDirectory = await loadClanDirectoryLite(fb, clanId);
            mine = clanId
                ? (nextDirectory.find(entry => entry.id === clanId)
                    || { id: clanId })
                : null;
        } else {
            const dirSnap = await fb.getDoc(
                fb.doc(fb.db, "clans_directory", "index")
            );
            nextDirectory = canonicalClanDirectory(
                dirSnap.exists() ? (dirSnap.data().clans ?? []) : []
            );
            mine = findDirectoryMembership(nextDirectory, {
                userId: uid,
                deviceId,
            });
        }
        if (myUserId() !== uid) return;
        if (mine?.id) {
            // Skip the one-shot fetch if the live clan listener is already
            // streaming this clan — the in-memory myClan is fresher than
            // a getDoc would be anyway.
            const listenerCoversClan =
                _clanListenerId === mine.id && previousClan?.id === mine.id;
            if (listenerCoversClan) {
                nextClan = previousClan;
            } else {
                const clanSnap = await fb.getDoc(
                    fb.doc(fb.db, "clans", mine.id)
                );
                if (clanSnap.exists()) {
                    nextClan = sanitizeClanDoc({
                        id: mine.id,
                        ...clanSnap.data(),
                    });
                }
            }
        }
        if (nextClan) {
            const directoryEntry = nextDirectory.find(
                entry => entry.id === nextClan.id
            ) || null;
            const linkPlan = clanDeviceLinkPlan({
                clan: nextClan,
                uid,
                deviceId,
                membership,
                device,
                directoryEntry,
                useReservations,
            });
            if (linkPlan.conflictClanId) {
                const sameClan = linkPlan.conflictClanId === nextClan.id;
                const other = nextDirectory.find(
                    entry => entry?.id === linkPlan.conflictClanId
                );
                await showDialog({
                    message: sameClan
                        ? `This ATLAS device is already linked to another account in ${nextClan.tag ? `[${nextClan.tag}] ` : ""}${nextClan.name}. One of the accounts must leave the clan.`
                        : `This ATLAS device is already linked to ${other?.tag ? `[${other.tag}] ` : ""}${other?.name || "another clan"}. This account is also in ${nextClan.tag ? `[${nextClan.tag}] ` : ""}${nextClan.name}. Leave one clan before using another account on this device.`,
                    okLabel: "OK",
                    cancelLabel: "Close",
                });
            } else if (linkPlan.repairClan || linkPlan.repairPointer) {
                try {
                    const linkResult = await linkCurrentClanDevice(
                        fb,
                        nextClan,
                        uid,
                        deviceId
                    );
                    if (linkResult?.clan) nextClan = sanitizeClanDoc(linkResult.clan);
                    if (linkResult?.directory) nextDirectory = linkResult.directory;
                } catch (linkErr) {
                    dbg("linkCurrentClanDevice failed: " + getErrMsg(linkErr));
                }
            }
        }
        if (myUserId() !== uid) return;
        myClan = nextClan;
        clanDirectory = nextDirectory;
        clanLoaded = true;
        clanLoadedForAccount = uid;
        clanLoadFailedAt = 0;
    } catch (e) {
        clanLoadFailedAt = Date.now();
        dbg("loadClanData failed: " + getErrMsg(e));
        console.warn("[RG HUD] Clan load failed:", e);
    }
}


export async function linkCurrentClanDevice(fb, clan, uid, deviceId) {
    const clanRef = fb.doc(fb.db, "clans", clan.id);
    const useReservations = clanReservationsEnabled();
    const directoryRef = clanDirectoryDocRef(fb, clan.id);
    const membershipRef = useReservations
        ? fb.doc(fb.db, "clan_memberships", uid)
        : null;
    const deviceRef = useReservations
        ? fb.doc(fb.db, "clan_devices", deviceId)
        : null;
    let result = { clan, directory: null, conflict: null };
    const ran = await runAtlasTransaction(fb, "link clan device", async tx => {
        result = { clan, directory: null, conflict: null };
        const directorySnap = await tx.get(directoryRef);
        const clanSnap = await tx.get(clanRef);
        const membershipSnap = useReservations
            ? await tx.get(membershipRef)
            : null;
        const deviceSnap = useReservations
            ? await tx.get(deviceRef)
            : null;
        if (!clanSnap.exists()) {
            result = { clan: null, directory: null, conflict: null };
            return;
        }
        const liveClan = { id: clan.id, ...clanSnap.data() };
        const member = clanMembers(liveClan).find(
            candidate => candidate.userId === uid
        );
        if (!member) {
            result = { clan: null, directory: null, conflict: null };
            return;
        }
        const liveDirectory = !useReservations && directorySnap.exists()
            ? (directorySnap.data().clans ?? [])
            : clanDirectory;
        const directoryEntry = useReservations
            ? (directorySnap.exists()
                ? { id: clan.id, ...directorySnap.data() }
                : null)
            : findDirectoryMembership(
                liveDirectory,
                { userId: null, deviceId }
            );
        const membership = membershipSnap?.exists()
            ? membershipSnap.data()
            : null;
        const device = deviceSnap?.exists() ? deviceSnap.data() : null;
        const plan = clanDeviceLinkPlan({
            clan: liveClan,
            uid,
            deviceId,
            membership,
            device,
            directoryEntry,
            useReservations,
        });
        if (plan.conflictClanId) {
            const lockedConflict = {
                ...(clanDirectory.find(
                    entry => entry?.id === plan.conflictClanId
                ) ?? {
                    id: plan.conflictClanId,
                    name: "another clan",
                    tag: "",
                }),
                membershipMatch: membership?.clanId === plan.conflictClanId
                    ? "player"
                    : "device",
            };
            result = {
                clan: liveClan,
                directory: null,
                conflict: lockedConflict,
            };
            return;
        }
        if (!plan.repairClan && !plan.repairPointer) {
            result = {
                clan: liveClan,
                directory: useReservations
                    ? clanDirectory
                    : canonicalClanDirectory(liveDirectory),
                conflict: null,
            };
            return;
        }
        const members = clanMembers(liveClan).map(candidate =>
            candidate.userId === uid
                ? { ...candidate, deviceId }
                : candidate
        );
        const existingStats = liveClan.memberStats?.[uid] ?? {};
        const deviceIds = [...new Set([
            ...(Array.isArray(existingStats.deviceIds) ? existingStats.deviceIds : []),
            deviceId,
        ])];
        const memberStats = {
            ...(liveClan.memberStats ?? {}),
            [uid]: { ...existingStats, deviceIds },
        };
        const reservationFields = useReservations
            ? {
                memberIds: members.map(candidate => candidate.userId),
                deviceIds: clanDeviceIds({ ...liveClan, members, memberStats }),
            }
            : {};
        const membersField = clanMembersField(liveClan, members);
        const linkedClan = {
            ...liveClan,
            ...membersField,
            memberStats,
            ...reservationFields,
        };
        const entry = clanDirectoryEntry(clan.id, linkedClan);
        const directory = putClanInDirectory(clanDirectory, entry);
        tx.set(clanRef, {
            ...membersField,
            memberStats,
            ...reservationFields,
            ...(useReservations
                ? { lastReservationRepairAt: fb.serverTimestamp() }
                : {}),
        }, { merge: true });
        if (useReservations) {
            tx.set(directoryRef, entry);
            tx.set(
                membershipRef,
                clanMembershipRecord(
                    clan.id,
                    member.role ?? "member",
                    [...clanMemberDeviceIds(linkedClan, uid), deviceId]
                )
            );
            tx.set(deviceRef, {
                clanId: clan.id,
                userId: uid,
                updatedAt: new Date().toISOString(),
            });
        } else {
            tx.set(
                directoryRef,
                { clans: putClanInDirectory(liveDirectory, entry) }
            );
        }
        result = { clan: linkedClan, directory, conflict: null };
    });
    if (!ran) return result;
    return result;
}


// Browse list is a point read of clans_directory/index (or a hard-capped
// query). Mutations update the index or their own shard in-transaction.

// zero-read patch of my own entry in the in-memory directory
export function patchMyClanInDirectory() {
    if (!myClan) return;
    clanDirectory = putClanInDirectory(
        clanDirectory,
        clanDirectoryEntry(myClan.id, myClan)
    );
    applyTitle(); // clan-lead flip
}


export async function refreshDirectoryThrottled(fb) {
    try {
        patchMyClanInDirectory();
        if (clanReservationsEnabled()) return;
        const now = Date.now();
        if (now - lastDirRefreshAt < DIR_REFRESH_THROTTLE_MS) return;
        lastDirRefreshAt = now;
        await refreshDirectory(fb);
    } catch (e) {
        dbg("refreshDirectoryThrottled threw: " + getErrMsg(e));
    }
}


export async function saveClanTagStyle(fb, clanId, newStyle) {
    return atlasSetDoc(
        fb,
        "clan tag style",
        fb.doc(fb.db, "clans", clanId),
        { tagStyle: newStyle },
        { merge: true }
    );
}



export function renderClanTagPanel() {
    const body = document.getElementById("rgClanTagBody");
    if (!body || !myClan) return;
    const isLeader = myClan.leaderId === myUserId();
    // roles with tagStyle perm see the full editor; others see preview + opt-in
    const canStyle = rolePerm(myClanRole(), "tagStyle");
    const st = myClan.tagStyle || {};
    const tagText = String(myClan.tag || "").trim();

    // working copy, live edits don't commit until Save
    const work = {
        mode: st.mode || (st.color ? "solid" : Array.isArray(st.stops) || st.paletteKey ? "gradient" : "none"),
        color: st.color || "#00bfff",
        gradientStart: st.gradientStart || "#00bfff",
        gradientEnd: st.gradientEnd || "#e94fff",
        paletteKey: st.paletteKey || null,   // null = custom start/end
        bracketColor: st.bracketColor || null, // null = brackets follow main style
        bold: !!st.bold,
        italic: !!st.italic,
        waveOn: !!st.waveOn,
        waveAmp: st.waveAmp ?? 8,
        rotateDeg: st.rotateDeg ?? 0,
    };

    function activeStops() {
        if (work.paletteKey) {
            const p = CLAN_TAG_PALETTES.find(x => x.key === work.paletteKey);
            if (p) return p.stops;
        }
        return [work.gradientStart, work.gradientEnd];
    }

    // when bracketColor is set, the gradient runs over just the letters
    // so the blend isn't broken by contrast-colored brackets
    function buildPreviewHtml() {
        if (!tagText) return '<span style="color:#888;font-style:italic;font-size:14px;">(clan has no tag set)</span>';
        const escCh = ch => ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch;
        const tagChars = [...tagText];
        const bracketColor = /^#[0-9a-fA-F]{6}$/.test(work.bracketColor || "") ? work.bracketColor : null;
        const stops = work.mode === "gradient" ? activeStops() : null;

        // wave alternates per char, static rotate is uniform
        const rotFor = wi => work.waveOn ? (wi % 2 === 0 ? work.waveAmp : -work.waveAmp)
            : (work.rotateDeg && !work.waveOn ? work.rotateDeg : 0);
        const spanFor = (ch, color, wi) => {
            const rot = rotFor(wi);
            const tf = rot ? "display:inline-block;transform:rotate(" + rot + "deg);" : "";
            const co = color ? "color:" + color + ";" : "";
            return '<span style="' + co + tf + '">' + escCh(ch) + '</span>';
        };

        // letter color at position i / tagChars.length
        const letterColor = (i) => {
            if (stops) {
                const giMax = bracketColor ? Math.max(0, tagChars.length - 1) : tagChars.length + 1;
                const gi = bracketColor ? i : i + 1;
                const t = giMax === 0 ? 0 : gi / giMax;
                return _sampleStops(stops, t);
            }
            if (work.mode === "solid") return work.color;
            return null;
        };
        // bracket color: bracketColor if set, else defer to mode
        const bracketC = bracketColor
            ? bracketColor
            : stops
                ? _sampleStops(stops, 0) // start of gradient for opening
                : work.mode === "solid" ? work.color : null;
        const bracketCEnd = bracketColor
            ? bracketColor
            : stops
                ? _sampleStops(stops, 1)
                : work.mode === "solid" ? work.color : null;

        let wi = 0;
        let content = spanFor("[", bracketC, wi++);
        for (let i = 0; i < tagChars.length; i++) {
            content += spanFor(tagChars[i], letterColor(i), wi++);
        }
        content += spanFor("]", bracketCEnd, wi++);

        const wrapStyle = "font-size:22px;font-weight:" + (work.bold ? "700" : "400") + ";font-style:" + (work.italic ? "italic" : "normal") + ";";
        return '<span style="' + wrapStyle + '">' + content + '</span>';
    }

    function updatePreview() {
        const el = document.getElementById("rgTagPreviewInner");
        if (el) el.innerHTML = buildPreviewHtml();
    }

    // ---- Build panel HTML ----
    let html = '';

    // big preview box (Forge style)
    html += '<div style="background:radial-gradient(120% 140% at 50% 0%, #101a3a 0%, #070a16 70%);border:1px solid #00bfff44;border-radius:10px;padding:16px;text-align:center;min-height:60px;display:flex;align-items:center;justify-content:center;margin-bottom:10px;">'
        + '<span id="rgTagPreviewInner">' + buildPreviewHtml() + '</span></div>';

    if (canStyle && tagText) {
        // mode selector
        html += '<div style="font-size:10px;font-weight:bold;color:#00bfff;margin:6px 0 4px;">STYLE MODE</div>';
        html += '<div style="display:flex;gap:4px;">';
        for (const m of ["none","solid","gradient"]) {
            const active = work.mode === m;
            html += '<button class="rgBtn rgTagMode" data-mode="' + m + '" style="flex:1;padding:5px;font-size:11px;'
                + (active ? 'background:#00bfff33;border:1px solid #00bfff;color:#00bfff;' : '') + '">'
                + m.charAt(0).toUpperCase() + m.slice(1) + '</button>';
        }
        html += '</div>';

        // solid color row
        html += '<div id="rgTagSolidRow" style="margin-top:8px;display:' + (work.mode === "solid" ? "flex" : "none") + ';gap:8px;align-items:center;font-size:11px;">'
            + 'Color: <input type="color" id="rgTagColor" value="' + work.color + '" style="width:40px;height:24px;padding:0;border:none;background:transparent;cursor:pointer;">'
            + '<span id="rgTagColorHex" style="opacity:.7;font-family:monospace;">' + work.color + '</span>'
            + '</div>';

        // gradient section: palettes + custom endpoints + preview bar
        html += '<div id="rgTagGradientRow" style="margin-top:8px;display:' + (work.mode === "gradient" ? "block" : "none") + ';font-size:11px;">';
        html += '<div style="opacity:.7;margin-bottom:4px;">Palettes</div>';
        html += '<div style="display:flex;flex-wrap:wrap;gap:4px;">';
        for (const p of CLAN_TAG_PALETTES) {
            const active = work.paletteKey === p.key;
            html += '<button class="rgBtn rgTagPalette" data-key="' + p.key + '" style="padding:3px 8px;font-size:11px;'
                + (active ? 'background:#00bfff33;border:1px solid #00bfff;' : '') + '">'
                + p.label + '</button>';
        }
        html += '<button class="rgBtn rgTagPalette" data-key="__custom" style="padding:3px 8px;font-size:11px;'
            + (!work.paletteKey ? 'background:#00bfff33;border:1px solid #00bfff;' : '') + '">Custom</button>';
        html += '</div>';
        html += '<div id="rgTagCustomRow" style="margin-top:6px;display:' + (work.paletteKey ? "none" : "flex") + ';gap:8px;align-items:center;flex-wrap:wrap;">'
            + 'Start: <input type="color" id="rgTagGradStart" value="' + work.gradientStart + '" style="width:40px;height:24px;padding:0;border:none;background:transparent;cursor:pointer;">'
            + '&rarr; End: <input type="color" id="rgTagGradEnd" value="' + work.gradientEnd + '" style="width:40px;height:24px;padding:0;border:none;background:transparent;cursor:pointer;">'
            + '</div>';
        const barStops = activeStops();
        html += '<div id="rgTagGradientBar" style="margin-top:6px;height:6px;border-radius:3px;background:linear-gradient(90deg, ' + barStops.join(", ") + ');"></div>';
        html += '</div>';

        // bold + italic
        html += '<div style="margin-top:10px;display:flex;gap:16px;font-size:11px;">'
            + '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;"><input type="checkbox" id="rgTagBold"' + (work.bold ? " checked" : "") + '> <b>Bold</b></label>'
            + '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;"><input type="checkbox" id="rgTagItalic"' + (work.italic ? " checked" : "") + '> <i>Italic</i></label>'
            + '</div>';

        // cleared bracket color -> brackets follow the main style
        html += '<div style="font-size:10px;font-weight:bold;color:#00bfff;margin:10px 0 4px;">BRACKETS</div>';
        html += '<div style="display:flex;gap:8px;align-items:center;font-size:11px;">'
            + 'Color: <input type="color" id="rgTagBracketColor" value="' + (work.bracketColor || "#ffffff") + '" style="width:40px;height:24px;padding:0;border:none;background:transparent;cursor:pointer;">'
            + '<button id="rgTagBracketMatch" class="rgBtn" style="padding:3px 8px;font-size:10px;'
            + (!work.bracketColor ? 'background:#00bfff33;border:1px solid #00bfff;' : '') + '">Match tag</button>'
            + '<span style="opacity:.6;font-size:10px;">' + (work.bracketColor ? work.bracketColor : "matches") + '</span>'
            + '</div>';

        // wave overrides static rotate
        html += '<div style="font-size:10px;font-weight:bold;color:#00bfff;margin:10px 0 4px;">EFFECTS</div>';
        html += '<label style="display:flex;align-items:center;gap:5px;font-size:11px;cursor:pointer;">'
            + '<input type="checkbox" id="rgTagWave"' + (work.waveOn ? " checked" : "") + '> Wave'
            + ' <span style="opacity:.6;margin-left:4px;">(alternates ±<span id="rgTagWaveAmpLbl">' + work.waveAmp + '</span>°)</span>'
            + '</label>';
        html += '<div id="rgTagWaveRow" style="margin-top:4px;display:' + (work.waveOn ? "flex" : "none") + ';gap:8px;align-items:center;font-size:11px;">'
            + 'Amp: <input type="range" id="rgTagWaveAmp" min="0" max="30" value="' + work.waveAmp + '" style="flex:1;">'
            + '</div>';
        html += '<div id="rgTagRotateRow" style="margin-top:6px;display:' + (work.waveOn ? "none" : "flex") + ';gap:8px;align-items:center;font-size:11px;">'
            + 'Rotate: <input type="range" id="rgTagRotate" min="-45" max="45" value="' + work.rotateDeg + '" style="flex:1;">'
            + '<span id="rgTagRotateLbl" style="width:32px;opacity:.7;">' + work.rotateDeg + '°</span>'
            + '</div>';

        html += '<button id="rgTagSave" class="rgBtn" style="width:100%;margin-top:10px;">Save Tag Style</button>';
    } else if (!canStyle && !tagText) {
        html += '<div style="font-size:11px;color:#888;text-align:center;margin-top:4px;">Leader hasn\'t set a tag yet.</div>';
    }

    // opt-in (all members)
    if (tagText) {
        html += '<hr style="border:none;border-top:1px solid #00bfff22;margin:10px 0 8px;">';
        html += '<label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;">'
            + '<input type="checkbox" id="rgUseTag"' + (useClanTagPref() ? " checked" : "") + '>'
            + ' Prepend clan tag to my in-game name</label>';
        html += '<div style="display:flex;align-items:center;gap:6px;font-size:11px;margin-top:6px;padding-left:20px;opacity:.85;">'
            + '<span>Position:</span>'
            + '<label style="display:flex;align-items:center;gap:3px;cursor:pointer;">'
            + '<input type="radio" name="rgTagPos" id="rgTagPosName" value="name"' + (clanTagPositionPref() === "name" ? " checked" : "") + '>'
            + ' Before name</label>'
            + '<label style="display:flex;align-items:center;gap:3px;cursor:pointer;">'
            + '<input type="radio" name="rgTagPos" id="rgTagPosTitle" value="title"' + (clanTagPositionPref() === "title" ? " checked" : "") + '>'
            + ' Before title</label>'
            + '</div>';
    }

    body.innerHTML = html;

    // ---- Wire live-update handlers ----
    if (canStyle && tagText) {
        // mode buttons
        for (const btn of document.querySelectorAll(".rgTagMode")) {
            btn.onclick = () => {
                work.mode = btn.getAttribute("data-mode");
                document.getElementById("rgTagSolidRow").style.display = work.mode === "solid" ? "flex" : "none";
                document.getElementById("rgTagGradientRow").style.display = work.mode === "gradient" ? "block" : "none";
                document.querySelectorAll(".rgTagMode").forEach(b => {
                    const active = b === btn;
                    b.style.background = active ? "#00bfff33" : "";
                    b.style.border = active ? "1px solid #00bfff" : "";
                    b.style.color = active ? "#00bfff" : "";
                });
                updatePreview();
            };
        }
        // palette chips. "Custom" returns to user start/end
        for (const btn of document.querySelectorAll(".rgTagPalette")) {
            btn.onclick = () => {
                const key = btn.getAttribute("data-key");
                work.paletteKey = key === "__custom" ? null : key;
                document.querySelectorAll(".rgTagPalette").forEach(b => {
                    const active = (b.getAttribute("data-key") === (work.paletteKey || "__custom"));
                    b.style.background = active ? "#00bfff33" : "";
                    b.style.border = active ? "1px solid #00bfff" : "";
                });
                document.getElementById("rgTagCustomRow").style.display = work.paletteKey ? "none" : "flex";
                const bar = document.getElementById("rgTagGradientBar");
                if (bar) bar.style.background = "linear-gradient(90deg, " + activeStops().join(", ") + ")";
                updatePreview();
            };
        }
        const wireInput = (id, key, extra) => {
            const el = document.getElementById(id);
            if (el) el.oninput = () => { work[key] = el.value; if (extra) extra(); updatePreview(); };
        };
        wireInput("rgTagColor", "color", () => {
            const hex = document.getElementById("rgTagColorHex");
            if (hex) hex.textContent = work.color;
        });
        const refreshBar = () => {
            const bar = document.getElementById("rgTagGradientBar");
            if (bar) bar.style.background = "linear-gradient(90deg, " + activeStops().join(", ") + ")";
        };
        wireInput("rgTagGradStart", "gradientStart", refreshBar);
        wireInput("rgTagGradEnd", "gradientEnd", refreshBar);
        const wireCheck = (id, key) => {
            const el = document.getElementById(id);
            if (el) el.onchange = () => { work[key] = el.checked; updatePreview(); };
        };
        wireCheck("rgTagBold", "bold");
        wireCheck("rgTagItalic", "italic");

        // "Match tag" clears bracket color so brackets rejoin main style
        const bracketColorEl = document.getElementById("rgTagBracketColor");
        const bracketMatchBtn = document.getElementById("rgTagBracketMatch");
        const bracketHexLbl = () => bracketMatchBtn && bracketMatchBtn.nextElementSibling;
        if (bracketColorEl) bracketColorEl.oninput = () => {
            work.bracketColor = bracketColorEl.value;
            if (bracketMatchBtn) {
                bracketMatchBtn.style.background = "";
                bracketMatchBtn.style.border = "";
            }
            const lbl = bracketHexLbl();
            if (lbl) lbl.textContent = work.bracketColor;
            updatePreview();
        };
        if (bracketMatchBtn) bracketMatchBtn.onclick = () => {
            work.bracketColor = null;
            bracketMatchBtn.style.background = "#00bfff33";
            bracketMatchBtn.style.border = "1px solid #00bfff";
            const lbl = bracketHexLbl();
            if (lbl) lbl.textContent = "matches";
            updatePreview();
        };
        const waveEl = document.getElementById("rgTagWave");
        if (waveEl) waveEl.onchange = () => {
            work.waveOn = waveEl.checked;
            document.getElementById("rgTagWaveRow").style.display = work.waveOn ? "flex" : "none";
            document.getElementById("rgTagRotateRow").style.display = work.waveOn ? "none" : "flex";
            updatePreview();
        };
        const waveAmpEl = document.getElementById("rgTagWaveAmp");
        if (waveAmpEl) waveAmpEl.oninput = () => {
            work.waveAmp = Number(waveAmpEl.value);
            const lbl = document.getElementById("rgTagWaveAmpLbl");
            if (lbl) lbl.textContent = work.waveAmp;
            updatePreview();
        };
        const rotEl = document.getElementById("rgTagRotate");
        if (rotEl) rotEl.oninput = () => {
            work.rotateDeg = Number(rotEl.value);
            const lbl = document.getElementById("rgTagRotateLbl");
            if (lbl) lbl.textContent = work.rotateDeg + "°";
            updatePreview();
        };

        document.getElementById("rgTagSave").onclick = async () => {
            const newStyle = {
                mode: work.mode,
                color: work.color,
                gradientStart: work.gradientStart,
                gradientEnd: work.gradientEnd,
                paletteKey: work.paletteKey,
                bracketColor: work.bracketColor,
                bold: work.bold,
                italic: work.italic,
                waveOn: work.waveOn,
                waveAmp: work.waveAmp,
                rotateDeg: work.rotateDeg,
            };
            try {
                const fb = await initFirebase();
                if (!fb) return;
                if (!(await saveClanTagStyle(fb, myClan.id, newStyle))) return;
                myClan.tagStyle = newStyle;
                // inline confirm, toast is easy to miss when scrolled deep
                const saveBtn = document.getElementById("rgTagSave");
                if (saveBtn) {
                    saveBtn.textContent = "✓ Saved for the clan!";
                    saveBtn.style.borderColor = "#00ff88";
                    saveBtn.style.color = "#00ff88";
                    setTimeout(() => {
                        saveBtn.textContent = "Save Tag Style";
                        saveBtn.style.borderColor = "";
                        saveBtn.style.color = "";
                    }, 1800);
                }
                showToast("Saved! Open 🎨 Forge and hit Apply to refresh YOUR name -- members do the same on theirs.");
            } catch (e) {
                dbg("save tag style threw: " + getErrMsg(e));
                console.error("[RG HUD] Save tag style failed:", e);
                showToast("Save failed.");
            }
        };
    }

    // opt-in handler
    const useTagCb = document.getElementById("rgUseTag");
    if (useTagCb) {
        useTagCb.onchange = () => {
            setUseClanTagPref(useTagCb.checked);
            // prefix only reaches the in-game name after Apply in Name Forge
            showToast(useTagCb.checked
                ? "Tag armed! Open 🎨 Name Forge and hit Apply to update your name."
                : "Tag prefix off -- hit Apply in 🎨 Name Forge to update your name.");
            if (typeof RGNF !== "undefined" && RGNF.refresh) RGNF.refresh();
        };
    }
    // position radio handlers
    for (const id of ["rgTagPosName", "rgTagPosTitle"]) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.onchange = () => {
            if (!el.checked) return;
            setClanTagPositionPref(el.value);
            if (typeof RGNF !== "undefined" && RGNF.refresh) RGNF.refresh();
        };
    }
}


export async function refreshDirectory(fb) {
    try {
        if (firestoreReadBudgetPassed()) {
            dbg("refreshDirectory skipped: read budget passed");
        } else {
            clanDirectory = await loadClanDirectoryLite(
                fb,
                myClan?.id || null
            );
        }
    } catch (e) {
        dbg("refreshDirectory failed: " + getErrMsg(e));
        console.warn("[RG HUD] Directory refresh failed:", e);
    }
    // repaint title in case standings flipped clan-lead status
    applyTitle();
}


export async function createClan(name, tag) {
    const fb = await initFirebase();
    if (!fb) return;
    const uid = myUserId();
    if (!uid) return;

    if (!eventPerm("allowClanCreate")) {
        showToast("New clans can\'t be created during this event.");
        return;
    }

    try {
        const initialMMR = myRankedMMR();
        const syncedAt = Date.now();
        const createdAt = new Date().toISOString();
        const deviceId = getDeviceId();
        const useReservations = clanReservationsEnabled();
        const nameKey = useReservations
            ? await clanNameReservationId(name)
            : null;
        const tagKey = useReservations ? sanitizeClanTag(tag) : null;
        const leaderMember = {
            userId: uid,
            name: myName(),
            role: "leader",
            mmr: initialMMR,
            syncedAt,
            deviceId,
            ...(useReservations ? { deviceIds: [deviceId] } : {}),
        };
        const clan = {
            name,
            tag: tag || "",
            tagStyle: null,
            leaderId: uid,
            members: useReservations
                ? { [uid]: leaderMember }
                : [leaderMember],
            memberStats: { [uid]: { mmr: initialMMR, syncedAt, deviceIds: [deviceId] } },
            joinRequests: [],
            totalMMR: initialMMR,
            createdAt,
            scriptVersion: SCRIPT_VERSION,
            versionNum: SCRIPT_VERSION_NUM,
            ...(useReservations ? {
                nameKey,
                tagKey,
                normalizedName: normalizeClanName(name),
                lockVersion: 1,
                deviceId,
                memberIds: [uid],
                deviceIds: [deviceId],
            } : {}),
        };
        const clanRef = fb.doc(fb.collection(fb.db, "clans"));
        const directoryRef = clanDirectoryDocRef(fb, clanRef.id);
        const nameRef = useReservations
            ? fb.doc(fb.db, "clan_name_keys", nameKey)
            : null;
        const tagRef = useReservations
            ? fb.doc(fb.db, "clan_tag_keys", tagKey)
            : null;
        const membershipRef = useReservations
            ? fb.doc(fb.db, "clan_memberships", uid)
            : null;
        const deviceRef = useReservations
            ? fb.doc(fb.db, "clan_devices", deviceId)
            : null;
        let outcome = "created";
        let existingMembership = null;
        let committedDirectory = null;

        // Save both together so double-clicks can't create extra clans.
        const ran = await runAtlasTransaction(fb, "create clan", async tx => {
            outcome = "created";
            existingMembership = null;
            committedDirectory = null;
            const directorySnap = !useReservations
                ? await tx.get(directoryRef)
                : null;
            const membershipSnap = useReservations
                ? await tx.get(membershipRef)
                : null;
            const deviceSnap = useReservations
                ? await tx.get(deviceRef)
                : null;
            const nameSnap = useReservations
                ? await tx.get(nameRef)
                : null;
            const tagSnap = useReservations
                ? await tx.get(tagRef)
                : null;
            const liveDirectory = directorySnap?.exists()
                ? (directorySnap.data().clans ?? [])
                : [];
            existingMembership = useReservations
                ? null
                : findDirectoryMembership(
                    liveDirectory,
                    { userId: uid, deviceId }
                );
            const lockedClanId = membershipSnap?.exists()
                ? membershipSnap.data().clanId
                : (deviceSnap?.exists() ? deviceSnap.data().clanId : null);
            if (!existingMembership && lockedClanId) {
                const locked = clanDirectory.find(
                    entry => entry?.id === lockedClanId
                );
                existingMembership = {
                    ...(locked ?? { id: lockedClanId, name: "another clan", tag: "" }),
                    membershipMatch: membershipSnap?.exists() ? "player" : "device",
                };
            }
            if (existingMembership) {
                outcome = "already-in-clan";
                return;
            }
            if (nameSnap?.exists()) {
                outcome = "name-taken";
                return;
            }
            if (tagSnap?.exists()) {
                outcome = "tag-taken";
                return;
            }
            const normalizedName = normalizeClanName(name);
            const normalizedTag = sanitizeClanTag(tag);
            if (!useReservations && liveDirectory.some(entry =>
                normalizeClanName(entry?.name) === normalizedName
            )) {
                outcome = "name-taken";
                return;
            }
            if (!useReservations && normalizedTag && liveDirectory.some(entry =>
                sanitizeClanTag(entry?.tag) === normalizedTag
            )) {
                outcome = "tag-taken";
                return;
            }
            const entry = clanDirectoryEntry(clanRef.id, clan);
            committedDirectory = putClanInDirectory(
                useReservations ? clanDirectory : liveDirectory,
                entry
            );
            tx.set(clanRef, clan);
            if (useReservations) {
                tx.set(directoryRef, entry);
                tx.set(nameRef, {
                    clanId: clanRef.id,
                    name,
                    normalizedName: normalizeClanName(name),
                });
                tx.set(tagRef, {
                    clanId: clanRef.id,
                    tag: sanitizeClanTag(tag),
                });
                tx.set(
                    membershipRef,
                    clanMembershipRecord(clanRef.id, "leader", [deviceId])
                );
                tx.set(deviceRef, {
                    clanId: clanRef.id,
                    userId: uid,
                    updatedAt: new Date().toISOString(),
                });
            } else {
                tx.set(directoryRef, { clans: committedDirectory });
            }
        });
        if (!ran) return;

        if (outcome === "already-in-clan") {
            await showDialog({
                message: clanMembershipMessage(myName(), existingMembership, true),
                okLabel: "OK",
                cancelLabel: "Close",
            });
            await loadClanData(true);
            renderClanView();
            return;
        }
        if (outcome === "name-taken") {
            showToast("A clan with that name already exists.");
            return;
        }
        if (outcome === "tag-taken") {
            showToast("That clan tag is already taken.");
            return;
        }

        dbg(`Clan created: name="${name}" tag="${tag || ""}" id=${clanRef.id}`);
        myClan = { id: clanRef.id, ...clan };
        clanDirectory = committedDirectory ?? clanDirectory;
        renderClanView();
    } catch (e) {
        pushError(e, "createClan");
        console.error("[RG HUD] Create clan failed:", e);
        showToast("Couldn't create clan (see console).");
    }
}


export async function requestJoin(clanId) {
    const fb = await initFirebase();
    if (!fb) return;
    const uid = myUserId();
    if (!uid) return;

    if (!eventPerm("allowJoin")) {
        showToast("Clan joins are locked during this event.");
        return;
    }

    try {
        const clanRef = fb.doc(fb.db, "clans", clanId);
        const requestName = myName();
        const deviceId = getDeviceId();
        const useReservations = clanReservationsEnabled();
        const directoryRef = !useReservations
            ? fb.doc(fb.db, "clans_directory", "index")
            : null;
        const membershipRef = useReservations
            ? fb.doc(fb.db, "clan_memberships", uid)
            : null;
        const deviceRef = useReservations
            ? fb.doc(fb.db, "clan_devices", deviceId)
            : null;
        let outcome = "sent";
        let existingMembership = null;
        const ran = await runAtlasTransaction(fb, "request clan join", async tx => {
            outcome = "sent";
            existingMembership = null;
            const directorySnap = !useReservations
                ? await tx.get(directoryRef)
                : null;
            const clanSnap = await tx.get(clanRef);
            const membershipSnap = useReservations
                ? await tx.get(membershipRef)
                : null;
            const deviceSnap = useReservations
                ? await tx.get(deviceRef)
                : null;
            if (!clanSnap.exists()) {
                outcome = "missing";
                return;
            }
            const clan = clanSnap.data();
            if (clanMembers(clan).some(m => m.userId === uid)) {
                outcome = "member";
                return;
            }
            const liveDirectory = directorySnap?.exists()
                ? (directorySnap.data().clans ?? [])
                : [];
            existingMembership = useReservations
                ? null
                : findDirectoryMembership(
                    liveDirectory,
                    { userId: uid, deviceId }
                );
            const lockedClanId = membershipSnap?.exists()
                ? membershipSnap.data().clanId
                : (deviceSnap?.exists() ? deviceSnap.data().clanId : null);
            if (!existingMembership && lockedClanId) {
                const locked = clanDirectory.find(
                    entry => entry?.id === lockedClanId
                );
                existingMembership = {
                    ...(locked ?? { id: lockedClanId, name: "another clan", tag: "" }),
                    membershipMatch: membershipSnap?.exists() ? "player" : "device",
                };
            }
            if (existingMembership) {
                outcome = "already-in-clan";
                return;
            }
            if (clanMembers(clan).length >= clanMaxMembers()) {
                outcome = "full";
                return;
            }
            const currentRequests = clan.joinRequests ?? [];
            const pendingIndex = currentRequests.findIndex(r => r.userId === uid);
            if (pendingIndex >= 0) {
                if (currentRequests[pendingIndex].deviceId !== deviceId) {
                    const joinRequests = currentRequests.map((request, index) =>
                        index === pendingIndex
                            ? { ...request, name: requestName, deviceId }
                            : request
                    );
                    tx.set(clanRef, { joinRequests }, { merge: true });
                }
                outcome = "pending";
                return;
            }
            outcome = "sent";
            const joinRequests = [
                ...currentRequests,
                { userId: uid, name: requestName, deviceId },
            ];
            tx.set(clanRef, { joinRequests }, { merge: true });
        });
        if (!ran) return;
        if (outcome === "missing") {
            showToast("That clan no longer exists.");
            return;
        }
        if (outcome === "member") {
            await loadClanData(true);
            showToast("You're already in this clan.");
            renderClanView();
            return;
        }
        if (outcome === "already-in-clan") {
            await showDialog({
                message: clanMembershipMessage(requestName, existingMembership, true),
                okLabel: "OK",
                cancelLabel: "Close",
            });
            await loadClanData(true);
            renderClanView();
            return;
        }
        if (outcome === "full") {
            showToast("That clan is full.");
            return;
        }
        if (outcome === "pending") {
            showToast("You already requested to join.");
            return;
        }
        dbg(`Join request sent to clan ${clanId}`);
        showToast("Join request sent!");
        renderClanView();
    } catch (e) {
        pushError(e, "requestJoin");
        console.error("[RG HUD] Request join failed:", e);
        showToast("Couldn't send join request — see console.");
    }
}


export async function approveRequest(userId, approve) {
    const fb = await initFirebase();
    if (!fb || !myClan) return;

    // denies are always allowed, they don't grow the roster
    if (approve && !eventPerm("allowApprove")) {
        showToast("Approvals are locked during this event.");
        return;
    }
    if (approve && !rolePerm(myClanRole(), "approve")) {
        showToast("Your role can't approve join requests.");
        return;
    }

    try {
        const clanId = myClan.id;
        const clanRef = fb.doc(fb.db, "clans", clanId);
        const useReservations = clanReservationsEnabled();
        const directoryRef = clanDirectoryDocRef(fb, clanId);
        const membershipRef = useReservations
            ? fb.doc(fb.db, "clan_memberships", userId)
            : null;
        const actorUid = myUserId();
        let committedClan = null;
        let committedDirectory = null;
        let existingMembership = null;
        let requestDisplayName = "This player";
        let outcome = approve ? "approved" : "denied";
        const ran = await runAtlasTransaction(fb, "handle clan request", async tx => {
            committedClan = null;
            committedDirectory = null;
            existingMembership = null;
            const directorySnap = approve && !useReservations
                ? await tx.get(directoryRef)
                : null;
            const clanSnap = await tx.get(clanRef);
            if (!clanSnap.exists()) {
                outcome = "missing";
                return;
            }
            const liveClan = clanSnap.data();
            const liveMembers = clanMembers(liveClan);
            const actor = liveMembers.find(m => m.userId === actorUid);
            if (approve && (!actor || !rolePerm(actor.role, "approve"))) {
                outcome = "forbidden";
                return;
            }
            const req = (liveClan.joinRequests ?? []).find(r => r.userId === userId);
            if (!req) {
                outcome = "handled";
                return;
            }
            requestDisplayName = req.name || "This player";
            const deviceRef = useReservations && req.deviceId
                ? fb.doc(fb.db, "clan_devices", req.deviceId)
                : null;
            const membershipSnap = approve && useReservations
                ? await tx.get(membershipRef)
                : null;
            const deviceSnap = approve && deviceRef
                ? await tx.get(deviceRef)
                : null;
            const liveDirectory = directorySnap?.exists()
                ? (directorySnap.data().clans ?? [])
                : [];
            if (approve) {
                existingMembership = useReservations
                    ? null
                    : findDirectoryMembership(
                        liveDirectory,
                        { userId, deviceId: req.deviceId }
                    );
                const lockedClanId = membershipSnap?.exists()
                    ? membershipSnap.data().clanId
                    : (deviceSnap?.exists() ? deviceSnap.data().clanId : null);
                if (!existingMembership && lockedClanId) {
                    const locked = clanDirectory.find(
                        entry => entry?.id === lockedClanId
                    );
                    existingMembership = {
                        ...(locked ?? { id: lockedClanId, name: "another clan", tag: "" }),
                        membershipMatch: membershipSnap?.exists() ? "player" : "device",
                    };
                }
                if (existingMembership) {
                    outcome = "already-in-clan";
                    return;
                }
            }
            if (approve && liveMembers.length >= clanMaxMembers()) {
                outcome = "full";
                return;
            }
            const joinRequests = (liveClan.joinRequests ?? []).filter(r => r.userId !== userId);
            let members = liveMembers;
            if (approve && !members.some(m => m.userId === userId)) {
                members = [
                    ...members,
                    {
                        userId: req.userId,
                        name: req.name,
                        role: "member",
                        ...(req.deviceId ? { deviceId: req.deviceId } : {}),
                    },
                ];
            }
            let memberStats = liveClan.memberStats;
            if (approve && req.deviceId) {
                const existingStats = liveClan.memberStats?.[userId] ?? {};
                const deviceIds = [...new Set([
                    ...(Array.isArray(existingStats.deviceIds) ? existingStats.deviceIds : []),
                    req.deviceId,
                ])];
                memberStats = {
                    ...(liveClan.memberStats ?? {}),
                    [userId]: { ...existingStats, deviceIds },
                };
            }
            const nextClan = {
                ...liveClan,
                id: clanId,
                joinRequests,
                members,
                ...(memberStats ? { memberStats } : {}),
            };
            const reservationFields = approve && useReservations
                ? {
                    memberIds: members.map(member => member.userId),
                    deviceIds: clanDeviceIds(nextClan),
                }
                : {};
            const membersField = clanMembersField(liveClan, members);
            tx.set(clanRef, {
                joinRequests,
                ...membersField,
                ...(memberStats ? { memberStats } : {}),
                ...reservationFields,
            }, { merge: true });
            committedClan = {
                ...nextClan,
                ...membersField,
                ...reservationFields,
            };
            if (approve) {
                const entry = clanDirectoryEntry(clanId, committedClan);
                committedDirectory = putClanInDirectory(
                    useReservations ? clanDirectory : liveDirectory,
                    entry
                );
                if (useReservations) {
                    tx.set(directoryRef, entry);
                    const deviceIds = req.deviceId ? [req.deviceId] : [];
                    tx.set(
                        membershipRef,
                        clanMembershipRecord(clanId, "member", deviceIds)
                    );
                    if (deviceRef) {
                        tx.set(deviceRef, {
                            clanId,
                            userId,
                            updatedAt: new Date().toISOString(),
                        });
                    }
                } else {
                    tx.set(directoryRef, { clans: committedDirectory });
                }
            }
            outcome = approve ? "approved" : "denied";
        });
        if (!ran) return;
        if (!committedClan) {
            if (outcome === "missing") showToast("That clan no longer exists.");
            else if (outcome === "forbidden") showToast("Your current role can't approve join requests.");
            else if (outcome === "full") showToast("That clan is full.");
            else if (outcome === "already-in-clan") {
                await showDialog({
                    message: clanMembershipMessage(requestDisplayName, existingMembership),
                    okLabel: "OK",
                    cancelLabel: "Close",
                });
            }
            else showToast("That request was already handled.");
            await loadClanData(true);
            renderClanView();
            return;
        }

        dbg(`Join request ${approve ? "approved" : "denied"} for ${userId}`);
        myClan = sanitizeClanDoc(committedClan);
        if (committedDirectory) clanDirectory = committedDirectory;
        renderClanView();
    } catch (e) {
        pushError(e, "approveRequest");
        console.error("[RG HUD] Approve request failed:", e);
        showToast(approve ? "Couldn't approve — see console." : "Couldn't deny — see console.");
    }
}


export async function writeClanNotice(fb, userId, notice) {
    if (!firebaseAuthUid) {
        dbg("writeClanNotice skipped: firebaseAuthUid not ready");
        return false;
    }
    const sourceUserId = firebaseAuthUid;
    const rgPlayerId = myUserId();
    const clanId = String(notice?.clanId || myClan?.id || "").trim();
    const payload = {
        ...notice,
        sourceUserId,
        rgPlayerId,
        deviceId: getDeviceId(),
        scriptVersion: SCRIPT_VERSION,
        versionNum: SCRIPT_VERSION_NUM,
    };
    if (clanId) payload.clanId = clanId;
    return atlasSetDoc(
        fb,
        "clan notice",
        fb.doc(fb.db, "clan_notices", userId),
        payload
    );
}


export async function kickMember(userId, message) {
    const fb = await initFirebase();
    if (!fb || !myClan) return;
    const myUid = myUserId();

    if (!eventPerm("allowKick")) {
        showToast("Kicking is locked during this event.");
        return;
    }

    try {
        const clanId = myClan.id;
        const clanRef = fb.doc(fb.db, "clans", clanId);
        const useReservations = clanReservationsEnabled();
        const directoryRef = clanDirectoryDocRef(fb, clanId);
        const membershipRef = useReservations
            ? fb.doc(fb.db, "clan_memberships", userId)
            : null;
        let outcome = "kicked";
        let committedClan = null;
        let committedDirectory = null;
        const ran = await runAtlasTransaction(fb, "kick clan member", async tx => {
            outcome = "kicked";
            committedClan = null;
            committedDirectory = null;
            const directorySnap = !useReservations
                ? await tx.get(directoryRef)
                : null;
            const clanSnap = await tx.get(clanRef);
            if (!clanSnap.exists()) {
                outcome = "missing";
                return;
            }
            const liveClan = clanSnap.data();
            const target = clanMembers(liveClan).find(m => m.userId === userId);
            const actor = clanMembers(liveClan).find(m => m.userId === myUid);
            if (!target) {
                outcome = "handled";
                return;
            }
            if (target.role === "leader" || !actor || !rolePerm(actor.role, "kick")
                || (ROLE_RANK[target.role] ?? 0) >= (ROLE_RANK[actor.role] ?? 0)) {
                outcome = "forbidden";
                return;
            }
            const members = clanMembers(liveClan).filter(m => m.userId !== userId);
            const deviceIds = clanMemberDeviceIds(liveClan, userId);
            const reservationFields = useReservations
                ? {
                    memberIds: members.map(member => member.userId),
                    deviceIds: clanDeviceIds({ ...liveClan, members }),
                }
                : {};
            const membersField = clanMembersField(liveClan, members);
            committedClan = {
                ...liveClan,
                id: clanId,
                ...membersField,
                ...reservationFields,
            };
            const entry = clanDirectoryEntry(clanId, committedClan);
            committedDirectory = putClanInDirectory(
                useReservations
                    ? clanDirectory
                    : (directorySnap?.exists()
                        ? (directorySnap.data().clans ?? [])
                        : []),
                entry
            );
            tx.set(clanRef, {
                ...membersField,
                ...reservationFields,
            }, { merge: true });
            if (useReservations) {
                tx.set(directoryRef, entry);
                tx.delete(membershipRef);
                for (const deviceId of deviceIds) {
                    tx.delete(fb.doc(fb.db, "clan_devices", deviceId));
                }
            } else {
                tx.set(directoryRef, { clans: committedDirectory });
            }
        });
        if (!ran) return;
        if (!committedClan) {
            if (outcome === "missing") showToast("That clan no longer exists.");
            else if (outcome === "handled") showToast("That player is no longer in the clan.");
            else showToast("You can't remove that player.");
            await loadClanData(true);
            renderClanView();
            return;
        }
        dbg(`Clan kick: ${userId} removed, msgLen=${(message ?? "").length}`);
        myClan = sanitizeClanDoc(committedClan);
        clanDirectory = committedDirectory;

        // one-time notice picked up + cleared by the kicked player's HUD
        const notice = {
            type: "kicked",
            clanName: myClan.name,
            message: (message ?? "").slice(0, 200),
            at: new Date().toISOString(),
        };
        await writeClanNotice(fb, userId, notice);

        renderClanView();
    } catch (e) {
        pushError(e, "kickMember");
        console.error("[RG HUD] Kick failed:", e);
        showToast("Couldn't kick member (see console).");
    }
}

export function scheduleClanNoticeCheck(delayMs = 0) {
    if (clanNoticeTimer) clearTimeout(clanNoticeTimer);
    clanNoticeTimer = setTimeout(() => {
        clanNoticeTimer = null;
        checkClanNotices();
    }, delayMs);
}


// Show a clan notice once, then clear it.
export async function checkClanNotices() {
    const fb = await initFirebase();
    if (!fb) return;
    const uid = myUserId();
    if (!uid) return;
    try {
        const ref = fb.doc(fb.db, "clan_notices", uid);
        const snap = await fb.getDoc(ref);
        if (snap.exists()) {
            const n = snap.data();
            let handled = false;
            if (n.type === "kicked") {
                const extra = n.message ? `  Message: "${n.message}"` : "";
                await showDialog({
                    message: `You were removed from clan "${n.clanName}".${extra}`,
                    okLabel: "OK",
                    cancelLabel: "Dismiss",
                });
                handled = true;
            } else if (n.type === "admin_disbanded") {
                const extra = n.message ? `  Message: "${n.message}"` : "";
                await showDialog({
                    message: `An ATLAS admin disbanded clan "${n.clanName}".${extra}`,
                    okLabel: "OK",
                    cancelLabel: "Close",
                });
                handled = true;
            }
            if (handled) {
                await atlasDeleteDoc(fb, "acknowledge clan notice", ref);
            }
            else dbgWarn(`Unknown clan notice type kept for later: ${String(n.type || "missing")}`);
        }
    } catch (e) {
        // notices are best-effort, don't spam the user
        dbg("checkClanNotices failed (non-fatal): " + getErrMsg(e));
    }
}


export async function setMemberRole(userId, newRole) {
    const fb = await initFirebase();
    if (!fb || !myClan) return;
    const myUid = myUserId();
    const me = clanMembers(myClan).find(m => m.userId === myUid);
    const target = clanMembers(myClan).find(m => m.userId === userId);
    if (!me || !target) return;

    // frozen by default during events, role changes muddy the contribution audit
    if (!eventPerm("allowRoleChange")) {
        showToast("Role changes are locked during this event.");
        return;
    }

    if (!canSetRole(me.role, target.role, newRole)) {
        showToast("You can't change that member's role.");
        return;
    }

    try {
        const clanId = myClan.id;
        const clanRef = fb.doc(fb.db, "clans", clanId);
        const useReservations = clanReservationsEnabled();
        const membershipRef = useReservations
            ? fb.doc(fb.db, "clan_memberships", userId)
            : null;
        let committedClan = null;
        let oldRole = target.role;
        const ran = await runAtlasTransaction(fb, "change clan role", async tx => {
            committedClan = null;
            const clanSnap = await tx.get(clanRef);
            if (useReservations) await tx.get(membershipRef);
            if (!clanSnap.exists()) return;
            const liveClan = clanSnap.data();
            const actor = clanMembers(liveClan).find(member =>
                member.userId === myUid
            );
            const liveTarget = clanMembers(liveClan).find(member =>
                member.userId === userId
            );
            if (!actor
                || !liveTarget
                || !canSetRole(actor.role, liveTarget.role, newRole)) {
                return;
            }
            oldRole = liveTarget.role;
            const members = clanMembers(liveClan).map(member =>
                member.userId === userId
                    ? { ...member, role: newRole }
                    : member
            );
            const membersField = clanMembersField(liveClan, members);
            tx.set(clanRef, {
                ...membersField,
                versionNum: SCRIPT_VERSION_NUM,
            }, { merge: true });
            if (useReservations) {
                tx.set(
                    membershipRef,
                    clanMembershipRecord(
                        clanId,
                        newRole,
                        clanMemberDeviceIds(liveClan, userId)
                    )
                );
            }
            committedClan = {
                ...liveClan,
                id: clanId,
                ...membersField,
            };
        });
        if (!ran) return;
        if (!committedClan) {
            showToast("That role could not be changed.");
            return;
        }
        dbg(`Clan role change: ${userId} ${oldRole} -> ${newRole}`);
        myClan = sanitizeClanDoc(committedClan);
        renderClanView();
    } catch (e) {
        pushError(e, "setMemberRole");
        console.error("[RG HUD] Set role failed:", e);
        showToast("Couldn't change role (see console).");
    }
}


export async function editClan(newName, newTag) {
    const fb = await initFirebase();
    if (!fb || !myClan) return;
    if (!rolePerm(myClanRole(), "editClanInfo")) return;

    // frozen during events so leaderboards don't see mid-event rebrands
    if (!eventPerm("allowRenameClan")) {
        showToast("Clan renames are locked during this event.");
        return;
    }

    const nameClash = clanDirectory.some(c =>
        c.id !== myClan.id
        && normalizeClanName(c.name) === normalizeClanName(newName)
    );
    const tagClash = clanDirectory.some(c =>
        c.id !== myClan.id
        && sanitizeClanTag(c.tag) === sanitizeClanTag(newTag)
    );
    if (nameClash) { showToast("A clan with that name already exists."); return; }
    if (tagClash) { showToast("That tag is already taken."); return; }

    try {
        const clanId = myClan.id;
        const actorUid = myUserId();
        const clanRef = fb.doc(fb.db, "clans", clanId);
        const useReservations = clanReservationsEnabled();
        const directoryRef = clanDirectoryDocRef(fb, clanId);
        let outcome = "updated";
        let committedClan = null;
        let committedDirectory = null;
        const ran = await runAtlasTransaction(fb, "edit clan", async tx => {
            outcome = "updated";
            committedClan = null;
            committedDirectory = null;
            const directorySnap = !useReservations
                ? await tx.get(directoryRef)
                : null;
            const clanSnap = await tx.get(clanRef);
            if (!clanSnap.exists()) {
                outcome = "missing";
                return;
            }
            const liveClan = clanSnap.data();
            const actor = clanMembers(liveClan).find(member =>
                member.userId === actorUid
            );
            if (!actor || !rolePerm(actor.role, "editClanInfo")) {
                outcome = "forbidden";
                return;
            }
            const liveDirectory = directorySnap?.exists()
                ? (directorySnap.data().clans ?? [])
                : [];
            if (!useReservations && liveDirectory.some(entry =>
                entry?.id !== clanId
                && normalizeClanName(entry?.name) === normalizeClanName(newName)
            )) {
                outcome = "name-taken";
                return;
            }
            if (!useReservations && liveDirectory.some(entry =>
                entry?.id !== clanId
                && sanitizeClanTag(entry?.tag) === sanitizeClanTag(newTag)
            )) {
                outcome = "tag-taken";
                return;
            }

            let oldNameRef = null;
            let newNameRef = null;
            let oldTagRef = null;
            let newTagRef = null;
            if (useReservations) {
                const oldNameKey = await clanNameReservationId(liveClan.name);
                const newNameKey = await clanNameReservationId(newName);
                oldNameRef = fb.doc(fb.db, "clan_name_keys", oldNameKey);
                newNameRef = fb.doc(fb.db, "clan_name_keys", newNameKey);
                oldTagRef = fb.doc(
                    fb.db,
                    "clan_tag_keys",
                    sanitizeClanTag(liveClan.tag)
                );
                newTagRef = fb.doc(
                    fb.db,
                    "clan_tag_keys",
                    sanitizeClanTag(newTag)
                );
                const newNameSnap = await tx.get(newNameRef);
                const newTagSnap = await tx.get(newTagRef);
                if (newNameSnap.exists()
                    && newNameSnap.data().clanId !== clanId) {
                    outcome = "name-taken";
                    return;
                }
                if (newTagSnap.exists()
                    && newTagSnap.data().clanId !== clanId) {
                    outcome = "tag-taken";
                    return;
                }
            }

            committedClan = {
                ...liveClan,
                id: clanId,
                name: newName,
                tag: sanitizeClanTag(newTag),
                ...(useReservations ? {
                    nameKey: newNameRef.id,
                    tagKey: newTagRef.id,
                    normalizedName: normalizeClanName(newName),
                } : {}),
            };
            const entry = clanDirectoryEntry(clanId, committedClan);
            committedDirectory = putClanInDirectory(
                useReservations ? clanDirectory : liveDirectory,
                entry
            );
            tx.set(clanRef, {
                name: newName,
                tag: sanitizeClanTag(newTag),
                versionNum: SCRIPT_VERSION_NUM,
                ...(useReservations ? {
                    nameKey: newNameRef.id,
                    tagKey: newTagRef.id,
                    normalizedName: normalizeClanName(newName),
                } : {}),
            }, { merge: true });
            if (useReservations) {
                tx.set(directoryRef, entry);
                if (oldNameRef.path !== newNameRef.path) tx.delete(oldNameRef);
                if (oldTagRef.path !== newTagRef.path) tx.delete(oldTagRef);
                tx.set(newNameRef, {
                    clanId,
                    name: newName,
                    normalizedName: normalizeClanName(newName),
                });
                tx.set(newTagRef, {
                    clanId,
                    tag: sanitizeClanTag(newTag),
                });
            } else {
                tx.set(directoryRef, { clans: committedDirectory });
            }
        });
        if (!ran) return;
        if (!committedClan) {
            if (outcome === "missing") showToast("That clan no longer exists.");
            else if (outcome === "forbidden") showToast("You can't edit this clan.");
            else if (outcome === "name-taken") showToast("A clan with that name already exists.");
            else if (outcome === "tag-taken") showToast("That tag is already taken.");
            return;
        }
        dbg(`Clan edited: name="${newName}" tag="${newTag}"`);
        myClan = sanitizeClanDoc(committedClan);
        clanDirectory = committedDirectory;
        showToast("Clan updated! Tag refreshes on members' next match.");
        renderClanView();
    } catch (e) {
        pushError(e, "editClan");
        console.error("[RG HUD] Edit clan failed:", e);
        showToast("Couldn't update clan (see console).");
    }
}


export function showEditClanForm() {
    const view = document.getElementById("rgClanView");
    view.innerHTML = `
        <b>Edit Clan</b>
        <div style="margin-top:8px;">
            <input type="text" id="rgEditName" maxlength="24" value="${escapeHtml(myClan.name ?? "")}"
                style="width:100%;box-sizing:border-box;background:#10181f;border:1px solid #00bfff88;border-radius:6px;color:#d7f3ff;padding:6px 8px;font-size:13px;margin-bottom:6px;user-select:text;">
            <input type="text" id="rgEditTag" maxlength="4" value="${escapeHtml(myClan.tag ?? "")}"
                style="width:100%;box-sizing:border-box;background:#10181f;border:1px solid #00bfff88;border-radius:6px;color:#d7f3ff;padding:6px 8px;font-size:13px;user-select:text;text-transform:uppercase;"
                oninput="this.value=this.value.toUpperCase().replace(/[^A-Z]/g,'').slice(0,4);">
            <div id="rgEditErr" style="color:#ff6b6b;font-size:11px;min-height:14px;margin:4px 0;"></div>
            <div style="display:flex;gap:6px;">
                <button id="rgEditGo" class="rgBtn" style="flex:1;">Save</button>
                <button id="rgEditCancel" class="rgBtn" style="flex:1;">Cancel</button>
            </div>
        </div>`;

    probeInput(document.getElementById("rgEditName"), "rgEditName");
    probeInput(document.getElementById("rgEditTag"), "rgEditTag");
    const errEl = document.getElementById("rgEditErr");
    document.getElementById("rgEditGo").onclick = () => {
        const name = document.getElementById("rgEditName").value.trim();
        const tag = sanitizeClanTag(document.getElementById("rgEditTag").value);
        if (name.length === 0 || name.length > 24) { errEl.textContent = "Name must be 1-24 characters."; return; }
        if (tag.length < 2 || tag.length > 4) { errEl.textContent = "Tag: 2-4 letters, no numbers or symbols."; return; }
        if (containsProfanity(name) || containsEmoji(name)) { errEl.textContent = "That name isn't allowed."; return; }
        if (containsProfanity(tag) || containsEmoji(tag)) { errEl.textContent = "That tag isn't allowed."; return; }
        editClan(name, tag);
    };
    document.getElementById("rgEditCancel").onclick = renderClanView;
}


export function showLineupPicker() {
    const view = document.getElementById("rgClanView");
    if (!view || !myClan) return;
    const members = clanMembers(myClan);
    const size = startingLineupSize();
    const selected = new Set(startingLineupUids(myClan));
    const rowsHtml = members.map(m => `
        <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;background:${selected.has(m.userId) ? "#0a2038" : "transparent"};" data-uid="${escapeHtml(m.userId)}">
            <input type="checkbox" class="rgLineupCheck" data-uid="${escapeHtml(m.userId)}" ${selected.has(m.userId) ? "checked" : ""}>
            <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(m.name)}</span>
            <span style="opacity:.6;font-size:10px;text-transform:uppercase;">${m.role}</span>
        </label>`).join("");

    view.innerHTML = `
        <b>Starting ${size} for this event</b>
        <div style="font-size:11px;opacity:.75;margin:4px 0 8px;">
            Check exactly ${size}. Unchecked members sit on the bench and don't score.
        </div>
        <div id="rgLineupList" style="display:flex;flex-direction:column;gap:2px;max-height:260px;overflow-y:auto;">
            ${rowsHtml}
        </div>
        <div id="rgLineupErr" style="color:#ff6b6b;font-size:11px;min-height:14px;margin:4px 0;"></div>
        <div style="display:flex;gap:6px;">
            <button id="rgLineupSave" class="rgBtn" style="flex:1;">Save</button>
            <button id="rgLineupCancel" class="rgBtn" style="flex:1;">Cancel</button>
        </div>`;

    const err = document.getElementById("rgLineupErr");
    const readSelected = () => Array.from(document.querySelectorAll(".rgLineupCheck"))
        .filter(cb => cb.checked).map(cb => cb.dataset.uid);

    // Cap checkboxes at `size`. Extra clicks nudge the user with the error.
    document.getElementById("rgLineupList").addEventListener("change", (e) => {
        if (!e.target.classList.contains("rgLineupCheck")) return;
        const picks = readSelected();
        if (picks.length > size) {
            e.target.checked = false;
            err.textContent = `Only ${size} starters allowed. Uncheck someone else first.`;
            return;
        }
        err.textContent = "";
        // Restripe row highlight
        for (const label of document.querySelectorAll("[data-uid]")) {
            const cb = label.querySelector("input");
            if (!cb) continue;
            label.style.background = cb.checked ? "#0a2038" : "transparent";
        }
    });

    document.getElementById("rgLineupSave").onclick = async () => {
        const picks = readSelected();
        if (picks.length !== size) {
            err.textContent = `Pick exactly ${size} (currently ${picks.length}).`;
            return;
        }
        await saveStartingLineup(picks);
        renderClanView();
    };
    document.getElementById("rgLineupCancel").onclick = renderClanView;
}


export async function saveStartingLineup(uids) {
    if (!myClan) return;
    const fb = await initFirebase();
    if (!fb) return;
    // Client-side belt-and-suspenders: role + phase already checked
    // before the picker opens, but re-check in case the event flipped
    // to active between opening and saving.
    const myRole = myClanRole();
    if (myRole !== "leader" && myRole !== "co-leader") return;
    if (eventPhase() === "active" && !eventPerm("allowBenchSwapDuringEvent")) {
        showToast("Lineup is locked during this event.");
        return;
    }
    try {
        const clanRef = fb.doc(fb.db, "clans", myClan.id);
        await atlasSetDoc(fb, "clans", clanRef, { startingLineup: uids }, { merge: true });
        myClan = { ...myClan, startingLineup: uids };
        showToast("Starting lineup saved");
    } catch (e) {
        dbg("saveStartingLineup failed: " + getErrMsg(e));
        showToast("Couldn't save lineup — try again");
    }
}


export async function transferLeadership(userId) {
    const fb = await initFirebase();
    if (!fb || !myClan) return;
    const myUid = myUserId();
    if (myClan.leaderId !== myUid) return;
    if (!rolePerm(myClanRole(), "transfer")) {
        showToast("Leadership transfers are currently disabled.");
        return;
    }

    if (!eventPerm("allowTransfer")) {
        showToast("Leadership transfers are locked during this event.");
        return;
    }

    try {
        const clanId = myClan.id;
        const clanRef = fb.doc(fb.db, "clans", clanId);
        const useReservations = clanReservationsEnabled();
        const directoryRef = clanDirectoryDocRef(fb, clanId);
        const oldLeaderRef = useReservations
            ? fb.doc(fb.db, "clan_memberships", myUid)
            : null;
        const newLeaderRef = useReservations
            ? fb.doc(fb.db, "clan_memberships", userId)
            : null;
        let outcome = "transferred";
        let committedClan = null;
        let committedDirectory = null;
        const ran = await runAtlasTransaction(fb, "transfer clan leadership", async tx => {
            outcome = "transferred";
            committedClan = null;
            committedDirectory = null;
            const directorySnap = !useReservations
                ? await tx.get(directoryRef)
                : null;
            const clanSnap = await tx.get(clanRef);
            if (useReservations) {
                await tx.get(oldLeaderRef);
                await tx.get(newLeaderRef);
            }
            if (!clanSnap.exists()) {
                outcome = "missing";
                return;
            }
            const liveClan = clanSnap.data();
            const actor = clanMembers(liveClan).find(member =>
                member.userId === myUid
            );
            const target = clanMembers(liveClan).find(member =>
                member.userId === userId
            );
            if (liveClan.leaderId !== myUid
                || !actor
                || !target
                || !rolePerm(actor.role, "transfer")) {
                outcome = "forbidden";
                return;
            }
            const members = clanMembers(liveClan).map(member => {
                if (member.userId === userId) return { ...member, role: "leader" };
                if (member.userId === myUid) return { ...member, role: "coleader" };
                return member;
            });
            const membersField = clanMembersField(liveClan, members);
            const newLeaderDevices = clanMemberDeviceIds(liveClan, userId);
            if (useReservations && !newLeaderDevices.length) {
                outcome = "target-device-missing";
                return;
            }
            committedClan = {
                ...liveClan,
                id: clanId,
                ...membersField,
                leaderId: userId,
                ...(useReservations && newLeaderDevices[0]
                    ? { deviceId: newLeaderDevices[0] }
                    : {}),
            };
            const entry = clanDirectoryEntry(clanId, committedClan);
            committedDirectory = putClanInDirectory(
                useReservations
                    ? clanDirectory
                    : (directorySnap?.exists()
                        ? (directorySnap.data().clans ?? [])
                        : []),
                entry
            );
            tx.set(clanRef, {
                ...membersField,
                leaderId: userId,
                versionNum: SCRIPT_VERSION_NUM,
                ...(useReservations && newLeaderDevices[0]
                    ? { deviceId: newLeaderDevices[0] }
                    : {}),
            }, { merge: true });
            if (useReservations) {
                tx.set(directoryRef, entry);
                tx.set(
                    oldLeaderRef,
                    clanMembershipRecord(
                        clanId,
                        "coleader",
                        clanMemberDeviceIds(liveClan, myUid)
                    )
                );
                tx.set(
                    newLeaderRef,
                    clanMembershipRecord(
                        clanId,
                        "leader",
                        newLeaderDevices
                    )
                );
            } else {
                tx.set(directoryRef, { clans: committedDirectory });
            }
        });
        if (!ran) return;
        if (!committedClan) {
            if (outcome === "missing") {
                showToast("That clan no longer exists.");
            } else if (outcome === "target-device-missing") {
                showToast("That player needs to open the latest ATLAS before becoming leader.");
            } else {
                showToast("Leadership could not be transferred.");
            }
            return;
        }
        dbg(`Clan leadership transferred to ${userId}`);
        myClan = sanitizeClanDoc(committedClan);
        clanDirectory = committedDirectory;
        renderClanView();
    } catch (e) {
        pushError(e, "transferLeadership");
        console.error("[RG HUD] Transfer leadership failed:", e);
        showToast("Couldn't transfer leadership (see console).");
    }
}


export async function leaveClan() {
    const fb = await initFirebase();
    if (!fb || !myClan) return;
    const uid = myUserId();

    // Force-refresh event config so a stale in-memory cache can't lock
    // leave when the event has actually ended.
    await loadEventConfig(fb, true);

    // leader path handled below (disband/transfer)
    if (!eventPerm("allowLeave") && myClan.leaderId !== uid) {
        dbg(`leaveClan blocked: phase=${eventPhase()} allowLeave=${eventConfig?.perms?.allowLeave} endTime=${eventConfig?.endTime} now=${Date.now()}`);
        showToast("Can't leave during an active event -- ask leader to kick.");
        return;
    }

    try {
        const clanId = myClan.id;
        const clanRef = fb.doc(fb.db, "clans", clanId);
        const useReservations = clanReservationsEnabled();
        const directoryRef = clanDirectoryDocRef(fb, clanId);
        const membershipRef = useReservations
            ? fb.doc(fb.db, "clan_memberships", uid)
            : null;
        let outcome = "left";
        let committedDirectory = null;
        const ran = await runAtlasTransaction(fb, "leave clan", async tx => {
            outcome = "left";
            committedDirectory = null;
            const directorySnap = !useReservations
                ? await tx.get(directoryRef)
                : null;
            const clanSnap = await tx.get(clanRef);
            if (!clanSnap.exists()) {
                outcome = "missing";
                return;
            }
            const liveClan = clanSnap.data();
            const liveMembers = clanMembers(liveClan);
            const liveMemberIds = Array.isArray(liveClan.memberIds) ? liveClan.memberIds : [];
            const member = liveMembers.find(candidate => candidate.userId === uid);
            // members can drift out of sync with memberIds. Treat the
            // uid still being on memberIds as "yes, still in the clan"
            // so leave doesn't silently no-op.
            const stuckInMemberIds = !member && liveMemberIds.includes(uid);
            if (!member && !stuckInMemberIds) {
                outcome = "handled";
                return;
            }
            const isLeader = liveClan.leaderId === uid;
            const isSoloLeader = isLeader && liveMembers.length === 1;
            const deviceIds = clanMemberDeviceIds(liveClan, uid);
            // Just scrubbing a stale uid — don't block on event locks.
            if (stuckInMemberIds && !isLeader && !eventPerm("allowLeave")) {
                dbg(`leaveClan tx: repairing memberIds desync for ${uid}`);
            } else if (!isLeader && !eventPerm("allowLeave")) {
                dbg(`leaveClan tx blocked: phase=${eventPhase()} allowLeave=${eventConfig?.perms?.allowLeave} endTime=${eventConfig?.endTime} now=${Date.now()}`);
                outcome = "leave-locked";
                return;
            }
            if (isSoloLeader && !eventPerm("allowDisband")) {
                outcome = "disband-locked";
                return;
            }
            if (isSoloLeader && !rolePerm(member.role, "disband")) {
                outcome = "disband-disabled";
                return;
            }
            if (isLeader && liveMembers.length > 1) {
                outcome = "transfer-first";
                return;
            }
            const liveDirectory = directorySnap?.exists()
                ? (directorySnap.data().clans ?? [])
                : [];
            if (isLeader) {
                outcome = "disbanded";
                committedDirectory = removeClanFromDirectory(
                    useReservations ? clanDirectory : liveDirectory,
                    clanId
                );
                if (useReservations) {
                    const nameKey = await clanNameReservationId(liveClan.name);
                    tx.delete(fb.doc(fb.db, "clan_name_keys", nameKey));
                    tx.delete(fb.doc(
                        fb.db,
                        "clan_tag_keys",
                        sanitizeClanTag(liveClan.tag)
                    ));
                    tx.delete(directoryRef);
                }
                tx.delete(clanRef);
            } else {
                const members = liveMembers.filter(candidate => candidate.userId !== uid);
                const membersField = clanMembersField(liveClan, members);
                // Filter the live memberIds/deviceIds instead of rebuilding
                // from the members list — if members was desynced, the
                // old code wiped everyone else's uid too.
                const uidDeviceIds = clanMemberDeviceIds(liveClan, uid);
                const nextMemberIds = liveMemberIds.filter(id => id !== uid);
                const liveDeviceIds = Array.isArray(liveClan.deviceIds) ? liveClan.deviceIds : [];
                const nextDeviceIds = liveDeviceIds.filter(d => !uidDeviceIds.includes(d));
                const reservationFields = useReservations
                    ? {
                        memberIds: nextMemberIds,
                        deviceIds: nextDeviceIds,
                    }
                    : {};
                const nextClan = {
                    ...liveClan,
                    id: clanId,
                    ...membersField,
                    ...reservationFields,
                };
                const entry = clanDirectoryEntry(clanId, nextClan);
                committedDirectory = putClanInDirectory(
                    useReservations ? clanDirectory : liveDirectory,
                    entry
                );
                tx.set(clanRef, {
                    ...membersField,
                    ...reservationFields,
                }, { merge: true });
                if (useReservations) tx.set(directoryRef, entry);
            }
            if (useReservations) {
                tx.delete(membershipRef);
                for (const deviceId of deviceIds) {
                    tx.delete(fb.doc(fb.db, "clan_devices", deviceId));
                }
            } else {
                tx.set(directoryRef, { clans: committedDirectory });
            }
        });
        if (!ran) return;
        if (!committedDirectory) {
            if (outcome === "leave-locked") showToast("Can't leave during an active event -- ask leader to kick.");
            else if (outcome === "disband-locked") showToast("Disbanding is locked during this event.");
            else if (outcome === "disband-disabled") showToast("Disbanding is currently disabled.");
            else if (outcome === "transfer-first") showToast("Transfer leadership or remove others before leaving.");
            else showToast("You are no longer in that clan.");
            await loadClanData(true);
            renderClanView();
            return;
        }
        dbg(outcome === "disbanded"
            ? `Clan disbanded (solo leader): ${clanId}`
            : `Clan left: ${clanId}`);
        detachClanListener();
        myClan = null;
        clanDirectory = committedDirectory;
        renderClanView();
    } catch (e) {
        pushError(e, "leaveClan");
        console.error("[RG HUD] Leave clan failed:", e);
        // local state is already partially wiped above, surface it
        showToast("Couldn't leave clan — refresh the page to retry.");
    }
}


// ---------- Clan view rendering ----------

export async function renderClanView() {
    try {
        const view = document.getElementById("rgClanView");
        if (!view) return;

        if (!lastKnownPlayerData) {
            view.innerHTML = `<div style="opacity:.8;">Log in or play a match first to use clans.</div>`;
            return;
        }

        view.innerHTML = `<div style="opacity:.8;">Loading clans...</div>`;
        // Warm reopen: reuse in-memory clan + directory when already loaded
        // for this account. Live clan doc updates come from the listener;
        // directory refreshes stay throttled. Force only on first load /
        // account switch (loadClanData handles that).
        const warmReopen = clanLoaded && clanLoadedForAccount === myUserId();
        await loadClanData(!warmReopen);
        const fb = await initFirebase();
        if (fb) await loadEventConfig(fb);
        if (fb) await loadClanRolePerms(fb);
        if (warmReopen && fb) await refreshDirectoryThrottled(fb);

        renderClanViewFromMemory();
        if (myClan) attachClanListener();
    } catch (e) {
        dbg("renderClanView threw: " + getErrMsg(e));
    }
}


// zero-read repaint from in-memory myClan
export function renderClanViewFromMemory() {
    const view = document.getElementById("rgClanView");
    if (!view) return;
    myClan ? renderMyClan(view) : renderNoClan(view);
}


// refresh clan tab in place if it's open
export function refreshClanViewIfOpen() {
    const view = document.getElementById("rgClanView");
    if (isVisible(view)) {
        renderClanViewFromMemory();
        if (myClan) attachClanListener();
    }
}


export function renderNoClan(view) {
    const rows = clanDirectory
        .slice()
        .sort((a, b) => (b.totalMMR ?? 0) - (a.totalMMR ?? 0))
        .map((c, i) => `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:3px 0;border-bottom:1px solid #ffffff11;">
                <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    <span style="color:#ffd700;">#${i + 1}</span>
                    ${c.tag ? `<span style="opacity:.7;">[${escapeHtml(c.tag)}]</span>` : ""}
                    <b>${escapeHtml(c.name)}</b>
                    <span style="opacity:.6;font-size:10px;">(${c.memberCount}/${clanMaxMembers()})</span>
                </span>
                <span style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
                    <span style="color:#00ff66;font-size:11px;">${c.totalMMR}</span>
                    <button class="rgBtn rgJoinBtn" data-clan="${escapeHtml(c.id)}" style="padding:2px 6px;font-size:10px;" ${c.memberCount >= clanMaxMembers() ? "disabled" : ""}>Join</button>
                </span>
            </div>`).join("");

    view.innerHTML = `
        ${eventBannerHtml(null, myUserId())}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <b>🛡️ Clans</b>
            <button id="rgCreateClanBtn" class="rgBtn" style="padding:3px 8px;font-size:11px;">+ Create</button>
        </div>
        <div style="max-height:200px;overflow-y:auto;">${rows || `<div style="opacity:.7;">No clans yet. Create the first one!</div>`}</div>
    `;

    document.getElementById("rgCreateClanBtn").onclick = showCreateClanForm;
    view.querySelectorAll(".rgJoinBtn").forEach(btn => {
        if (!eventPerm("allowJoin")) {
            btn.disabled = true;
            btn.style.opacity = "0.5";
            btn.style.cursor = "not-allowed";
            btn.title = "Joins locked during event";
            btn.textContent = "Locked (event)";
        } else {
            btn.onclick = () => requestJoin(btn.getAttribute("data-clan"));
        }
    });
}


export function showCreateClanForm() {
    const view = document.getElementById("rgClanView");
    view.innerHTML = `
        <b>Create a Clan</b>
        <div style="margin-top:8px;">
            <input type="text" id="rgClanName" placeholder="Clan name (max 24)" maxlength="24"
                style="width:100%;box-sizing:border-box;background:#10181f;border:1px solid #00bfff88;border-radius:6px;color:#d7f3ff;padding:6px 8px;font-size:13px;margin-bottom:6px;user-select:text;">
            <input type="text" id="rgClanTag" placeholder="Tag (2-4 letters, required)" maxlength="4"
                style="width:100%;box-sizing:border-box;background:#10181f;border:1px solid #00bfff88;border-radius:6px;color:#d7f3ff;padding:6px 8px;font-size:13px;user-select:text;">
            <div id="rgClanErr" style="color:#ff6b6b;font-size:11px;min-height:14px;margin:4px 0;"></div>
            <div style="display:flex;gap:6px;">
                <button id="rgClanCreateGo" class="rgBtn" style="flex:1;">Create</button>
                <button id="rgClanCreateCancel" class="rgBtn" style="flex:1;">Cancel</button>
            </div>
        </div>`;

    const nameEl = document.getElementById("rgClanName");
    const tagEl = document.getElementById("rgClanTag");
    const errEl = document.getElementById("rgClanErr");
    probeInput(nameEl, "rgClanName");
    probeInput(tagEl, "rgClanTag");
    [nameEl, tagEl].forEach(el => {
        el.addEventListener("keydown", e => e.stopPropagation(), true);
    });
    // uppercase + letter-only as they type
    tagEl.style.textTransform = "uppercase";
    tagEl.addEventListener("input", () => {
        const clean = sanitizeClanTag(tagEl.value);
        if (tagEl.value !== clean) tagEl.value = clean;
    });

    const createButton = document.getElementById("rgClanCreateGo");
    createButton.onclick = async () => {
        const name = nameEl.value.trim();
        const tag = sanitizeClanTag(tagEl.value);
        if (name.length === 0 || name.length > 24) { errEl.textContent = "Name must be 1-24 characters."; return; }
        if (tag.length < 2 || tag.length > 4) { errEl.textContent = "Tag: 2-4 letters, no numbers or symbols."; return; }
        if (containsProfanity(name) || containsEmoji(name)) { errEl.textContent = "That name isn't allowed."; return; }
        if (containsProfanity(tag) || containsEmoji(tag)) { errEl.textContent = "That tag isn't allowed."; return; }
        if (clanDirectory.some(c => (c.tag ?? "").toLowerCase() === tag.toLowerCase())) {
            errEl.textContent = "That tag is already taken."; return;
        }
        createButton.disabled = true;
        createButton.textContent = "Creating...";
        try {
            await createClan(name, tag);
        } finally {
            if (createButton.isConnected) {
                createButton.disabled = false;
                createButton.textContent = "Create";
            }
        }
    };
    document.getElementById("rgClanCreateCancel").onclick = renderClanView;
}


export function renderMyClan(view) {
    const uid = myUserId();
    const me = clanMembers(myClan).find(m => m.userId === uid);
    const myRole = me?.role ?? "member";
    const rank = [...clanDirectory].sort((a, b) => (b.totalMMR ?? 0) - (a.totalMMR ?? 0))
        .findIndex(c => c.id === myClan.id) + 1;

    // ⋯ menu, per-target rank guards still apply below
    const canManage = rolePerm(myRole, "kick") || rolePerm(myRole, "roleChange");
    // current MMR minus per-member baseline (only during active event)
    const eventActive = eventPhase() === "active";
    const eventBaselines = eventActive ? (clanBaselineForCurrentEvent(myClan) || {}) : {};
    const contribFor = (member) => {
        if (!eventActive) return null;
        const base = eventBaselines[member.userId];
        const mmr = effectiveClanMemberStat(myClan, member).mmr;
        if (base == null || typeof mmr !== "number") return null;
        return mmr - base;
    };

    const benchOn = benchFeatureEnabled();
    const starterSet = benchOn ? new Set(startingLineupUids(myClan)) : null;
    const canEditLineup = benchOn
        && (myRole === "leader" || myRole === "co-leader")
        && (eventPhase() !== "active" || eventPerm("allowBenchSwapDuringEvent"));
    const memberRows = clanMembers(myClan)
        .slice()
        .sort((a, b) => (ROLE_RANK[b.role] ?? 0) - (ROLE_RANK[a.role] ?? 0))
        .map(m => {
            const actable = canManage && m.userId !== uid && m.role !== "leader"
                && (ROLE_RANK[m.role] ?? 0) < (ROLE_RANK[myRole] ?? 0);
            const isBench = starterSet && m.userId && !starterSet.has(m.userId);
            const stat = effectiveClanMemberStat(myClan, m);
            const contrib = contribFor(m);
            // shows staleness so "+0" vs "last synced 2h ago" is clear
            const ageMs = typeof stat.syncedAt === "number" ? Date.now() - stat.syncedAt : null;
            const ageLabel = ageMs == null ? null
                : ageMs < 90e3 ? "just now"
                : ageMs < 3600e3 ? `${Math.round(ageMs / 60e3)}m ago`
                : ageMs < 86400e3 ? `${Math.round(ageMs / 3600e3)}h ago`
                : `${Math.round(ageMs / 86400e3)}d ago`;
            const freshnessNote = ageLabel ? `· last synced ${ageLabel}` : "· sync age unknown (teammate needs v12.9+)";
            const stale = ageMs != null && ageMs > 3600e3;
            // green gain, red loss, gray dash = hasn't played this event
            const contribHtml = eventActive
                ? (contrib == null
                    ? `<span title="Hasn't played during this event yet" style="opacity:.4;font-size:10px;font-family:monospace;">—</span>`
                    : `<span title="Event contribution (current MMR - baseline) ${freshnessNote}" style="color:${contrib >= 0 ? "#00ff66" : "#ff6b6b"};opacity:${stale ? ".45" : "1"};font-size:10px;font-weight:bold;font-family:monospace;">${contrib >= 0 ? "+" : ""}${contrib}</span>`)
                : "";
            const benchBadge = isBench
                ? `<span title="Bench for this event — MMR not scored" style="font-size:9px;padding:0 4px;border:1px solid #ff9a3c;border-radius:4px;color:#ff9a3c;">BENCH</span>`
                : "";
            return `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;gap:6px;${isBench ? "opacity:.75;" : ""}">
                <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    ${escapeHtml(m.name)}
                    ${typeof stat.mmr === "number" ? `<span style="opacity:.5;font-size:10px;">${stat.mmr}</span>` : ""}
                    ${benchBadge}
                </span>
                <span style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
                    ${contribHtml}
                    <span style="opacity:.7;font-size:10px;text-transform:uppercase;">${m.role}</span>
                    ${actable ? `<button class="rgBtn rgManage" data-uid="${escapeHtml(m.userId)}" data-name="${escapeHtml(m.name)}" data-role="${escapeHtml(m.role)}" style="padding:1px 6px;font-size:10px;">⋯</button>` : ""}
                </span>
            </div>`;
        }).join("");

    let requestsSection = "";
    if (canManageRequests(myRole) && (myClan.joinRequests ?? []).length > 0) {
        const reqRows = myClan.joinRequests.map(r => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;gap:6px;">
                <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.name)}</span>
                <span style="display:flex;gap:4px;flex-shrink:0;">
                    <button class="rgBtn rgApprove" data-uid="${escapeHtml(r.userId)}" style="padding:1px 6px;font-size:10px;">✓</button>
                    <button class="rgBtn rgReject" data-uid="${escapeHtml(r.userId)}" style="padding:1px 6px;font-size:10px;">✗</button>
                </span>
            </div>`).join("");
        requestsSection = `
            <hr style="border:none;border-top:1px solid #00bfff88;margin:8px 0;">
            <b>Join Requests</b>
            <div>${reqRows}</div>`;
    }

    const isLeader = myClan.leaderId === uid;
    view.innerHTML = `
        ${eventBannerHtml(myClan, uid)}
        <div style="display:flex;justify-content:space-between;align-items:center;">
            <b style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${myClan.tag ? `[${escapeHtml(myClan.tag)}] ` : ""}${escapeHtml(myClan.name)}</b>
            <span style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
                ${canEditLineup ? `<button id="rgLineupBtn" class="rgBtn" style="padding:1px 6px;font-size:10px;" title="Set starting ${startingLineupSize()}">🪑</button>` : ""}
                ${rolePerm(myRole, "editClanInfo") ? `<button id="rgEditClan" class="rgBtn" style="padding:1px 6px;font-size:10px;">✏️</button>` : ""}
                <span style="color:#ffd700;font-size:11px;">Rank #${rank || "-"}</span>
            </span>
        </div>
        <div style="font-size:11px;opacity:.75;margin:2px 0 6px;">
            Total MMR: <span style="color:#00ff66;">${effectiveClanTotalMMR(myClan)}</span>
            &nbsp;•&nbsp; ${clanMembers(myClan).length}/${clanMaxMembers()} members
        </div>
        <div id="rgMembersHeader" style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;padding:2px 0;margin-top:2px;">
            <span id="rgMembersArrow" style="font-size:9px;opacity:.7;width:8px;display:inline-block;">▶</span>
            <b>Members</b>
        </div>
        <div id="rgMembersList" style="display:none;">${memberRows}</div>
        ${requestsSection}
        <div id="rgClanTagPanel" style="margin-top:10px;padding:8px;border:1px solid #00bfff44;border-radius:6px;">
            <div id="rgClanTagHeader" style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;">
                <span id="rgClanTagArrow" style="font-size:9px;opacity:.7;width:8px;display:inline-block;">▶</span>
                <span style="font-size:11px;font-weight:bold;color:#00bfff;">CLAN TAG STYLE</span>
            </div>
            <div id="rgClanTagBody" style="display:none;margin-top:6px;"></div>
        </div>
        <button id="rgLeaveClan" class="rgBtn" style="width:100%;margin-top:8px;">Leave Clan</button>
    `;

    if (rolePerm(myRole, "editClanInfo")) {
        const editBtn = document.getElementById("rgEditClan");
        if (editBtn) editBtn.onclick = showEditClanForm;
    }
    if (canEditLineup) {
        const lineupBtn = document.getElementById("rgLineupBtn");
        if (lineupBtn) lineupBtn.onclick = showLineupPicker;
    }

    // collapsed by default to save HUD height
    const mHeader = document.getElementById("rgMembersHeader");
    if (mHeader) {
        mHeader.onclick = () => {
            const list = document.getElementById("rgMembersList");
            const arrow = document.getElementById("rgMembersArrow");
            const open = isVisible(list);
            list.style.display = open ? "none" : "block";
            arrow.textContent = open ? "▶" : "▼";
        };
    }
    // renderClanTagPanel still runs so the preview is ready when opened
    const tHeader = document.getElementById("rgClanTagHeader");
    if (tHeader) {
        tHeader.onclick = () => {
            const body = document.getElementById("rgClanTagBody");
            const arrow = document.getElementById("rgClanTagArrow");
            const open = isVisible(body);
            body.style.display = open ? "none" : "block";
            arrow.textContent = open ? "▶" : "▼";
        };
    }

    view.querySelectorAll(".rgApprove").forEach(b => b.onclick = () => approveRequest(b.getAttribute("data-uid"), true));
    view.querySelectorAll(".rgReject").forEach(b => b.onclick = () => approveRequest(b.getAttribute("data-uid"), false));
    view.querySelectorAll(".rgManage").forEach(b => b.onclick = async () => {
        const tUid = b.getAttribute("data-uid");
        const tName = b.getAttribute("data-name");
        const tRole = b.getAttribute("data-role");
        await showManageMemberMenu(tUid, tName, tRole, myRole, myClan.leaderId === uid);
    });
    renderClanTagPanel();
    // gray out Leave for non-leader members when allowLeave is off
    if (!eventPerm("allowLeave") && myClan && myClan.leaderId !== myUserId()) {
        const lb = document.getElementById("rgLeaveClan");
        if (lb) {
            lb.disabled = true;
            lb.style.opacity = "0.5";
            lb.style.cursor = "not-allowed";
            lb.title = "Locked during active event";
            lb.textContent = "Leave Clan (locked during event)";
        }
    }
            document.getElementById("rgLeaveClan").onclick = async () => {
        const sure = await showDialog({ message: "Leave this clan?", okLabel: "Leave", cancelLabel: "Cancel" });
        if (sure) leaveClan();
    };
}


// rendered temporarily into the clan view
export async function showManageMemberMenu(userId, name, targetRole, actorRole, actorIsLeader) {
  try {
    const view = document.getElementById("rgClanView");
    if (!view) return;

    const actions = [];
    // any role strictly below the actor that isn't the current one
    const assignable = ["coleader", "elder", "member"].filter(r =>
        r !== targetRole && canSetRole(actorRole, targetRole, r)
    );
    for (const r of assignable) {
        const verb = (ROLE_RANK[r] > ROLE_RANK[targetRole]) ? "Promote to" : "Demote to";
        actions.push({ label: `${verb} ${r}`, run: () => setMemberRole(userId, r) });
    }
    if (actorIsLeader && rolePerm(actorRole, "transfer")) {
        actions.push({ label: "👑 Transfer leadership", danger: true, run: async () => {
            const sure = await showDialog({
                message: `Make ${name} the clan leader? You'll become co-leader.`,
                okLabel: "Transfer", cancelLabel: "Cancel",
            });
            if (sure) transferLeadership(userId);
        }});
    }
    if (rolePerm(actorRole, "kick")) actions.push({ label: "❌ Kick from clan", danger: true, run: async () => {
        const sure = await showDialog({ message: `Kick ${name} from the clan?`, okLabel: "Kick", cancelLabel: "Cancel" });
        if (!sure) { renderClanView(); return; }
        const msg = await showDialog({
            message: `Optional message to ${name} (leave blank to skip):`,
            withInput: true, inputPlaceholder: "Message...", okLabel: "Send", cancelLabel: "No message",
        });
        kickMember(userId, msg || "");
    }});

    const btns = actions.map((a, i) =>
        `<button class="rgBtn rgMgAction" data-i="${i}" style="width:100%;margin-bottom:4px;${a.danger ? "border-color:#ff6b6b88;" : ""}">${a.label}</button>`
    ).join("");

    view.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <b>Manage ${escapeHtml(name)}</b>
            <span style="opacity:.6;font-size:10px;text-transform:uppercase;">${targetRole}</span>
        </div>
        ${btns}
        <button id="rgMgBack" class="rgBtn" style="width:100%;margin-top:6px;">Back</button>
    `;

    view.querySelectorAll(".rgMgAction").forEach(btn => {
        btn.onclick = () => actions[parseInt(btn.getAttribute("data-i"))].run();
    });
    document.getElementById("rgMgBack").onclick = renderClanView;
  } catch (e) {
    dbg("showManageMemberMenu threw: " + getErrMsg(e));
  }
}


export function myUserId() { return lastKnownPlayerData?.Id ?? null; }


// plain in-game name (first line, TMP tags stripped, [TAG] prefix removed).
// used to seed Name Forge, not the leaderboard display name.
export function myGameNamePlain() {
    const raw = String(lastKnownPlayerData?.Nickname ?? "");
    if (!raw) return "";
    const firstLine = raw.split(/<br\s*\/?\s*>/i)[0];
    let plain = firstLine.replace(/<[^>]*>/g, "").trim();
    plain = plain.replace(/^\[[^\]]{1,6}\]\s*/, "");
    return plain;
}


export function myName() {
    return cachedDisplayNames.get(myUserId()) || cleanName(lastKnownPlayerData?.Nickname) || "Unknown";
}
