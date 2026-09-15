// Anti-cheat write caps. Trip either bucket and writes freeze locally
// until an admin clears the flag server-side.

export const DAILY_WIN_CAP = 120;
export const HOURLY_WIN_CAP = 50;
const STORAGE_KEY = "rgHudWinLimits_v1";

function utcDateString(now) {
  return new Date(now).toISOString().slice(0, 10);
}
function utcHourString(now) {
  return new Date(now).toISOString().slice(0, 13);
}

function readStore() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {}; }
  catch { return {}; }
}
function writeStore(value) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch {}
}

function emptyTracker(totalWinsNow) {
  return {
    utcDate: null,
    utcHour: null,
    dailyBaseline: totalWinsNow,
    hourlyBaseline: totalWinsNow,
    lastTotalWins: totalWinsNow,
    flagged: false,
    flaggedAt: null,
    flaggedReason: null,
  };
}

export function evaluateWinLimits(accountId, totalWinsNow, now = Date.now()) {
  if (!accountId || !Number.isFinite(totalWinsNow)) return null;
  const store = readStore();
  const prev = store[accountId] ? { ...store[accountId] } : emptyTracker(totalWinsNow);

  const utcDate = utcDateString(now);
  const utcHour = utcHourString(now);

  if (prev.utcDate !== utcDate) {
    prev.dailyBaseline = totalWinsNow;
    prev.utcDate = utcDate;
  }
  if (prev.utcHour !== utcHour) {
    prev.hourlyBaseline = totalWinsNow;
    prev.utcHour = utcHour;
  }

  // Account switch or wipe: wins can't go down within one lifetime, so
  // reseed baselines instead of letting the deltas go negative.
  if (totalWinsNow < prev.lastTotalWins) {
    prev.dailyBaseline = totalWinsNow;
    prev.hourlyBaseline = totalWinsNow;
  }

  const dailyCount = Math.max(0, totalWinsNow - prev.dailyBaseline);
  const hourlyCount = Math.max(0, totalWinsNow - prev.hourlyBaseline);

  if (!prev.flagged) {
    if (dailyCount > DAILY_WIN_CAP) {
      prev.flagged = true;
      prev.flaggedAt = now;
      prev.flaggedReason = `>${DAILY_WIN_CAP} wins in one UTC day`;
    } else if (hourlyCount > HOURLY_WIN_CAP) {
      prev.flagged = true;
      prev.flaggedAt = now;
      prev.flaggedReason = `>${HOURLY_WIN_CAP} wins in one UTC hour`;
    }
  }

  prev.lastTotalWins = totalWinsNow;
  store[accountId] = prev;
  writeStore(store);

  return {
    dailyWins: { utcDate, count: dailyCount },
    hourlyWins: { utcHour, count: hourlyCount },
    reviewFlagged: !!prev.flagged,
    flaggedReason: prev.flaggedReason || null,
    flaggedAt: prev.flaggedAt || null,
  };
}

export function isFlaggedLocally(accountId) {
  if (!accountId) return false;
  return !!(readStore()[accountId]?.flagged);
}

export function reconcileFlagFromServer(accountId, serverFlagged) {
  if (!accountId) return;
  const store = readStore();
  const prev = store[accountId];
  if (!prev) {
    if (!serverFlagged) return;
    store[accountId] = { ...emptyTracker(0), flagged: true, flaggedAt: Date.now(), flaggedReason: "server-side review flag" };
    writeStore(store);
    return;
  }
  if (prev.flagged === !!serverFlagged) return;
  prev.flagged = !!serverFlagged;
  if (!serverFlagged) {
    prev.flaggedAt = null;
    prev.flaggedReason = null;
  } else if (!prev.flaggedAt) {
    prev.flaggedAt = Date.now();
    prev.flaggedReason = "server-side review flag";
  }
  store[accountId] = prev;
  writeStore(store);
}
