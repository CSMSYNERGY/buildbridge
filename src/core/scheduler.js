// Minimal in-process job scheduler. Suited to the single-instance Railway
// deployment; jobs must be idempotent since restarts re-run them.

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

/** Stop all jobs (used by tests). */
export function stopScheduler() {
  for (const job of jobs) {
    if (job.timer) clearInterval(job.timer);
    job.timer = null;
  }
  started = false;
}
