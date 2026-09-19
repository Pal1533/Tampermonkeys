
export function advanceOpponentStreak(previous, wins, matches, publishedStreak = null, now = Date.now()) {
    const safeWins = Number(wins);
    const safeMatches = Number(matches);
    const published = Number(publishedStreak);
    const base = {
        streak: 0,
        confident: false,
        lastWins: Number.isFinite(safeWins) ? safeWins : 0,
        lastMatches: Number.isFinite(safeMatches) ? safeMatches : 0,
        updatedAt: now,
    };
    if (publishedStreak !== null && Number.isFinite(published)) {
        base.streak = Math.max(-999, Math.min(999, Math.trunc(published)));
        base.confident = true;
        return base;
    }
    if (!Number.isFinite(safeWins)
        || !Number.isFinite(safeMatches)
        || safeWins < 0
        || safeMatches < safeWins) {
        return base;
    }
    const priorWins = Number(previous?.lastWins);
    const priorMatches = Number(previous?.lastMatches);
    if (!Number.isFinite(priorWins)
        || !Number.isFinite(priorMatches)
        || safeWins < priorWins
        || safeMatches < priorMatches) {
        return base;
    }
    const matchDiff = safeMatches - priorMatches;
    const winDiff = safeWins - priorWins;
    if (matchDiff <= 0) {
        base.streak = Math.trunc(Number(previous?.streak) || 0);
        base.confident = previous?.confident === true;
        return base;
    }
    const losses = matchDiff - winDiff;
    const priorStreak = Math.trunc(Number(previous?.streak) || 0);
    if (winDiff > 0 && losses === 0) {
        base.streak = priorStreak > 0 ? priorStreak + winDiff : winDiff;
    } else if (losses > 0 && winDiff === 0) {
        base.streak = priorStreak < 0 ? priorStreak - losses : -losses;
    } else {
        base.streak = winDiff >= losses ? 1 : -1;
    }
    base.streak = Math.max(-999, Math.min(999, base.streak));
    base.confident = true;
    return base;
}


export function submissionTotals(stats) {
    const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
    let wins = 0;
    let matches = 0;
    let found = false;
    for (const mode of modes) {
        const row = stats?.[mode];
        if (typeof row?.wins !== "number" || typeof row?.matchesPlayed !== "number") continue;
        wins += row.wins;
        matches += row.matchesPlayed;
        found = true;
    }
    return found ? { wins, matches } : null;
}


export function leaderboardCacheKey(mode) {
    return `${RG_LB_CACHE_KEY_PREFIX}.${mode}`;
}


export function normalizeAggregateEntries(rows) {
    if (!Array.isArray(rows)) return [];
    const entries = [];
    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index] || {};
        // Defense-in-depth: the aggregate builder already filters deleted
        // rows, but skip them here too so a bad publish can't leak them.
        if (row.deleted === true) continue;
        const uid = String(row.uid || row.sourceUserId || "").trim();
        const rgPlayerId = String(row.rgPlayerId || "").trim();
        const mmr = Number(row.mmr);
        if (!uid || !Number.isFinite(mmr)) continue;
        entries.push({
            uid,
            ...(rgPlayerId ? { rgPlayerId } : {}),
            name: String(row.name || ""),
            mmr,
            rank: Number(row.rank) > 0 ? Number(row.rank) : entries.length + 1,
        });
    }
    return entries;
}


export function lookupInCache(cache, uid, mode) {
    if (!cache || !cache.modes || !uid) return null;
    const entries = cache.modes[mode];
    if (!entries) return null;
    const needle = String(uid);
    // Roster logs only have the in-game id. Never match Firebase uid.
    // Old rows stored that game id in uid; new rows put it on rgPlayerId.
    return entries.find((e) => String(e.rgPlayerId || e.uid) === needle) || null;
}


export function tierColorForRank(rank) {
    if (rank <= 3) return "#ffd700";
    if (rank <= 10) return "#c77dff";
    if (rank <= 25) return "#00d4ff";
    return "#9aa5ad";
}


export function modeLabel(mode) {
    if (mode === "Competitive1v1") return "Competitive 1v1";
    if (mode === "Competitive2v2") return "Competitive 2v2";
    if (mode === "Competitive3v3") return "Competitive 3v3";
    return mode;
}


export function derivedFormatFromPlayerCount(n) {
    if (n === 2) return "Competitive1v1";
    if (n === 3 || n === 4) return "Competitive2v2";
    if (n === 5 || n === 6) return "Competitive3v3";
    return null;
}


export function parseRosterInitLine(line) {
    // no regex — 10k-char nicknames with lots of parens hit catastrophic
    // backtracking on the old lazy .*? pattern, dropping those players
    // from the roster. linear scan from the right instead.
    const s = String(line ?? "");
    const prefix = "Initialized stats for player";
    const prefixIdx = s.indexOf(prefix);
    if (prefixIdx < 0) return null;
    const uidTagIdx = s.lastIndexOf("(UserId:");
    if (uidTagIdx <= prefixIdx) return null;
    const closeIdx = s.indexOf(")", uidTagIdx);
    if (closeIdx < 0) return null;
    const details = s.substring(uidTagIdx + 1, closeIdx);
    const uidMatch = details.match(/\bUserId:\s*([^,]*)/i);
    if (!uidMatch) return null;
    const teamMatch = details.match(/\bTeam:\s*([A-Za-z]+)/i);
    const rawTeam = (teamMatch?.[1] ?? "").trim();
    const team = /^orange$/i.test(rawTeam) ? "Orange"
        : /^blue$/i.test(rawTeam) ? "Blue"
        : rawTeam || null;
    let nameStart = prefixIdx + prefix.length;
    while (nameStart < uidTagIdx && (s[nameStart] === " " || s[nameStart] === ":")) nameStart++;
    return {
        name: s.substring(nameStart, uidTagIdx).trim(),
        uid: (uidMatch[1] ?? "").trim(),
        team,
    };
}


export function trustedTeamContext(roster, selfUid, expectedPlayerCount) {
    const counts = {};
    for (const player of roster) {
        if (player.team) counts[player.team] = (counts[player.team] || 0) + 1;
    }
    const expectedPerSide = expectedPlayerCount / 2;
    const teamsBalanced = Number.isInteger(expectedPerSide)
        && roster.length === expectedPlayerCount
        && counts.Orange === expectedPerSide
        && counts.Blue === expectedPerSide;
    const selfTeam = roster.find(player => player.uid === selfUid)?.team || null;
    return { counts, teamsBalanced, selfTeam };
}
