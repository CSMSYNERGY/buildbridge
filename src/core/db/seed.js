import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { plans } from './schema.js';

// Own postgres-js connection (like migrate.js). Routing through client.js would
// pull in the Workers-only pg-proxy transport, which crashes in a plain Node run.
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const db = drizzle(sql);

const seedPlans = [
  { id: 'smartbuild_monthly',  name: 'SmartBuild Monthly',   appSlug: 'smartbuild',  billingInterval: 'monthly', priceUsd: 15000 },
  { id: 'smartbuild_annual',   name: 'SmartBuild Annual',    appSlug: 'smartbuild',  billingInterval: 'annual',  priceUsd: 150000 },
  { id: 'idearoom_monthly',    name: 'IdeaRoom Monthly',     appSlug: 'idearoom',    billingInterval: 'monthly', priceUsd: 4900 },
  { id: 'idearoom_annual',     name: 'IdeaRoom Annual',      appSlug: 'idearoom',    billingInterval: 'annual',  priceUsd: 49000 },
  { id: 'quickbooks_monthly',  name: 'QuickBooks Monthly',   appSlug: 'quickbooks',  billingInterval: 'monthly', priceUsd: 6900 },
  { id: 'quickbooks_annual',   name: 'QuickBooks Annual',    appSlug: 'quickbooks',  billingInterval: 'annual',  priceUsd: 69000 },
  { id: 'monday_monthly',      name: 'Monday.com Monthly',   appSlug: 'monday',      billingInterval: 'monthly', priceUsd: 5900 },
  { id: 'monday_annual',       name: 'Monday.com Annual',    appSlug: 'monday',      billingInterval: 'annual',  priceUsd: 59000 },
  { id: 'suite_monthly',       name: 'Suite Monthly',        appSlug: 'suite',       billingInterval: 'monthly', priceUsd: 25000 },
  { id: 'suite_annual',        name: 'Suite Annual',         appSlug: 'suite',       billingInterval: 'annual',  priceUsd: 250000 },
];

try {
  await db.insert(plans).values(seedPlans).onConflictDoNothing();
  console.log(`Seeded ${seedPlans.length} plans.`);
} catch (err) {
  console.error('Seed failed:', err);
  await sql.end();
  process.exit(1);
}

await sql.end();
process.exit(0);
