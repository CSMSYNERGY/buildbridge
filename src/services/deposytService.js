import { env } from '../core/env.js';
import { createError } from '../core/middleware/errorHandler.js';

const DEPOSYT_BASE = 'https://api.deposyt.com/v1';

async function deposytFetch(method, path, body = undefined) {
  const res = await fetch(`${DEPOSYT_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.DEPOSYT_PRIVATE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw createError(res.status, `Deposyt API error [${method} ${path}]: ${text}`);
  }

  return res.json();
}

/**
 * Create a new Deposyt subscription.
 * @param {string} planId - Deposyt plan id
 * @param {object} customerData - { name, email, locationId, ... }
 */
export async function createSubscription(planId, customerData) {
  return deposytFetch('POST', '/subscriptions', {
    plan_id: planId,
    customer: customerData,
    metadata: { locationId: customerData.locationId },
  });
}

/**
 * Cancel an existing Deposyt subscription immediately.
 */
export async function cancelSubscription(deposytSubId) {
  return deposytFetch('DELETE', `/subscriptions/${deposytSubId}`);
}

/**
 * Fetch a single subscription by id from Deposyt.
 */
export async function getSubscription(deposytSubId) {
  return deposytFetch('GET', `/subscriptions/${deposytSubId}`);
}
