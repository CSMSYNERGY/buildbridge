import crypto from 'crypto';
import { env } from '../env.js';
import { setAuthCookie } from './jwt.js';

/**
 * Decrypt the GHL SSO key payload and issue an app session cookie.
 * Called from GET /api/auth/sso?key=<encrypted_key>
 */
export async function ghlSsoController(req, res, next) {
  try {
    const { key } = req.query;

    // No key — GHL is previewing the URL or the user already has a session.
    // Fall through to the app; the existing cookie (if any) will authenticate them.
    if (!key) {
      return res.redirect('/buildbridge');
    }

    const userData = decryptSsoKey(key);

    const name = userData.name
      ?? `${userData.firstName ?? ''} ${userData.lastName ?? ''}`.trim()
      || null;

    setAuthCookie(res, {
      locationId: userData.locationId,
      companyId: userData.companyId,
      userId: userData.userId,
      email: userData.email,
      name,
    });

    res.redirect('/buildbridge');
  } catch (err) {
    next(err);
  }
}

function decryptSsoKey(key) {
  const sharedSecret = env.GHL_SHARED_SECRET;

  // GHL SSO uses AES-256-CBC with the shared secret as the key (SHA-256 hashed)
  const keyBuffer = crypto.createHash('sha256').update(sharedSecret).digest();
  const ivBuffer = Buffer.alloc(16, 0); // GHL uses a zero IV for SSO

  const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuffer, ivBuffer);
  let decrypted = decipher.update(key, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return JSON.parse(decrypted);
}
