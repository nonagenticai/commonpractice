// scripts/migrate.ts — standalone migrate entrypoint (`bun run migrate`).
import { config } from '../src/config';
import { applyMigrations } from '../src/db/migration-runner';

await applyMigrations(config.database.url);
console.log('[migrate] done');
process.exit(0);
