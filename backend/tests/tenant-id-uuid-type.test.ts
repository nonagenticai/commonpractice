// tests/tenant-id-uuid-type.test.ts — migration 0084 anti-drift guard: EVERY tenant_id is a uuid.
//
// WHAT THIS PINS, AND WHY A CATALOG TEST RATHER THAN A BEHAVIOURAL ONE.
// 0084 converted the last three `tenant_id text` columns (`datasets`, `tenant_llm_settings`,
// `mcp_prompts`) to `uuid` and repointed seven RLS policies from `app_current_tenant_text()` to the
// long-standing `app_current_tenant_uuid()`. Nothing in this repo mechanically compares
// `src/db/schema.ts` against the real column types: drizzle-kit is a manual script and does not run
// in CI (`.github/workflows/ci-cd.yaml` says so in a comment), and `tests/rls-coverage.test.ts` —
// the only other schema anti-drift guard — is deliberately type-agnostic. So a future migration or
// a new table could reintroduce a `text` tenant key and every existing test would stay green.
//
// ⛔ THE FAILURE THIS EXISTS FOR IS NOT "THE WRONG TYPE", IT IS "AN INVISIBLE ROW". Under RLS the
// tenant predicate is an EQUALITY. A `text` key admits `'<uuid> '`, `'<UUID>'` and `''`, none of
// which any `uuid` GUC will ever equal — so a row written with a stray space is not slightly wrong,
// it is permanently unreachable BY ITS OWN OWNER, with no error on either the write or the read.
// 0058's header documents the same silent-mismatch class on `usage_counters`: an ABSENT GUC errors
// loudly, a MISMATCHED one returns zero rows and says nothing. `uuid` makes the whole class
// unrepresentable at write time instead of undetectable at read time, and this test is what keeps
// it that way.
import { test, expect } from 'bun:test';
import { queryClient } from '../src/db/client';

// The three 0084 converted. Named explicitly rather than derived, so that DELETING one of these
// tables is a deliberate edit here and not a silently-shrinking assertion.
const CONVERTED = ['datasets', 'mcp_prompts', 'tenant_llm_settings'] as const;

// Tables whose `tenant_id` is legitimately NOT a uuid. Empty, and that is the assertion: there is
// no such table, and adding one needs a written reason right here.
//
// ⚠️ `_purge_20260809b_llm_settings` is NOT listed and must not be. It was a `text` tenant_id on
// prod — one of the `_purge_*` snapshot tables 0084 deliberately left alone (migrating debris would
// dignify a snapshot as schema) and that 0118 drops. It only ever existed on prod, created by hand
// and by no migration, so a CI database has never contained it. Allowlisting it here would create
// the false impression that this guard has an opinion about it.
const NON_UUID_TENANT_KEYS_WITH_A_REASON = new Set<string>([]);

test('no table has a non-uuid tenant_id column', async () => {
  const rows = await queryClient<{ table_name: string; data_type: string; is_nullable: string }[]>`
    SELECT c.table_name, c.data_type, c.is_nullable
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND t.table_type   = 'BASE TABLE'
       AND c.column_name  = 'tenant_id'
     ORDER BY c.table_name
  `;

  // Guard the guard: if the catalog query ever returns nothing, every assertion below passes
  // vacuously and this file becomes a green no-op. There are ~25 such columns.
  expect(rows.length).toBeGreaterThan(15);

  const offenders = rows
    .filter((r) => r.data_type !== 'uuid' && !NON_UUID_TENANT_KEYS_WITH_A_REASON.has(r.table_name))
    .map((r) => `${r.table_name}.tenant_id is ${r.data_type}`);
  expect(offenders).toEqual([]);

  // All three of 0084's tables are actually present — otherwise the filter above proves nothing
  // about them.
  for (const t of CONVERTED) {
    expect(rows.find((r) => r.table_name === t), `${t} missing from the catalog`).toBeDefined();
  }

  // ⛔ NULLABILITY IS PART OF THE CONTRACT, IN BOTH DIRECTIONS.
  // `mcp_prompts.tenant_id` MUST stay nullable: NULL is the encoding of "GLOBAL prompt, visible to
  // every workspace" (policy `mcp_prompts_read` is `tenant_id IS NULL OR tenant_id = …`), and every
  // prompt the product ships is global. A `SET NOT NULL` here would not fail loudly — it would hide
  // every shipped prompt from every tenant. The other two MUST stay NOT NULL: a NULL tenant there
  // is a row nobody can ever see.
  const nullable = Object.fromEntries(rows.map((r) => [r.table_name, r.is_nullable]));
  expect(nullable['mcp_prompts']).toBe('YES');
  expect(nullable['datasets']).toBe('NO');
  expect(nullable['tenant_llm_settings']).toBe('NO');
});

test('no RLS policy still calls app_current_tenant_text()', async () => {
  // 0084 left the FUNCTION in place on purpose (dropping it mid-rollout would 42883 an un-rolled
  // replica), so its mere existence proves nothing. What must be true is that nothing CALLS it:
  // against a uuid column `uuid = text` is 42883, so a policy that still names it is either broken
  // or guarding a column that has regressed to text.
  const rows = await queryClient<{ tablename: string; policyname: string }[]>`
    SELECT tablename, policyname
      FROM pg_policies
     WHERE coalesce(qual, '') || coalesce(with_check, '') LIKE '%app_current_tenant_text%'
  `;
  expect(rows.map((r) => `${r.tablename}.${r.policyname}`)).toEqual([]);

  // Positive control. The assertion above is an emptiness check, which also passes if the query is
  // wrong, if `pg_policies` is empty, or if RLS was never set up on this database at all. Pin that
  // the same query shape DOES find the uuid helper, so an empty result means "none left" rather
  // than "nothing looked".
  const uuidPolicies = await queryClient<{ n: string }[]>`
    SELECT count(*)::text AS n
      FROM pg_policies
     WHERE coalesce(qual, '') || coalesce(with_check, '') LIKE '%app_current_tenant_uuid%'
  `;
  expect(Number(uuidPolicies[0]!.n)).toBeGreaterThan(15);
});

test('mcp_prompts natural key partitions global from tenant rows, and still blocks two globals', async () => {
  // `mcp_prompts_name_locale_tenant_uq` is an EXPRESSION index, so — unlike this table's PK and
  // `datasets`' unique constraint — Postgres could not re-derive it across 0084's type change:
  // 0008 wrote it as `COALESCE(tenant_id, '')` and `''` is not a uuid. 0084 rebuilt it against the
  // zero-uuid sentinel the repo already uses for this job in 0018/0019/0023/0037/0043.
  //
  // ⛔ THIS ASSERTS THE SENTINEL'S BEHAVIOUR, NOT ITS TEXT, AND THAT IS DELIBERATE — TWICE OVER.
  // The first version of this test matched the sentinel's literal uuid against `indexdef`. That
  // spelled a bare quoted uuid into this file, and `tests/fixture-id-collisions.test.ts` correctly
  // flagged it: the zero-uuid is already claimed by mcp-sdk-transport.test.ts and
  // metering-emit.test.ts, and that ratchet cannot tell a schema constant from a fixture row it is
  // about to have deleted out from under it. Suppressing it via the KNOWN list would have been the
  // wrong repair — the guard bounds a real flake class and gets to stay strict.
  //
  // The replacement is not a workaround, it is the better assertion. A substring match on
  // `indexdef` pins the SPELLING of a value the schema is free to change, and passes for an index
  // that is uniquely useless (`coalesce(tenant_id, tenant_id)` contains no sentinel to match but
  // is also no constraint at all). What actually has to hold is the PARTITION: NULL is not equal
  // to NULL, so without a coalesce two GLOBAL prompts could share a (name, locale) — the exact
  // duplicate 0008 created this index to prevent, and the one that would make `getPrompt()`
  // non-deterministic. Below, the duplicate global is refused and the tenant-scoped row with the
  // SAME (name, locale) is admitted. That is the contract, in both directions, with no literal.
  const NAME = '0084.sentinel.probe'; // unique to this file; nothing seeds or reads it
  const TENANT = '0e5d0000-0000-4000-8000-000000000084';
  const cleanup = async () => {
    await queryClient`DELETE FROM mcp_prompts WHERE name = ${NAME}`;
  };
  await cleanup();
  try {
    await queryClient`
      INSERT INTO mcp_prompts (name, locale, tenant_id, template) VALUES (${NAME}, 'en', NULL, 'g1')
    `;

    // A SECOND global row with the same (name, locale) must be refused. Without the coalesce this
    // succeeds, because NULL <> NULL — which is the whole reason the sentinel exists.
    let refused: unknown;
    try {
      await queryClient`
        INSERT INTO mcp_prompts (name, locale, tenant_id, template) VALUES (${NAME}, 'en', NULL, 'g2')
      `;
    } catch (err) {
      refused = err;
    }
    expect(refused, 'a second GLOBAL prompt sharing (name, locale) must violate the natural key')
      .toBeDefined();
    expect(String(refused)).toContain('mcp_prompts_name_locale_tenant_uq');

    // A TENANT-scoped row with the same (name, locale) must still be allowed — the sentinel
    // separates the global partition from each tenant's, it does not merge them. An index that
    // rejected this would break per-tenant prompt overrides, which is what seed-ai.ts's drift
    // pass and `getPrompt()`'s fallback are built around.
    await queryClient`
      INSERT INTO mcp_prompts (name, locale, tenant_id, template) VALUES (${NAME}, 'en', ${TENANT}, 't1')
    `;
    const rows = await queryClient<{ n: string }[]>`
      SELECT count(*)::text AS n FROM mcp_prompts WHERE name = ${NAME}
    `;
    expect(Number(rows[0]!.n)).toBe(2);
  } finally {
    await cleanup();
  }

  // The index is still UNIQUE and still coalesces to a UUID — the structural half, minus the
  // literal. `''::text` is 0008's pre-0084 spelling; if it ever comes back, the column has
  // regressed to text and the first test in this file is the one that will say so loudest.
  const [idx] = await queryClient<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes WHERE indexname = 'mcp_prompts_name_locale_tenant_uq'
  `;
  expect(idx, 'mcp_prompts_name_locale_tenant_uq is missing').toBeDefined();
  expect(idx!.indexdef).toContain('UNIQUE');
  expect(idx!.indexdef).toContain('COALESCE(tenant_id,');
  expect(idx!.indexdef).toContain('::uuid');
  expect(idx!.indexdef).not.toContain("''::text");
});

test('⛔ tenantIdSchema accepts the prod demo tenant …0001 and the nil id (zod 4 `.uuid()` refused them)', async () => {
  const { tenantIdSchema } = await import('../src/utils/tenant-id');
  const { DEMO_TENANT_ID } = await import('../src/config');
  const { SYSTEM_TENANT_ID } = await import('../src/services/license-provisioning');
  // No DB rows here — pure schema checks; the v4/v7 ids are this file's own (fixture-id-collisions).
  for (const id of [DEMO_TENANT_ID, SYSTEM_TENANT_ID, '7C1D2E3F-4A5B-4C6D-8E7F-0A1B2C3D4E5F', '01928c3a-0000-7abc-9def-0123456789ab']) {
    expect(tenantIdSchema.parse(id)).toBe(id.toLowerCase());
  }
  expect(tenantIdSchema.safeParse('not-a-uuid').success).toBe(false);
});
