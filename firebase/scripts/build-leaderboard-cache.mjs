import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { decodeFirestoreDocument } from "./snapshot-production.mjs";
import { incrementPipelineReads } from "./pipeline-read-counter.mjs";
import { eventsFromCacheResult, persistSecurityEvents } from "./security-log.mjs";

const execFileAsync = promisify(execFile);

export const CACHE_COLLECTION = "leaderboard_cache";
export const PLAYLISTS = Object.freeze(["1v1", "2v2", "3v3"]);
// PLAYLISTS_WITH_WINS is the union used by the JSON emitter, which also
// publishes the wins-descending playlist for the static leaderboard site.
export const PLAYLISTS_WITH_WINS = Object.freeze(["1v1", "2v2", "3v3", "wins"]);
export const CACHE_TOP_N = 100;
// First-seen UIDs above this, or above previous #1 + cushion, are held
// out of the published JSON / HUD cache. Does not reject the Firestore
// write — veterans installing the HUD for the first time still sync.
export const PUBLISH_MMR_ABS_HOLD = 15000;
export const PUBLISH_MMR_JUMP_CUSHION = 2500;
// Known high accounts that are allowed on the public JSON even when
// they look "first-seen" after a restore or a HUD reinstall.
export const PUBLISH_KEEP_NAMES = Object.freeze([
  "king von",
  "virtualzzs",
  "yamajax",
  "king slayer",
]);
export const MAX_CACHE_DOC_BYTES = 900_000;
export const SCHEMA_VERSION = 1;
export const JSON_SCHEMA_VERSION = 1;
// Fields the site renders per row. Kept in sync with the leaderboard doc
// shape (`name`, `mmr`, `wins`, `matches`, `currentStreak`, `flag`, `icons`,
// `iconSize`, `glowColor`, `glowStrength`). Nothing here should be a
// live/session field that would freeze if the JSON goes stale.
export const JSON_ROW_FIELDS = Object.freeze([
  "flag",
  "icons",
  "iconSize",
  "glowColor",
  "glowStrength",
  "wins",
  "matches",
  "currentStreak",
]);

const PUBLIC_IMAGE_HOSTS = new Set([
  "i.imgur.com",
  "imgur.com",
  "upload.wikimedia.org",
]);

function isBlockedImageHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return true;
  if (host.endsWith(".discordapp.com") || host.endsWith(".discordapp.net")) return true;
  if (host.endsWith(".githubusercontent.com") || host === "github.com" || host === "www.github.com") {
    return true;
  }
  if (host.endsWith(".jsdelivr.net")) return true;
  return false;
}

// Leftover inline country PNGs from the old board. Swap them for the
// short Wikimedia URL so the public JSON does not ship a 3–30 KB data
// URI that then gets sliced to 2048 chars and rendered as a broken image.
const KNOWN_DATA_FLAG_HTTPS = [
  ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFwAAAAxCAMAAABgWz7uAAAAnFBMVEX///+xIzOwHS6w", "https://upload.wikimedia.org/wikipedia/commons/a/a4/Flag_of_the_United_States.svg"],
  ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFwAAAA9CAMAAAAXmf6VAAAAGFBMVEX///8hRoyuHCeu", "https://upload.wikimedia.org/wikipedia/commons/2/20/Flag_of_the_Netherlands.svg"],
  ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAT4AAACfCAMAAABX0UX9AAAAkFBMVEXVKx7////TGADr", "https://upload.wikimedia.org/wikipedia/commons/d/d9/Flag_of_Canada_%28Pantone%29.svg"],
  ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFwAAAAuCAMAAACS246gAAAAb1BMVEX////PFCsAJH3O", "https://upload.wikimedia.org/wikipedia/commons/8/83/Flag_of_the_United_Kingdom_%283-5%29.svg"],
  ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAP0AAACfCAMAAAAF1y+fAAAAb1BMVEUAteJQni/vM0D/", "https://upload.wikimedia.org/wikipedia/commons/d/dd/Flag_of_Azerbaijan.svg"],
];

// Country flags stay. Discord / GitHub / jsDelivr file links do not.
export function publicImageUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (!/^(https?:|data:)/i.test(text)) return text;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(text)) {
    for (const [prefix, httpsUrl] of KNOWN_DATA_FLAG_HTTPS) {
      if (text.startsWith(prefix)) return httpsUrl;
    }
    return text;
  }
  if (text.startsWith("data:")) return "";
  try {
    const parsed = new URL(text);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    if (isBlockedImageHost(parsed.hostname)) return "";
    if (!PUBLIC_IMAGE_HOSTS.has(parsed.hostname.toLowerCase())) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

const BLOCKED_ARGUMENTS = new Set([
  "--commit",
  "--create",
  "--delete",
  "--deploy",
  "--force",
  "--import",
  "--mutation",
  "--production",
  "--restore",
  "--set",
  "--update",
  "--write",
]);

export const HELP = `Build trusted playlist aggregate docs under leaderboard_cache/.

Dry run (default — no writes):
  npm run build:leaderboard-cache -- --project rgleaderboard

Apply writes after dry-run review:
  npm run build:leaderboard-cache -- --project rgleaderboard --apply

Emit playlist JSON blobs (uploads to R2 when R2 env is set, otherwise
dumps to stdout):
  npm run build:leaderboard-cache -- --project rgleaderboard --emit-json
  npm run build:leaderboard-cache -- --project rgleaderboard --emit-json --skip-firestore

Write playlist JSON to a local directory (for GitHub Actions + Pages/jsDelivr):
  npm run build:leaderboard-cache -- --project rgleaderboard --emit-json --skip-firestore --output-dir ./data

Optional:
  --playlists 1v1,2v2,3v3[,wins]
  --top 100
  --json-prefix leaderboard/         (R2 key prefix, default "leaderboard/")
  --output-dir ./data                (write JSON to disk instead of R2)

Safety:
  - Dry run is the default.
  --apply is required for Firestore writes.
  - Client writes to leaderboard_cache are denied by rules; this script uses
    a privileged service account or admin user token.
  - Unchanged sourceHash skips the write.
  - Oversized documents are refused.
  - --emit-json without R2 env vars is a no-op upload (prints JSON to stdout).
  - --output-dir writes to disk and skips R2 entirely.
`;

function argumentKey(argument) {
  return argument.includes("=")
    ? argument.slice(0, argument.indexOf("="))
    : argument;
}

export function parseCacheArguments(args) {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }

  for (const argument of args) {
    const key = argumentKey(argument);
    if (BLOCKED_ARGUMENTS.has(key)) {
      throw new Error(`${key} is blocked: use --apply for cache writes`);
    }
  }

  let project = "";
  let apply = false;
  let playlists = null;
  let top = CACHE_TOP_N;
  let emitJson = false;
  let skipFirestore = false;
  let jsonPrefix = "leaderboard/";
  let outputDir = "";
  let stateDir = "";
  let forceFull = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--emit-json") {
      emitJson = true;
      continue;
    }
    if (argument === "--skip-firestore") {
      skipFirestore = true;
      continue;
    }
    if (argument === "--json-prefix") {
      if (!args[index + 1] || args[index + 1].startsWith("-")) {
        throw new Error("--json-prefix requires a value");
      }
      jsonPrefix = args[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--json-prefix=")) {
      jsonPrefix = argument.slice("--json-prefix=".length);
      continue;
    }
    if (argument === "--output-dir") {
      if (!args[index + 1] || args[index + 1].startsWith("-")) {
        throw new Error("--output-dir requires a path");
      }
      outputDir = args[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--output-dir=")) {
      outputDir = argument.slice("--output-dir=".length);
      continue;
    }
    if (argument === "--state-dir") {
      if (!args[index + 1] || args[index + 1].startsWith("-")) {
        throw new Error("--state-dir requires a path");
      }
      stateDir = args[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--state-dir=")) {
      stateDir = argument.slice("--state-dir=".length);
      continue;
    }
    if (argument === "--force-full") {
      forceFull = true;
      continue;
    }
    if (argument === "--project") {
      if (project || !args[index + 1] || args[index + 1].startsWith("-")) {
        throw new Error("--project requires one explicit project ID");
      }
      project = args[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--project=")) {
      if (project) throw new Error("--project may only be provided once");
      project = argument.slice("--project=".length);
      continue;
    }
    if (argument === "--playlists") {
      if (!args[index + 1] || args[index + 1].startsWith("-")) {
        throw new Error("--playlists requires a comma-separated list");
      }
      playlists = args[index + 1]
        .split(",")
        .map(value => value.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }
    if (argument.startsWith("--playlists=")) {
      playlists = argument
        .slice("--playlists=".length)
        .split(",")
        .map(value => value.trim())
        .filter(Boolean);
      continue;
    }
    if (argument === "--top") {
      if (!args[index + 1] || args[index + 1].startsWith("-")) {
        throw new Error("--top requires a positive integer");
      }
      top = Number(args[index + 1]);
      index += 1;
      continue;
    }
    if (argument.startsWith("--top=")) {
      top = Number(argument.slice("--top=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!project) throw new Error("--project is required");
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
    throw new Error("Project ID has an invalid format");
  }
  if (!Number.isInteger(top) || top < 1 || top > 500) {
    throw new Error("--top must be an integer from 1 to 500");
  }
  // When emitting JSON, wins is a supported playlist. Firestore-only mode
  // keeps the historical 1v1/2v2/3v3 default to preserve existing behavior.
  const allowedPlaylists = emitJson ? PLAYLISTS_WITH_WINS : PLAYLISTS;
  if (playlists === null) {
    playlists = [...allowedPlaylists];
  }
  for (const playlist of playlists) {
    if (!allowedPlaylists.includes(playlist)) {
      throw new Error(`Unsupported playlist: ${playlist}`);
    }
  }
  if (!playlists.length) throw new Error("--playlists must not be empty");
  if (skipFirestore && !emitJson) {
    throw new Error("--skip-firestore requires --emit-json");
  }
  if (typeof jsonPrefix !== "string") {
    throw new Error("--json-prefix must be a string");
  }
  if (jsonPrefix && !jsonPrefix.endsWith("/")) jsonPrefix += "/";

  if (outputDir && !emitJson) {
    throw new Error("--output-dir requires --emit-json");
  }

  return {
    help: false,
    project,
    apply,
    playlists,
    top,
    emitJson,
    skipFirestore,
    jsonPrefix,
    outputDir,
    stateDir,
    forceFull,
  };
}

export function compactLeaderboardRow(raw, rank) {
  // Soft-deleted rows never make it to the published JSON.
  if (raw?.deleted === true) return null;
  const uid = String(raw?.sourceUserId || raw?.uid || raw?._docId || "").trim();
  const name = String(raw?.name || "").trim();
  const mmr = Number(raw?.mmr);
  if (!uid || !Number.isFinite(mmr)) return null;
  const rgPlayerId = String(raw?.rgPlayerId || "").trim();
  return {
    uid,
    name: name.slice(0, 120),
    mmr: Math.round(mmr),
    rank: Number(rank),
    ...(rgPlayerId ? { rgPlayerId } : {}),
  };
}

export function sourceHashForRows(rows) {
  const payload = rows.map(row => [
    row.uid,
    row.rgPlayerId || "",
    row.name,
    row.mmr,
    row.rank,
  ]);
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

export function buildCacheDocument(playlist, rows, {
  builtAt = new Date().toISOString(),
  builder = "build-leaderboard-cache",
} = {}) {
  // Rank must come after the filter — a soft-deleted row was leaving a
  // gap (missing #67) and shifting every later rank up by one.
  const compact = rows
    .map(row => compactLeaderboardRow(row, 0))
    .filter(Boolean)
    .map((row, index) => ({ ...row, rank: index + 1 }));
  const sourceHash = sourceHashForRows(compact);
  return {
    schemaVersion: SCHEMA_VERSION,
    playlist,
    rowCount: compact.length,
    sourceHash,
    builtAt,
    builder,
    rows: compact,
  };
}

// Richer row for the static-JSON site. Keeps the compact ranking fields
// (uid/name/rank plus mmr or wins/matches depending on playlist) and adds
// the presentation fields the client needs to render without a second
// Firestore lookup: flag, icons, iconSize, glowColor, glowStrength.
// currentStreak is deliberately included but the caller should treat it as
// possibly stale — the JSON is rebuilt on a debounced timer, not live.
export function buildJsonRow(raw, rank, playlist) {
  // Soft-deleted rows are hidden from the JSON blob.
  if (raw?.deleted === true) return null;
  const uid = String(raw?.sourceUserId || raw?.uid || raw?._docId || "").trim();
  const name = String(raw?.name || "").trim();
  if (!uid) return null;
  const row = {
    rank: Number(rank),
    uid,
    name: name.slice(0, 120),
  };
  // Manual admin rows have random Firestore ids that don't match the
  // deterministic {uid}_{playlist} slot. Emit the real doc id so the
  // client's edit/delete targets the actual document. ATLAS-synced
  // rows omit this field to keep the JSON compact.
  const docId = String(raw?._docId || "").trim();
  if (docId && docId !== `${uid}_${playlist}`) {
    row._docId = docId;
  }
  // Explicit sourceUserId is emitted whenever it's actually on the doc,
  // so the client can distinguish "uid is a real source id" from "uid
  // fell back to the doc id". Enables ATLAS-badge + purge-all-playlists
  // fan-out even for rows sitting at a random-id path.
  const sourceUserId = String(raw?.sourceUserId || "").trim();
  if (sourceUserId) {
    row.sourceUserId = sourceUserId;
  }
  if (playlist === "wins") {
    const wins = Number(raw?.wins);
    const matches = Number(raw?.matches);
    if (!Number.isFinite(wins) || !Number.isFinite(matches)) return null;
    row.wins = Math.round(wins);
    row.matches = Math.round(matches);
  } else {
    const mmr = Number(raw?.mmr);
    if (!Number.isFinite(mmr)) return null;
    row.mmr = Math.round(mmr);
    // Include wins/matches when present so wins-descending views on the
    // site can share row objects with the mmr views.
    if (Number.isFinite(Number(raw?.wins))) row.wins = Math.round(Number(raw.wins));
    if (Number.isFinite(Number(raw?.matches))) {
      row.matches = Math.round(Number(raw.matches));
    }
  }
  if (raw?.flag && typeof raw.flag === "string") {
    const flag = publicImageUrl(raw.flag);
    if (flag) row.flag = flag.startsWith("data:") ? flag : flag.slice(0, 2048);
  }
  if (raw?.icons !== undefined && raw.icons !== null) {
    if (typeof raw.icons === "string") {
      const icons = raw.icons
        .split(",")
        .map(icon => publicImageUrl(icon.trim()))
        .filter(Boolean)
        .join(",");
      if (icons) row.icons = icons.slice(0, 10000);
    } else if (Array.isArray(raw.icons)) {
      const icons = raw.icons
        .slice(0, 12)
        .map(icon => publicImageUrl(icon))
        .filter(Boolean);
      if (icons.length) row.icons = icons;
    }
  }
  if (Number.isFinite(Number(raw?.iconSize))) {
    row.iconSize = Number(raw.iconSize);
  }
  if (typeof raw?.glowColor === "string") {
    row.glowColor = raw.glowColor;
  }
  if (Number.isFinite(Number(raw?.glowStrength))) {
    row.glowStrength = Number(raw.glowStrength);
  }
  if (Number.isFinite(Number(raw?.currentStreak))) {
    row.currentStreak = Math.trunc(Number(raw.currentStreak));
  }
  // Raw Glicko-2 numbers. Optional — only emitted when the HUD wrote
  // them (18.x builds don't have these fields).
  if (Number.isFinite(Number(raw?.rating))) row.rating = Number(raw.rating);
  if (Number.isFinite(Number(raw?.rd))) row.rd = Number(raw.rd);
  if (Number.isFinite(Number(raw?.vol))) row.vol = Number(raw.vol);
  // Session fields drive "Last played N ago" and the +delta pill on the site.
  // Without them every row hovers to "Last played: unknown".
  if (Number.isFinite(Number(raw?.sessionStartedAt))) {
    row.sessionStartedAt = Math.trunc(Number(raw.sessionStartedAt));
  }
  if (Number.isFinite(Number(raw?.sessionLastSeen))) {
    row.sessionLastSeen = Math.trunc(Number(raw.sessionLastSeen));
  }
  if (Number.isFinite(Number(raw?.sessionMmrDelta))) {
    row.sessionMmrDelta = Math.trunc(Number(raw.sessionMmrDelta));
  }
  if (raw?.reviewFlagged === true) {
    row.reviewFlagged = true;
  }
  return row;
}

// JSON blob shape:
//   { playlist, builtAt, sourceHash, schemaVersion, rowCount, rows: [...] }
// The sourceHash is a stable digest over the compact ranking fields only
// (uid/name/rank plus mmr or wins/matches) so cosmetic-only changes to
// flag/icons/glow don't cause every rebuild to write a new JSON blob.
export function buildLeaderboardJson(playlist, rows, {
  builtAt = new Date().toISOString(),
  builder = "build-leaderboard-cache",
} = {}) {
  // Same gap fix as buildCacheDocument — rank after filter, not before.
  const enriched = rows
    .map(row => buildJsonRow(row, 0, playlist))
    .filter(Boolean)
    .map((row, index) => ({ ...row, rank: index + 1 }));
  const compactForHash = enriched.map(row => {
    if (playlist === "wins") {
      return { uid: row.uid, name: row.name, wins: row.wins, matches: row.matches, rank: row.rank };
    }
    return { uid: row.uid, name: row.name, mmr: row.mmr, rank: row.rank };
  });
  const sourceHash = createHash("sha256")
    .update(JSON.stringify(compactForHash))
    .digest("hex");
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    playlist,
    builtAt,
    builder,
    sourceHash,
    rowCount: enriched.length,
    rows: enriched,
  };
}

export function estimateDocumentBytes(document) {
  return Buffer.byteLength(JSON.stringify(document), "utf8");
}

export function assertCacheDocumentSize(document, maxBytes = MAX_CACHE_DOC_BYTES) {
  const bytes = estimateDocumentBytes(document);
  if (bytes > maxBytes) {
    throw new Error(
      `${CACHE_COLLECTION}/${document.playlist} is ${bytes} bytes (max ${maxBytes})`,
    );
  }
  return bytes;
}

export function planCacheWrite(existingFields, nextDocument) {
  assertCacheDocumentSize(nextDocument);
  if (existingFields?.sourceHash === nextDocument.sourceHash
      && existingFields?.rowCount === nextDocument.rowCount
      && Number(existingFields?.schemaVersion) === nextDocument.schemaVersion) {
    return { action: "skip", reason: "sourceHash unchanged", document: nextDocument };
  }
  return { action: "write", reason: "content changed", document: nextDocument };
}

function encodeFirestoreValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map(encodeFirestoreValue),
      },
    };
  }
  if (value && typeof value === "object") {
    return {
      mapValue: {
        fields: encodeFirestoreFields(value),
      },
    };
  }
  throw new Error(`Unsupported Firestore value: ${typeof value}`);
}

function encodeFirestoreFields(document) {
  return Object.fromEntries(
    Object.entries(document).map(([key, value]) => [
      key,
      encodeFirestoreValue(value),
    ]),
  );
}

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
  if (options.method === "GET" && response.status === 404) return null;
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = body?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Firestore request failed (${response.status}): ${message}`);
  }
  return body;
}

export async function getGcloudAccessToken() {
  if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) {
    return process.env.GOOGLE_OAUTH_ACCESS_TOKEN.trim();
  }
  const { stdout } = await execFileAsync(
    "gcloud",
    ["auth", "print-access-token"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDSDK_METRICS_ENVIRONMENT: "atlas-leaderboard-cache",
      },
      maxBuffer: 1024 * 1024,
    },
  );
  const token = stdout.trim();
  if (!token) throw new Error("gcloud returned an empty access token");
  return token;
}

export async function queryPlaylistRows(
  fetchImpl,
  token,
  project,
  playlist,
  top = CACHE_TOP_N,
) {
  // The wins playlist ranks by wins DESC (matching `firestore.indexes.json`);
  // every other playlist ranks by mmr DESC.
  const orderField = playlist === "wins" ? "wins" : "mmr";
  const body = await apiJson(
    fetchImpl,
    token,
    `${documentsBase(project)}:runQuery`,
    {
      method: "POST",
      quotaProject: project,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "leaderboard" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "playlist" },
              op: "EQUAL",
              value: { stringValue: playlist },
            },
          },
          orderBy: [
            { field: { fieldPath: orderField }, direction: "DESCENDING" },
          ],
          limit: top,
        },
      }),
    },
  );

  const rows = [];
  for (const entry of body || []) {
    if (!entry?.document) continue;
    const decoded = decodeFirestoreDocument(entry.document);
    // _docId is a uid fallback for legacy admin rows with no sourceUserId.
    rows.push({ ...decoded.fields, _docId: decoded.id, _updateTime: decoded.updateTime });
  }
  return rows;
}

// Only pull rows that changed since `since`. Needs the (playlist,
// lastWriteAt) composite index; callers fall back to full-scan if not ready.
export async function queryPlaylistDelta(
  fetchImpl,
  token,
  project,
  playlist,
  since,
) {
  const body = await apiJson(
    fetchImpl,
    token,
    `${documentsBase(project)}:runQuery`,
    {
      method: "POST",
      quotaProject: project,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "leaderboard" }],
          where: {
            compositeFilter: {
              op: "AND",
              filters: [
                {
                  fieldFilter: {
                    field: { fieldPath: "playlist" },
                    op: "EQUAL",
                    value: { stringValue: playlist },
                  },
                },
                {
                  fieldFilter: {
                    field: { fieldPath: "lastWriteAt" },
                    op: "GREATER_THAN",
                    value: { timestampValue: since },
                  },
                },
              ],
            },
          },
          orderBy: [
            { field: { fieldPath: "lastWriteAt" }, direction: "ASCENDING" },
          ],
        },
      }),
    },
  );
  const rows = [];
  for (const entry of body || []) {
    if (!entry?.document) continue;
    const decoded = decodeFirestoreDocument(entry.document);
    rows.push({ ...decoded.fields, _docId: decoded.id, _updateTime: decoded.updateTime });
  }
  return rows;
}

// Upsert changed rows into the previous snapshot by doc id.
export function mergeSnapshot(previous, delta) {
  const byId = new Map();
  for (const row of Array.isArray(previous) ? previous : []) {
    if (row?._docId) byId.set(row._docId, row);
  }
  for (const row of Array.isArray(delta) ? delta : []) {
    if (row?._docId) byId.set(row._docId, row);
  }
  return Array.from(byId.values());
}

export function normalizePublishName(name) {
  return String(name || "")
    .trim()
    .replace(/^\[[^\]]+\]\s*/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// Same person, different HUD name or Firebase uid. Canonical key first,
// then a display name they asked to keep on the public board.
const IDENTITY_NAME_ALIASES = {
  "romance anime a": "virtualzzs",
  virtualzzs: "virtualzzs",
};
const IDENTITY_UID_ALIASES = {
  "5UHW153KADWkCoU5aEDRpc6rrCw2": "virtualzzs",
  Ly8RPbr4z4Svd0IyUMJrR9B1wRh1: "virtualzzs",
};
const IDENTITY_DISPLAY_NAMES = {
  virtualzzs: "[KING] Virtualzzs",
};

export function identityKey(row) {
  const uid = String(row?.sourceUserId || row?.uid || "").trim();
  if (uid && IDENTITY_UID_ALIASES[uid]) return IDENTITY_UID_ALIASES[uid];
  const name = normalizePublishName(row?.name);
  return IDENTITY_NAME_ALIASES[name] || name;
}

function rowUid(row) {
  return String(row?.sourceUserId || row?.uid || row?._docId || "").trim();
}

function rowVersion(row) {
  const value = Number(row?.versionNum);
  return Number.isFinite(value) ? value : 0;
}

function rowWriteAt(row) {
  const raw = row?.lastWriteAt || row?._updateTime || "";
  const parsed = Date.parse(typeof raw === "string" ? raw : String(raw));
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowScore(row, playlist) {
  const value = Number(playlist === "wins" ? row?.wins : row?.mmr);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function rowSessionSeen(row) {
  const value = Number(row?.sessionLastSeen);
  return Number.isFinite(value) ? value : 0;
}

function preferIdentityRow(current, candidate, playlist) {
  if (rowVersion(candidate) !== rowVersion(current)) {
    return rowVersion(candidate) > rowVersion(current);
  }
  if (rowWriteAt(candidate) !== rowWriteAt(current)) {
    return rowWriteAt(candidate) > rowWriteAt(current);
  }
  if (rowSessionSeen(candidate) !== rowSessionSeen(current)) {
    return rowSessionSeen(candidate) > rowSessionSeen(current);
  }
  return rowScore(candidate, playlist) > rowScore(current, playlist);
}

function absorbIdentityExtras(winner, loser) {
  if (!winner || !loser) return winner;
  const out = { ...winner };
  if (!out.flag && loser.flag) out.flag = loser.flag;
  if (!out.icons && loser.icons) out.icons = loser.icons;
  if (out.iconSize == null && loser.iconSize != null) out.iconSize = loser.iconSize;
  if (!out.glowColor && loser.glowColor) out.glowColor = loser.glowColor;
  if (out.glowStrength == null && loser.glowStrength != null) out.glowStrength = loser.glowStrength;
  const preferred = IDENTITY_DISPLAY_NAMES[identityKey(out)]
    || IDENTITY_DISPLAY_NAMES[identityKey(loser)];
  if (preferred) {
    out.name = preferred;
  } else {
    const winnerTagged = /^\[[^\]]+\]\s*/.test(String(winner.name || "").trim());
    const loserTagged = /^\[[^\]]+\]\s*/.test(String(loser.name || "").trim());
    if (!winnerTagged && loserTagged
        && identityKey(winner) === identityKey(loser)) {
      out.name = loser.name;
    }
  }
  return out;
}

function collapseByKey(rows, playlist, keyFn) {
  const kept = new Map();
  const leftovers = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = keyFn(row);
    if (!key) {
      leftovers.push(row);
      continue;
    }
    const existing = kept.get(key);
    if (!existing) {
      kept.set(key, row);
      continue;
    }
    if (preferIdentityRow(existing, row, playlist)) {
      kept.set(key, absorbIdentityExtras(row, existing));
    } else {
      kept.set(key, absorbIdentityExtras(existing, row));
    }
  }
  return [...kept.values(), ...leftovers].map((row) => {
    const preferred = IDENTITY_DISPLAY_NAMES[identityKey(row)];
    return preferred && row?.name !== preferred ? { ...row, name: preferred } : row;
  });
}

// HUD reinstalls mint a new anonymous Firebase uid, so the same player
// can land twice under the same name (or the same in-game id). Collapse
// in-game id first, then display name, so either kind of twin drops.
export function dedupeRowsByIdentity(rows, playlist) {
  const byGameId = collapseByKey(
    rows,
    playlist,
    row => String(row?.rgPlayerId || "").trim() || "",
  );
  return collapseByKey(
    byGameId,
    playlist,
    row => identityKey(row),
  );
}

// New uid showing up already above the current top (plus a cushion)
// stays out of the public JSON. Already-published players are left alone.
export function holdSuspiciousRankedRows(rows, previousRows = []) {
  const prev = Array.isArray(previousRows) ? previousRows : [];
  const seenUids = new Set(
    prev.map(row => String(row?.sourceUserId || row?.uid || "").trim()).filter(Boolean),
  );
  const seenNames = new Set(
    prev.map(row => normalizePublishName(row?.name)).filter(Boolean),
  );
  const keepNames = new Set(PUBLISH_KEEP_NAMES.map(normalizePublishName));
  let previousMax = 0;
  for (const row of prev) {
    const mmr = Number(row?.mmr);
    if (Number.isFinite(mmr) && mmr > previousMax) previousMax = mmr;
  }
  const threshold = Math.max(PUBLISH_MMR_ABS_HOLD, previousMax + PUBLISH_MMR_JUMP_CUSHION);
  const kept = [];
  const held = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const uid = String(row?.sourceUserId || row?.uid || "").trim();
    const mmr = Number(row?.mmr);
    const nameKey = normalizePublishName(row?.name);
    const firstSeen = Boolean(uid) && !seenUids.has(uid) && !seenNames.has(nameKey);
    const known = keepNames.has(nameKey);
    if (firstSeen && !known && Number.isFinite(mmr) && mmr > threshold) {
      held.push({
        uid,
        name: String(row?.name || ""),
        mmr,
        threshold,
        reason: `first-seen mmr ${mmr} > ${threshold}`,
      });
      continue;
    }
    kept.push(row);
  }
  return { kept, held, threshold };
}

// Tie-breakers matter: without them ranks shuffle between publishes,
// and on the wins playlist a 7/12 grinder outranked a 7/10 player. Order:
// primary desc, matches asc (wins only), name, uid.
export function sortSnapshotForPlaylist(rows, playlist) {
  const primary = playlist === "wins" ? "wins" : "mmr";
  const nameOf = row => String(row?.name || "");
  const uidOf = row => String(row?.sourceUserId || row?.uid || row?._docId || "");
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const aValue = Number(a?.[primary]);
    const bValue = Number(b?.[primary]);
    const aFinite = Number.isFinite(aValue);
    const bFinite = Number.isFinite(bValue);
    if (!aFinite && !bFinite) return 0;
    if (!aFinite) return 1;
    if (!bFinite) return -1;
    if (aValue !== bValue) return bValue - aValue;
    if (playlist === "wins") {
      const aMatches = Number(a?.matches);
      const bMatches = Number(b?.matches);
      const aMatchFinite = Number.isFinite(aMatches);
      const bMatchFinite = Number.isFinite(bMatches);
      if (aMatchFinite && bMatchFinite && aMatches !== bMatches) return aMatches - bMatches;
      if (aMatchFinite && !bMatchFinite) return -1;
      if (!aMatchFinite && bMatchFinite) return 1;
    }
    const nameCompare = nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: "base" });
    if (nameCompare !== 0) return nameCompare;
    return uidOf(a).localeCompare(uidOf(b));
  });
}

// Newest lastWriteAt across the batch — becomes next "since" cursor.
export function maxLastWriteAt(rows) {
  let max = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const raw = row?.lastWriteAt;
    const ts = typeof raw === "string" ? raw : raw?.value;
    if (typeof ts === "string" && (!max || ts > max)) max = ts;
  }
  return max;
}

export function blacklistPausesWrites(data) {
  const fields = data?.fields && typeof data.fields === "object" ? data.fields : data;
  return fields?.pauseWrites === true;
}

export function allowedUserIdsFromControl(data) {
  const fields = data?.fields && typeof data.fields === "object" ? data.fields : data;
  return Array.isArray(fields?.allowedUserIds) ? fields.allowedUserIds.map(String) : null;
}

// HUD-synced rows need an allowlisted uid. Manual admin rows have no
// sourceUserId and still publish. If the control field is missing, keep
// the old "publish everyone" behavior so a bad deploy cannot blank the board.
export function keepAllowlistedRows(rows, allowedUserIds) {
  if (!Array.isArray(allowedUserIds)) return Array.isArray(rows) ? rows : [];
  const allow = new Set(allowedUserIds.map(id => String(id || "").trim()).filter(Boolean));
  return (Array.isArray(rows) ? rows : []).filter(row => {
    const uid = String(row?.sourceUserId || "").trim();
    if (!uid) return true;
    return allow.has(uid);
  });
}

// First-seen poison rows already held off the public JSON. Ban the uid
// when MMR is cartoonishly high so the next HUD write dies in rules.
export const AUTO_BLACKLIST_MMR = 20000;
export function uidsToAutoBlacklist(heldRows, alreadyBanned = [], alreadyAllowed = []) {
  const banned = new Set((alreadyBanned || []).map(id => String(id || "").trim()));
  const allowed = new Set((alreadyAllowed || []).map(id => String(id || "").trim()).filter(Boolean));
  const add = [];
  for (const row of Array.isArray(heldRows) ? heldRows : []) {
    const uid = String(row?.uid || "").trim();
    const mmr = Number(row?.mmr);
    if (!uid || banned.has(uid) || allowed.has(uid) || !Number.isFinite(mmr) || mmr < AUTO_BLACKLIST_MMR) continue;
    banned.add(uid);
    add.push(uid);
  }
  return add;
}

export async function readAccessControl(fetchImpl, token, project) {
  const body = await apiJson(
    fetchImpl,
    token,
    `${documentsBase(project)}/admin/blacklist`,
    { method: "GET", quotaProject: project },
  );
  if (!body?.name) return { paused: false, allowedUserIds: null, userIds: [] };
  const decoded = decodeFirestoreDocument(body);
  return {
    paused: blacklistPausesWrites(decoded),
    allowedUserIds: allowedUserIdsFromControl(decoded),
    userIds: Array.isArray(decoded?.userIds) ? decoded.userIds.map(String) : [],
  };
}

export async function readWritesPaused(fetchImpl, token, project) {
  const control = await readAccessControl(fetchImpl, token, project);
  return control.paused;
}

export async function appendBlacklistUserIds(fetchImpl, token, project, extraIds) {
  const ids = [...new Set((extraIds || []).map(id => String(id || "").trim()).filter(Boolean))];
  if (!ids.length) return { written: false, userIds: [] };
  const control = await readAccessControl(fetchImpl, token, project);
  const merged = [...new Set([...(control.userIds || []), ...ids])];
  await apiJson(
    fetchImpl,
    token,
    `${documentsBase(project)}/admin/blacklist?updateMask.fieldPaths=userIds`,
    {
      method: "PATCH",
      quotaProject: project,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          userIds: {
            arrayValue: { values: merged.map(id => ({ stringValue: id })) },
          },
        },
      }),
    },
  );
  return { written: true, userIds: merged };
}

export async function readCacheDocument(
  fetchImpl,
  token,
  project,
  playlist,
) {
  const body = await apiJson(
    fetchImpl,
    token,
    `${documentsBase(project)}/${CACHE_COLLECTION}/${encodeURIComponent(playlist)}`,
    { method: "GET", quotaProject: project },
  );
  if (!body?.name) return null;
  return decodeFirestoreDocument(body);
}

export async function queryIconKeyRows(fetchImpl, token, project) {
  const documents = [];
  let pageToken = "";
  do {
    const url = new URL(`${documentsBase(project)}/iconKey`);
    url.searchParams.set("pageSize", "300");
    url.searchParams.set("orderBy", "__name__");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const body = await apiJson(fetchImpl, token, url, {
      method: "GET",
      quotaProject: project,
    });
    for (const document of body.documents || []) {
      documents.push(decodeFirestoreDocument(document));
    }
    pageToken = body.nextPageToken || "";
  } while (pageToken);
  return documents.map(document => ({
    id: document.id,
    icon: String(document.fields?.icon || "").trim(),
    label: String(document.fields?.label || "").trim(),
  })).filter(row => row.id && row.icon && row.label);
}

export function buildIconKeyManifest(rows, {
  builtAt = new Date().toISOString(),
  builder = "build-leaderboard-cache",
} = {}) {
  const compact = rows
    .map(row => ({
      id: String(row.id),
      icon: String(row.icon || "").slice(0, 500),
      label: String(row.label || "").slice(0, 100),
    }))
    .filter(row => row.id && row.icon && row.label)
    .sort((left, right) => left.id.localeCompare(right.id));
  const sourceHash = createHash("sha256")
    .update(JSON.stringify(compact))
    .digest("hex");
  return {
    schemaVersion: SCHEMA_VERSION,
    playlist: "iconKey",
    rowCount: compact.length,
    sourceHash,
    builtAt,
    builder,
    rows: compact,
  };
}

async function commitWrites(fetchImpl, token, project, writes) {
  if (!writes.length) return { writeResults: [] };
  return apiJson(
    fetchImpl,
    token,
    `${documentsBase(project)}:commit`,
    {
      method: "POST",
      quotaProject: project,
      body: JSON.stringify({ writes }),
    },
  );
}

export async function buildLeaderboardCaches({
  project,
  apply = false,
  playlists = PLAYLISTS,
  top = CACHE_TOP_N,
  fetchImpl = globalThis.fetch,
  getToken = getGcloudAccessToken,
  includeIconKey = true,
  now = () => new Date().toISOString(),
  emitJson = false,
  skipFirestore = false,
  jsonPrefix = "leaderboard/",
  uploadJsonImpl = null,
  onJsonBlob = null,
  loadStateFor = null,
  saveStateFor = null,
  forceFull = false,
  checkHalt = true,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is required");
  }
  const token = await getToken();
  const access = checkHalt
    ? await readAccessControl(fetchImpl, token, project)
    : { paused: false, allowedUserIds: null, userIds: [] };
  if (checkHalt && access.paused) {
    console.warn("[halt] pauseWrites is on. Skipping publish.");
    return {
      project,
      apply,
      emitJson,
      skipFirestore,
      written: 0,
      skipped: 0,
      plannedWrites: 0,
      plans: [],
      commitResult: null,
      jsonBlobs: [],
      uploads: [],
      stateSummary: [],
      heldRows: [],
      autoBanUids: [],
      paused: true,
    };
  }
  const builtAt = now();
  const plans = [];
  const writes = [];
  const jsonBlobs = [];
  const uploads = [];
  const stateSummary = [];
  const heldRows = [];
  let autoBanUids = [];

  for (const playlist of playlists) {
    // If prior state exists, pull only what changed since then. Otherwise
    // (or on --force-full / index-not-ready) do a full scan.
    const priorState = (!forceFull && typeof loadStateFor === "function")
      ? (await loadStateFor(playlist)) || {}
      : {};
    const priorSnapshot = Array.isArray(priorState.snapshot) ? priorState.snapshot : null;
    const priorSince = typeof priorState.since === "string" ? priorState.since : null;

    let rows;
    let deltaRows = null;
    let mode = "full";
    let fallbackReason = null;
    if (priorSnapshot && priorSince && !forceFull) {
      try {
        deltaRows = await queryPlaylistDelta(
          fetchImpl,
          token,
          project,
          playlist,
          priorSince,
        );
        // Nothing changed since the last run — skip the readCacheDocument
        // GET, the write plan, and the JSON emit for this playlist. Keep
        // the cursor where it is by rewriting the same state back. Saves
        // ~1 Firestore GET per playlist per minute (~1.5k reads/day).
        if (deltaRows.length === 0) {
          console.log(`[cdc:${playlist}] no changes, skipped`);
          stateSummary.push({
            playlist,
            mode: "delta",
            snapshotRows: priorSnapshot.length,
            deltaRows: 0,
            nextSince: priorSince,
            fallbackReason: null,
            skipped: true,
          });
          if (typeof saveStateFor === "function") {
            await saveStateFor(playlist, { since: priorSince, snapshot: priorSnapshot });
          }
          continue;
        }
        rows = mergeSnapshot(priorSnapshot, deltaRows);
        mode = "delta";
      } catch (error) {
        const message = error?.message || String(error);
        if (/FAILED_PRECONDITION|requires an index/i.test(message)) {
          console.log(`[cdc:${playlist}] delta query rejected (index not ready?), falling back to full scan`);
          rows = await queryPlaylistRows(fetchImpl, token, project, playlist, top);
          mode = "full-fallback";
          fallbackReason = "index_not_ready";
        } else {
          throw error;
        }
      }
    } else {
      rows = await queryPlaylistRows(fetchImpl, token, project, playlist, top);
    }

    // Full snapshot goes back to saveStateFor; top-N slice is what we publish.
    const sortedForPlaylist = sortSnapshotForPlaylist(
      dedupeRowsByIdentity(rows, playlist),
      playlist,
    );
    const hold = playlist === "wins"
      ? { kept: sortedForPlaylist, held: [], threshold: null }
      : holdSuspiciousRankedRows(sortedForPlaylist, priorSnapshot || []);
    if (hold.held.length) {
      console.warn(`[hold:${playlist}] withheld ${hold.held.length} first-seen row(s) above ${hold.threshold}`);
      for (const row of hold.held) {
        console.warn(`  ${row.uid} ${row.name} mmr=${row.mmr} (${row.reason})`);
        heldRows.push({ playlist, ...row });
      }
    }
    const allowlisted = keepAllowlistedRows(hold.kept, access.allowedUserIds);
    const topSlice = allowlisted.slice(0, top);

    // Advance the cursor; keep the prior one if no rows came back this run.
    const nextSince = maxLastWriteAt(mode === "delta" ? deltaRows : rows)
      || priorSince
      || builtAt;
    stateSummary.push({
      playlist,
      mode,
      snapshotRows: rows.length,
      deltaRows: deltaRows?.length ?? null,
      nextSince,
      fallbackReason,
    });
    if (typeof saveStateFor === "function") {
      await saveStateFor(playlist, { since: nextSince, snapshot: rows });
    }

    // Downstream steps see the sorted-and-sliced top-N, same as before.
    rows = topSlice;

    // Firestore leaderboard_cache write path (unchanged behavior).
    if (!skipFirestore) {
      const document = buildCacheDocument(playlist, rows, { builtAt });
      const existing = await readCacheDocument(
        fetchImpl,
        token,
        project,
        playlist,
      );
      const plan = planCacheWrite(existing?.fields || null, document);
      plans.push({ path: `${CACHE_COLLECTION}/${playlist}`, ...plan });
      if (plan.action === "write" && apply) {
        writes.push({
          update: {
            name: `projects/${project}/databases/(default)/documents/${CACHE_COLLECTION}/${playlist}`,
            fields: encodeFirestoreFields(plan.document),
          },
        });
      }
    }

    // JSON emit path — built alongside Firestore so we only run the query
    // once. Upload happens after the loop so we can report a summary.
    if (emitJson) {
      const jsonBlob = buildLeaderboardJson(playlist, rows, { builtAt });
      const key = `${jsonPrefix}${playlist}.json`;
      jsonBlobs.push({ playlist, key, blob: jsonBlob });
      if (typeof onJsonBlob === "function") {
        onJsonBlob({ playlist, key, blob: jsonBlob });
      }
    }
  }

  if (!skipFirestore && includeIconKey) {
    const iconRows = await queryIconKeyRows(fetchImpl, token, project);
    const document = buildIconKeyManifest(iconRows, { builtAt });
    const existing = await readCacheDocument(
      fetchImpl,
      token,
      project,
      "iconKey",
    );
    const plan = planCacheWrite(existing?.fields || null, document);
    plans.push({ path: `${CACHE_COLLECTION}/iconKey`, ...plan });
    if (plan.action === "write" && apply) {
      writes.push({
        update: {
          name: `projects/${project}/databases/(default)/documents/${CACHE_COLLECTION}/iconKey`,
          fields: encodeFirestoreFields(plan.document),
        },
      });
    }
  }

  let commitResult = null;
  if (apply && writes.length) {
    commitResult = await commitWrites(fetchImpl, token, project, writes);
  }

  // R2 upload for each emitted JSON blob. If uploadJsonImpl isn't provided
  // (or R2 env vars are missing), we skip the upload — the CLI dumps the
  // JSON to stdout instead so operators can verify the shape locally.
  if (emitJson && typeof uploadJsonImpl === "function") {
    for (const entry of jsonBlobs) {
      try {
        const result = await uploadJsonImpl(entry.key, entry.blob, {
          sourceHash: entry.blob.sourceHash,
        });
        uploads.push({
          playlist: entry.playlist,
          key: entry.key,
          status: result?.status || 0,
          etag: result?.etag || "",
          sourceHash: entry.blob.sourceHash,
          action: "uploaded",
        });
      } catch (error) {
        uploads.push({
          playlist: entry.playlist,
          key: entry.key,
          action: "failed",
          error: error?.message || String(error),
        });
        throw error;
      }
    }
  } else if (emitJson) {
    for (const entry of jsonBlobs) {
      uploads.push({
        playlist: entry.playlist,
        key: entry.key,
        action: "skipped-no-uploader",
        sourceHash: entry.blob.sourceHash,
      });
    }
  }

  // Bump the daily pipeline read counter so the admin dashboard can see
  // how much this cron actually costs. Sum of deltaRows across all
  // playlists this run; non-fatal on failure. Only fires on --apply so
  // dry-runs stay read-only.
  if (apply) {
    const readsThisRun = stateSummary.reduce(
      (sum, entry) => sum + (entry.deltaRows ?? entry.snapshotRows ?? 0),
      0,
    );
    await incrementPipelineReads({
      fetchImpl,
      token,
      project,
      label: "build-leaderboard-cache",
      reads: readsThisRun,
    });
    const autoBan = uidsToAutoBlacklist(heldRows, access.userIds, access.allowedUserIds);
    autoBanUids = autoBan;
    if (autoBan.length) {
      try {
        await appendBlacklistUserIds(fetchImpl, token, project, autoBan);
        console.warn(`[autoban] added ${autoBan.length} uid(s) over ${AUTO_BLACKLIST_MMR} MMR`);
      } catch (error) {
        console.warn(`[autoban] skipped: ${error?.message || error}`);
      }
    }
  } else {
    autoBanUids = uidsToAutoBlacklist(heldRows, access.userIds, access.allowedUserIds);
  }

  return {
    project,
    apply,
    emitJson,
    skipFirestore,
    written: apply ? writes.length : 0,
    skipped: plans.filter(plan => plan.action === "skip").length,
    plannedWrites: plans.filter(plan => plan.action === "write").length,
    plans,
    commitResult,
    jsonBlobs,
    uploads,
    stateSummary,
    heldRows,
    autoBanUids,
  };
}

// Load the R2 uploader lazily so this script keeps working with only the
// Firestore path when R2 env vars are absent (or when the module is
// imported for unit tests).
async function resolveUploader(options) {
  if (options.uploadJsonImpl) return options.uploadJsonImpl;
  try {
    const module = await import("./upload-to-r2.mjs");
    module.readR2ConfigFromEnv(); // throws R2ConfigError when unset
    return module.uploadJson;
  } catch (error) {
    if (error?.name === "R2ConfigError") return null;
    throw error;
  }
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseCacheArguments(argv);
  if (parsed.help) {
    console.log(HELP);
    return { help: true };
  }

  let uploadJsonImpl = null;
  if (parsed.emitJson && !parsed.outputDir) {
    // Local --output-dir mode skips R2 entirely. Only try to resolve the R2
    // uploader when we're not writing to disk.
    uploadJsonImpl = await resolveUploader(options);
  }

  // --state-dir turns on CDC. Missing state files = full scan + write them
  // for next time.
  let loadStateFor = null;
  let saveStateFor = null;
  const pendingSaves = [];
  if (parsed.stateDir) {
    const { mkdir, readFile, writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    await mkdir(parsed.stateDir, { recursive: true });
    const statePath = playlist => path.join(parsed.stateDir, `${playlist}.json`);
    loadStateFor = async playlist => {
      try {
        const text = await readFile(statePath(playlist), "utf8");
        const parsedState = JSON.parse(text);
        return {
          since: typeof parsedState?.since === "string" ? parsedState.since : null,
          snapshot: Array.isArray(parsedState?.snapshot) ? parsedState.snapshot : null,
        };
      } catch (error) {
        if (error?.code === "ENOENT") return {};
        throw error;
      }
    };
    saveStateFor = async (playlist, state) => {
      // Defer until after publish succeeds so a mid-run crash doesn't
      // advance the cursor past unprocessed docs.
      pendingSaves.push({ playlist, path: statePath(playlist), state });
    };
  }

  const result = await buildLeaderboardCaches({
    project: parsed.project,
    apply: parsed.apply,
    playlists: parsed.playlists,
    top: parsed.top,
    emitJson: parsed.emitJson,
    skipFirestore: parsed.skipFirestore,
    jsonPrefix: parsed.jsonPrefix,
    uploadJsonImpl,
    loadStateFor,
    saveStateFor,
    forceFull: parsed.forceFull,
    ...options,
  });

  if (parsed.emitJson && parsed.outputDir) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    await mkdir(parsed.outputDir, { recursive: true });
    for (const blob of result.jsonBlobs) {
      const filePath = path.join(parsed.outputDir, `${blob.playlist}.json`);
      const body = JSON.stringify(blob.blob);
      await writeFile(filePath, body, "utf8");
      console.log(`WROTE ${filePath} rows=${blob.blob.rowCount} bytes=${body.length}`);
    }
    const heldPath = path.join(parsed.outputDir, "held.json");
    const heldBody = JSON.stringify(result.heldRows || [], null, 2);
    await writeFile(heldPath, heldBody, "utf8");
    if (result.heldRows?.length) {
      console.warn(`HELD ${heldPath} rows=${result.heldRows.length}`);
    }
  }

  try {
    const { appendFile, mkdir, readFile, writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const events = eventsFromCacheResult(result, { autoBan: result.autoBanUids || [] });
    const fallbackOut = process.env.GITHUB_WORKSPACE
      ? path.join(process.env.GITHUB_WORKSPACE, "out")
      : "";
    const outDir = parsed.outputDir || fallbackOut;
    const outputPath = outDir ? path.join(outDir, "security-events.jsonl") : "";
    const statePath = parsed.stateDir
      ? path.join(parsed.stateDir, "security-events.json")
      : "";
    if (outputPath) await mkdir(outDir, { recursive: true });
    await persistSecurityEvents(events, {
      writeFile,
      readFile,
      appendFile,
      outputPath,
      statePath,
      stepSummaryPath: process.env.GITHUB_STEP_SUMMARY || "",
    });
    if (outputPath && events.length) {
      console.warn(`SECURITY ${outputPath} events=${events.length}`);
    }
  } catch (error) {
    console.warn(`[security] persist skipped: ${error?.message || error}`);
  }

  // Publish landed — safe to flush the deferred state writes now.
  if (pendingSaves.length) {
    const { writeFile } = await import("node:fs/promises");
    for (const pending of pendingSaves) {
      const body = JSON.stringify(pending.state);
      await writeFile(pending.path, body, "utf8");
      console.log(`STATE ${pending.path} since=${pending.state.since} snapshotRows=${pending.state.snapshot?.length ?? 0}`);
    }
  }

  // Emit a compact per-run status + rolling history for the admin panel.
  // Sits alongside the per-playlist state files under --state-dir.
  if (parsed.stateDir && result.stateSummary?.length) {
    const { readFile, writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const statusPath = path.join(parsed.stateDir, "status.json");
    const historyPath = path.join(parsed.stateDir, "history.json");
    const builtAt = new Date().toISOString();
    const perPlaylist = {};
    let deltaTotal = 0;
    let snapshotTotal = 0;
    let anyFallback = false;
    let anyFull = false;
    const fallbackReasons = {};
    for (const entry of result.stateSummary) {
      const deltaRows = entry.deltaRows ?? entry.snapshotRows;
      perPlaylist[entry.playlist] = {
        mode: entry.mode,
        deltaRows,
        snapshotRows: entry.snapshotRows,
        since: entry.nextSince,
        fallbackReason: entry.fallbackReason ?? null,
      };
      deltaTotal += deltaRows || 0;
      snapshotTotal += entry.snapshotRows || 0;
      if (entry.mode === "full-fallback") {
        anyFallback = true;
        if (entry.fallbackReason) fallbackReasons[entry.playlist] = entry.fallbackReason;
      }
      if (entry.mode === "full") anyFull = true;
    }
    const readsProjectedFullScan = snapshotTotal;
    const readsSaved = Math.max(0, readsProjectedFullScan - deltaTotal);
    const readsSavedPct = readsProjectedFullScan > 0
      ? Math.round((readsSaved / readsProjectedFullScan) * 1000) / 10
      : 0;
    const status = {
      builtAt,
      forceFull: Boolean(parsed.forceFull),
      overallMode: anyFallback ? "full-fallback" : anyFull ? "full" : "delta",
      readsThisRun: deltaTotal,
      readsProjectedFullScan,
      readsSaved,
      readsSavedPct,
      playlists: perPlaylist,
    };
    await writeFile(statusPath, JSON.stringify(status), "utf8");
    console.log(`STATUS ${statusPath} mode=${status.overallMode} reads=${deltaTotal}/${readsProjectedFullScan}`);

    // Rolling last-96 history so the admin panel can sparkline delta
    // counts / reads-saved over the last day (at hourly cadence) or the
    // last 24h (at 15-min cadence).
    let history = { runs: [] };
    try {
      const raw = await readFile(historyPath, "utf8");
      const parsedHistory = JSON.parse(raw);
      if (Array.isArray(parsedHistory?.runs)) history = parsedHistory;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    history.runs.push({
      builtAt,
      overallMode: status.overallMode,
      reads: deltaTotal,
      readsSaved,
      playlists: Object.fromEntries(
        Object.entries(perPlaylist).map(([pl, v]) => [pl, v.deltaRows]),
      ),
    });
    if (history.runs.length > 96) history.runs = history.runs.slice(-96);
    await writeFile(historyPath, JSON.stringify(history), "utf8");
    console.log(`HISTORY ${historyPath} entries=${history.runs.length}`);

    // Lifetime counter. Survives the 96-entry rolling window so the
    // "reads saved" tile can climb continuously from the day CDC shipped.
    // First-run initializes with `since` at the current builtAt.
    const lifetimePath = path.join(parsed.stateDir, "lifetime.json");
    let lifetime = null;
    try {
      const raw = await readFile(lifetimePath, "utf8");
      lifetime = JSON.parse(raw);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!lifetime || typeof lifetime !== "object") {
      lifetime = { since: builtAt, syncs: 0, reads: 0, readsSaved: 0, readsBaseline: 0 };
    }
    lifetime.syncs = (lifetime.syncs || 0) + 1;
    lifetime.reads = (lifetime.reads || 0) + deltaTotal;
    lifetime.readsSaved = (lifetime.readsSaved || 0) + readsSaved;
    lifetime.readsBaseline = (lifetime.readsBaseline || 0) + readsProjectedFullScan;
    lifetime.lastSyncAt = builtAt;
    await writeFile(lifetimePath, JSON.stringify(lifetime), "utf8");
    console.log(`LIFETIME ${lifetimePath} syncs=${lifetime.syncs} readsSaved=${lifetime.readsSaved}`);
  }

  for (const plan of result.plans) {
    const bytes = estimateDocumentBytes(plan.document);
    console.log(
      `${plan.action.toUpperCase()} ${plan.path}`
        + ` rows=${plan.document.rowCount}`
        + ` bytes=${bytes}`
        + ` hash=${plan.document.sourceHash.slice(0, 12)}`
        + ` (${plan.reason})`,
    );
  }

  if (parsed.emitJson) {
    for (const upload of result.uploads) {
      const blob = result.jsonBlobs.find(entry => entry.playlist === upload.playlist);
      const rowCount = blob?.blob?.rowCount ?? 0;
      const hash = (upload.sourceHash || "").slice(0, 12);
      if (upload.action === "uploaded") {
        const bytes = blob ? estimateDocumentBytes(blob.blob) : 0;
        console.log(
          `UPLOADED ${upload.key} rows=${rowCount} bytes=${bytes} hash=${hash} status=${upload.status}`,
        );
      } else if (upload.action === "skipped-no-uploader") {
        console.log(
          `EMIT-ONLY ${upload.key} rows=${rowCount} hash=${hash} (R2 env not set — dumping JSON to stdout)`,
        );
        if (blob) console.log(JSON.stringify(blob.blob));
      } else if (upload.action === "failed") {
        console.log(`FAILED ${upload.key}: ${upload.error}`);
      }
    }
  }

  for (const entry of result.stateSummary || []) {
    const deltaLabel = entry.deltaRows == null ? "-" : entry.deltaRows;
    console.log(
      `CDC ${entry.playlist} mode=${entry.mode} snapshotRows=${entry.snapshotRows} deltaRows=${deltaLabel} nextSince=${entry.nextSince}`,
    );
  }

  const firestoreSummary = parsed.skipFirestore
    ? "Firestore writes skipped (--skip-firestore)."
    : parsed.apply
      ? `Applied ${result.written} Firestore write(s); skipped ${result.skipped}.`
      : `Dry run: ${result.plannedWrites} Firestore write(s) planned; skipped ${result.skipped}. Re-run with --apply to write.`;
  console.log(firestoreSummary);
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
