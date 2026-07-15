// NMI (Network Merchants) recurring-billing integration — the payment engine
// behind Deposyt's gateway. Replaces the never-completed api.deposyt.com stub.
//
// Flow: the browser tokenizes the card with Collect.js (no card data touches us),
// then we call the Payment API (transact.php) with recurring=add_subscription and
// the customer's payment_token to start the subscription against a preset plan.
//
// Docs: https://support.nmi.com/hc/en-gb/articles/14525725002385-API-Recurring-Payments-and-Subscriptions
import { env } from '../core/env.js';
import { createError } from '../core/middleware/errorHandler.js';

const GATEWAY = env.NMI_GATEWAY_URL.replace(/\/+$/, '');
const TRANSACT_URL = `${GATEWAY}/api/transact.php`;

/**
 * Map an app plan id (from the `plans` table) to the recurring Plan ID set up in
 * the Deposyt/NMI gateway. These must match the gateway's Recurring → Plans list.
 */
export const NMI_PLAN_IDS = {
  smartbuild_monthly: 'SMARTBUILD_MONTHLY',
  smartbuild_annual: 'SMARTBUILD_YEARLY',
  idearoom_monthly: 'IDEAROOM_MONTHLY',
  idearoom_annual: 'IDEAROOM_YEARLY',
  quickbooks_monthly: 'QUICKBOOKS_MONTHLY',
  quickbooks_annual: 'QUICKBOOKS_YEARLY',
  monday_monthly: 'MONDAY_MONTHLY',
  monday_annual: 'MONDAY_YEARLY',
  suite_monthly: 'BUILDBRIDGE_SUITE_MONTHLY',
  suite_annual: 'BUILDBRIDGE_SUITE_YEARLY',
};

export function nmiPlanIdFor(appPlanId) {
  return NMI_PLAN_IDS[appPlanId] ?? null;
}

function requireConfigured() {
  if (!env.NMI_SECURITY_KEY) {
    throw createError(503, 'Billing is not configured (NMI_SECURITY_KEY is missing).');
  }
}

/**
 * POST to transact.php. NMI takes form-urlencoded input and returns a
 * form-urlencoded body (response=1 approved | 2 declined | 3 error).
 */
async function nmiPost(params) {
  requireConfigured();

  const body = new URLSearchParams({ security_key: env.NMI_SECURITY_KEY, ...params });
  const res = await fetch(TRANSACT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const text = await res.text();
  const parsed = Object.fromEntries(new URLSearchParams(text));

  if (parsed.response !== '1') {
    const msg = parsed.responsetext || 'transaction declined';
    // 402 Payment Required — a clean, client-displayable billing failure.
    throw createError(402, `Payment gateway error: ${msg}`);
  }
  return parsed;
}

/**
 * Start a recurring subscription against a preset gateway plan.
 * @param {object} opts
 * @param {string} opts.appPlanId    plans.id (e.g. 'suite_monthly')
 * @param {string} opts.paymentToken Collect.js one-time token
 * @param {string} [opts.firstName]
 * @param {string} [opts.lastName]
 * @param {string} [opts.email]
 * @param {string} [opts.locationId] GHL location, stored for reconciliation
 */
export async function createSubscription({
  appPlanId,
  paymentToken,
  firstName = '',
  lastName = '',
  email = '',
  locationId = '',
}) {
  const planId = nmiPlanIdFor(appPlanId);
  if (!planId) throw createError(400, `No gateway plan mapped for "${appPlanId}"`);
  if (!paymentToken) throw createError(400, 'paymentToken is required');

  const parsed = await nmiPost({
    recurring: 'add_subscription',
    plan_id: planId,
    payment_token: paymentToken,
    first_name: firstName,
    last_name: lastName,
    email,
    // Tie the gateway subscription back to the GHL location for webhooks/reporting.
    merchant_defined_field_1: locationId,
    orderid: locationId ? `bb_${locationId}_${appPlanId}` : `bb_${appPlanId}`,
  });

  return {
    subscriptionId: parsed.subscription_id,
    transactionId: parsed.transactionid,
    raw: parsed,
  };
}

/** Cancel a recurring subscription immediately. */
export async function cancelSubscription(subscriptionId) {
  if (!subscriptionId) throw createError(400, 'subscriptionId is required');
  return nmiPost({ recurring: 'delete_subscription', subscription_id: subscriptionId });
}
