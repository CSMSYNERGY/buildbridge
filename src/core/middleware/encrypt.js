import crypto from 'crypto';
import { env } from '../env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16;

// Derive the key lazily (memoized). Building it at module scope crashes when the
// ENCRYPTION_KEY secret isn't present yet — e.g. during `wrangler deploy` upload
// validation, which evaluates global scope before secrets are bound. Resolving it
// on first encrypt/decrypt call (inside a request) avoids that.
let _key;
function getKey() {
  if (!_key) _key = Buffer.from(env.ENCRYPTION_KEY, 'hex'); // 32 bytes
  return _key;
}

/**
 * Encrypt a plaintext string.
 * Returns a base64-encoded string: iv (12 bytes) + authTag (16 bytes) + ciphertext
 */
export function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

/**
 * Decrypt a base64-encoded blob produced by encrypt().
 */
export function decrypt(cipherblob) {
  const buf = Buffer.from(cipherblob, 'base64');

  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
}
