/**
 * BuildBridge uptime + integrity monitor (independent watchdog).
 *
 * Runs on a Cron Trigger, separate from the BuildBridge worker itself, so it
 * keeps watching (and can still email) even if a BuildBridge deploy breaks the
 * main worker. It runs the SAME check the self-verifying deploy does, against
 * the LIVE site:
 *   - GET /            -> Worker alive (redirects to the app)
 *   - GET /buildbridge/ -> SPA shell present
 *   - every hashed asset the shell references returns REAL JS/CSS, not the HTML
 *     fallback (the 2026-07-20 blank-page outage: assets served HTTP 200 with
 *     content-type text/html, which a plain status check would miss).
 *
 * Alerting is edge-triggered and de-duplicated via KV: it emails once when the
 * site goes DOWN and once when it RECOVERS -- not every tick during an outage.
 *
 * Email is sent through Cloudflare Email Sending (the `send_email` binding).
 * See SETUP.md for the one-time domain onboarding.
 */

const APP_PATH = "/buildbridge/";
const ASSET_RE = /\/buildbridge\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g;
const STATE_KEY = "buildbridge:last-status";

function assetsFrom(html) {
  return [...new Set([...html.matchAll(ASSET_RE)].map((m) => m[0]))].sort();
}

function looksLikeHtml(body, contentType) {
  if (/^\s*<!doctype html/i.test(body) || /^\s*<html[\s>]/i.test(body)) return true;
  if (/text\/html/i.test(contentType || "")) return true;
  return false;
}

/**
 * Returns { ok: boolean, failures: string[] }. Never throws — a fetch error
 * becomes a recorded failure so a network blip reads as "down", not a crash.
 */
async function checkSite(baseUrl) {
  const base = baseUrl.replace(/\/+$/, "");
  const failures = [];
  const get = (url) => fetch(url, { redirect: "manual", headers: { "cache-control": "no-cache" } });

  // 0) Worker liveness — root should redirect (Worker logic, not Static Assets).
  try {
    const root = await get(base + "/");
    if (root.status < 200 || root.status >= 400) failures.push(`GET / -> ${root.status} (Worker looks down)`);
  } catch (e) {
    failures.push(`GET / threw: ${e?.message || e}`);
  }

  // 1) App shell.
  let liveAssets = [];
  try {
    const entry = await get(base + APP_PATH);
    if (entry.status !== 200) {
      failures.push(`GET ${APP_PATH} -> ${entry.status} (expected 200)`);
    } else {
      const html = await entry.text();
      if (!/id="root"/.test(html)) failures.push(`GET ${APP_PATH} did not return the SPA shell (<div id="root"> missing)`);
      liveAssets = assetsFrom(html);
      if (liveAssets.length === 0) failures.push(`${APP_PATH} references no /buildbridge/assets/*.js|css`);
    }
  } catch (e) {
    failures.push(`GET ${APP_PATH} threw: ${e?.message || e}`);
  }

  // 2) Every referenced asset must serve real JS/CSS — not the HTML fallback.
  for (const path of liveAssets) {
    try {
      const res = await get(base + path);
      const ct = res.headers.get("content-type") || "";
      if (res.status !== 200) {
        failures.push(`asset ${path} -> ${res.status}`);
        continue;
      }
      const body = await res.text();
      if (looksLikeHtml(body, ct)) {
        failures.push(`asset ${path} served HTML instead of ${path.endsWith(".css") ? "CSS" : "JS"} (ct: ${ct || "n/a"}) — blank-page bug`);
        continue;
      }
      const wantJs = path.endsWith(".js");
      if (wantJs ? !/javascript/i.test(ct) : !/css/i.test(ct)) {
        failures.push(`asset ${path} unexpected content-type "${ct}"`);
      }
    } catch (e) {
      failures.push(`asset ${path} threw: ${e?.message || e}`);
    }
  }

  return { ok: failures.length === 0, failures };
}

async function sendAlert(env, subject, body) {
  const from = env.ALERT_FROM || "buildbridge-monitor@csmsynergy.com";
  const to = env.ALERT_TO || "ahsan@csmsynergy.com";
  try {
    await env.ALERT_EMAIL.send({ from, to, subject, text: body });
    console.log(`ALERT SENT: "${subject}" -> ${to}`);
    return { ok: true };
  } catch (e) {
    // Log loudly — a failed alert is itself an incident, but must not throw and
    // kill the scheduled run (which would lose the KV state update).
    const msg = e?.stack || e?.message || String(e);
    console.error(`ALERT SEND FAILED: ${msg}`);
    return { ok: false, error: e?.message || String(e) };
  }
}

async function runCheck(env, { source, simulateDown = false, alerting = true }) {
  const base = env.TARGET_BASE_URL || "https://buildbridge.csmsynergy.com";
  const nowIso = new Date().toISOString();
  // `simulateDown` forces a failure so the DOWN alert path can be exercised
  // on demand (used to verify email delivery) without any real outage.
  const { ok, failures } = simulateDown
    ? { ok: false, failures: ["SIMULATED failure (test only — the site is fine)"] }
    : await checkSite(base);

  const prevRaw = env.MONITOR_STATE ? await env.MONITOR_STATE.get(STATE_KEY) : null;
  const prev = prevRaw ? JSON.parse(prevRaw) : { status: "unknown", since: nowIso };
  const nextStatus = ok ? "healthy" : "unhealthy";

  // Edge-triggered alerts: only on a status transition. `alerting` is false for
  // unauthenticated HTTP checks so the public URL can't be used to email you.
  let alert = null;
  if (!alerting) {
    // observability-only run: report what WOULD have happened, send nothing
    if (!ok && prev.status !== "unhealthy") alert = { kind: "down", suppressed: true };
    else if (ok && prev.status === "unhealthy") alert = { kind: "recovered", suppressed: true };
  } else if (!ok && prev.status !== "unhealthy") {
    const r = await sendAlert(
      env,
      "🔴 BuildBridge is DOWN",
      [
        `BuildBridge failed its health check at ${nowIso}.`,
        `Target: ${base}`,
        ``,
        `Problems:`,
        ...failures.map((f) => `  • ${f}`),
        ``,
        `This is the class of failure that caused the blank page on 2026-07-20.`,
        `You'll get one more email when it recovers.`,
      ].join("\n")
    );
    alert = { kind: "down", ...r };
  } else if (ok && prev.status === "unhealthy") {
    const r = await sendAlert(
      env,
      "🟢 BuildBridge recovered",
      [`BuildBridge is healthy again at ${nowIso}.`, `Target: ${base}`, ``, `It was down since ${prev.since}.`].join("\n")
    );
    alert = { kind: "recovered", ...r };
  }

  const state = {
    status: nextStatus,
    since: prev.status === nextStatus ? prev.since || nowIso : nowIso,
    checkedAt: nowIso,
    failures,
    source,
    alert,
  };
  if (env.MONITOR_STATE) await env.MONITOR_STATE.put(STATE_KEY, JSON.stringify(state));
  return state;
}

export default {
  // Cron entry point — the real watchdog. Alerting is ON here.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env, { source: "cron", alerting: true }));
  },

  // HTTP endpoints (only reachable if workers.dev / a route is enabled):
  //   GET /            -> last-known status (read-only, no side effects)
  //   GET /check       -> run a fresh check now, report result, send NO email
  //   GET /check?key=<CHECK_TOKEN>[&simulate=down]
  //                    -> authenticated: may send a real alert (used to verify
  //                       email delivery after Email Sending is onboarded)
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/check") {
      const authed = !!env.CHECK_TOKEN && url.searchParams.get("key") === env.CHECK_TOKEN;
      const simulateDown = authed && url.searchParams.get("simulate") === "down";
      const state = await runCheck(env, { source: authed ? "manual-auth" : "manual", simulateDown, alerting: authed });
      return Response.json(state, { status: state.status === "healthy" ? 200 : 503 });
    }
    const raw = env.MONITOR_STATE ? await env.MONITOR_STATE.get(STATE_KEY) : null;
    const state = raw ? JSON.parse(raw) : { status: "unknown" };
    return Response.json(state, { status: state.status === "unhealthy" ? 503 : 200 });
  },
};
