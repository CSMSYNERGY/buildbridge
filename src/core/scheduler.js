// Minimal in-process job scheduler. Suited to the single-instance Railway
// deployment; jobs must be idempotent since restarts re-run them.

import { recordThrown } from '../services/errorLogService.js';

const jobs = []; // { name, intervalMs, fn, timer }
let started = false;

/**
 * Register a recurring job. Call before startScheduler().
 * fn is awaited; errors are logged and do not stop the schedule.
 */
export function registerJob(name, intervalMs, fn) {
  jobs.push({ name, intervalMs, fn, timer: null });
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
export async function runDueJobs() {
  if (jobs.length === 0) {
    console.log('[scheduler] cron tick: no jobs registered');
    return;
  }
  console.log(`[scheduler] cron tick: running ${jobs.length} job(s):`, jobs.map((j) => j.name).join(', '));
  for (const job of jobs) {
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
