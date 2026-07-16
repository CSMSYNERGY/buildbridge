// Yoder Barnes model — one-way push into QuickBooks:
//   opportunity Won → QBO customer + milestone rows → scheduled invoices.
// Importing this module registers the webhook handler and the scheduler job.

import { registerGhlHandler } from '../core/webhooks/ghlDispatcher.js';
import { registerJob } from '../core/scheduler.js';
import {
  handleOpportunityWon,
  invoiceDueMilestones,
  pollWonOpportunities,
} from '../services/milestoneService.js';

// Fired by a GHL workflow "custom webhook" action on opportunity stage change
// (the handler itself skips anything that isn't Won).
registerGhlHandler('opportunity.stage_change', handleOpportunityWon);
// Also accept an explicit Won event for workflows triggered only on Won.
registerGhlHandler('opportunity.won', handleOpportunityWon);

// Poll GHL for won opportunities every 15 minutes — a webhook-free path so
// reseller clients don't each have to wire up a GHL workflow. Idempotent and
// gated on the per-tenant milestone-invoicing toggle.
registerJob('yoder-poll-won', 15 * 60 * 1000, pollWonOpportunities);

// Check for due milestones every 15 minutes.
registerJob('yoder-invoice-due-milestones', 15 * 60 * 1000, invoiceDueMilestones);

console.log('[yoder] Yoder Barnes QuickBooks integration registered');
