#!/usr/bin/env node
/**
 * Self-verifying deploy smoke-test for BuildBridge.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-07-20 BuildBridge went to a blank page: a deploy shipped an
 * `index.html` that referenced hashed asset filenames (index-XXXX.js/css) that
 * were NOT part of that deployment. Because the Worker's `assets` config uses
 * `not_found_handling: "none"`, a request for a missing asset falls through to
 * the Express worker, which serves the SPA `index.html` (HTML) for unknown
 * paths. The browser then receives HTML where it expected a JS module, can't
 * parse it, and renders nothing. Nothing in the deploy checked the result, so
 * the outage was silent until a human noticed.
 *
 * WHAT THIS DOES
 * --------------
 * After a deploy, fetch the LIVE site and fail loudly unless the app actually
 * loads end-to-end:
 *   1. GET the app entry (/buildbridge/) -> must be 200 + the SPA shell.
 *   2. GET the root (/) -> must redirect (proves the Worker itself is alive,
 *      not just Static Assets).
 *   3. For every hashed asset the live index.html references, GET it and assert
 *      it serves REAL JS/CSS -- not the HTML fallback (the exact outage bug).
 *
 * If a freshly-built local dist is present (frontend/dist/buildbridge/index.html),
 * its asset hashes are treated as the source of truth for what SHOULD be live,
 * and the script POLLS the live site until it serves those same hashes (to ride
 * out CDN/edge propagation after `wrangler deploy`) before verifying them. Run
 * standalone (no fresh build) it simply checks that the live site is internally
 * consistent.
 *
 * Exit 0 = verified. Non-zero = something a user would see as broken.
 *
 * Env:
 *   VERIFY_BASE_URL   override the site (default https://buildbridge.csmsynergy.com)
 *   VERIFY_TIMEOUT_MS overall propagation-poll budget (default 120000)
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const BASE_URL = (process.env.VERIFY_BASE_URL || "https://buildbridge.csmsynergy.com").replace(/\/+$/, "");
const APP_PATH = "/buildbridge/";
const APP_URL = BASE_URL + APP_PATH;
const LOCAL_INDEX = join(REPO_ROOT, "frontend", "dist", "buildbridge", "index.html");
const POLL_BUDGET_MS = Number(process.env.VERIFY_TIMEOUT_MS || 120_000);
const POLL_INTERVAL_MS = 5_000;

const ASSET_RE = /\/buildbridge\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g;

function die(msg) {
  console.error(`\n❌  Deploy verification FAILED\n    ${msg}\n`);
  process.exit(1);
}
function ok(msg) {
  console.log(`    ✓ ${msg}`);
}

// fetch with a few retries so a single transient edge blip doesn't false-fail.
async function get(url, { asText = true } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: "manual", headers: { "cache-control": "no-cache" } });
      const body = asText ? await res.text() : "";
      return { res, body };
    } catch (e) {
      lastErr = e;
      await sleep(1500);
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assetsFrom(html) {
  return [...new Set([...html.matchAll(ASSET_RE)].map((m) => m[0]))].sort();
}

// The outage signature: an asset request served the HTML SPA shell instead of
// real JS/CSS. Detect it by both the body prefix and the content-type.
function looksLikeHtml(body, contentType) {
  if (/^\s*<!doctype html/i.test(body) || /^\s*<html[\s>]/i.test(body)) return true;
  if (/text\/html/i.test(contentType || "")) return true;
  return false;
}

async function main() {
  console.log(`\nBuildBridge deploy verification -> ${BASE_URL}`);

  // 0) Worker liveness: root must redirect to the app (Worker logic, not Static Assets).
  const root = await get(BASE_URL + "/");
  if (root.res.status < 200 || root.res.status >= 400) {
    die(`GET / returned ${root.res.status} (>=400). The Worker itself looks down.`);
  }
  ok(`GET / -> ${root.res.status} (Worker alive)`);

  // 1) Determine the expected asset set. Prefer the freshly-built local dist.
  let expected = null;
  if (existsSync(LOCAL_INDEX)) {
    const localHtml = readFileSync(LOCAL_INDEX, "utf8");
    expected = assetsFrom(localHtml);
    if (expected.length === 0) die(`local ${LOCAL_INDEX} references no /buildbridge/assets/*.js|css -- did the build run?`);
    ok(`local build references ${expected.length} asset(s): ${expected.map((p) => p.split("/").pop()).join(", ")}`);
  } else {
    console.log(`    (no local dist at ${LOCAL_INDEX}; verifying live site self-consistency only)`);
  }

  // 2) Poll the live app entry until it references the expected assets (propagation),
  //    or just read whatever it references when running standalone.
  const startedAt = performance.now();
  let liveAssets = null;
  let liveHtml = null;
  for (;;) {
    const entry = await get(APP_URL);
    if (entry.res.status !== 200) die(`GET ${APP_URL} returned ${entry.res.status} (expected 200).`);
    liveHtml = entry.body;
    if (!/id="root"/.test(liveHtml)) die(`GET ${APP_URL} did not return the SPA shell (<div id="root"> missing).`);
    liveAssets = assetsFrom(liveHtml);
    if (liveAssets.length === 0) die(`live index.html references no /buildbridge/assets/*.js|css.`);

    if (!expected || arraysEqual(liveAssets, expected)) break;

    if (performance.now() - startedAt > POLL_BUDGET_MS) {
      die(
        `live site still not serving the newly-built assets after ${Math.round(POLL_BUDGET_MS / 1000)}s.\n` +
          `    expected: ${expected.join(", ")}\n` +
          `    live:     ${liveAssets.join(", ")}\n` +
          `    (deploy may not have propagated, or the wrong build was deployed)`
      );
    }
    console.log(`    ...waiting for new build to propagate (live has old hashes); retrying in ${POLL_INTERVAL_MS / 1000}s`);
    await sleep(POLL_INTERVAL_MS);
  }
  ok(`GET ${APP_PATH} -> 200, SPA shell present, ${liveAssets.length} asset(s) referenced`);

  // 3) Every referenced asset must serve real JS/CSS -- not the HTML fallback.
  for (const path of liveAssets) {
    const url = BASE_URL + path;
    const { res, body } = await get(url);
    const ct = res.headers.get("content-type") || "";
    if (res.status !== 200) die(`asset ${path} returned ${res.status} (expected 200).`);
    if (looksLikeHtml(body, ct)) {
      die(
        `asset ${path} served HTML instead of ${path.endsWith(".css") ? "CSS" : "JS"} ` +
          `(content-type: ${ct || "n/a"}).\n` +
          `    This is the blank-page bug: index.html references an asset that isn't deployed,\n` +
          `    so the request falls through to the SPA fallback and returns HTML the browser can't run.`
      );
    }
    const wantJs = path.endsWith(".js");
    const typeOk = wantJs ? /javascript/i.test(ct) : /css/i.test(ct);
    if (!typeOk) {
      die(`asset ${path} has unexpected content-type "${ct}" (wanted ${wantJs ? "JavaScript" : "CSS"}).`);
    }
    ok(`asset ${path.split("/").pop()} -> 200 ${ct}`);
  }

  console.log(`\n✅  Deploy verified: ${APP_URL} loads and all ${liveAssets.length} asset(s) serve real JS/CSS.\n`);
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

main().catch((e) => die(e?.stack || e?.message || String(e)));
