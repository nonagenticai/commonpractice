// tests/boot-seeds.test.ts — the seeds prod gets at every boot are actually wired to the boot.
//
// CI seeds through `bun run seed` (seedAll) and never executes server.ts, so deleting a boot-seed
// call from server.ts used to keep the whole suite green while prod silently stopped receiving it
// (SEED_DEMO_DATA is false there, so seedAll never runs). Two halves:
//   1. server.ts calls `runBootSeeds()` — a source guard, since importing server.ts starts a server;
//   2. `runBootSeeds()` runs BOTH steps — proven by the effect, not by reading the file.
//
// REQUIRES a migrated + seeded database (CI shape).
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db, contentTranslations } from '../src/db/client';
import { runBootSeeds } from '../src/db/boot-seeds';
import { BLOCK_PORT_I18N } from '../src/blocks/port-labels';

/** server.ts with every `//` comment line dropped, so a commented-out call does not count. */
function serverCode(): string {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'server.ts'), 'utf8');
  // Non-vacuity: an empty or moved file must not pass the "contains" check below by accident.
  expect(src.length).toBeGreaterThan(2000);
  expect(src).toContain('applyMigrations(');
  return src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

test('server.ts runs the boot seeds (top-level await, not commented out)', () => {
  const code = serverCode();
  expect(code).toMatch(/^await runBootSeeds\(\);$/m);
  expect(code).toMatch(/import \{ runBootSeeds \} from '\.\/db\/boot-seeds';/);
});

test('runBootSeeds runs the flow-template seed and the port-label seed', async () => {
  const cell = and(
    eq(contentTranslations.entity_type, BLOCK_PORT_I18N),
    eq(contentTranslations.entity_id, 'table-view'),
    eq(contentTranslations.locale, 'fr'),
    eq(contentTranslations.field, 'out.view'),
  );
  await db.delete(contentTranslations).where(cell);

  const result = await runBootSeeds();

  expect(result.flowTemplates).not.toBe('failed');
  if (result.flowTemplates !== 'failed') expect(result.flowTemplates.total).toBeGreaterThan(0);
  expect(result.blockPortLabels).not.toBe('failed');
  if (result.blockPortLabels !== 'failed') expect(result.blockPortLabels.inserted).toBe(1);
  const [row] = await db.select().from(contentTranslations).where(cell);
  expect(row?.value, 'the boot seed restored the missing label').toBe('Tableau');
}, 30_000);
