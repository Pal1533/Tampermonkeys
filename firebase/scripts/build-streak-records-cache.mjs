import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { decodeFirestoreDocument, getGcloudAccessToken } from "./snapshot-production.mjs";

const execFileAsync = promisify(execFile);

export const CACHE_COLLECTION = "leaderboard_cache";
export const CACHE_DOC_ID = "streak_records";
export const SOURCE_COLLECTION = "player_streaks";
export const TOP_N = 50;

export const HELP = `Build the streak records aggregate at leaderboard_cache/${CACHE_DOC_ID}.

Dry run (default — no writes):
  node firebase/scripts/build-streak-records-cache.mjs --project rgleaderboard

Apply writes after review:
  node firebase/scripts/build-streak-records-cache.mjs --project rgleaderboard --apply

Optional:
  --top 50            (default ${TOP_N})

Reads:
  Queries player_streaks ordered by bestWinStreak DESC, limit --top. Needs
  the (bestWinStreak DESC) index; add it to firestore.indexes.json.

Writes:
  Overwrites leaderboard_cache/${CACHE_DOC_ID} with { rows[], updatedAt, rowCount }.
  Client writes to leaderboard_cache are denied by rules; this script uses
  gcloud user or service-account credentials.
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
    const streak = Number(fields.bestWinStreak);
    if (!Number.isFinite(streak) || streak <= 0) continue;
    rows.push({
      accountId: String(fields.accountId || ""),
      displayName: String(fields.displayName || "Unknown").slice(0, 32),
      bestWinStreak: Math.trunc(streak),
      bestAt: Number(fields.bestAt) || 0,
    });
  }
  return rows;
}

export async function writeCacheDoc(fetchImpl, token, project, rows) {
  const updatedAt = Date.now();
  const payload = {
    rows,
    rowCount: rows.length,
    updatedAt,
  };
  const url = `${documentsBase(project)}/${CACHE_COLLECTION}/${encodeURIComponent(CACHE_DOC_ID)}`;
  await apiJson(fetchImpl, token, url, {
    method: "PATCH",
    quotaProject: project,
    body: JSON.stringify({ fields: encodeFields(payload) }),
  });
  return { updatedAt, rowCount: rows.length };
}

function parseArgs(argv) {
  const args = { apply: false, top: TOP_N, project: "", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--apply") args.apply = true;
    else if (a === "--project") args.project = argv[++i];
    else if (a.startsWith("--project=")) args.project = a.slice("--project=".length);
    else if (a === "--top") args.top = Math.trunc(Number(argv[++i]) || TOP_N);
    else if (a.startsWith("--top=")) args.top = Math.trunc(Number(a.slice("--top=".length)) || TOP_N);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.help && !args.project) {
    throw new Error("--project is required (e.g. --project rgleaderboard)");
  }
  if (args.top <= 0 || args.top > 500) {
    throw new Error(`--top must be 1..500 (got ${args.top})`);
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

  const rows = await queryTopStreaks(fetchImpl, token, args.project, args.top);
  console.log(`READ ${SOURCE_COLLECTION} rows=${rows.length} top=${args.top}`);
  for (const r of rows.slice(0, 5)) {
    console.log(`  #${rows.indexOf(r) + 1} ${r.displayName} streak=${r.bestWinStreak} at=${r.bestAt ? new Date(r.bestAt).toISOString() : "?"}`);
  }

  if (!args.apply) {
    console.log(`DRY-RUN complete. Re-run with --apply to write leaderboard_cache/${CACHE_DOC_ID}.`);
    return { rows, applied: false };
  }

  const result = await writeCacheDoc(fetchImpl, token, args.project, rows);
  console.log(`WROTE leaderboard_cache/${CACHE_DOC_ID} rowCount=${result.rowCount} updatedAt=${new Date(result.updatedAt).toISOString()}`);
  return { rows, applied: true, ...result };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => {
    console.error(e?.stack || e?.message || String(e));
    process.exit(1);
  });
}
