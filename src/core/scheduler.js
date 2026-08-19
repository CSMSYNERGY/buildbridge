// Minimal in-process job scheduler. Suited to the single-instance Railway
// deployment; jobs must be idempotent since restarts re-run them.

import { recordThrown } from '../services/errorLogService.js';

const jobs = []; // { name, intervalMs, fn, timer }
let started = false;

/**
 * Register a recurring job. Call before startScheduler().
 * fn is awaited; errors are logged and do not stop the schedule.
 */
export function registerJob(name, intervalMs, fn, cron = null) {
  jobs.push({
    name, intervalMs, fn, timer: null, cron,
  });
  if (started) startJob(jobs[jobs.length - 1]);
}

function startJob(job) {
  const run = async () => {
    try {
      await job.fn();
    } catch (err) {
      console.error(`[scheduler] job "${job.name}" failed:`, err.message);
    }
  };
  // Kick off shortly after boot, then on the interval.
  setTimeout(run, 10 * 1000);
  job.timer = setInterval(run, job.intervalMs);
  job.timer.unref?.();
}

/** Start all registered jobs. Safe to call once from index.js. */
export function startScheduler() {
  if (started) return;
  started = true;
  for (const job of jobs) startJob(job);
  console.log(`[scheduler] started with ${jobs.length} job(s):`, jobs.map((j) => j.name).join(', ') || '(none)');
}

/**
 * Run every registered job exactly once, sequentially. This is the Workers
 * entry point for scheduled work: the Cloudflare Cron Trigger (see the
 * `scheduled` handler in src/worker.js) calls this instead of startScheduler(),
 * because the setInterval/setTimeout loop above cannot run on the Workers
 * runtime. The cron cadence in wrangler.jsonc must match the jobs' intended
 * interval (currently every 15 min for all jobs). Errors are logged per job and
 * never abort the batch; jobs are already required to be idempotent.
 */
export async function runDueJobs(cron = null) {
  if (jobs.length === 0) {
    console.log('[scheduler] cron tick: no jobs registered');
    return;
  }
  // ONE JOB PER INVOCATION, when the job says which trigger it belongs to.
  //
  // A Worker invocation has a fixed subrequest budget and every job in the tick
  // spends from the same one — so the last job to run inherits whatever the earlier
  // ones left, and on 2026-08-19 that was nothing: Rockwood's sync died on its first
  // Synergy call with "Too many subrequests by single Worker invocation", every
  // fifteen minutes for three and a half hours, while the jobs ahead of it finished
  // normally. Separate cron expressions mean separate invocations and therefore
  // separate budgets, so one client's backlog can no longer starve another's sync.
  //
  // A job with no cron of its own still runs on every tick — that is the local and
  // single-process behaviour, where there is no invocation budget to divide.
  const due = cron ? jobs.filter((j) => !j.cron || j.cron === cron) : jobs;
  if (due.length === 0) {
    console.log(`[scheduler] cron tick (${cron}): no jobs for this trigger`);
    return;
  }
  console.log(`[scheduler] cron tick${cron ? ` (${cron})` : ''}: running ${due.length} job(s):`, due.map((j) => j.name).join(', '));
  for (const job of due) {
    try {
      await job.fn();
    } catch (err) {
      console.error(`[scheduler] job "${job.name}" failed:`, err.message);
      // Backstop record: a job that throws OUT of its own per-tenant handling
      // (which records its own errors) still lands in error_events, so no cron
      // failure is invisible once the tail is closed.
      await recordThrown(err, {
        source: 'cron',
        kind: 'cron_job_failed',
        context: { job: job.name },
      });
    }
  }
}

/** Stop all jobs (used by tests). */
export function stopScheduler() {
  for (const job of jobs) {
    if (job.timer) clearInterval(job.timer);
    job.timer = null;
  }
  started = false;
}
