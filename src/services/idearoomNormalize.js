// Pure IdeaRoom payload → GHL-ready lead mapping. No DB/network imports, so it
// is unit-testable against the sample fixtures without app env or a database.

function firstFiniteNumber(...vals) {
  for (const v of vals) {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function clean(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Normalize an IdeaRoom webhook (or REST) payload into a flat, GHL-ready lead.
 * The shape is identical for the Sheds (ShedView) and Carports (CarportView)
 * products; missing sections degrade gracefully.
 *
 * Payload reference: docs/idearoom-integration.md §2.1 and docs/fixtures/.
 */
export function normalizeLead(payload = {}) {
  const order = payload.order ?? {};
  const customer = order.customer ?? {};
  const addr = order.billingAddress ?? order.shippingAddress ?? {};

  const firstName = clean(customer.firstName);
  const lastName = clean(customer.lastName);
  const name = [firstName, lastName].filter(Boolean).join(' ') || null;

  // Product summary — prefer structured integrationProperties (Carports), fall
  // back to the sharePost description (Sheds), then a generic label.
  const ip = order.integrationProperties ?? {};
  const size = ip.buildingSize
    ? [ip.buildingSize.width, ip.buildingSize.length].filter(Boolean).join(' x ')
    : null;
  const productSummary =
    (ip.buildingStyle ? (size ? `${ip.buildingStyle} — ${size}` : ip.buildingStyle) : null) ||
    clean(order.sharePost?.description) ||
    'IdeaRoom building';

  // Configuration / bill-of-materials — line items that carry a description.
  const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
  const specSummary = lineItems
    .filter((li) => li && li.description)
    .map((li) => {
      const qty = li.quantity && li.quantity !== 1 ? ` (x${li.quantity})` : '';
      return `• ${li.description}${qty}`;
    })
    .join('\n');

  // Renders / floor-plan images — collect any http(s) URLs on order.images.
  const images =
    order.images && typeof order.images === 'object'
      ? Object.values(order.images).filter((v) => typeof v === 'string' && /^https?:\/\//.test(v))
      : [];

  return {
    eventType: (payload.eventType ?? payload.event_type ?? '').toString().toLowerCase(),
    clientId: clean(payload.clientId),
    hash: clean(payload.hash) ?? clean(order.uuid),
    environment: clean(payload.environment),
    designUrl: clean(payload.url),
    status: clean(order.status),
    contact: {
      firstName,
      lastName,
      name,
      email: clean(customer.email),
      phone: clean(customer.phone) ?? clean(order.secondaryPhone),
      address1: clean(addr.address1),
      city: clean(addr.city),
      state: clean(addr.state),
      postalCode: clean(addr.zip) ?? clean(addr.postalCode),
    },
    productSummary,
    specSummary,
    lineItems,
    images,
    monetaryValue: firstFiniteNumber(order.totalPrice, order.subtotalPrice, order.buildingPrice),
  };
}
