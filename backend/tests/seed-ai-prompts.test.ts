// tests/seed-ai-prompts.test.ts — the agent.system prompt is seeded for ALL 8 book
// editions (§5B), so every locale resolves a governable prompt row (en real, the
// rest EN placeholders). Idempotent: re-running seedAi adds no duplicates.
import { test, expect } from 'bun:test';
import { and, eq, isNull } from 'drizzle-orm';
import { db, mcpPrompts } from '../src/db/client';
import { seedAi } from '../src/db/seed-ai';
import { SUPPORTED_LOCALES } from '../src/utils/locale';

test('seedAi seeds agent.system for every supported locale (global tenant)', async () => {
  await seedAi();
  for (const locale of SUPPORTED_LOCALES) {
    const rows = await db
      .select({ id: mcpPrompts.id, template: mcpPrompts.template })
      .from(mcpPrompts)
      .where(
        and(
          eq(mcpPrompts.name, 'agent.system'),
          eq(mcpPrompts.locale, locale),
          isNull(mcpPrompts.tenant_id),
        ),
      );
    expect(rows.length).toBe(1); // exactly one (idempotent, no dupes)
    expect(rows[0]!.template.length).toBeGreaterThan(50);
  }
});

test('seedAi is idempotent — a second run does not duplicate prompt rows', async () => {
  await seedAi();
  await seedAi();
  const rows = await db
    .select({ id: mcpPrompts.id })
    .from(mcpPrompts)
    .where(
      and(
        eq(mcpPrompts.name, 'agent.system'),
        eq(mcpPrompts.locale, 'en'),
        isNull(mcpPrompts.tenant_id),
      ),
    );
  expect(rows.length).toBe(1);
});
