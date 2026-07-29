import { cleanEnv, str, port, url, bool } from 'envalid';

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
  // Dedicated admin-endpoint key. Optional: when blank, /admin falls back to
  // X_API_KEY (set this to a distinct value to separate admin from the actions API).
  ADMIN_API_KEY: str({ default: '' }),

  // JWT
  APP_JWT_SECRET: str({ docs: 'Must be at least 32 characters' }),

  // Database
  DATABASE_URL: str(),

  // Encryption
  ENCRYPTION_KEY: str({ docs: 'Must be 64 hex characters (32 bytes for AES-256)' }),

  // SmartBuild
  SMARTBUILD_BASE_URL: url(),

  // Deposyt (legacy). The private API key is no longer read at runtime — NMI
  // handles billing now — so it's optional to avoid a boot-crash if it's pruned
  // from the environment. The webhook signing key is still consumed.
  DEPOSYT_PRIVATE_API_KEY: str({ default: '' }),
  DEPOSYT_WEBHOOK_SIGNING_KEY: str(),

  // NMI / Deposyt gateway — recurring billing via the Payment API (transact.php)
  // and Collect.js card tokenization. NMI_SECURITY_KEY is the private server-side
  // key; NMI_TOKENIZATION_KEY is the public Collect.js key sent to the browser.
  // Leave NMI_SECURITY_KEY blank to disable checkout (create returns 503).
  NMI_GATEWAY_URL: url({ default: 'https://deposyt.transactiongateway.com' }),
  NMI_SECURITY_KEY: str({ default: '' }),
  NMI_TOKENIZATION_KEY: str({ default: '' }),

  // Intuit / QuickBooks Online (OAuth2) — optional; leave blank to disable the
  // QuickBooks integration. When blank, the Connect flow returns a 503.
  INTUIT_CLIENT_ID: str({ default: '' }),
  INTUIT_CLIENT_SECRET: str({ default: '' }),
  QBO_REDIRECT_URI: str({ default: '' }),
  QBO_ENVIRONMENT: str({ choices: ['sandbox', 'production'], default: 'sandbox' }),
  QBO_API_BASE_URL: str({ default: '' }), // override for tests/mocks; blank → per-environment default
  // Opt-in for the App Foundations GraphQL custom-field-definitions API (modern
  // QBO "Custom fields"). OFF by default because the required scope
  // `app-foundations.custom-field-definitions.read` is NOT offered on the Intuit
  // app's Permissions page (verified 2026-07-26: only com.intuit.quickbooks.accounting
  // and .payment are selectable), so every call 403s and asking for the scope in the
  // OAuth request buys nothing. Flip to true once Intuit grants App Foundations
  // access — then reconnect each company so its token carries the new scope.
  QBO_ENABLE_CUSTOM_FIELDS_API: bool({ default: false }),

  // Background jobs (milestone invoicing, two-way sync). Disable when running
  // multiple instances to avoid duplicate job execution.
  ENABLE_SCHEDULER: bool({ default: true }),
});
