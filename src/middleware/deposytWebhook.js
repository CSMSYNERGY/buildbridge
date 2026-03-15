import crypto from 'crypto';
import { env } from '../core/env.js';
import { createError } from '../core/middleware/errorHandler.js';

/**
 * Express middleware — verifies the Deposyt HMAC-SHA256 webhook signature.
 * Expects header: x-deposyt-signature: sha256=<hex>
 * Requires rawBody to be captured on req (set via express.json verify option in index.js).
 */
export function deposytSignatureVerify(req, _res, next) {
  try {
    const sigHeader = req.headers['x-deposyt-signature'];
    if (!sigHeader) throw createError(401, 'Missing x-deposyt-signature header');

    const [algo, receivedHex] = sigHeader.split('=');
    if (algo !== 'sha256' || !receivedHex) {
      throw createError(401, 'Malformed x-deposyt-signature header');
    }

    const rawBody = req.rawBody;
    if (!rawBody) throw createError(500, 'rawBody not available — check express.json verify config');

    const expected = crypto
      .createHmac('sha256', env.DEPOSYT_WEBHOOK_SIGNING_KEY)
      .update(rawBody)
      .digest('hex');

    // Pad to equal length before timingSafeEqual to avoid length-leak errors
    const expectedBuf = Buffer.from(expected, 'hex');
    const receivedBuf = Buffer.from(receivedHex.padEnd(expected.length, '0'), 'hex');

    if (expectedBuf.length !== receivedBuf.length ||
        !crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
      throw createError(401, 'Invalid Deposyt webhook signature');
    }

    next();
  } catch (err) {
    next(err);
  }
}
