import { cleanEnv, str, port, url } from 'envalid';

export const env = cleanEnv(process.env, {
  // Application
  NODE_ENV: str({ choices: ['development', 'test', 'production'], default: 'development' }),
  PORT: port({ default: 3000 }),

  // GoHighLevel OAuth
  GHL_CLIENT_ID: str(),
  GHL_CLIENT_SECRET: str(),
  GHL_SCOPES: str(),
  GHL_SHARED_SECRET: str(),
  GHL_BASE_URL: url({ default: 'https://services.leadconnectorhq.com' }),
  GHL_DEFAULT_API_VERSION: str({ default: '2021-07-28' }),

  // OAuth Redirect
  REDIRECT_URI: url(),

  // API Security
  X_API_KEY: str(),

  // JWT
  APP_JWT_SECRET: str({ docs: 'Must be at least 32 characters' }),

  // Database
  DATABASE_URL: str(),

  // Encryption
  ENCRYPTION_KEY: str({ docs: 'Must be 64 hex characters (32 bytes for AES-256)' }),

  // SmartBuild
  SMARTBUILD_BASE_URL: url(),

  // Deposyt
  DEPOSYT_PRIVATE_API_KEY: str(),
  DEPOSYT_WEBHOOK_SIGNING_KEY: str(),

  // Intuit / QuickBooks Online (OAuth2) — optional; leave blank to disable the
  // QuickBooks integration. When blank, the Connect flow returns a 503.
  INTUIT_CLIENT_ID: str({ default: '' }),
  INTUIT_CLIENT_SECRET: str({ default: '' }),
  QBO_REDIRECT_URI: str({ default: '' }),
  QBO_ENVIRONMENT: str({ choices: ['sandbox', 'production'], default: 'sandbox' }),
});
