import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// Read DATABASE_URL directly (dotenv above loads it) instead of the full app env
// schema, so a DB-only migration run doesn't require every app secret to be set.
const migrationClient = postgres(process.env.DATABASE_URL, { max: 1 });

try {
  await migrate(drizzle(migrationClient), {
    migrationsFolder: './src/core/db/migrations',
  });
  console.log('Migrations complete.');
} catch (err) {
  console.error('Migration failed:', err);
  process.exit(1);
} finally {
  await migrationClient.end();
}
