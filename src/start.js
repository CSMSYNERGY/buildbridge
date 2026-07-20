// Entry point with startup error logging for Railway diagnosis
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception at startup:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection at startup:', reason);
  process.exit(1);
});

console.log('[startup] BuildBridge v2 starting...');
console.log('[startup] NODE_ENV:', process.env.NODE_ENV);
console.log('[startup] PORT:', process.env.PORT);

// Check critical env vars before importing the app (which runs envalid)
const required = [
  'GHL_CLIENT_ID', 'GHL_CLIENT_SECRET', 'GHL_SCOPES', 'GHL_SHARED_SECRET',
  'REDIRECT_URI', 'X_API_KEY', 'APP_JWT_SECRET', 'DATABASE_URL',
  'ENCRYPTION_KEY', 'SMARTBUILD_BASE_URL',
  // DEPOSYT_PRIVATE_API_KEY is no longer read at runtime (NMI replaced Deposyt
  // for billing); only the webhook signing key is still consumed.
  'DEPOSYT_WEBHOOK_SIGNING_KEY',
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('[FATAL] Missing required environment variables:', missing.join(', '));
  process.exit(1);
}
console.log('[startup] All required env vars present. Loading app...');

try {
  await import('./index.js');
  console.log('[startup] App loaded successfully.');
} catch (err) {
  console.error('[FATAL] App failed to load:', err);
  process.exit(1);
}
