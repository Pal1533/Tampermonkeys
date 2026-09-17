// One-shot cleanup for the merge:true / hasOnly trap.
//
// The 2026-08-14 rules rewrite added a strict hasOnly() whitelist to
// leaderboard writes (isValidScriptEntry). Any doc that still carries
// legacy fields — reviewFlaggedAt, reviewClearedAt, deleted, deletedAt —
// silently denies every HUD update: setDoc merge:true makes the rule see
// the merged doc, which then trips hasOnly().
//
// This script scans the whole leaderboard collection and PATCHes those
// fields off any doc that has them. Uses ADC for auth.
//
// Dry-run by default. Pass --apply to actually strip.
//
//   gcloud auth login
//   node firebase/scripts/strip-legacy-leaderboard-fields.mjs
//   node firebase/scripts/strip-legacy-leaderboard-fields.mjs --apply

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PROJECT_ID = "rgleaderboard";
const COLLECTION = "leaderboard";
const LEGACY_FIELDS = ["reviewFlaggedAt", "reviewClearedAt", "deleted", "deletedAt"];
const APPLY = process.argv.includes("--apply");

async function accessToken() {
  const { stdout } = await execFileAsync("gcloud", ["auth", "print-access-token"]);
  return stdout.trim();
}

async function listAllDocs(token) {
  const out = [];
  let pageToken = null;
  do {
    const url = new URL(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${COLLECTION}`,
    );
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-goog-user-project": PROJECT_ID,
      },
    });
    if (!resp.ok) {
      throw new Error(`list failed: ${resp.status} ${await resp.text()}`);
    }
    const json = await resp.json();
    for (const doc of json.documents || []) out.push(doc);
    pageToken = json.nextPageToken || null;
  } while (pageToken);
  return out;
}

async function stripFields(token, docName, fieldsPresent) {
  const path = docName.split("/documents/")[1];
  const url = new URL(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}`,
  );
  for (const f of fieldsPresent) url.searchParams.append("updateMask.fieldPaths", f);
  const resp = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-goog-user-project": PROJECT_ID,
    },
    body: JSON.stringify({ fields: {} }),
  });
  if (!resp.ok) {
    throw new Error(`patch failed for ${path}: ${resp.status} ${await resp.text()}`);
  }
}

async function main() {
  const token = await accessToken();
  console.log(`[strip-legacy] listing ${COLLECTION} on ${PROJECT_ID}…`);
  const docs = await listAllDocs(token);
  console.log(`[strip-legacy] scanned ${docs.length} docs`);

  const dirty = [];
  const skippedTombstones = [];
  for (const doc of docs) {
    const f = doc.fields || {};
    // Never touch a genuine tombstone. Admins set deleted:true on purpose.
    const isTombstone = f.deleted?.booleanValue === true;
    const hasSourceUid = typeof f.sourceUserId?.stringValue === "string";
    const strip = [];
    if ("reviewFlaggedAt" in f) strip.push("reviewFlaggedAt");
    if ("reviewClearedAt" in f) strip.push("reviewClearedAt");
    if (!isTombstone && hasSourceUid) {
      if ("deleted" in f) strip.push("deleted");
      if ("deletedAt" in f) strip.push("deletedAt");
    }
    if (isTombstone) skippedTombstones.push(doc.name.split("/").pop());
    if (strip.length) dirty.push({ name: doc.name, fields: strip });
  }
  if (skippedTombstones.length) {
    console.log(`[strip-legacy] skipped ${skippedTombstones.length} tombstoned docs`);
  }

  console.log(`[strip-legacy] ${dirty.length} docs carry legacy fields`);
  for (const d of dirty) {
    console.log(`  ${d.name.split("/").pop()}  ${d.fields.join(", ")}`);
  }

  if (!APPLY) {
    console.log("\ndry run. rerun with --apply to actually strip.");
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const d of dirty) {
    try {
      await stripFields(token, d.name, d.fields);
      ok++;
    } catch (err) {
      failed++;
      console.error(`  failed ${d.name}: ${err.message}`);
    }
  }
  console.log(`\n[strip-legacy] patched ${ok}, failed ${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
