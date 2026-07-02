import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import * as schema from './schema.js';

const client = postgres(env.DATABASE_URL, {
  max: env.NODE_ENV === 'test' ? 1 : 10,
  idle_timeout: 20,
  connect_timeout: 10,
  // Railway↔Supabase requires SSL; honor sslmode=disable for local development
  ssl: env.DATABASE_URL.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
  connection: {
    options: '--client_encoding=UTF8',
  },
});

export const db = drizzle(client, { schema });
