import crypto from 'crypto';
import { env } from '../env.js';
import { setAuthCookie } from './jwt.js';
import { createError } from '../middleware/errorHandler.js';
import { ensureLocation } from '../../services/locationService.js';

/**
 * Decrypt a GHL SSO payload and issue an app session.
 *
 * Two entry shapes are supported:
 *   • GET  /api/sso/decrypt?key=...   — custom-page-URL flow: GHL appended the key
 *     to a top-level navigation. Sets the cookie and redirects into the SPA.
 *   • POST /api/sso/decrypt {key}     — embedded-iframe flow: the SPA obtained the
 *     encrypted payload from the GHL parent frame via the postMessage handshake
 *     (REQUEST_USER_DATA → REQUEST_USER_DATA_RESPONSE) and sends it here. Responds
 *     with JSON { user, token }: the cookie is set too (Partitioned), but the token
 *     is returned so the SPA can fall back to an Authorization header when the
 *     browser refuses third-party cookies inside the iframe.
 */
export async function ghlSsoController(req, res, next) {
  try {
    const key = req.body?.key ?? req.query?.key;
    const wantsJson = req.method === 'POST' || req.accepts(['html', 'json']) === 'json';

    // No key — GHL is previewing the URL or the user already has a session.
    // Fall through to the app; the existing cookie (if any) will authenticate them.
    if (!key) {
      if (wantsJson) throw createError(400, 'Missing SSO key');
      return res.redirect('/buildbridge');
    }

    let userData;
    try {
      userData = decryptSsoKey(String(key));
    } catch (err) {
      console.error('[sso] SSO payload decryption failed:', err?.message);
      throw createError(401, 'Invalid SSO payload');
    }

    // TEMPORARY diagnostic: field shape of GHL's SSO payload (ids only, no secrets).
    console.log(
      '[sso] payload keys:', Object.keys(userData).join(','),
      '| activeLocation:', userData.activeLocation,
      '| locationId:', userData.locationId,
      '| companyId:', userData.companyId,
      '| type:', userData.type,
    );

    // Marketplace SSO payloads carry activeLocation; the legacy shape carries
    // locationId. companyId may arrive as companyId or company_id.
    const locationId = userData.activeLocation ?? userData.locationId ?? null;
    const companyId = userData.companyId ?? userData.company_id ?? null;
    const userId = userData.userId ?? userData.id ?? null;
    const email = userData.email ?? null;
    const fullName = `${userData.firstName ?? ''} ${userData.lastName ?? ''}`.trim();
    const name = userData.userName ?? userData.name ?? (fullName || null);

    if (!locationId && !companyId) {
      throw createError(401, 'SSO payload contained no location or company');
    }

    // Guarantee the tenant row exists BEFORE handing out a session. Nearly every
    // table is foreign-keyed to locations.id, and SSO (the normal path when the app
    // is installed at agency level) previously minted sessions for locations that
    // had no row — so the first feature write died on an FK violation and the user
    // saw a bare "Internal server error". See services/locationService.js.
    if (locationId) {
      await ensureLocation(locationId, { companyId, name: null, email: null });
    }

    const token = setAuthCookie(res, { locationId, companyId, userId, email, name });

    if (wantsJson) {
      return res.json({ user: { locationId, companyId, userId, email, name }, token });
    }
    return res.redirect('/buildbridge');
  } catch (err) {
    next(err);
  }
}

/**
 * GHL has shipped two SSO encryption formats; detect and handle both:
 *
 *  1. CryptoJS/OpenSSL format (current marketplace SSO): base64 whose plaintext
 *     starts with "Salted__" + 8-byte salt; key+IV derived from the app's SSO key
 *     via OpenSSL's EVP_BytesToKey (MD5 chaining), AES-256-CBC.
 *  2. Legacy format: AES-256-CBC with key = SHA-256(shared secret) and a zero IV.
 */
function decryptSsoKey(key) {
  const sharedSecret = env.GHL_SHARED_SECRET;
  const raw = Buffer.from(key, 'base64');

  if (raw.length > 16 && raw.subarray(0, 8).toString('utf8') === 'Salted__') {
    const salt = raw.subarray(8, 16);
    const ciphertext = raw.subarray(16);
    const { key: aesKey, iv } = evpBytesToKey(sharedSecret, salt, 32, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return JSON.parse(decrypted);
  }

  // Legacy: SHA-256 key, zero IV.
  const keyBuffer = crypto.createHash('sha256').update(sharedSecret).digest();
  const ivBuffer = Buffer.alloc(16, 0);
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuffer, ivBuffer);
  let decrypted = decipher.update(key, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

/**
 * OpenSSL EVP_BytesToKey with MD5 — the KDF CryptoJS uses when AES-encrypting with
 * a string password (which is how GHL produces marketplace SSO payloads).
 */
function evpBytesToKey(password, salt, keyLen, ivLen) {
  const passwordBuf = Buffer.from(password, 'utf8');
  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  while (derived.length < keyLen + ivLen) {
    block = crypto.createHash('md5').update(Buffer.concat([block, passwordBuf, salt])).digest();
    derived = Buffer.concat([derived, block]);
  }
  return {
    key: derived.subarray(0, keyLen),
    iv: derived.subarray(keyLen, keyLen + ivLen),
  };
}
