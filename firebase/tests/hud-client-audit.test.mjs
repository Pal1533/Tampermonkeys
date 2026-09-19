import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { JSDOM } from "jsdom";
import {
  nickSafeColor as nickSafeColorFromModule,
  sanitizeNicknameColors as sanitizeNicknameColorsFromModule,
} from "../../src/shared/nickname-color.js";
import { clanMembers as clanMembersFromModule } from "../../src/clans/members.js";
import { canonicalClanDirectory as canonicalClanDirectoryFromModule } from "../../src/clans/directory.js";
import { sanitizeClanTag as sanitizeClanTagFromModule } from "../../src/clans/tag.js";
import { escapeHtml as escapeHtmlFromModule } from "../../src/shared/html.js";
import { hexToRgba as hexToRgbaFromModule } from "../../src/shared/color.js";
import { cleanName as cleanNameFromModule } from "../../src/identity/names.js";
import { resolveAtlasFirebaseApp as resolveAtlasFirebaseAppFromModule } from "../../src/firebase/app.js";
import { truncateForDeny as truncateForDenyFromModule } from "../../src/firebase/deny.js";
import { parseRosterInitLine as parseRosterInitLineFromModule } from "../../src/leaderboard/cache.js";
import { normalizePopupPreferences as normalizePopupPreferencesFromModule } from "../../src/leaderboard/popups.js";
import { isAtlasAdSrc as isAtlasAdSrcFromModule } from "../../src/ads.js";
import { glickoOf as glickoOfFromModule } from "../../src/matches/glicko.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(testDirectory, "..");
const hudScriptPath = process.env.HUD_SCRIPT
  ? path.resolve(process.env.HUD_SCRIPT)
  : path.resolve(workspace, "../rg_hud.user.js");
const hudSource = await readFile(hudScriptPath, "utf8");
const { buildHudSource } = await import(
  path.resolve(workspace, "../scripts/build-hud.mjs")
);

function extractHudFunction(name, context = {}) {
  const asyncStart = hudSource.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0
    ? asyncStart
    : hudSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name} in HUD`);
  const bodyStart = hudSource.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < hudSource.length; index += 1) {
    if (hudSource[index] === "{") depth += 1;
    if (hudSource[index] === "}") depth -= 1;
    if (depth === 0) {
      return vm.runInNewContext(
        `(${hudSource.slice(start, index + 1)})`,
        context,
      );
    }
  }
  throw new Error(`unterminated ${name}`);
}

function hudFunctionSource(name) {
  const asyncStart = hudSource.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0
    ? asyncStart
    : hudSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name} in HUD`);
  const signatureEnd = hudSource.indexOf(") {", start);
  assert.notEqual(signatureEnd, -1, `missing ${name} body in HUD`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  for (let index = bodyStart; index < hudSource.length; index += 1) {
    if (hudSource[index] === "{") depth += 1;
    if (hudSource[index] === "}") depth -= 1;
    if (depth === 0) return hudSource.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const redactSupportText = extractHudFunction("redactSupportText");
const normalizePopupPreferences = extractHudFunction(
  "normalizePopupPreferences",
);
const rankedPopupAllowed = extractHudFunction("rankedPopupAllowed", {
  normalizePopupPreferences,
});
const popupStackPositionStyle = extractHudFunction(
  "popupStackPositionStyle",
  { normalizePopupPreferences },
);
const advanceOpponentStreak = extractHudFunction("advanceOpponentStreak");
const streakSnipeMinimum = extractHudFunction("streakSnipeMinimum", {
  STREAK_SNIPE_MIN: 3,
});
const streakSnipeCandidates = extractHudFunction("streakSnipeCandidates", {
  RG_LB_MODES: [
    "Competitive1v1",
    "Competitive2v2",
    "Competitive3v3",
  ],
  STREAK_SNIPE_MIN: 3,
});
const nameForgePresetKey = extractHudFunction("nameForgePresetKey");
const stripClanTagPrefix = extractHudFunction("stripClanTagPrefix");

test("shipped ATLAS userscript matches the modular source bundle", async () => {
  const rebuilt = await buildHudSource();
  assert.equal(hudSource, rebuilt);
});

test("Name Forge color sanitizing is a shared module", () => {
  assert.equal(nickSafeColorFromModule("#FFA600"), "#FFA700");
  assert.equal(
    sanitizeNicknameColorsFromModule("<#FFA600>"),
    "<#FFA700>",
  );
});

test("clan and popup helpers live in source modules", () => {
  assert.deepEqual(
    clanMembersFromModule({ members: { a: { name: "A" } } }),
    [{ name: "A", userId: "a" }],
  );
  assert.equal(canonicalClanDirectoryFromModule([{ id: "z" }, { id: "a" }]).length, 2);
  assert.equal(sanitizeClanTagFromModule("ab12!"), "AB");
  assert.equal(escapeHtmlFromModule("<x>"), "&lt;x&gt;");
  assert.equal(hexToRgbaFromModule("#00ff00", 0.5), "rgba(0,255,0,0.5)");
  assert.equal(cleanNameFromModule("<#FF0000>Hi"), "Hi");
  assert.equal(truncateForDenyFromModule("  a   b  ", 3), "a b");
  const created = [];
  const app = resolveAtlasFirebaseAppFromModule([], { projectId: "rgleaderboard" }, (config, name) => {
    created.push(name || "[DEFAULT]");
    return { name: name || "[DEFAULT]", options: config };
  });
  assert.equal(app.name, "[DEFAULT]");
  assert.deepEqual(created, ["[DEFAULT]"]);
  assert.equal(
    normalizePopupPreferencesFromModule({ popupPosition: "bottom-left" }).position,
    "bottom-left",
  );
  assert.equal(
    parseRosterInitLineFromModule(
      "Initialized stats for player Foo (UserId: abc, Team: Blue)",
    )?.uid,
    "abc",
  );
  // regression: 10k-char nickname with tons of parens used to hang on the
  // old backtracking regex and drop the player from the roster.
  const monster = "(".repeat(5000) + "AAA" + ")".repeat(5000);
  const t0 = performance.now();
  const parsed = parseRosterInitLineFromModule(
    `[PlayerDataManager] Initialized stats for player: ${monster} (UserId: bigid, Team: Orange)`,
  );
  assert.equal(parsed?.uid, "bigid");
  assert.equal(parsed?.team, "Orange");
  assert.ok(performance.now() - t0 < 100, "parseRosterInitLine should be linear, not backtracking");
  assert.equal(isAtlasAdSrcFromModule("https://imasdk.googleapis.com/x.js"), true);
  assert.equal(glickoOfFromModule({ ModesGlicko: { Casual: { rd: 80 } } }, "Casual").rd, 80);
});

test("release metadata and debug logging stay synchronized", () => {
  const version = hudSource.match(/^\/\/ @version\s+(.+)$/m)?.[1].trim();
  const fallback = hudSource.match(
    /const SCRIPT_VERSION = [^\n]+\|\| "([^"]+)"/,
  )?.[1];
  assert.ok(version, "missing userscript version");
  assert.equal(version.replace(/-dev$/, ""), fallback);
  assert.match(hudSource, /const RG_DEBUG = true;/);
});

test("deny logger attaches client-side reasons (19.5+)", () => {
  // describeDenyReasons must be defined and called from atlasSetDoc's
  // catch — otherwise deny records ship without the reason list and
  // the admin panel can't say "mode must be one of [...], got X".
  assert.match(hudSource, /function describeDenyReasons\(bucket, data, opts/);
  assert.match(hudSource, /const reasons = describeDenyReasons\(label, stamped, \{ docId \}\);/);
  // Per-bucket helpers must be defined for the three write paths.
  assert.match(hudSource, /function describeLeaderboardReasons\(/);
  assert.match(hudSource, /function describeScriptSubmissionReasons\(/);
  assert.match(hudSource, /function describeMatchSnapshotReasons\(/);
  assert.match(hudSource, /\[RG HUD\]\[security\]/);
});

const resolveAtlasFirebaseApp = extractHudFunction("resolveAtlasFirebaseApp", {
  ATLAS_FIREBASE_APP_NAME: "atlas",
});
const firebaseAuthShouldRetry = extractHudFunction("firebaseAuthShouldRetry");

test("resolveAtlasFirebaseApp: empty page uses the default app like 19.9", () => {
  const created = [];
  const initializeApp = (config, name) => {
    created.push(name || "[DEFAULT]");
    return { name: name || "[DEFAULT]", options: config };
  };
  const app = resolveAtlasFirebaseApp([], { projectId: "rgleaderboard" }, initializeApp);
  assert.equal(app.name, "[DEFAULT]");
  assert.deepEqual(created, ["[DEFAULT]"]);
});

test("resolveAtlasFirebaseApp: reuses default when it is already rgleaderboard", () => {
  const existing = [{ name: "[DEFAULT]", options: { projectId: "rgleaderboard" } }];
  const app = resolveAtlasFirebaseApp(existing, { projectId: "rgleaderboard" }, () => {
    throw new Error("should not create a second app");
  });
  assert.equal(app, existing[0]);
});

test("resolveAtlasFirebaseApp: uses named atlas only when default is another project", () => {
  const existing = [{ name: "[DEFAULT]", options: { projectId: "rocketball-23c12" } }];
  const created = [];
  const initializeApp = (config, name) => {
    created.push(name);
    return { name, options: config };
  };
  const app = resolveAtlasFirebaseApp(existing, { projectId: "rgleaderboard" }, initializeApp);
  assert.equal(app.name, "atlas");
  assert.deepEqual(created, ["atlas"]);
});

test("getDeviceId keeps the same id in Tampermonkey storage after origin wipe", () => {
  assert.match(hudFunctionSource("getDeviceId"), /atlasTmStorage\(\)/);
  assert.match(hudFunctionSource("getDeviceId"), /readStoredDeviceId\(tm\)/);
  const context = { DEVICE_ID_KEY: "rgHudDeviceId" };
  const writeStoredDeviceId = extractHudFunction("writeStoredDeviceId", context);
  const readStoredDeviceId = extractHudFunction("readStoredDeviceId", context);
  const data = {};
  const storage = {
    get: (key) => data[key] ?? null,
    set: (key, value) => { data[key] = value; },
  };
  writeStoredDeviceId(storage, "device-keep");
  assert.equal(readStoredDeviceId(storage), "device-keep");
});

test("ATLAS persists Firebase Auth in Tampermonkey storage", () => {
  assert.match(hudSource, /@grant\s+GM_getValue/);
  assert.match(hudSource, /@grant\s+GM_setValue/);
  assert.match(hudSource, /@grant\s+GM_deleteValue/);
  assert.match(hudSource, /@inject-into\s+page/);
  assert.match(hudSource, /function hydrateAtlasAuthFromTm\(/);
  assert.match(hudSource, /function backupAtlasAuthToTm\(/);
  const initInner = hudFunctionSource("initFirebaseInner");
  assert.match(initInner, /initializeAuth\(app,/);
  assert.match(initInner, /hydrateAtlasAuthFromTm\(/);
  assert.match(initInner, /backupAtlasAuthToTm\(/);
  assert.match(initInner, /browserLocalPersistence/);
  assert.match(initInner, /indexedDBLocalPersistence/);
  assert.doesNotMatch(initInner, /createAtlasAuthPersistence/);
  assert.doesNotMatch(initInner, /setPersistence/);
  const initAuthAt = initInner.indexOf("initializeAuth(app,");
  const getAuthAt = initInner.indexOf("getAuth(app)");
  assert.ok(initAuthAt >= 0 && getAuthAt > initAuthAt);
});

test("hydrateAtlasAuthFromTm writes a missing Auth blob and leaves an existing one", () => {
  const hydrateAtlasAuthFromTm = extractHudFunction("hydrateAtlasAuthFromTm");
  const data = { atlasFirebaseAuthUser: '{"uid":"QQOCAgdfAkgkL22MEkVmXzIZJBk2"}' };
  const store = {};
  const localStore = {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = value; },
  };
  assert.equal(hydrateAtlasAuthFromTm(null, "key", "[DEFAULT]", localStore), false);
  assert.equal(
    hydrateAtlasAuthFromTm(
      { get: (key) => data[key] ?? null },
      "key",
      "[DEFAULT]",
      localStore,
    ),
    true,
  );
  assert.equal(store["firebase:authUser:key:[DEFAULT]"], '{"uid":"QQOCAgdfAkgkL22MEkVmXzIZJBk2"}');
  store["firebase:authUser:key:[DEFAULT]"] = '{"uid":"keep-me"}';
  hydrateAtlasAuthFromTm(
    { get: (key) => data[key] ?? null },
    "key",
    "[DEFAULT]",
    localStore,
  );
  assert.equal(store["firebase:authUser:key:[DEFAULT]"], '{"uid":"keep-me"}');
});

test("backupAtlasAuthToTm copies localStorage then falls back to user.toJSON", () => {
  const backupAtlasAuthToTm = extractHudFunction("backupAtlasAuthToTm");
  const data = {};
  const storage = {
    get: (key) => data[key] ?? null,
    set: (key, value) => { data[key] = value; },
  };
  const localStore = {
    getItem: (key) => (
      key === "firebase:authUser:key:[DEFAULT]" ? '{"uid":"from-ls"}' : null
    ),
  };
  assert.equal(backupAtlasAuthToTm(null, "key", "[DEFAULT]", localStore), false);
  assert.equal(backupAtlasAuthToTm(storage, "key", "[DEFAULT]", localStore), true);
  assert.equal(data.atlasFirebaseAuthUser, '{"uid":"from-ls"}');
  const emptyStore = { getItem: () => null };
  const emptyData = {};
  const emptyStorage = { set: (key, value) => { emptyData[key] = value; } };
  assert.equal(
    backupAtlasAuthToTm(emptyStorage, "key", "[DEFAULT]", emptyStore, {
      toJSON: () => ({ uid: "from-user" }),
    }),
    true,
  );
  assert.equal(emptyData.atlasFirebaseAuthUser, '{"uid":"from-user"}');
});

test("page hooks target the game window, not the userscript sandbox", () => {
  const pageWindow = extractHudFunction("pageWindow", {
    unsafeWindow: { id: "page" },
    window: { id: "sandbox" },
  });
  assert.equal(pageWindow().id, "page");
  const fallback = extractHudFunction("pageWindow", { window: { id: "sandbox" } });
  assert.equal(fallback().id, "sandbox");
  assert.match(hudSource, /const gameWindow = pageWindow\(\)/);
  assert.match(hudSource, /gameWindow\.fetch = async function/);
  assert.match(hudSource, /pageConsole\.log = function/);
});

test("display name storage survives a refresh for the same in-game account", () => {
  const data = {};
  const storage = {
    get: (key) => data[key] ?? null,
    set: (key, value) => { data[key] = value; },
  };
  const displayNameStorageKey = extractHudFunction("displayNameStorageKey");
  const writeStoredDisplayName = extractHudFunction("writeStoredDisplayName", {
    displayNameStorageKey,
  });
  const readStoredDisplayName = extractHudFunction("readStoredDisplayName", {
    displayNameStorageKey,
  });
  writeStoredDisplayName(storage, "cemzDSxfDgV0gvEilUGqzRFLp252", "JesusDied4U");
  assert.equal(
    readStoredDisplayName(storage, "cemzDSxfDgV0gvEilUGqzRFLp252"),
    "JesusDied4U",
  );
  assert.equal(readStoredDisplayName(storage, "someone-else"), "");
  assert.equal(readStoredDisplayName(null, "cemzDSxfDgV0gvEilUGqzRFLp252"), "");
});

test("a leaderboard name is ours when the Firebase id or in-game id matches", () => {
  const nameRowBelongsToPlayer = extractHudFunction("nameRowBelongsToPlayer");
  const isNameTakenByOthers = extractHudFunction("isNameTakenByOthers", {
    nameRowBelongsToPlayer,
  });
  const ownGame = "cemzDSxfDgV0gvEilUGqzRFLp252";
  const oldUid = "QQOCAgdfAkgkL22MEkVmXzIZJBk2";
  const newUid = "newFirebaseUid123";
  assert.equal(
    nameRowBelongsToPlayer({ sourceUserId: oldUid, rgPlayerId: ownGame }, newUid, ownGame),
    true,
  );
  assert.equal(
    nameRowBelongsToPlayer({ sourceUserId: newUid }, newUid, ownGame),
    true,
  );
  assert.equal(
    nameRowBelongsToPlayer({ sourceUserId: "other-uid", rgPlayerId: "other-game" }, newUid, ownGame),
    false,
  );
  assert.equal(
    isNameTakenByOthers(
      [{ sourceUserId: oldUid, rgPlayerId: ownGame, name: "JesusDied4U" }],
      newUid,
      ownGame,
    ),
    false,
  );
  assert.equal(
    isNameTakenByOthers(
      [{ sourceUserId: "other-uid", rgPlayerId: "other-game", name: "JesusDied4U" }],
      newUid,
      ownGame,
    ),
    true,
  );
  assert.equal(
    isNameTakenByOthers([{ name: "JesusDied4U" }], newUid, ownGame),
    true,
  );
});

test("board display names drop a clan tag prefix", () => {
  const boardNameWithoutClanTag = extractHudFunction("boardNameWithoutClanTag");
  const boardIdentityFromDocs = extractHudFunction("boardIdentityFromDocs", {
    boardNameWithoutClanTag,
  });
  const displayNameFromLeaderboardDocs = extractHudFunction(
    "displayNameFromLeaderboardDocs",
    { boardIdentityFromDocs },
  );
  assert.equal(boardNameWithoutClanTag("[KING] JesusDied4U"), "JesusDied4U");
  assert.equal(boardNameWithoutClanTag("JesusDied4U"), "JesusDied4U");
  assert.equal(
    displayNameFromLeaderboardDocs(
      [{ rgPlayerId: "cemzDSxfDgV0gvEilUGqzRFLp252", name: "[KING] JesusDied4U" }],
      "cemzDSxfDgV0gvEilUGqzRFLp252",
    ),
    "JesusDied4U",
  );
  assert.equal(
    displayNameFromLeaderboardDocs(
      [{ rgPlayerId: "other", name: "Nope" }],
      "cemzDSxfDgV0gvEilUGqzRFLp252",
    ),
    "",
  );
  assert.equal(
    boardIdentityFromDocs(
      [
        {
          rgPlayerId: "cemzDSxfDgV0gvEilUGqzRFLp252",
          playlist: "tombstone",
          name: "OldTwin",
          sourceUserId: "old-uid",
        },
        {
          rgPlayerId: "cemzDSxfDgV0gvEilUGqzRFLp252",
          playlist: "3v3",
          name: "[KING] JesusDied4U",
          sourceUserId: "new-uid",
        },
      ],
      "cemzDSxfDgV0gvEilUGqzRFLp252",
    ).sourceUserId,
    "new-uid",
  );
});

test("a new Firebase id does not publish a second row for the same in-game account", () => {
  const shouldPublishLeaderboardRow = extractHudFunction("shouldPublishLeaderboardRow");
  assert.equal(shouldPublishLeaderboardRow("", "new-uid"), true);
  assert.equal(shouldPublishLeaderboardRow("old-uid", "old-uid"), true);
  assert.equal(shouldPublishLeaderboardRow("old-uid", "new-uid"), false);
  assert.equal(
    shouldPublishLeaderboardRow(["old-uid", "new-uid"], "new-uid"),
    true,
  );
  const sync = hudFunctionSource("syncToRealLeaderboard");
  assert.match(sync, /shouldPublishLeaderboardRow\(/);
  assert.doesNotMatch(sync, /limit\(1\)/);
  assert.match(sync, /playlist !== "tombstone"/);
  const submit = hudFunctionSource("submitToLeaderboardInner");
  const boardCall = submit.indexOf("syncToRealLeaderboard(");
  const snapshotSet = submit.indexOf("lastSyncSnapshot.set(");
  assert.ok(boardCall >= 0 && snapshotSet > boardCall);
});

test("leaderboard submit reuses a stored or board name before prompting", () => {
  const inner = hudFunctionSource("submitToLeaderboardInner");
  assert.match(inner, /readStoredDisplayName\(/);
  assert.match(inner, /writeStoredDisplayName\(/);
  assert.match(inner, /lookupDisplayNameFromBoard\(/);
  assert.match(inner, /isNameTaken\(fb, suggestion, firebaseAuthUid, data\.Id\)/);
  assert.match(hudSource, /askDisplayName\(suggestion, isRename, fb, firebaseAuthUid, data\.Id\)/);
});

test("ensureAnonymousAuth waits for a restored session before minting a uid", async () => {
  let signIns = 0;
  const context = {
    signInAnonymouslyFn: async (auth) => {
      signIns += 1;
      auth.currentUser = { uid: "new-uid" };
    },
    firebaseAuthUid: null,
    firebaseAuthError: null,
  };
  const ensureAnonymousAuth = extractHudFunction("ensureAnonymousAuth", context);

  const restored = {
    currentUser: { uid: "QQOCAgdfAkgkL22MEkVmXzIZJBk2" },
    authStateReady: async () => {},
  };
  await ensureAnonymousAuth(restored);
  assert.equal(signIns, 0);
  assert.equal(context.firebaseAuthUid, "QQOCAgdfAkgkL22MEkVmXzIZJBk2");

  const fresh = { currentUser: null, authStateReady: async () => {} };
  await ensureAnonymousAuth(fresh);
  assert.equal(signIns, 1);
  assert.equal(context.firebaseAuthUid, "new-uid");
});

test("firebaseAuthShouldRetry: Settings retry stays live until a uid exists", () => {
  assert.equal(firebaseAuthShouldRetry(null), true);
  assert.equal(firebaseAuthShouldRetry(""), true);
  assert.equal(firebaseAuthShouldRetry("QQOCAgdfAkgkL22MEkVmXzIZJBk2"), false);
});

test("Firebase id row retries auth instead of staying on signing in", () => {
  const initSource = hudFunctionSource("initFirebase");
  assert.match(hudSource, /function paintAuthUid\(/);
  assert.match(hudSource, /function retryFirebaseAuth\(/);
  assert.match(initSource, /firebaseAuthShouldRetry\(firebaseAuthUid\)/);
  assert.match(initSource, /retryFirebaseAuth\(\)/);
  assert.match(hudSource, /tap Settings to retry/);
  assert.doesNotMatch(initSource, /sign-in timed out/);
});

test("HUD errors tell the player to message RIS3N or Pal on Discord", () => {
  const formatAtlasError = extractHudFunction("formatAtlasError");
  assert.equal(
    formatAtlasError("Stats submission failed -- check console"),
    "Stats submission failed, message RIS3N or Pal on Discord",
  );
  assert.equal(
    formatAtlasError("Firebase failed to load"),
    "Firebase failed to load, message RIS3N or Pal on Discord",
  );
  assert.match(hudFunctionSource("showError"), /formatAtlasError\(/);
});

test("HUD tells unlisted players to ask Pal or Jesus on Discord", () => {
  assert.match(hudSource, /https:\/\/discord\.gg\/MDz7hsrh9m/);
  assert.match(hudSource, /function showNotAllowlistedUI/);
  assert.match(hudSource, /isAllowlistGatedLabel/);
  const gate = hudFunctionSource("isUpdateRequired");
  assert.match(gate, /admin", "gate"/);
  assert.match(gate, /notAllowlisted = true/);
  assert.doesNotMatch(gate, /allowedUserIds/);
});

test("clan MMR sync skips Firestore when no event is active", () => {
  const source = hudFunctionSource("updateMyClanMMR");
  assert.match(source, /eventPhase\(\) !== "active"/);
  assert.match(source, /Clan MMR write skipped: no active event/);
  assert.match(source, /await loadEventConfig\(fb\)/);
  assert.doesNotMatch(
    source.slice(0, source.indexOf("Clan MMR write skipped")),
    /loadClanData\(true\)/,
  );
});

test("every client mutation path uses the central version gate", () => {
  const mutationPaths = [
    "submitToLeaderboardInner",
    "upsertPlaylistEntry",
    "updateMyClanMMR",
    "maybeCaptureEventBaseline",
    "linkCurrentClanDevice",
    "saveClanTagStyle",
    "createClan",
    "requestJoin",
    "approveRequest",
    "kickMember",
    "writeClanNotice",
    "checkClanNotices",
    "setMemberRole",
    "editClan",
    "transferLeadership",
    "leaveClan",
  ];
  for (const name of mutationPaths) {
    assert.match(
      hudFunctionSource(name),
      /\b(?:atlasSetDoc|atlasDeleteDoc|runAtlasTransaction)\s*\(/,
      `${name} bypasses the centralized mutation gate`,
    );
  }

  const gate = hudFunctionSource("atlasMutationAllowed");
  assert.match(gate, /isUpdateRequired\(fb\)/);
  assert.match(gate, /showUpdateRequiredUI\(\)/);
});

test("every clan write carries the forced-upgrade version", () => {
  const atlasStampedMutationData = extractHudFunction(
    "atlasStampedMutationData",
    {
      SCRIPT_VERSION: "16.1",
      SCRIPT_VERSION_NUM: 16.1,
      getDeviceId: () => "device-bound",
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(atlasStampedMutationData(
      { path: "clans/clan-one" },
      { totalMMR: 1234 },
    ))),
    {
      totalMMR: 1234,
      deviceId: "device-bound",
      scriptVersion: "16.1",
      versionNum: 16.1,
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(atlasStampedMutationData(
      { path: "clans_directory/clan-one" },
      { totalMMR: 1234 },
    ))),
    {
      totalMMR: 1234,
      deviceId: "device-bound",
    },
  );
});

test("outdated clients see one update UI while reads stay available", async () => {
  let updateUiCount = 0;
  const uiContext = {
    updateRequiredUiShown: false,
    showBanner: () => { updateUiCount += 1; },
  };
  const showUpdateRequiredUI = extractHudFunction(
    "showUpdateRequiredUI",
    uiContext,
  );
  showUpdateRequiredUI();
  showUpdateRequiredUI();
  assert.equal(updateUiCount, 1);

  const atlasMutationAllowed = extractHudFunction("atlasMutationAllowed", {
    isUpdateRequired: async () => true,
    writesPaused: false,
    updateRequired: true,
    notAllowlisted: false,
    isAllowlistGatedLabel: () => false,
    showUpdateRequiredUI,
    showNotAllowlistedUI: () => {},
    dbg: () => {},
  });
  assert.equal(await atlasMutationAllowed({}, "test write"), false);

  for (const readName of [
    "loadEventConfig",
    "loadClanRolePerms",
    "loadClanData",
    "fetchLeaderboardCache",
  ]) {
    assert.doesNotMatch(
      hudFunctionSource(readName),
      /atlasMutationAllowed\(/,
      `${readName} blocks a read`,
    );
  }
});

test("clan load never lists the entire clans_directory collection", () => {
  assert.match(hudSource, /async function loadClanDirectoryLite\(/);
  assert.doesNotMatch(
    hudSource,
    /getDocs\(\s*fb\.collection\(\s*fb\.db,\s*"clans_directory"\s*\)/,
  );
  assert.doesNotMatch(
    hudSource,
    /getDocs\(\s*fb\.collection\(\s*fb\.db,\s*"clans"\s*\)/,
  );

  const load = hudFunctionSource("loadClanDataInner");
  assert.match(load, /clan_memberships/);
  assert.match(load, /clan_devices/);
  assert.match(load, /loadClanDirectoryLite\(/);
  assert.match(load, /fb\.doc\(\s*fb\.db,\s*"clans",\s*mine\.id\s*\)/);
  assert.match(load, /membership,/);
  assert.match(load, /device,/);
  assert.match(load, /linkPlan\.repairClan/);
  assert.match(load, /const previousClan = myClan/);
  assert.match(load, /nextClan = previousClan/);
  assert.doesNotMatch(load, /if \(useReservations\s*\n?\s*\|\|/);

  const lite = hudFunctionSource("loadClanDirectoryLite");
  assert.match(lite, /clans_directory",\s*"index"/);
  assert.match(lite, /clans_directory",\s*clanId/);
  assert.doesNotMatch(lite, /getDocs\(/);
  assert.doesNotMatch(lite, /fb\.limit\(/);
  assert.match(lite, /firestoreReadBudgetPassed\(/);

  const refresh = hudFunctionSource("refreshDirectory");
  assert.match(refresh, /loadClanDirectoryLite\(/);
  assert.match(refresh, /firestoreReadBudgetPassed\(/);
  assert.doesNotMatch(refresh, /getDocs\(/);
  assert.doesNotMatch(refresh, /atlasSetDoc\(/);

  assert.match(
    hudFunctionSource("fetchLeaderboardCache"),
    /firestoreReadBudgetPassed\(/,
  );
});

test("loadClanDirectoryLite point-reads index and shard, never getDocs", async () => {
  const calls = [];
  const canonicalClanDirectory = extractHudFunction("canonicalClanDirectory");
  const putClanInDirectory = extractHudFunction("putClanInDirectory", {
    canonicalClanDirectory,
  });
  const loadClanDirectoryLite = extractHudFunction("loadClanDirectoryLite", {
    firestoreReadBudgetPassed: () => false,
    putClanInDirectory,
    canonicalClanDirectory,
    clanDirectory: [],
    dbg: () => {},
  });
  const fb = {
    db: {},
    doc: (_db, collectionName, id) => ({ path: `${collectionName}/${id}` }),
    collection: () => {
      throw new Error("must not list a collection");
    },
    query: () => {
      throw new Error("must not query when the index exists");
    },
    limit: (count) => ({ limit: count }),
    getDoc: async (ref) => {
      calls.push(["getDoc", ref.path]);
      if (ref.path === "clans_directory/index") {
        return {
          exists: () => true,
          data: () => ({ clans: [{ id: "other", name: "Other" }] }),
        };
      }
      if (ref.path === "clans_directory/king") {
        return {
          exists: () => true,
          data: () => ({ id: "king", name: "KING", tag: "KING" }),
        };
      }
      return { exists: () => false, data: () => ({}) };
    },
    getDocs: async () => {
      calls.push(["getDocs"]);
      throw new Error("must not list clans_directory");
    },
  };
  const result = await loadClanDirectoryLite(fb, "king");
  assert.deepEqual(calls, [
    ["getDoc", "clans_directory/index"],
    ["getDoc", "clans_directory/king"],
  ]);
  assert.equal(result.some((clan) => clan.id === "king"), true);
  assert.equal(result.some((clan) => clan.id === "other"), true);
});

test("loadClanDirectoryLite does not query when the index is missing", async () => {
  const calls = [];
  const canonicalClanDirectory = extractHudFunction("canonicalClanDirectory");
  const putClanInDirectory = extractHudFunction("putClanInDirectory", {
    canonicalClanDirectory,
  });
  const loadClanDirectoryLite = extractHudFunction("loadClanDirectoryLite", {
    firestoreReadBudgetPassed: () => false,
    putClanInDirectory,
    canonicalClanDirectory,
    clanDirectory: [],
    dbg: () => {},
  });
  const fb = {
    db: {},
    doc: (_db, collectionName, id) => ({ path: `${collectionName}/${id}` }),
    collection: () => {
      throw new Error("must not list a collection");
    },
    query: () => {
      throw new Error("must not query when the index is missing");
    },
    limit: () => {
      throw new Error("must not limit a directory query");
    },
    getDoc: async (ref) => {
      calls.push(["getDoc", ref.path]);
      if (ref.path === "clans_directory/king") {
        return {
          exists: () => true,
          data: () => ({ id: "king", name: "KING", tag: "KING" }),
        };
      }
      return { exists: () => false, data: () => ({}) };
    },
    getDocs: async () => {
      calls.push(["getDocs"]);
      throw new Error("must not list clans_directory");
    },
  };
  const result = await loadClanDirectoryLite(fb, "king");
  assert.deepEqual(calls, [
    ["getDoc", "clans_directory/index"],
    ["getDoc", "clans_directory/king"],
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "king");
});

test("Firestore diagnostics use rolling budgets without losing session totals", () => {
  assert.match(hudSource, /let firestoreReadCount = 0;/);
  assert.match(hudSource, /function logRead\(/);
  assert.match(hudSource, /FIRESTORE_READ_BUDGET/);
  assert.match(hudSource, /FIRESTORE_WRITE_BUDGET/);
  assert.match(hudSource, /FIRESTORE_BUDGET_WINDOW_MS/);
  assert.match(hudSource, /function nextFirestoreBudgetWindow\(/);
  assert.match(hudSource, /firestore:\s*\{[\s\S]*reads:\s*firestoreReadCount/);
  assert.match(hudSource, /writes:\s*firestoreWriteCount/);
  assert.match(hudSource, /windowReads:\s*firestoreBudgetWindow\.reads/);
  assert.match(hudSource, /windowWrites:\s*firestoreBudgetWindow\.writes/);

  const nextFirestoreBudgetWindow = extractHudFunction(
    "nextFirestoreBudgetWindow",
    { FIRESTORE_BUDGET_WINDOW_MS: 10 * 60 * 1000 },
  );
  const active = {
    startedAt: 1_000,
    reads: 120,
    writes: 40,
    readWarned: true,
    writeWarned: true,
  };
  assert.equal(nextFirestoreBudgetWindow(active, 2_000), active);
  assert.deepEqual(
    JSON.parse(JSON.stringify(nextFirestoreBudgetWindow(active, 601_000))),
    {
      startedAt: 601_000,
      reads: 0,
      writes: 0,
      readWarned: false,
      writeWarned: false,
    },
  );
});

test("denied match audits stay disabled", () => {
  const source = hudFunctionSource("writeMatchAudit");
  assert.match(source, /disabled/i);
  assert.doesNotMatch(source, /\.(?:addDoc|setDoc|runTransaction)\s*\(/);
  assert.doesNotMatch(hudSource, /["']match_audits["']\),\s*audit/);
});

test("sourced leaderboard writes use deterministic ids only", () => {
  const source = hudFunctionSource("upsertPlaylistEntry");
  assert.match(
    source,
    /fb\.doc\(fb\.db,\s*REAL_LEADERBOARD_COLLECTION,\s*deterministicId\)/,
  );
  assert.doesNotMatch(source, /fb\.(?:query|getDocs|addDoc)\s*\(/);
  assert.doesNotMatch(source, /\.deleteDoc\s*\(/);
});

test("support bundle redacts stable identifiers and full user agents", () => {
  const deviceId = "device-123456789";
  const userAgent = "Example Browser/123.4";
  const playerId = "player-secret-id";
  const safe = redactSupportText(
    `device=${deviceId}\nua=${userAgent}\nplayer=${playerId}`,
    [deviceId, userAgent, playerId],
  );
  assert.doesNotMatch(safe, /device-123456789|Example Browser|player-secret-id/);
  assert.equal((safe.match(/\[redacted\]/g) || []).length, 3);

  const debugStart = hudSource.indexOf(
    'document.getElementById("rgSetCopyDebug").onclick',
  );
  const debugEnd = hudSource.indexOf(
    "// handler early-returns",
    debugStart,
  );
  const debugSource = hudSource.slice(debugStart, debugEnd);
  assert.match(debugSource, /hudExists: !!q\("rgHUD"\)/);
  assert.match(debugSource, /firebaseId:\s*firebaseAuthUid/);
  assert.match(debugSource, /deviceId:\s*getDeviceId\(\)/);
  assert.doesNotMatch(debugSource, /userAgent:\s*/);
  assert.match(debugSource, /redactSupportText\(text, redactions\)/);
  assert.match(debugSource, /rgDump: _rgLogBuf\.slice\(\)/);
  assert.match(debugSource, /JSON\.stringify\(payload,/);
});

test("settings keep the streak toggle and remove ranked popup controls", () => {
  const resetStart = hudSource.indexOf(
    'document.getElementById("rgSetReset").onclick',
  );
  const resetEnd = hudSource.indexOf(
    "// trim player data",
    resetStart,
  );
  const resetSource = hudSource.slice(resetStart, resetEnd);
  assert.match(resetSource, /applyTitle\(\)/);

  for (const id of [
    "rgSetPopupOpponents",
    "rgSetPopupTeammates",
    "rgSetPopupMaxRank",
    "rgSetPopupDuration",
    "rgSetPopupPosition",
  ]) {
    assert.doesNotMatch(hudSource, new RegExp(`id="${id}"`));
    assert.doesNotMatch(hudSource, new RegExp(`getElementById\\("${id}"\\)`));
  }

  assert.doesNotMatch(hudSource, /Ranked player popups/);
  assert.doesNotMatch(hudSource, /applyPopupPreferencesToOpenStack/);
  assert.match(hudSource, /id="rgSetStreakSnipe"/);
  assert.match(hudSource, /settings\.streakSnipeEnabled = setStreakSnipe\.checked/);
  assert.doesNotMatch(hudSource, /rgSetPreviewStreakSnipe|Preview streak snipe/i);
});

test("streak publication piggybacks the existing merged submission", () => {
  const submission = hudFunctionSource("submitToLeaderboardInner");
  assert.match(
    submission,
    /currentStreak:\s*streakData\?\.accountId === data\.Id/,
  );
  assert.match(
    submission,
    /currentStreak:\s*payload\.currentStreak/,
  );
  assert.match(
    submission,
    /atlasSetDoc\([\s\S]*"script_submissions"[\s\S]*\{\s*merge:\s*true\s*\}/,
  );
  assert.equal(
    (submission.match(/"script_submissions"/g) || []).length,
    1,
    "streak publication must not add another Firestore write",
  );
});

test("opponent streak inference accepts publication and safe deltas", () => {
  const published = advanceOpponentStreak(null, 10, 20, 7, 1000);
  assert.deepEqual(
    JSON.parse(JSON.stringify(published)),
    {
      streak: 7,
      confident: true,
      lastWins: 10,
      lastMatches: 20,
      updatedAt: 1000,
    },
  );

  const baseline = advanceOpponentStreak(null, 10, 20, null, 1000);
  assert.equal(baseline.confident, false);
  const inferred = advanceOpponentStreak(baseline, 12, 22, null, 2000);
  assert.equal(inferred.streak, 2);
  assert.equal(inferred.confident, true);
});

test("streak snipe threshold is clamped without a match-end config read", () => {
  assert.equal(streakSnipeMinimum(undefined), 3);
  assert.equal(streakSnipeMinimum({ streakSnipeMin: -8 }), 1);
  assert.equal(streakSnipeMinimum({ streakSnipeMin: 999 }), 100);

  const maybeSource = hudFunctionSource("maybeShowStreakSnipe");
  assert.match(maybeSource, /config = _remoteConfigMemo/);
  assert.match(maybeSource, /settings\.streakSnipeEnabled === false/);
  assert.doesNotMatch(maybeSource, /getRemoteConfig\(/);

  const matchEndSource = hudSource.slice(
    hudSource.indexOf('if (url.includes("/v0304_player/matchEnd"))'),
    hudSource.indexOf('} else if (url.includes("/v0304_login/login"))'),
  );
  const triggerStart = matchEndSource.indexOf("maybeShowStreakSnipe(");
  const triggerEnd = matchEndSource.indexOf(");", triggerStart);
  assert.notEqual(triggerStart, -1);
  assert.doesNotMatch(
    matchEndSource.slice(triggerStart, triggerEnd + 2),
    /getRemoteConfig\(/,
  );
});

test("streak snipe selects the strongest tracked opponent after a win", () => {
  const candidates = streakSnipeCandidates(
    { Competitive1v1: 1200 },
    { Competitive1v1: 1212 },
    [
      { name: "Three", streak: 3, confident: true, isTeammate: false },
      { name: "Eight", streak: 8, confident: true, isTeammate: false },
      { name: "Teammate", streak: 20, confident: true, isTeammate: true },
      { name: "Guess", streak: 30, confident: false, isTeammate: false },
    ],
    3,
  );
  assert.deepEqual(
    Array.from(candidates, candidate => candidate.name),
    ["Eight", "Three"],
  );
  assert.equal(
    streakSnipeCandidates(
      { Competitive1v1: 1200 },
      { Competitive1v1: 1190 },
      [{ streak: 8, confident: true, isTeammate: false }],
      3,
    ).length,
    0,
  );
});

test("ranked popups match roster logs on in-game id only", () => {
  const lookupInCache = extractHudFunction("lookupInCache");
  const cache = {
    modes: {
      Competitive3v3: [
        { uid: "legacy-in-game", name: "Johnny Football", mmr: 9000, rank: 4 },
        {
          uid: "firebase-uid",
          rgPlayerId: "in-game-id",
          name: "Xuuya",
          mmr: 10193,
          rank: 1,
        },
      ],
    },
  };
  assert.equal(
    lookupInCache(cache, "legacy-in-game", "Competitive3v3")?.name,
    "Johnny Football",
  );
  assert.equal(
    lookupInCache(cache, "in-game-id", "Competitive3v3")?.name,
    "Xuuya",
  );
  assert.equal(lookupInCache(cache, "firebase-uid", "Competitive3v3"), null);
  assert.equal(lookupInCache(cache, "unknown", "Competitive3v3"), null);
  assert.match(hudSource, /rgHudLbCache_v4/);
  assert.equal(
    /leaderboard aggregate missing rgPlayerId/.test(hudSource),
    false,
  );
});

test("ranked popups keep fixed defaults and show opponent streak badges", () => {
  assert.match(
    hudSource,
    /const RANKED_POPUP_PREFERENCES = Object\.freeze\(/,
  );
  assert.match(
    hudFunctionSource("showLbOpponentPopup"),
    /preferences \|\| RANKED_POPUP_PREFERENCES/,
  );
  for (const name of [
    "fireAllRankedPopups",
    "firePostmortemPopupsIfDeferred",
  ]) {
    assert.match(
      hudFunctionSource(name),
      /normalizePopupPreferences\(RANKED_POPUP_PREFERENCES\)/,
    );
  }
  assert.match(hudSource, /class="rg-lb-streak"/);
  assert.match(hudSource, /_matchOpponentStreaks\.set\(/);
});

test("streak snipe uses the selected precision timing and safe text nodes", () => {
  const styles = hudSource.slice(
    hudSource.indexOf("function ensureStreakSnipeStyles()"),
    hudSource.indexOf("function showStreakSnipeOverlay("),
  );
  assert.match(styles, /rgSnipeOverlay 7\.2s/);
  assert.match(styles, /0%, 29%[\s\S]*31%/);
  assert.match(styles, /45%, 96\.5% \{ opacity: 1/);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: 4\.8s/,
  );

  const overlay = hudFunctionSource("showStreakSnipeOverlay");
  assert.match(overlay, /title\.textContent/);
  assert.match(overlay, /value\.textContent/);
  assert.match(overlay, /prefersReducedPopupMotion\(\) \? 4850 : 7250/);
  assert.doesNotMatch(overlay, /\.innerHTML\s*=/);
});

test("account switches clear every rank cache", () => {
  const context = {
    cachedRanks: new Map([["1v1", 1]]),
    cachedMmrToNext: new Map([["1v1", 10]]),
    prevRanks: new Map([["1v1", 2]]),
    lastRankedMMR: new Map([["1v1", 2200]]),
    lastRankedAt: new Map([["1v1", Date.now()]]),
    ranksFetchedThisSession: true,
  };
  const resetAccountRankState = extractHudFunction(
    "resetAccountRankState",
    context,
  );
  resetAccountRankState();
  assert.equal(context.cachedRanks.size, 0);
  assert.equal(context.cachedMmrToNext.size, 0);
  assert.equal(context.prevRanks.size, 0);
  assert.equal(context.lastRankedMMR.size, 0);
  assert.equal(context.lastRankedAt.size, 0);
  assert.equal(context.ranksFetchedThisSession, false);

  const sessionStart = hudSource.indexOf("function captureSessionStart(data)");
  const deltaStart = hudSource.indexOf("function deltaBadge(", sessionStart);
  assert.match(
    hudSource.slice(sessionStart, deltaStart),
    /resetAccountRankState\(\)/,
  );
});

test("kick and disband notices delete only after acknowledgement", async () => {
  const events = [];
  let acknowledge;
  const fb = {
    db: {},
    doc: (_db, collectionName, id) => `${collectionName}/${id}`,
    getDoc: async () => ({
      exists: () => true,
      data: () => ({
        type: "kicked",
        clanName: "Test Clan",
        message: "Event rule",
      }),
    }),
    deleteDoc: async (ref) => events.push(["delete", ref]),
  };
  const checkClanNotices = extractHudFunction("checkClanNotices", {
    initFirebase: async () => fb,
    myUserId: () => "player-one",
    showDialog: async () => new Promise((resolve) => {
      acknowledge = () => {
        events.push(["ack"]);
        resolve(true);
      };
    }),
    atlasDeleteDoc: async (_fb, _label, ref) => fb.deleteDoc(ref),
    dbg: () => {},
    dbgWarn: () => {},
  });

  const pending = checkClanNotices();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);
  acknowledge();
  await pending;
  assert.deepEqual(events, [
    ["ack"],
    ["delete", "clan_notices/player-one"],
  ]);

  const listenerStart = hudSource.indexOf("async function attachClanListener()");
  const listenerEnd = hudSource.indexOf(
    "function detachClanListener()",
    listenerStart,
  );
  assert.match(
    hudSource.slice(listenerStart, listenerEnd),
    /scheduleClanNoticeCheck\(500\)/,
  );
});

test("HUD dragging keeps unrelated document mouse handlers", () => {
  const dom = new JSDOM(
    '<div id="hud"><div id="handle"></div></div>',
    { url: "https://rocketgoal.io/" },
  );
  const { document } = dom.window;
  const hud = document.getElementById("hud");
  const handle = document.getElementById("handle");
  for (const [key, value] of [
    ["offsetTop", 40],
    ["offsetLeft", 40],
    ["offsetWidth", 300],
  ]) {
    Object.defineProperty(hud, key, { configurable: true, value });
  }

  let propertyHandlerCalls = 0;
  let listenerCalls = 0;
  document.onmousemove = () => { propertyHandlerCalls += 1; };
  document.addEventListener("mousemove", () => { listenerCalls += 1; });
  const dragElement = extractHudFunction("dragElement", {
    document,
    window: dom.window,
    localStorage: dom.window.localStorage,
    dbg: () => {},
  });
  dragElement(hud, handle);

  handle.dispatchEvent(new dom.window.MouseEvent("mousedown", {
    bubbles: true,
    clientX: 100,
    clientY: 100,
  }));
  document.dispatchEvent(new dom.window.MouseEvent("mousemove", {
    bubbles: true,
    clientX: 90,
    clientY: 90,
  }));
  document.dispatchEvent(new dom.window.MouseEvent("mouseup", {
    bubbles: true,
  }));

  assert.equal(propertyHandlerCalls, 1);
  assert.equal(listenerCalls, 1);
  assert.equal(typeof document.onmousemove, "function");
});

test("popup preferences cover roles, safe corners, and reduced motion", () => {
  assert.equal(
    rankedPopupAllowed(
      1,
      false,
      { popupEnabled: true, minRankToShow: 100 },
      { popupShowOpponents: false, popupShowTeammates: true },
    ),
    false,
  );
  assert.equal(
    rankedPopupAllowed(
      1,
      null,
      { popupEnabled: true, minRankToShow: 100 },
      { popupShowOpponents: false, popupShowTeammates: true },
    ),
    true,
  );
  assert.deepEqual(
    { ...popupStackPositionStyle("top-left") },
    {
      top: "20px",
      bottom: "auto",
      left: "20px",
      right: "auto",
      flexDirection: "column",
    },
  );
  assert.match(
    hudSource,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/,
  );
});

test("login response moves Name Forge onto the authenticated account", () => {
  const calls = [];
  const syncForgeFromLogin = extractHudFunction("syncForgeFromLogin", {
    cleanName: (value) => value.replace(/<[^>]*>/g, "").trim(),
    stripLeadingClanTagMarkup: (value) => value.replace(/^\[RG\]\s*/, ""),
    RGNF: {
      syncToCurrentPlayer: (...args) => calls.push(["sync", ...args]),
      verifyStolenName: (...args) => calls.push(["verify", ...args]),
    },
  });
  assert.equal(
    syncForgeFromLogin({
      Id: "player-2",
      Nickname: "[RG] <#FFFFFF>RIS3N",
    }),
    true,
  );
  assert.deepEqual(calls, [
    ["sync", "player-2", "RIS3N", "<#FFFFFF>RIS3N"],
    ["verify", "[RG] <#FFFFFF>RIS3N"],
  ]);
  assert.equal(syncForgeFromLogin({ Nickname: "Missing id" }), false);
});

test("Name Forge keeps paint help readable and long TMP code scrollable", () => {
  assert.match(
    hudSource,
    /\.rgnf-paintbar\s*\{[^}]*flex-wrap:\s*wrap/s,
  );
  assert.match(
    hudSource,
    /\.rgnf-code\s*\{[^}]*max-height:\s*180px/s,
  );
  assert.match(
    hudSource,
    /rawEdit\.style\.cssText\s*=\s*'[^']*overflow-y:auto/,
  );
});

test("Name Forge preset folders list labels, not TMP name previews", () => {
  assert.match(hudSource, /el\('span', \{ text: p\.label, title: p\.label \}\)/);
  assert.doesNotMatch(hudSource, /presetCell\.appendChild\(renderRawTMP/);
});

test("HUD input isolation yields embedded Name Forge shortcuts", () => {
  const isNameForgeInput = extractHudFunction("isNameForgeInput");
  assert.equal(
    isNameForgeInput({
      closest: (selector) => selector === ".rgnf-panel" ? {} : null,
    }),
    true,
  );
  assert.equal(isNameForgeInput({ closest: () => null }), false);
  assert.equal(isNameForgeInput(null), false);
  assert.match(hudSource, /if \(isNameForgeInput\(active\)\) return;/);
});

test("Name Forge can paint a highlighted slice without recoloring the rest", () => {
  const normalizeColorSpans = extractHudFunction("normalizeColorSpans");
  const colorStyleAt = extractHudFunction("colorStyleAt");
  const cloneColorStyle = extractHudFunction("cloneColorStyle");
  const bakeUncoveredColorSpans = extractHudFunction("bakeUncoveredColorSpans", {
    normalizeColorSpans,
    cloneColorStyle,
  });
  const subtractColorRange = extractHudFunction("subtractColorRange", {
    cloneColorStyle,
  });
  const applySliceColor = extractHudFunction("applySliceColor", {
    bakeUncoveredColorSpans,
    subtractColorRange,
    cloneColorStyle,
    normalizeColorSpans,
  });
  const splitByColorSpans = extractHudFunction("splitByColorSpans", {
    normalizeColorSpans,
    colorStyleAt,
  });
  const fallback = {
    mode: "gradient",
    solid: "#00ff00",
    stops: ["#00ff00", "#0000ff"],
    solidAlpha: 255,
  };
  const runs = splitByColorSpans("ABCDEF", [
    { start: 2, end: 4, mode: "solid", solid: "#ff0000", stops: [] },
  ], fallback);
  assert.equal(runs.map((run) => run.text).join(""), "ABCDEF");
  assert.equal(runs[0].style.mode, "gradient");
  assert.equal(runs[1].text, "CD");
  assert.equal(runs[1].style.solid, "#ff0000");
  assert.equal(runs[2].style.mode, "gradient");
  const laterWins = splitByColorSpans("ABCDEF", [
    { start: 0, end: 6, mode: "solid", solid: "#111111", stops: [] },
    { start: 2, end: 4, mode: "gradient", solid: "#222222", stops: ["#aaaaaa", "#bbbbbb"] },
  ], fallback);
  assert.equal(laterWins[1].style.mode, "gradient");
  const before = {
    mode: "gradient",
    solid: "#111111",
    stops: ["#ff8800", "#ff0000"],
    solidAlpha: 255,
  };
  const after = {
    mode: "solid",
    solid: "#00ffff",
    stops: ["#00ffff"],
    solidAlpha: 255,
  };
  const sliced = applySliceColor([], 6, { start: 2, end: 4 }, before, after);
  const slicedRuns = splitByColorSpans("ABCDEF", sliced, after);
  assert.equal(slicedRuns[0].style.stops[0], "#ff8800");
  assert.equal(slicedRuns[1].style.solid, "#00ffff");
  assert.equal(slicedRuns[2].style.stops[0], "#ff8800");
  assert.match(hudSource, /commitNameColor\(/);
  assert.match(hudSource, /Painting the highlighted text only/);
  assert.match(hudSource, /isPaintSpaceEl\(/);
  assert.match(hudSource, /dataset\.forgeI/);
  assert.match(hudSource, /rgnf-paintbar/);
  assert.match(hudSource, /wirePreviewPaint\(/);
  assert.match(hudSource, /function setPreviewZoom\(/);
  assert.match(hudSource, /Does not change the in-game name size/);
  assert.match(hudFunctionSource("renderRawPreview"), /makePaintBar\(/);
  assert.match(hudFunctionSource("renderRawPreview"), /wirePreviewPaint\(/);
  assert.match(hudFunctionSource("renderRawTMP"), /dataset\.forgeI/);
  const nickSafeColor = extractHudFunction("nickSafeColor");
  const expandPaintHex = extractHudFunction("expandPaintHex", { nickSafeColor });
  const colorSpansFromRawName = extractHudFunction("colorSpansFromRawName", {
    expandPaintHex,
    normalizeColorSpans,
  });
  const fromRaw = colorSpansFromRawName("<#7A4E08>.<#835703>+", ".+");
  assert.equal(fromRaw.length, 2);
  assert.equal(fromRaw[0].solid, "#7A4E08");
  assert.equal(fromRaw[0].start, 0);
  assert.equal(fromRaw[0].end, 1);
  assert.equal(fromRaw[1].solid, "#835703");
  const fromPadded = colorSpansFromRawName("<#7A4E08>.<#835703>+\u00A0\u00A0", ".+");
  assert.equal(fromPadded.length, 2);
  assert.equal(fromPadded[1].end, 2);
  assert.match(hudFunctionSource("commitNameColor"), /const range = namePaintRange/);
  assert.match(hudFunctionSource("commitNameColor"), /A lost highlight must not/);
});

test("Name Forge layers overlay the name, not a title on a later line", () => {
  const spliceLayersOnFirstLine = extractHudFunction("spliceLayersOnFirstLine", {
    layersMarkup: () => "<pos=0>LAYER",
  });
  assert.equal(
    spliceLayersOnFirstLine(
      "<b><align=center>RIS3N</align></b><br><br><#FF0000>test",
      { layers: [{ text: "RIS3N" }] },
    ),
    "<b><align=center>RIS3N</align></b><pos=0>LAYER<br><br><#FF0000>test",
  );
  assert.equal(
    spliceLayersOnFirstLine("RIS3N", { layers: [{}] }),
    "RIS3N<pos=0>LAYER",
  );

  const buildCode = extractHudFunction("buildCode", {
    restorePreferredArtChars: (value) => value,
    brailleToAsciiArt: (value) => value,
    colorizeNamedArt: (name) => name,
    isAsciiArtText: () => false,
    normalizeForgeAlign: () => "center",
    packAsciiArt: (value) => value,
    composeExtraLine: (_state, kind) => (
      kind === "title" ? { line: "<#FF0000>test", visibleWidth: 4 } : null
    ),
    spliceLayersOnFirstLine,
    scoredSuffix: () => "<size=0>",
    alphaHex: () => "FF",
  });
  const code = buildCode({
    name: "RIS3N",
    rotateDeg: 0,
    waveOn: false,
    sizePct: 100,
    markOn: false,
    bold: true,
    italic: false,
    underline: false,
    strike: false,
    align: "center",
    titleOn: true,
    titleText: "test",
    titleGapLines: 1,
    subtitleOn: false,
    layers: [{ text: "RIS3N" }],
  });
  const layerAt = code.indexOf("<pos=0>LAYER");
  const titleAt = code.indexOf("<#FF0000>test");
  assert.ok(layerAt >= 0 && titleAt >= 0, code);
  assert.ok(layerAt < titleAt, code);
});

test("Name Forge treats dot art and tall ASCII as art, not a title", () => {
  const isAsciiArtText = extractHudFunction("isAsciiArtText");
  const preserveForgeNewlines = extractHudFunction("preserveForgeNewlines");
  const artLineStats = extractHudFunction("artLineStats");
  const artFitSizePct = extractHudFunction("artFitSizePct");
  const artLineHeightPct = extractHudFunction("artLineHeightPct");
  const artMspaceEm = extractHudFunction("artMspaceEm");
  const artLineHeightEm = extractHudFunction("artLineHeightEm", { artMspaceEm });
  const brailleToAsciiArt = extractHudFunction("brailleToAsciiArt");
  const restorePreferredArtChars = extractHudFunction("restorePreferredArtChars");
  const gameSafeArtChars = extractHudFunction("gameSafeArtChars", {
    restorePreferredArtChars,
  });
  const isBrailleArtText = extractHudFunction("isBrailleArtText");
  const stripArtWidthPads = extractHudFunction("stripArtWidthPads");
  const visibleArtWidth = extractHudFunction("visibleArtWidth", { stripArtWidthPads });
  const padArtLineToWidth = extractHudFunction("padArtLineToWidth", {
    stripArtWidthPads,
    visibleArtWidth,
  });
  const padArtBodyLines = extractHudFunction("padArtBodyLines", { padArtLineToWidth });
  const normalizeForgeAlign = extractHudFunction("normalizeForgeAlign");
  const artBlockIndentCols = extractHudFunction("artBlockIndentCols", { normalizeForgeAlign });
  const artIndentPad = extractHudFunction("artIndentPad");
  const indentArtBody = extractHudFunction("indentArtBody", { artIndentPad });
  const wrapPackedArt = extractHudFunction("wrapPackedArt", { normalizeForgeAlign });
  const packAsciiArt = extractHudFunction("packAsciiArt", {
    preserveForgeNewlines,
    artLineStats,
    artFitSizePct,
    artLineHeightPct,
    artMspaceEm,
    artLineHeightEm,
    brailleToAsciiArt,
    gameSafeArtChars,
    stripArtWidthPads,
    wrapPackedArt,
    normalizeForgeAlign,
    padArtLineToWidth,
    padArtBodyLines,
    artBlockIndentCols,
    artIndentPad,
    indentArtBody,
  });
  const editableTextFromRaw = extractHudFunction("editableTextFromRaw");
  const editableFieldsFromRaw = extractHudFunction("editableFieldsFromRaw", {
    editableTextFromRaw,
    isAsciiArtText,
  });

  const dots = "..--..\n.    .\n..--..";
  assert.equal(isAsciiArtText(dots), true);
  assert.equal(isAsciiArtText("●●●●●\n●   ●"), true);
  assert.equal(isAsciiArtText("........\n.      ."), true);
  assert.equal(isAsciiArtText("Player\nChampion"), false);
  assert.equal(editableFieldsFromRaw("●●●●●\n●   ●").titleOn, false);
  assert.equal(editableFieldsFromRaw("Player\nChampion").titleOn, true);

  const packedDots = packAsciiArt("●●●●●\n●   ●");
  assert.match(packedDots, /<mspace=0\.72em>/);
  assert.match(packedDots, /<line-height=1\.12em>/);
  assert.match(packedDots, /<align=left>/);
  assert.match(packedDots, /●●●●●<br>●   ●/);
  assert.match(packedDots, /●   ●<br><\/mspace><\/align>/);
  assert.equal(/\u00A0/.test(packedDots), false);
  assert.equal(/<#00000000>/.test(packedDots), false);
  assert.match(packedDots, /^<line-height=/);
  assert.equal(packAsciiArt(packedDots), packedDots);

  const figlet = "  ____\n / __/\n/ /__ \n\\___/ ";
  assert.equal(isAsciiArtText(figlet), true);
  const packedFig = packAsciiArt(figlet + "\n" + figlet);
  assert.match(packedFig, /<size=\d+%>/);
  assert.match(packedFig, /<line-height=/);
  assert.ok(packedFig.indexOf("<size=") < packedFig.indexOf("<line-height="));
  assert.match(packAsciiArt(" <tag> "), /\uFF1Ctag\uFF1E/);

  const crew = "⠀⠀⣠⣤⣶⣦⣤⡀⠀\n⠀⣼⣿⠋⠀⠀⢻⣿⡄\n⣿⣿⣿⣿⣿⣿⣿⣿⣿";
  assert.equal(isBrailleArtText(crew), true);
  assert.equal(brailleToAsciiArt("⠀"), " ");
  assert.equal(brailleToAsciiArt("⣿"), "#");
  assert.equal(/[\u2800-\u28FF]/.test(brailleToAsciiArt(crew)), false);
  assert.equal(/[\u2800-\u28FF]/.test(packAsciiArt(crew)), false);
  const packedCrew = packAsciiArt(crew);
  assert.match(packedCrew, /<mspace=0\.72em>/);
  assert.match(packedCrew, /<line-height=1\.12em>/);
  assert.equal(gameSafeArtChars("+:+"), "+:+");
  assert.equal(restorePreferredArtChars("==##''"), "++##::");
  assert.equal(restorePreferredArtChars("=##:"), "+##:");
  assert.equal(
    restorePreferredArtChars("+<size=0>x</size>:\u200B+"),
    "+:+",
  );
  assert.match(packAsciiArt(".++#####++:+#:\n##"), /\+:/);
  const packedShort = packAsciiArt(".++#####++:+#:\n##");
  assert.match(packedShort, /<align=left>/);
  assert.match(packedShort, /##<br><\/mspace><\/align>/);
  assert.equal(/<space=/.test(packedShort), false);
  assert.equal(/<#00000000>/.test(packedShort), false);
  assert.equal(editableTextFromRaw("##" + "<#00000000>.".repeat(12) + "<br>"), "##");
  assert.equal(packAsciiArt("a\u00A0\u00A0b\nc").includes("\u00A0"), false);
  assert.equal(normalizeForgeAlign("RIGHT"), "right");
  const packedCenter = packAsciiArt(".++#####++:+#:\n##", "center");
  assert.match(packedCenter, /<rgnf-align=center>/);
  assert.match(packedCenter, /<align=left>/);
  assert.match(packedCenter, /<color=#00000000>\.\.\.<\/color>\.\+\+#####\+\+:\+#:/);
  assert.match(packedCenter, /<color=#00000000>\.\.\.<\/color>##<br><\/mspace><\/align>/);
  assert.equal(/<align=center>/.test(packedCenter), false);
  assert.equal(/<space=/.test(packedCenter), false);
  assert.equal(packAsciiArt(packedCenter, "center"), packedCenter);
  const packedRight = packAsciiArt(".++#####++:+#:\n##", "right");
  assert.match(packedRight, /<rgnf-align=right>/);
  assert.match(packedRight, /<align=left>/);
  assert.match(packedRight, /<color=#00000000>\.\.\.\.\.\.<\/color>##<br><\/mspace><\/align>/);
  assert.match(hudSource, /\['left', 'Left'\], \['center', 'Center'\], \['right', 'Right'\]/);
  assert.match(hudSource, /Align the name/);
  assert.match(hudSource, /rgNameForge\.alignDefault\.v1/);
  assert.match(hudSource, /align: readAlignDefault\(\) \|\| 'left'/);
  assert.match(hudFunctionSource("alignFromRaw"), /readAlignDefault/);
  assert.match(hudSource, /writeAlignDefault\(value\)/);
  const alignFromRawPref = extractHudFunction("alignFromRaw", {
    readAlignDefault: () => "center",
  });
  assert.equal(alignFromRawPref("hello"), "center");
  assert.equal(alignFromRawPref("<align=right>hello</align>"), "right");
  const alignFromRawFresh = extractHudFunction("alignFromRaw", {
    readAlignDefault: () => null,
  });
  assert.equal(alignFromRawFresh("hello"), "left");
  assert.equal(
    alignFromRawFresh("<rgnf-align=center><align=left>x</align>"),
    "center",
  );
  const nickSafeColor = extractHudFunction("nickSafeColor");
  const sanitizeNicknameColors = extractHudFunction("sanitizeNicknameColors", {
    nickSafeColor,
  });
  assert.equal(nickSafeColor("#FFA600"), "#FFA700");
  assert.match(
    sanitizeNicknameColors("<#FF8800>+<#FFA600>"),
    /<#FFA700>/,
  );
  assert.equal(/FFA600/i.test(sanitizeNicknameColors("<#FFA600>")), false);
});

test("Name Forge remembers a Scored default and keeps clan tags off the name", () => {
  const resolveScoredMode = extractHudFunction("resolveScoredMode");
  assert.equal(resolveScoredMode("default", "hide"), "hide");
  assert.equal(resolveScoredMode("hide", "default"), "hide");
  assert.equal(resolveScoredMode("styled", "hide"), "styled");
  assert.equal(resolveScoredMode("default", null), "default");
  assert.equal(resolveScoredMode("", "tiny"), "tiny");

  const isAsciiArtText = extractHudFunction("isAsciiArtText");
  const editableGlyphs = extractHudFunction("editableGlyphs");
  const replaceRawVisibleText = extractHudFunction("replaceRawVisibleText", {
    editableGlyphs,
  });
  const replaceRawNameText = extractHudFunction("replaceRawNameText", {
    isAsciiArtText,
    replaceRawVisibleText,
  });
  assert.equal(
    replaceRawNameText("<#4C67B5>Old<br><size=50%>Title", "New"),
    "<#4C67B5>New<br><size=50%>Title",
  );
  assert.equal(
    replaceRawNameText("<#4C67B5>Old", "New"),
    "<#4C67B5>New",
  );

  assert.match(hudSource, /rgNameForge\.scoredDefault\.v1/);
  assert.match(hudSource, /writeScoredDefault\(v\)/);
  assert.match(hudSource, /setTagStripper/);
  assert.match(hudSource, /_stripTag\(effectiveForgeCode\(state\)\)/);
  assert.match(hudFunctionSource("setRawSnapshot"), /_stripTag\(restorePreferredArtChars\(raw\)\)/);
  assert.match(hudFunctionSource("applyLoadedForgeName"), /setRawSnapshot/);
  assert.match(hudFunctionSource("applyLoadedForgeName"), /loadStateSnapshot/);
  assert.match(hudFunctionSource("applyLoadedForgeName"), /render\(_rgnfPanel\)/);
  assert.match(hudSource, /text: 'Load', title: 'Show this name in the preview'/);
  assert.match(hudSource, /setRawSnapshot\(_stripTag\(String\(rawNickname\)\)\)/);
  assert.match(hudSource, /do not overwrite with the live nameplate/);
  assert.match(hudFunctionSource("renderRawTMP"), /rgnf-ascii/);
  assert.match(hudFunctionSource("renderRawTMP"), /max-content/);
  assert.match(hudFunctionSource("renderRawPreview"), /rgnf-preview-stack/);
});

test("Name Forge presets survive an origin localStorage wipe via Tampermonkey storage", () => {
  const tm = new Map();
  const atlasTmStorage = () => ({
    get: (key) => (tm.has(key) ? tm.get(key) : null),
    set: (key, value) => { tm.set(key, value); },
  });
  const { window } = new JSDOM("", { url: "https://rocketgoal.io/" });
  const saveJSON = extractHudFunction("saveJSON", {
    atlasTmStorage,
    localStorage: window.localStorage,
  });
  const loadJSON = extractHudFunction("loadJSON", {
    atlasTmStorage,
    localStorage: window.localStorage,
    saveJSON,
  });
  const key = nameForgePresetKey("player-one");
  saveJSON(key, [{ name: "Fire" }]);
  window.localStorage.clear();
  const restored = loadJSON(key, []);
  assert.equal(JSON.stringify(restored), JSON.stringify([{ name: "Fire" }]));
  assert.equal(window.localStorage.getItem(key), JSON.stringify([{ name: "Fire" }]));
});

test("Name Forge presets and clan-tag cleanup are account safe", () => {
  assert.equal(
    nameForgePresetKey("player-one"),
    "rgNameForge.presets.v2.player-one",
  );
  assert.notEqual(
    nameForgePresetKey("player-one"),
    nameForgePresetKey("player-two"),
  );
  assert.equal(stripClanTagPrefix("[KING] Player", "KING"), "Player");
  assert.equal(
    stripClanTagPrefix(
      "<color=#fff>[<b>K</b>I<color=#0ff>N</color>G]</color> Player",
      "KING",
    ),
    "Player",
  );
  assert.equal(
    stripClanTagPrefix("[OTHER] Player", "KING"),
    "[OTHER] Player",
  );
});
