import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import * as schema from './schema.js';

// Local Postgres (localhost) does not speak SSL; remote (Supabase) requires it.
const isLocalDb = /@(localhost|127\.0\.0\.1)[:\/]/.test(env.DATABASE_URL);

const client = postgres(env.DATABASE_URL, {
  max: env.NODE_ENV === 'test' ? 1 : 10,
  idle_timeout: 20,
  connect_timeout: 10,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
  connection: {
    options: '--client_encoding=UTF8',
  },
});

export const db = drizzle(client, { schema });
