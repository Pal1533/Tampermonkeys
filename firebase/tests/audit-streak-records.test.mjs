import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIT_WINDOW_MS,
  DAILY_WIN_THRESHOLD,
  HOURLY_WIN_THRESHOLD,
  auditStreakRecords,
  hasDuplicateMatchIds,
  main,
  parseArgs,
  pauseFlaggedStreaks,
} from "../scripts/audit-streak-records.mjs";

function snapshotDoc(uid, matchId, outcome) {
  return {
    document: {
      name: `projects/rgleaderboard/databases/(default)/documents/match_snapshots/${uid}_${matchId}`,
      fields: {
        sourceUserId: { stringValue: uid },
        matchId: { stringValue: matchId },
        outcome: { stringValue: outcome },
      },
    },
  };
}

function streakDoc(uid, accountId, displayName, bestWinStreak, bestAt) {
  return {
    document: {
      name: `projects/rgleaderboard/databases/(default)/documents/player_streaks/${uid}`,
      fields: {
        accountId: { stringValue: accountId },
        displayName: { stringValue: displayName },
        bestWinStreak: { integerValue: String(bestWinStreak) },
        bestAt: { integerValue: String(bestAt) },
      },
    },
  };
}

// Builds a fetchImpl that:
//  - answers the single player_streaks top-N query with `rows`
//  - answers match_snapshots window queries from `windowDocs`, keyed by
//    `${uid}::${startIso}::${endIso}`
//  - answers the match_snapshots existence probe from `hasAnySnapshots`
//  - records every PATCH call it sees in `calls`
function buildFetchImpl({ rows, windowDocs = {}, hasAnySnapshots = {}, calls = [] }) {
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (options.method === "PATCH") {
      calls.push({ url: String(url), body });
      return { ok: true, status: 200, async text() { return "{}"; } };
    }
    const sq = body?.structuredQuery;
    if (sq?.from?.[0]?.collectionId === "player_streaks") {
      return { ok: true, status: 200, async text() { return JSON.stringify(rows.map(streakDocFor)); } };
    }
    if (sq?.from?.[0]?.collectionId === "match_snapshots") {
      const filters = sq.where?.compositeFilter?.filters;
      if (filters) {
        const uid = filters[0].fieldFilter.value.stringValue;
        const startIso = filters[1].fieldFilter.value.stringValue;
        const endIso = filters[2].fieldFilter.value.stringValue;
        const key = `${uid}::${startIso}::${endIso}`;
        const docs = windowDocs[key] || [];
        return { ok: true, status: 200, async text() { return JSON.stringify(docs.map(d => snapshotDoc(uid, d.matchId, d.outcome))); } };
      }
      // existence probe: single fieldFilter + limit 1
      const uid = sq.where.fieldFilter.value.stringValue;
      const found = hasAnySnapshots[uid];
      return {
        ok: true, status: 200,
        async text() { return JSON.stringify(found ? [snapshotDoc(uid, "any", "W")] : []); },
      };
    }
    throw new Error(`Unexpected fetch: ${url} ${JSON.stringify(body)}`);
  };
  return fetchImpl;

  function streakDocFor(row) {
    return streakDoc(row.uid, row.accountId, row.displayName, row.bestWinStreak, row.bestAt);
  }
}

test("parseArgs exposes tunable win-rate thresholds with sane defaults", () => {
  const a = parseArgs(["--project", "rgleaderboard"]);
  assert.equal(a.hourlyWinThreshold, HOURLY_WIN_THRESHOLD);
  assert.equal(a.dailyWinThreshold, DAILY_WIN_THRESHOLD);
  const b = parseArgs(["--project", "rgleaderboard", "--hourly-win-threshold", "40", "--daily-win-threshold=80"]);
  assert.equal(b.hourlyWinThreshold, 40);
  assert.equal(b.dailyWinThreshold, 80);
});

test("parseArgs rejects a non-positive win-rate threshold", () => {
  assert.throws(() => parseArgs(["--project", "x", "--hourly-win-threshold", "0"]), /hourly-win-threshold/);
  assert.throws(() => parseArgs(["--project", "x", "--daily-win-threshold", "-5"]), /daily-win-threshold/);
});

test("hasDuplicateMatchIds flags a repeated matchId, not a repeated outcome", () => {
  assert.equal(hasDuplicateMatchIds([{ matchId: "m1" }, { matchId: "m2" }]), false);
  assert.equal(hasDuplicateMatchIds([{ matchId: "m1" }, { matchId: "m1" }]), true);
  assert.equal(hasDuplicateMatchIds([]), false);
});

test("auditStreakRecords passes a streak fully backed by real wins", async () => {
  const bestAt = Date.parse("2026-09-20T12:00:00.000Z");
  const startIso = new Date(bestAt - AUDIT_WINDOW_MS).toISOString();
  const endIso = new Date(bestAt).toISOString();
  const fetchImpl = buildFetchImpl({
    rows: [{ uid: "uidA", accountId: "accA", displayName: "Ace", bestWinStreak: 3, bestAt }],
    windowDocs: {
      [`uidA::${startIso}::${endIso}`]: [
        { matchId: "m1", outcome: "W" }, { matchId: "m2", outcome: "W" }, { matchId: "m3", outcome: "W" },
      ],
      // rate-check windows for uidA: no docs registered -> 0 wins, well under threshold.
    },
  });
  const audit = await auditStreakRecords({ fetchImpl, token: "t", project: "rgleaderboard", now: bestAt });
  assert.equal(audit.flags.length, 0);
  assert.equal(audit.skipped.length, 0);
});

test("auditStreakRecords flags a streak short on real wins, unless it has zero snapshot history", async () => {
  const bestAt = Date.parse("2026-09-20T12:00:00.000Z");
  const startIso = new Date(bestAt - AUDIT_WINDOW_MS).toISOString();
  const endIso = new Date(bestAt).toISOString();

  // uidB: claims 5, only 2 real wins backing it, but has other match history -> flagged.
  // uidC: claims 5, zero wins and zero match_snapshots at all -> skipped (pre-19.2 HUD).
  const fetchImpl = buildFetchImpl({
    rows: [
      { uid: "uidB", accountId: "accB", displayName: "Bee", bestWinStreak: 5, bestAt },
      { uid: "uidC", accountId: "accC", displayName: "Cee", bestWinStreak: 5, bestAt },
    ],
    windowDocs: {
      [`uidB::${startIso}::${endIso}`]: [{ matchId: "m1", outcome: "W" }, { matchId: "m2", outcome: "W" }],
    },
    hasAnySnapshots: { uidB: true, uidC: false },
  });
  const audit = await auditStreakRecords({ fetchImpl, token: "t", project: "rgleaderboard", now: bestAt });

  assert.equal(audit.flags.length, 1);
  assert.equal(audit.flags[0].uid, "uidB");
  assert.equal(audit.flags[0].shortBy, 3);
  assert.equal(audit.flags[0].duplicateMatchIds, false);
  assert.equal(audit.flags[0].rateAnomaly, null);

  assert.equal(audit.skipped.length, 1);
  assert.equal(audit.skipped[0].uid, "uidC");
  assert.match(audit.skipped[0].reason, /no match_snapshots/);
});

test("auditStreakRecords flags a duplicate matchId even when the win count matches", async () => {
  const bestAt = Date.parse("2026-09-20T12:00:00.000Z");
  const startIso = new Date(bestAt - AUDIT_WINDOW_MS).toISOString();
  const endIso = new Date(bestAt).toISOString();
  const fetchImpl = buildFetchImpl({
    rows: [{ uid: "uidD", accountId: "accD", displayName: "Dee", bestWinStreak: 2, bestAt }],
    windowDocs: {
      // Same matchId counted twice — should never happen under correct
      // rules (docId is uid_matchId), so this is the integrity-check path.
      [`uidD::${startIso}::${endIso}`]: [
        { matchId: "m1", outcome: "W" }, { matchId: "m1", outcome: "W" },
      ],
    },
  });
  const audit = await auditStreakRecords({ fetchImpl, token: "t", project: "rgleaderboard", now: bestAt });
  assert.equal(audit.flags.length, 1);
  assert.equal(audit.flags[0].uid, "uidD");
  assert.equal(audit.flags[0].shortBy, 0);
  assert.equal(audit.flags[0].duplicateMatchIds, true);
});

test("auditStreakRecords flags an impossible hourly win rate even when the PR window checks out", async () => {
  const bestAt = Date.parse("2026-09-20T12:00:00.000Z");
  const startIso = new Date(bestAt - AUDIT_WINDOW_MS).toISOString();
  const endIso = new Date(bestAt).toISOString();
  const hourAgoIso = new Date(bestAt - 60 * 60 * 1000).toISOString();
  const nowIso = new Date(bestAt).toISOString();
  const dayAgoIso = new Date(bestAt - 24 * 60 * 60 * 1000).toISOString();

  const manyWins = Array.from({ length: HOURLY_WIN_THRESHOLD + 1 }, (_, i) => ({ matchId: `m${i}`, outcome: "W" }));

  const fetchImpl = buildFetchImpl({
    rows: [{ uid: "uidE", accountId: "accE", displayName: "Eve", bestWinStreak: 3, bestAt }],
    windowDocs: {
      [`uidE::${startIso}::${endIso}`]: [
        { matchId: "m1", outcome: "W" }, { matchId: "m2", outcome: "W" }, { matchId: "m3", outcome: "W" },
      ],
      [`uidE::${hourAgoIso}::${nowIso}`]: manyWins,
      [`uidE::${dayAgoIso}::${nowIso}`]: manyWins,
    },
  });
  const audit = await auditStreakRecords({ fetchImpl, token: "t", project: "rgleaderboard", now: bestAt });
  assert.equal(audit.flags.length, 1);
  assert.equal(audit.flags[0].uid, "uidE");
  assert.equal(audit.flags[0].shortBy, 0);
  assert.equal(audit.flags[0].rateAnomaly.reason, "hourly_win_rate");
  assert.equal(audit.flags[0].rateAnomaly.observed, HOURLY_WIN_THRESHOLD + 1);
});

test("pauseFlaggedStreaks patches reviewFlagged with a field mask, one write per flagged uid", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, async text() { return "{}"; } };
  };
  const flags = [
    { uid: "uidB", duplicateMatchIds: false, rateAnomaly: null },
    { uid: "uidD", duplicateMatchIds: true, rateAnomaly: null },
    { uid: "uidE", duplicateMatchIds: false, rateAnomaly: { reason: "hourly_win_rate", observed: 101 } },
  ];
  const results = await pauseFlaggedStreaks(fetchImpl, "t", "rgleaderboard", flags, 12345);

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.match(call.url, /\/player_streaks\/uid[BDE]\?/);
    assert.match(call.url, /updateMask\.fieldPaths=reviewFlagged/);
    assert.match(call.url, /updateMask\.fieldPaths=reviewFlagReason/);
    assert.match(call.url, /updateMask\.fieldPaths=reviewFlaggedAt/);
    assert.equal(call.body.fields.reviewFlagged.booleanValue, true);
    assert.equal(call.body.fields.reviewFlaggedAt.integerValue, "12345");
  }
  assert.deepEqual(results, [
    { uid: "uidB", reason: "short_by_wins" },
    { uid: "uidD", reason: "duplicate_match_id" },
    { uid: "uidE", reason: "hourly_win_rate" },
  ]);
});

test("main --apply writes flags then pauses every flagged account", async () => {
  const bestAt = Date.parse("2026-09-20T12:00:00.000Z");
  const startIso = new Date(bestAt - AUDIT_WINDOW_MS).toISOString();
  const endIso = new Date(bestAt).toISOString();
  const patchCalls = [];
  const fetchImpl = buildFetchImpl({
    rows: [{ uid: "uidB", accountId: "accB", displayName: "Bee", bestWinStreak: 5, bestAt }],
    windowDocs: {
      [`uidB::${startIso}::${endIso}`]: [{ matchId: "m1", outcome: "W" }],
    },
    hasAnySnapshots: { uidB: true },
    calls: patchCalls,
  });

  const result = await main(["--project", "rgleaderboard", "--apply"], {
    fetchImpl,
    getToken: async () => "token",
  });

  assert.equal(result.applied, true);
  assert.equal(result.flags.length, 1);
  assert.equal(result.paused.length, 1);
  assert.equal(result.paused[0].uid, "uidB");
  // one write for player_streaks_flagged/latest, one for the paused uid
  const targets = patchCalls.map(c => c.url);
  assert.ok(targets.some(u => u.includes("player_streaks_flagged/latest")));
  assert.ok(targets.some(u => u.includes("player_streaks/uidB")));
});
