// Rockwood model — two-way QuickBooks sync:
//   contacts + estimates reconciled between QBO and GHL every 15 minutes,
//   last-write-wins on conflicts. QuickBooks remains Rockwood's source of
//   truth; changes made there flow into Synergy (GHL) and vice-versa.
// Importing this module registers the scheduler job.

import { registerJob } from '../core/scheduler.js';
import { syncAllLocations } from '../services/qbSyncService.js';

// Its own cron trigger — see runDueJobs for why the jobs must not share one.
registerJob('rockwood-quickbooks-sync', 15 * 60 * 1000, syncAllLocations, '*/15 * * * *');

console.log('[rockwood] Rockwood QuickBooks two-way sync registered');
