// How many outbound calls one scheduled run may make.
//
// A Cloudflare Worker invocation has a hard ceiling on subrequests, and hitting it
// does not slow the run down — it fails every remaining fetch instantly, including
// the database write that advances the sync cursor and the INSERT that would have
// recorded the failure. The run therefore dies silently, having done real work, with
// nothing to show for it.
//
// That is not a hypothetical. On 2026-08-19 Rockwood's sync hit the ceiling on every
// pass for three and a half hours, and it was self-sustaining: the cursor could not
// advance, so the next pass replayed an ever-larger backlog, so it hit the ceiling
// sooner. The existing guards could not help — they are a wall-clock deadline and
// per-loop record caps, and neither has any idea what a record COSTS. A backlog of
// fast responses burns the budget without ever approaching the time limit.
//
// So the loops ask this module the same way they ask about the deadline, and stop
// early when it is spent. Stopping early is already safe there: every half advances
// the cursor only as far as the last record it actually handled, so an interrupted
// pass makes real progress and the next one continues from exactly that point. A
// backlog drains over several passes instead of blocking forever.
//
// Only outbound HTTP is counted — GoHighLevel and QuickBooks — because those are the
// calls this codebase makes deliberately. Each one drags a database read for its
// credentials behind it (see makeGhlRequest), and database access is itself a service
// binding and therefore also a subrequest, so the real spend is roughly twice what is
// counted here. The default limit is set with that doubling in mind.

// MEASURED, not guessed. On 2026-08-19 a run logged "20 outbound call(s)" and then
// hit the ceiling — which puts the real limit at 50 subrequests per invocation, the
// Workers FREE tier, not the 1000 a paid plan gets. The factor between the two
// numbers is the credential read every request drags behind it, plus the link and
// settings reads around them: each counted call is worth roughly two and a half
// subrequests, and the pass spends a dozen more on its own bookkeeping.
//
// Twelve leaves real headroom under fifty. It is deliberately conservative, because
// the cost of guessing high is not a slow pass — it is a pass that dies without
// writing its cursor, which is what put this client's sync out for most of a day.
//
// ⚠️ This number is a workaround for a plan limit, not a design. On Workers Paid the
// ceiling is 1000 and this can go back to a couple of hundred, which is the
// difference between draining a backlog in three passes and thirty.
const DEFAULT_LIMIT = 12;

let used = 0;
let limit = Infinity;

/**
 * Start counting for one invocation. Called once per scheduled run — NOT per
 * location, since the ceiling belongs to the invocation and every location in the
 * run spends from the same one.
 */
export function beginBudget(max = DEFAULT_LIMIT) {
  used = 0;
  limit = Number.isFinite(max) && max > 0 ? max : DEFAULT_LIMIT;
}

/** Record an outbound call. Cheap enough to call from every request helper. */
export function spendSubrequest(n = 1) {
  used += n;
}

/** True once the run should stop starting new work and let the cursor advance. */
export function budgetExhausted() {
  return used >= limit;
}

/** For the per-pass stats line, so a run that stopped early says so. */
export function subrequestsUsed() {
  return used;
}

/**
 * Stop counting. Web traffic shares this isolate, so leaving a budget armed after a
 * run would let ordinary requests trip a guard that has nothing to do with them.
 */
export function endBudget() {
  limit = Infinity;
  used = 0;
}
