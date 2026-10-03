import { fileURLToPath } from "node:url";

import { decodeFirestoreDocument, getGcloudAccessToken } from "./snapshot-production.mjs";

export const SOURCE_COLLECTION = "player_streaks";
export const SNAPSHOT_COLLECTION = "match_snapshots";
export const FLAG_COLLECTION = "player_streaks_flagged";
export const FLAG_DOC_ID = "latest";
export const AUDIT_WINDOW_MS = 12 * 60 * 60 * 1000; // 12h
// Cap audits to the top N by bestWinStreak. Anyone below this doesn't
// materially affect the public board and isn't worth the reads.
export const AUDIT_TOP_N = 50;

// Independent win-rate ceilings, checked against real match_snapshots
// (not the client-reported hourlyWins/dailyWins fields, which a modified
// client could simply lie about). Starting values mirror the existing
// self-reported caps in firestore.rules — tune based on observed data.
export const HOURLY_WIN_THRESHOLD = 100;
export const DAILY_WIN_THRESHOLD = 200;

export const HELP = `Audit player_streaks for records unbacked by real wins in the 12h
window before bestAt. Reads match_snapshots per uid, flags entries where
the observed wins are fewer than the claimed streak, the win rate looks
impossible, or the same matchId is reused more than once.

Dry run (default — no writes):
  node firebase/scripts/audit-streak-records.mjs --project rgleaderboard

Apply writes:
  node firebase/scripts/audit-streak-records.mjs --project rgleaderboard --apply

Writes:
  Overwrites ${FLAG_COLLECTION}/${FLAG_DOC_ID} with { flags[], auditedAt, auditedCount }.
  Only admins can read this doc; clients don't need it.
  In --apply mode, also patches reviewFlagged=true (+ reason, timestamp)
  onto every flagged player_streaks/{uid} doc. firestore.rules pauses
  further writes to that doc (notUnderReview()) until an admin manually
  clears reviewFlagged — the script never clears or deletes it itself.

Optional:
  --top ${AUDIT_TOP_N}       (audit the top N by bestWinStreak)
  --window-hours 12
  --hourly-win-threshold ${HOURLY_WIN_THRESHOLD}
  --daily-win-threshold ${DAILY_WIN_THRESHOLD}
`;

function documentsBase(project) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/(default)/documents`;
}

async function apiJson(fetchImpl, token, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "X-Goog-User-Project": options.quotaProject || "",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    redirect: "error",
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = body?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Firestore request failed (${response.status}): ${message}`);
  }
  return body;
}

function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } };
  }
  if (value && typeof value === "object") {
    return { mapValue: { fields: encodeFields(value) } };
  }
  throw new Error(`Unsupported Firestore value type: ${typeof value}`);
}

function encodeFields(document) {
  return Object.fromEntries(
    Object.entries(document).map(([k, v]) => [k, encodeValue(v)])
  );
}

export async function queryTopStreaks(fetchImpl, token, project, top) {
  const body = await apiJson(
    fetchImpl,
    token,
    `${documentsBase(project)}:runQuery`,
    {
      method: "POST",
      quotaProject: project,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: SOURCE_COLLECTION }],
          orderBy: [
            { field: { fieldPath: "bestWinStreak" }, direction: "DESCENDING" },
          ],
          limit: top,
        },
      }),
    }
  );
  const rows = [];
  for (const entry of body || []) {
    if (!entry?.document) continue;
    const decoded = decodeFirestoreDocument(entry.document);
    const fields = decoded.fields || {};
    rows.push({
      uid: decoded.id,
      accountId: String(fields.accountId || ""),
      displayName: String(fields.displayName || "Unknown"),
      bestWinStreak: Math.trunc(Number(fields.bestWinStreak) || 0),
      bestAt: Number(fields.bestAt) || 0,
    });
  }
  return rows;
}

// Range query on match_snapshots.at is a string comparison because the
// rule stores `at` as an ISO string (see match_snapshots rule). ISO-8601
// with Z suffix is lex-sortable, so string range works.
//
// Returns the raw docs (matchId + outcome) rather than just a count so
// callers can also run integrity checks (e.g. duplicate matchId) off the
// exact same query result instead of paying for a second read.
export async function listMatchSnapshotsInWindow(fetchImpl, token, project, uid, startIso, endIso) {
  const body = await apiJson(
    fetchImpl,
    token,
    `${documentsBase(project)}:runQuery`,
    {
      method: "POST",
      quotaProject: project,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: SNAPSHOT_COLLECTION }],
          where: {
            compositeFilter: {
              op: "AND",
              filters: [
                {
                  fieldFilter: {
                    field: { fieldPath: "sourceUserId" },
                    op: "EQUAL",
                    value: { stringValue: uid },
                  },
                },
                {
                  fieldFilter: {
                    field: { fieldPath: "at" },
                    op: "GREATER_THAN_OR_EQUAL",
                    value: { stringValue: startIso },
                  },
                },
                {
                  fieldFilter: {
                    field: { fieldPath: "at" },
                    op: "LESS_THAN_OR_EQUAL",
                    value: { stringValue: endIso },
                  },
                },
              ],
            },
          },
        },
      }),
    }
  );
  const docs = [];
  for (const entry of body || []) {
    if (!entry?.document) continue;
    const decoded = decodeFirestoreDocument(entry.document);
    docs.push({
      matchId: String(decoded.fields?.matchId || ""),
      outcome: String(decoded.fields?.outcome || ""),
    });
  }
  return docs;
}

export async function countWinsInWindow(fetchImpl, token, project, uid, startIso, endIso) {
  const docs = await listMatchSnapshotsInWindow(fetchImpl, token, project, uid, startIso, endIso);
  return {
    wins: docs.filter(d => d.outcome === "W").length,
    matches: docs.length,
  };
}

// Defense-in-depth: match_snapshots docIds are `${sourceUserId}_${matchId}`,
// so under correct rules one user can never have two docs for the same
// matchId. firestore.rules also now makes a snapshot's identity/outcome/at
// immutable after creation, closing the one known way this could have
// happened (replaying/sliding an old real win's `at` timestamp). If this
// ever fires it means a rules regression, not just an inflated streak —
// either way, a streak record it touches shouldn't be trusted at face value.
export function hasDuplicateMatchIds(docs) {
  const seen = new Set();
  for (const d of docs) {
    if (!d.matchId) continue;
    if (seen.has(d.matchId)) return true;
    seen.add(d.matchId);
  }
  return false;
}

// Independently counts real match_snapshots wins in trailing 1h/24h
// windows ending "now" (not bestAt) — this is about ongoing pace, not the
// historical PR moment — and deliberately does not trust the
// client-reported hourlyWins/dailyWins fields on the leaderboard doc,
// since a modified client could just lie about those.
export async function winRateAnomaly(fetchImpl, token, project, uid, {
  now = Date.now(),
  hourlyThreshold = HOURLY_WIN_THRESHOLD,
  dailyThreshold = DAILY_WIN_THRESHOLD,
} = {}) {
  const nowIso = new Date(now).toISOString();
  const hourAgoIso = new Date(now - 60 * 60 * 1000).toISOString();
  const dayAgoIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const [hourly, daily] = await Promise.all([
    countWinsInWindow(fetchImpl, token, project, uid, hourAgoIso, nowIso),
    countWinsInWindow(fetchImpl, token, project, uid, dayAgoIso, nowIso),
  ]);
  if (hourly.wins > hourlyThreshold) {
    return { reason: "hourly_win_rate", observed: hourly.wins, threshold: hourlyThreshold };
  }
  if (daily.wins > dailyThreshold) {
    return { reason: "daily_win_rate", observed: daily.wins, threshold: dailyThreshold };
  }
  return null;
}

async function totalMatchSnapshots(fetchImpl, token, project, uid) {
  const body = await apiJson(
    fetchImpl,
    token,
    `${documentsBase(project)}:runQuery`,
    {
      method: "POST",
      quotaProject: project,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: SNAPSHOT_COLLECTION }],
          where: {
            fieldFilter: {
              field: { fieldPath: "sourceUserId" },
              op: "EQUAL",
              value: { stringValue: uid },
            },
          },
          limit: 1,
        },
      }),
    }
  );
  // We only need to know "any" vs "none". A pre-19.2 HUD has zero
  // snapshots; skipping the flag on those keeps the false-positive
  // rate down. Full counts would cost more reads for no extra signal.
  for (const entry of body || []) {
    if (entry?.document) return true;
  }
  return false;
}

export async function auditStreakRecords({
  fetchImpl,
  token,
  project,
  top = AUDIT_TOP_N,
  windowMs = AUDIT_WINDOW_MS,
  now = Date.now(),
  hourlyWinThreshold = HOURLY_WIN_THRESHOLD,
  dailyWinThreshold = DAILY_WIN_THRESHOLD,
}) {
  const rows = await queryTopStreaks(fetchImpl, token, project, top);
  const flags = [];
  const skipped = [];
  for (const row of rows) {
    if (!row.bestAt || !row.uid) {
      skipped.push({ ...row, reason: "missing bestAt or uid" });
      continue;
    }
    const startIso = new Date(row.bestAt - windowMs).toISOString();
    const endIso = new Date(row.bestAt).toISOString();
    const docs = await listMatchSnapshotsInWindow(
      fetchImpl, token, project, row.uid, startIso, endIso
    );
    const wins = docs.filter(d => d.outcome === "W").length;
    const matches = docs.length;
    const duplicateMatchIds = hasDuplicateMatchIds(docs);
    const rateAnomaly = await winRateAnomaly(fetchImpl, token, project, row.uid, {
      now, hourlyThreshold: hourlyWinThreshold, dailyThreshold: dailyWinThreshold,
    });

    const shortBy = Math.max(0, row.bestWinStreak - wins);
    if (shortBy === 0 && !duplicateMatchIds && !rateAnomaly) continue; // legit or plausible

    if (shortBy > 0 && !duplicateMatchIds && !rateAnomaly) {
      const hasAnySnapshots = matches > 0 || await totalMatchSnapshots(fetchImpl, token, project, row.uid);
      if (!hasAnySnapshots) {
        // Pre-19.2 HUD, or user never played after upgrading. Not evidence
        // of forgery; note and move on so admin can eyeball if desired.
        skipped.push({
          ...row,
          reason: "no match_snapshots on record (pre-19.2 or lapsed)",
        });
        continue;
      }
    }
    flags.push({
      uid: row.uid,
      accountId: row.accountId,
      displayName: row.displayName,
      bestWinStreak: row.bestWinStreak,
      bestAt: row.bestAt,
      windowStart: startIso,
      windowEnd: endIso,
      observedWins: wins,
      observedMatches: matches,
      shortBy,
      duplicateMatchIds,
      rateAnomaly,
    });
  }
  return { auditedAt: now, auditedCount: rows.length, flags, skipped };
}

// Sets reviewFlagged (+ reason, timestamp) on each flagged uid's own
// player_streaks doc via a field-masked PATCH so unrelated fields are
// left untouched. firestore.rules' notUnderReview() then blocks further
// writes to that doc until an admin manually clears reviewFlagged.
export async function pauseFlaggedStreaks(fetchImpl, token, project, flags, now = Date.now()) {
  const results = [];
  for (const f of flags) {
    const reason = f.duplicateMatchIds
      ? "duplicate_match_id"
      : f.rateAnomaly
        ? f.rateAnomaly.reason
        : "short_by_wins";
    const url = `${documentsBase(project)}/${SOURCE_COLLECTION}/${encodeURIComponent(f.uid)}`
      + "?updateMask.fieldPaths=reviewFlagged"
      + "&updateMask.fieldPaths=reviewFlagReason"
      + "&updateMask.fieldPaths=reviewFlaggedAt";
    await apiJson(fetchImpl, token, url, {
      method: "PATCH",
      quotaProject: project,
      body: JSON.stringify({
        fields: encodeFields({
          reviewFlagged: true,
          reviewFlagReason: reason,
          reviewFlaggedAt: now,
        }),
      }),
    });
    results.push({ uid: f.uid, reason });
  }
  return results;
}

export async function writeFlagsDoc(fetchImpl, token, project, audit) {
  const payload = {
    auditedAt: audit.auditedAt,
    auditedCount: audit.auditedCount,
    flagCount: audit.flags.length,
    flags: audit.flags,
    skipped: audit.skipped,
  };
  const url = `${documentsBase(project)}/${FLAG_COLLECTION}/${encodeURIComponent(FLAG_DOC_ID)}`;
  await apiJson(fetchImpl, token, url, {
    method: "PATCH",
    quotaProject: project,
    body: JSON.stringify({ fields: encodeFields(payload) }),
  });
  return payload;
}

export function parseArgs(argv) {
  const args = {
    apply: false,
    top: AUDIT_TOP_N,
    windowHours: AUDIT_WINDOW_MS / (60 * 60 * 1000),
    hourlyWinThreshold: HOURLY_WIN_THRESHOLD,
    dailyWinThreshold: DAILY_WIN_THRESHOLD,
    project: "",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--apply") args.apply = true;
    else if (a === "--project") args.project = argv[++i];
    else if (a.startsWith("--project=")) args.project = a.slice("--project=".length);
    else if (a === "--top") args.top = Math.trunc(Number(argv[++i]) || AUDIT_TOP_N);
    else if (a.startsWith("--top=")) args.top = Math.trunc(Number(a.slice("--top=".length)) || AUDIT_TOP_N);
    else if (a === "--window-hours") args.windowHours = Number(argv[++i]);
    else if (a.startsWith("--window-hours=")) args.windowHours = Number(a.slice("--window-hours=".length));
    else if (a === "--hourly-win-threshold") args.hourlyWinThreshold = Math.trunc(Number(argv[++i]));
    else if (a.startsWith("--hourly-win-threshold=")) args.hourlyWinThreshold = Math.trunc(Number(a.slice("--hourly-win-threshold=".length)));
    else if (a === "--daily-win-threshold") args.dailyWinThreshold = Math.trunc(Number(argv[++i]));
    else if (a.startsWith("--daily-win-threshold=")) args.dailyWinThreshold = Math.trunc(Number(a.slice("--daily-win-threshold=".length)));
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.help && !args.project) {
    throw new Error("--project is required (e.g. --project rgleaderboard)");
  }
  if (args.top <= 0 || args.top > 500) {
    throw new Error(`--top must be 1..500 (got ${args.top})`);
  }
  if (!(args.windowHours > 0 && args.windowHours <= 168)) {
    throw new Error(`--window-hours must be 0..168 (got ${args.windowHours})`);
  }
  if (!(args.hourlyWinThreshold > 0)) {
    throw new Error(`--hourly-win-threshold must be a positive number (got ${args.hourlyWinThreshold})`);
  }
  if (!(args.dailyWinThreshold > 0)) {
    throw new Error(`--daily-win-threshold must be a positive number (got ${args.dailyWinThreshold})`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return { help: true };
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const getToken = options.getToken || getGcloudAccessToken;
  const token = await getToken();
  const windowMs = args.windowHours * 60 * 60 * 1000;

  const audit = await auditStreakRecords({
    fetchImpl, token,
    project: args.project,
    top: args.top,
    windowMs,
    hourlyWinThreshold: args.hourlyWinThreshold,
    dailyWinThreshold: args.dailyWinThreshold,
  });

  console.log(`AUDIT audited=${audit.auditedCount} window=${args.windowHours}h`);
  if (audit.flags.length === 0) {
    console.log(`OK no flags`);
  } else {
    console.log(`FLAGS ${audit.flags.length}`);
    for (const f of audit.flags) {
      const extra = [
        f.duplicateMatchIds ? "duplicate_match_id" : null,
        f.rateAnomaly ? `${f.rateAnomaly.reason}=${f.rateAnomaly.observed}` : null,
      ].filter(Boolean).join(", ");
      console.log(`  ${f.displayName} (uid=${f.uid.slice(0, 8)}…) claimed=${f.bestWinStreak} observed=${f.observedWins}/${f.observedMatches} short_by=${f.shortBy}${extra ? ` [${extra}]` : ""} bestAt=${new Date(f.bestAt).toISOString()}`);
    }
  }
  if (audit.skipped.length) {
    console.log(`SKIPPED ${audit.skipped.length} (no snapshots on record)`);
  }

  if (!args.apply) {
    console.log(`DRY-RUN complete. Re-run with --apply to write ${FLAG_COLLECTION}/${FLAG_DOC_ID} and pause flagged accounts.`);
    return { ...audit, applied: false };
  }

  const written = await writeFlagsDoc(fetchImpl, token, args.project, audit);
  console.log(`WROTE ${FLAG_COLLECTION}/${FLAG_DOC_ID} flagCount=${written.flagCount} auditedAt=${new Date(written.auditedAt).toISOString()}`);

  const paused = await pauseFlaggedStreaks(fetchImpl, token, args.project, audit.flags, audit.auditedAt);
  if (paused.length) {
    console.log(`PAUSED ${paused.length} player_streaks doc(s) via reviewFlagged=true (admin must clear manually)`);
  }
  return { ...audit, applied: true, paused };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => {
    console.error(e?.stack || e?.message || String(e));
    process.exit(1);
  });
}
