
// fallback for when the Worker forgets expireTimeMillis
export function extractJwtExpMillis(token) {
    try {
        if (typeof token !== "string") return null;
        const parts = token.split(".");
        if (parts.length < 2) return null;
        // base64url → base64
        let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        while (b64.length % 4) b64 += "=";
        const json = atob(b64);
        const payload = JSON.parse(json);
        const exp = Number(payload && payload.exp);
        if (!Number.isFinite(exp) || exp <= 0) return null;
        return exp * 1000;
    } catch {
        return null;
    }
}


export function atlasTmStorage() {
    if (typeof GM_getValue !== "function" || typeof GM_setValue !== "function") return null;
    return {
        get: (key) => GM_getValue(key, null),
        set: (key, value) => { GM_setValue(key, value); },
        remove: (key) => {
            if (typeof GM_deleteValue === "function") GM_deleteValue(key);
            else GM_setValue(key, "");
        },
    };
}


// Tampermonkey storage survives a rocketgoal.io cache clear. Origin
// IndexedDB / localStorage do not. Copy the official Auth blob into
// localStorage before initializeAuth — Firebase 10 rejects a duck-typed
// persistence object ("Expected a class definition").
export function hydrateAtlasAuthFromTm(storage, apiKey, appName, localStore) {
    if (!storage || !apiKey || !localStore || typeof localStore.getItem !== "function") return false;
    let raw;
    try { raw = storage.get("atlasFirebaseAuthUser"); } catch (e) { return false; }
    if (raw == null || raw === "") return false;
    const blob = typeof raw === "string" ? raw : JSON.stringify(raw);
    const names = ["[DEFAULT]", "atlas"];
    if (appName && names.indexOf(appName) < 0) names.unshift(appName);
    let wrote = false;
    for (let i = 0; i < names.length; i++) {
        const key = "firebase:authUser:" + apiKey + ":" + names[i];
        try {
            if (!localStore.getItem(key)) {
                localStore.setItem(key, blob);
                wrote = true;
            }
        } catch (e) {}
    }
    return wrote;
}


export function backupAtlasAuthToTm(storage, apiKey, appName, localStore, user) {
    if (!storage || typeof storage.set !== "function") return false;
    let blob = null;
    if (localStore && apiKey && typeof localStore.getItem === "function") {
        const names = ["[DEFAULT]", "atlas"];
        if (appName && names.indexOf(appName) < 0) names.unshift(appName);
        for (let i = 0; i < names.length; i++) {
            try {
                const fromLs = localStore.getItem("firebase:authUser:" + apiKey + ":" + names[i]);
                if (fromLs) { blob = fromLs; break; }
            } catch (e) {}
        }
    }
    if (!blob && user && typeof user.toJSON === "function") {
        try { blob = JSON.stringify(user.toJSON()); } catch (e) {}
    }
    if (!blob) return false;
    try { storage.set("atlasFirebaseAuthUser", blob); return true; } catch (e) { return false; }
}


export function atlasSetLongCookie(name, value) {
    try {
        document.cookie =
            name + "=" + encodeURIComponent(value) +
            "; max-age=31536000; path=/; SameSite=Lax; Secure";
    } catch (e) {}
}


export function atlasReadCookie(name) {
    try {
        const prefix = name + "=";
        const parts = document.cookie ? document.cookie.split("; ") : [];
        for (let i = 0; i < parts.length; i++) {
            if (parts[i].indexOf(prefix) === 0) {
                return decodeURIComponent(parts[i].slice(prefix.length));
            }
        }
    } catch (e) {}
    return null;
}


export function getAtlasProxyKvConfig() {
    try {
        if (typeof window === "undefined" || !window.location) return null;
        const host = window.location.hostname;
        // Real game runs the Tampermonkey path. Anything else that served
        // this script must be the proxy origin.
        if (!host || host === "rocketgoal.io") return null;

        let sid = null;
        let keyB64 = null;
        try { sid = localStorage.getItem("atlas.kv.sid") || atlasReadCookie("atlas_kv_sid"); } catch (e) {}
        try { keyB64 = localStorage.getItem("atlas.kv.key") || atlasReadCookie("atlas_kv_key"); } catch (e) {}

        if (!sid || !keyB64) {
            sid = (typeof crypto !== "undefined" && crypto.randomUUID)
                ? crypto.randomUUID()
                : Date.now().toString(36) + Math.random().toString(36).slice(2);
            const rand = new Uint8Array(32);
            crypto.getRandomValues(rand);
            keyB64 = bytesToBase64(rand);
            try {
                localStorage.setItem("atlas.kv.sid", sid);
                localStorage.setItem("atlas.kv.key", keyB64);
            } catch (e) {}
            atlasSetLongCookie("atlas_kv_sid", sid);
            atlasSetLongCookie("atlas_kv_key", keyB64);
        } else {
            // Mirror across whichever store is missing so a single wipe
            // (only cookies, or only localStorage) doesn't lose us.
            try {
                if (!localStorage.getItem("atlas.kv.sid")) localStorage.setItem("atlas.kv.sid", sid);
                if (!localStorage.getItem("atlas.kv.key")) localStorage.setItem("atlas.kv.key", keyB64);
            } catch (e) {}
            if (!atlasReadCookie("atlas_kv_sid")) atlasSetLongCookie("atlas_kv_sid", sid);
            if (!atlasReadCookie("atlas_kv_key")) atlasSetLongCookie("atlas_kv_key", keyB64);
        }

        return { sid: sid, keyB64: keyB64 };
    } catch (e) {
        return null;
    }
}


export async function importAtlasProxyKvKey(keyB64) {
    const raw = base64ToBytes(keyB64);
    return crypto.subtle.importKey(
        "raw",
        raw,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"],
    );
}


export async function hydrateAtlasAuthFromProxyKv(apiKey, appName, localStore) {
    if (!apiKey || !localStore || typeof localStore.getItem !== "function") return false;
    const cfg = getAtlasProxyKvConfig();
    if (!cfg) return false;
    try {
        const resp = await fetch(atlasProxyKvPath(cfg.sid), {
            method: "GET",
            credentials: "same-origin",
        });
        if (!resp.ok) return false;
        const payload = await resp.json();
        if (!payload || !payload.iv || !payload.ciphertext) return false;
        const key = await importAtlasProxyKvKey(cfg.keyB64);
        const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: base64ToBytes(payload.iv) },
            key,
            base64ToBytes(payload.ciphertext),
        );
        const blob = new TextDecoder().decode(plain);
        if (!blob) return false;
        const names = ["[DEFAULT]", "atlas"];
        if (appName && names.indexOf(appName) < 0) names.unshift(appName);
        let wrote = false;
        for (let i = 0; i < names.length; i++) {
            const k = "firebase:authUser:" + apiKey + ":" + names[i];
            try {
                if (!localStore.getItem(k)) {
                    localStore.setItem(k, blob);
                    wrote = true;
                }
            } catch (e) {}
        }
        return wrote;
    } catch (e) {
        try { dbg("proxy KV hydrate failed: " + getErrMsg(e)); } catch (_) {}
        return false;
    }
}


export async function backupAtlasAuthToProxyKv(apiKey, appName, localStore) {
    if (!apiKey || !localStore || typeof localStore.getItem !== "function") return false;
    const cfg = getAtlasProxyKvConfig();
    if (!cfg) return false;
    let blob = null;
    const names = ["[DEFAULT]", "atlas"];
    if (appName && names.indexOf(appName) < 0) names.unshift(appName);
    for (let i = 0; i < names.length; i++) {
        try {
            const raw = localStore.getItem("firebase:authUser:" + apiKey + ":" + names[i]);
            if (raw) { blob = raw; break; }
        } catch (e) {}
    }
    if (!blob) return false;
    try {
        const key = await importAtlasProxyKvKey(cfg.keyB64);
        const iv = new Uint8Array(12);
        crypto.getRandomValues(iv);
        const ct = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv },
            key,
            new TextEncoder().encode(blob),
        );
        const resp = await fetch(atlasProxyKvPath(cfg.sid), {
            method: "PUT",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                iv: bytesToBase64(iv),
                ciphertext: bytesToBase64(new Uint8Array(ct)),
            }),
        });
        return resp.ok;
    } catch (e) {
        try { dbg("proxy KV backup failed: " + getErrMsg(e)); } catch (_) {}
        return false;
    }
}


export async function initFirebaseInner() {
    try {
        const { initializeApp, getApps } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
        const {
            getFirestore,
            doc,
            setDoc,
            getDoc: rawGetDoc,
            collection,
            query,
            where,
            getDocs: rawGetDocs,
            getCountFromServer: rawGetCountFromServer,
            orderBy,
            limit,
            deleteDoc,
            serverTimestamp,
            onSnapshot: rawOnSnapshot,
            runTransaction,
        } =
            await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
        const {
            getAuth,
            signInAnonymously,
            initializeAuth,
            indexedDBLocalPersistence,
            browserLocalPersistence,
        } =
            await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
        signInAnonymouslyFn = signInAnonymously;

        // App Check via Cloudflare Worker. reCAPTCHA v3 doesn't survive
        // the Unity/userscript context on rocketgoal.io, so the Worker
        // signs App Check tokens for allowlisted anonymous uids instead.
        const { initializeAppCheck, CustomProvider, getToken: getAppCheckToken } =
            await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-check.js");
        const APP_CHECK_WORKER_URL = "https://atlas-appcheck.therootedengineer.workers.dev/mint";

        const app = resolveAtlasFirebaseApp(getApps(), FIREBASE_CONFIG, initializeApp);
        let atlasAppCheckHandle = null;
        try {
            dbg("AppCheck: registering CustomProvider (Worker=" + APP_CHECK_WORKER_URL + ")");
            atlasAppCheckHandle = initializeAppCheck(app, {
                provider: new CustomProvider({
                    getToken: async () => {
                        const auth = atlasFirebaseAuth;
                        const user = auth && auth.currentUser;
                        if (!user) throw new Error("no auth user yet");
                        const idToken = await user.getIdToken();
                        const resp = await fetch(APP_CHECK_WORKER_URL, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ uid: user.uid, idToken }),
                        });
                        if (!resp.ok) {
                            const errText = await resp.text().catch(() => "");
                            const msg = "Worker " + resp.status + ": " + errText;
                            dbg("AppCheck: token fetch REJECTED — " + msg);
                            _lastAppCheckToken = {
                                mintedAt: Date.now(),
                                expireTimeMillis: null,
                                len: 0,
                                error: msg,
                            };
                            throw new Error(msg);
                        }
                        const data = await resp.json();
                        const jwtExpMillis = extractJwtExpMillis(data.token);
                        const workerExpMillis = Number(data.expireTimeMillis) || null;
                        const effectiveExpMillis = workerExpMillis || jwtExpMillis || null;
                        dbg("AppCheck: token minted via Worker (len=" + (data.token?.length || 0)
                            + ", workerExpMs=" + (workerExpMillis || "missing")
                            + ", jwtExpMs=" + (jwtExpMillis || "unparsable") + ")");
                        _lastAppCheckToken = {
                            mintedAt: Date.now(),
                            expireTimeMillis: effectiveExpMillis,
                            workerExpMillis,
                            jwtExpMillis,
                            len: data.token?.length || 0,
                            error: null,
                        };
                        return { token: data.token, expireTimeMillis: effectiveExpMillis };
                    },
                }),
                isTokenAutoRefreshEnabled: true,
            });
            dbg("AppCheck: CustomProvider registered");
        } catch (err) {
            dbg("AppCheck: init THREW — " + getErrMsg(err));
        }
        const db = getFirestore(app);
        // Sign in before handing firestoreReady out; writes without
        // an auth.uid stamp get denied.
        try {
            const tm = atlasTmStorage();
            const appName = app && app.name ? app.name : "[DEFAULT]";
            if (tm) {
                hydrateAtlasAuthFromTm(tm, FIREBASE_CONFIG.apiKey, appName, localStorage);
            } else {
                // Proxy path: no Tampermonkey, restore from the Worker's
                // encrypted KV store before Firebase reads localStorage.
                await hydrateAtlasAuthFromProxyKv(FIREBASE_CONFIG.apiKey, appName, localStorage);
            }
            let auth;
            try {
                auth = initializeAuth(app, {
                    persistence: [browserLocalPersistence, indexedDBLocalPersistence],
                });
            } catch (e) {
                auth = getAuth(app);
            }
            atlasFirebaseAuth = auth;
            await ensureAnonymousAuth(auth);
            if (tm) {
                backupAtlasAuthToTm(tm, FIREBASE_CONFIG.apiKey, appName, localStorage, auth && auth.currentUser);
            } else {
                // Fire-and-forget. A failed backup doesn't block startup.
                backupAtlasAuthToProxyKv(FIREBASE_CONFIG.apiKey, appName, localStorage).catch(() => {});
            }
        } catch (authErr) {
            firebaseAuthUid = null;
            firebaseAuthError = getErrMsg(authErr);
            dbg("initFirebase: signInAnonymously failed: " + firebaseAuthError);
        }
        paintAuthUid();
        // Force an App Check token fetch now that anon auth is settled,
        // so the debug bundle records success/fail without waiting on
        // the lazy Firestore-triggered path.
        if (atlasAppCheckHandle) {
            getAppCheckToken(atlasAppCheckHandle).then(
                (result) => {
                    const tokLen = result?.token?.length || 0;
                    if (tokLen > 0) {
                        dbg("AppCheck: initial fetch ok (len=" + tokLen + ")");
                        if (!_lastAppCheckToken || !_lastAppCheckToken.mintedAt) {
                            _lastAppCheckToken = {
                                mintedAt: Date.now(),
                                expireTimeMillis: Number(result?.expireTimeMillis) || null,
                                len: tokLen,
                                error: null,
                            };
                        }
                    } else {
                        dbg("AppCheck: initial fetch returned empty");
                        _lastAppCheckToken = {
                            mintedAt: Date.now(),
                            expireTimeMillis: null,
                            len: 0,
                            error: "empty result",
                        };
                    }
                },
                (err) => {
                    const msg = getErrMsg(err);
                    dbg("AppCheck: initial fetch failed — " + msg);
                    _lastAppCheckToken = {
                        mintedAt: Date.now(),
                        expireTimeMillis: null,
                        len: 0,
                        error: msg,
                    };
                },
            );
        }
        const denySubject = () => {
            const uid = currentUidForDeny();
            return uid ? `uid=${uid}` : "";
        };
        const enrichReadDeny = (label, err) => {
            const ac = appCheckSnapshot();
            const acc = accessSnapshot();
            const likelyCauses = classifyDeny(err, { ac, acc, label });
            return { appCheck: ac, access: acc, likelyCauses };
        };
        const getDoc = async ref => {
            try {
                const snapshot = await rawGetDoc(ref);
                logRead(ref?.path || "document");
                return snapshot;
            } catch (err) {
                if (isDeny(err)) logDeny(ref?.path || "document", {
                    op: "read", path: ref?.path, err,
                    subject: denySubject(),
                    ...enrichReadDeny(ref?.path || "document", err),
                });
                throw err;
            }
        };
        const getDocs = async target => {
            try {
                const snapshot = await rawGetDocs(target);
                logRead("query", Math.max(1, snapshot.size || 0));
                return snapshot;
            } catch (err) {
                if (isDeny(err)) logDeny(target?.path || "query", {
                    op: "query", path: target?.path, err,
                    subject: denySubject(),
                    ...enrichReadDeny(target?.path || "query", err),
                });
                throw err;
            }
        };
        const getCountFromServer = async target => {
            try {
                const snapshot = await rawGetCountFromServer(target);
                logRead("count query");
                return snapshot;
            } catch (err) {
                if (isDeny(err)) logDeny(target?.path || "count query", {
                    op: "count", path: target?.path, err,
                    subject: denySubject(),
                    ...enrichReadDeny(target?.path || "count query", err),
                });
                throw err;
            }
        };
        const onSnapshot = (target, onNext, onError) =>
            rawOnSnapshot(target, snapshot => {
                logRead(target?.path || "listener", snapshot?.size || 1);
                onNext(snapshot);
            }, err => {
                if (isDeny(err)) logDeny(target?.path || "listener", {
                    op: "listener", path: target?.path, err,
                    subject: denySubject(),
                    ...enrichReadDeny(target?.path || "listener", err),
                });
                if (typeof onError === "function") onError(err);
            });

        firestoreReady = {
            db,
            doc,
            setDoc,
            getDoc,
            collection,
            query,
            where,
            getDocs,
            getCountFromServer,
            orderBy,
            limit,
            deleteDoc,
            serverTimestamp,
            onSnapshot,
            runTransaction,
        };
        isUpdateRequired(firestoreReady).then(() => {
            if (notAllowlisted) showNotAllowlistedUI();
            if (writesPaused) showWritesPausedUI();
        }).catch(() => {});
        return firestoreReady;
    } catch (e) {
        firebaseAuthError = getErrMsg(e);
        paintAuthUid();
        dbg("initFirebase failed: " + firebaseAuthError);
        console.error("[RG HUD] Firebase init failed:", e);
        showError("Firebase failed to load");
        return null;
    }
}


export async function initFirebase() {
    if (!FIREBASE_CONFIG) return null;
    if (firestoreReady && !firebaseAuthShouldRetry(firebaseAuthUid)) return firestoreReady;
    if (firestoreInitPromise) return firestoreInitPromise;
    firestoreInitPromise = firestoreReady ? retryFirebaseAuth() : initFirebaseInner();
    try {
        return await firestoreInitPromise;
    } finally {
        firestoreInitPromise = null;
    }
}


export async function retryFirebaseAuth() {
    try {
        await ensureAnonymousAuth(atlasFirebaseAuth);
        updateRequiredChecked = false;
        notAllowlisted = false;
        if (firestoreReady) await isUpdateRequired(firestoreReady);
        if (notAllowlisted) showNotAllowlistedUI();
    } catch (authErr) {
        firebaseAuthUid = null;
        firebaseAuthError = getErrMsg(authErr);
        dbg("retryFirebaseAuth failed: " + firebaseAuthError);
    }
    paintAuthUid();
    return firestoreReady;
}


export async function ensureAnonymousAuth(auth) {
    if (!auth) throw new Error("Firebase auth is not ready");
    // Persistence restore is async. Signing in before it finishes
    // creates a second uid and overwrites the saved session.
    if (typeof auth.authStateReady === "function") {
        await auth.authStateReady();
    }
    if (!auth.currentUser) await signInAnonymouslyFn(auth);
    firebaseAuthUid = auth.currentUser ? auth.currentUser.uid : null;
    firebaseAuthError = firebaseAuthUid ? null : "no-uid";
    if (!firebaseAuthUid) throw new Error("signInAnonymously resolved without a uid");
}
