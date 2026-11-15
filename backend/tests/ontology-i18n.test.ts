// tests/ontology-i18n.test.ts — Phase 3.5 (SPEC §B6): ontology label/description i18n.
// Proves compileEffective overlays content_translations for a non-en locale (keyed by the
// reseed-stable natural key) and falls back to the en base columns when a translation is
// missing. Runs the real seeds against CI Postgres :5433.
import { test, expect, beforeAll } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { seedOntology } from '../src/db/seed-ontology';
import { seedOntologyI18n } from '../src/db/seed-ontology-i18n';
import { compileEffective, hideGlobalEntity, invalidateOntologyCache } from '../src/ontology/ontology-service';
import { db, ontologyEntities, ontologyAttributes, tenants } from '../src/db/client';

// Two full seeds, hundreds of round trips. bun 1.3.14 does NOT apply bunfig's
// `[test] timeout` to HOOKS — they get a fixed 5s — so on a contended CI runner this
// hook died at exactly 5000.29ms and reported `(fail) (unnamed)`, naming neither the
// file nor the cause. It failed three separate runs and blocked merged work from
// deploying. Same explicit-timeout fix as keycloak.test.ts:39, which had the same
// shape (expensive one-off setup under the fixed hook budget).
beforeAll(async () => {
  await seedOntology();
  await seedOntologyI18n();
}, 30_000);

test('compileEffective(locale=nl) localizes entity label + description', async () => {
  const nl = await compileEffective('insurance', 'Claims', { locale: 'nl' });
  // The Claims-desk Claim (industry_dept cell) is the winning row → its nl label/desc.
  const claim = nl.entities.find((e) => e.name === 'Claim')!;
  expect(claim.key).toBe('industry_dept:insurance:Claims:Claim');
  expect(claim.label).toBe('Schadeclaim (schadeafdeling)');
  expect(claim.description).toContain('schadeafdeling');
  // A generic entity pulled in by expansion is localized too — BOTH fields now. Entity
  // descriptions used to be insurance-only (9 of 38); they are 38 of 38 as of 0080.
  const customer = nl.entities.find((e) => e.name === 'Customer')!;
  expect(customer.label).toBe('Klant');
  expect(customer.description).toBe('Een persoon of organisatie waaraan het bedrijf diensten levert.');
});

test('en is the base edition — no overlay is applied for the default locale', async () => {
  const en = await compileEffective('insurance', 'Claims', { locale: 'en' });
  const claimEn = en.entities.find((e) => e.name === 'Claim')!;
  expect(claimEn.label).toBe('Claim (Claims desk)');
  const customerEn = en.entities.find((e) => e.name === 'Customer')!;
  expect(customerEn.description).toBe('A person or organization the company serves.');
});

test('a field with an en base and NO translation falls back to the en base column', async () => {
  // ⛔ THIS TEST EXISTS BECAUSE THE OLD FALLBACK ASSERTION DIED AND ITS REPLACEMENT WAS VACUOUS.
  //
  // The original read: "Customer has a localized label but no seeded description, so description
  // stays en." True while entity descriptions covered 9 of 38 entities. 0080 took them to 38 of 38,
  // so Customer HAS an `nl` description now and the assertion asserted an absence that had been
  // filled. It was replaced with a claim that the fallback was "still exercised on `Claim.amount`".
  // ⛔ THAT CLAIM WAS FALSE, and measurably so: `Claim.amount` carries NO `en` description at all,
  // so `expect(amountNl.description).toBe(amountEn.description)` compared `null` to `null` and
  // could never fail. Of the 133 seeded attributes exactly TWO have an `en` description
  // (`Claim.adjuster_notes`, `Claim.fraud_score`) and BOTH are translated — so no shipped row is a
  // valid fallback example any more, and for a while this file asserted the fallback while proving
  // nothing about it. A comment claiming coverage that does not exist is worse than the gap: it
  // stops the next reader from looking.
  //
  // So the example is INSERTED, not found — which is what the ⛔ in the previous version said to do.
  // It lives in its own (industry × department) cell so it cannot perturb any other test's graph,
  // and it is removed again in `finally`.
  const IND = '__i18n_fallback_probe__';
  const LABEL_EN = 'Fallback Probe';
  const DESC_EN = 'An English base column with no translation, on purpose.';
  const ATTR_DESC_EN = 'An English attribute description with no translation, on purpose.';

  const [row] = await db
    .insert(ontologyEntities)
    .values({
      scope: 'industry_dept',
      industry: IND,
      department: IND,
      name: 'FallbackProbe',
      label: LABEL_EN,
      synonyms: [],
      description: DESC_EN,
    })
    .returning({ id: ontologyEntities.id });
  try {
    await db.insert(ontologyAttributes).values({
      entity_id: row!.id,
      name: 'probe_field',
      type: 'string',
      synonyms: [],
      pii: false,
      description: ATTR_DESC_EN,
    });
    invalidateOntologyCache();

    const nl = await compileEffective(IND, IND, { locale: 'nl' });
    const probe = nl.entities.find((e) => e.name === 'FallbackProbe');
    expect(probe, 'the fixture entity did not reach the compiled graph').toBeDefined();

    // ⛔ ASSERTED AGAINST THE LITERAL ENGLISH TEXT, NEVER AGAINST THE en COMPILE. Comparing the nl
    // compile to the en compile is what made the previous version vacuous — two nulls agree. These
    // strings are non-empty by construction, so a fallback that returned null, '' or undefined
    // fails here.
    expect(probe!.label).toBe(LABEL_EN);
    expect(probe!.description).toBe(DESC_EN);
    const attr = probe!.attributes.find((a) => a.name === 'probe_field');
    expect(attr, 'the fixture attribute did not reach the compiled graph').toBeDefined();
    expect(attr!.description).toBe(ATTR_DESC_EN);

    // And the locale really was the overlaid path, not a short-circuit: `nl` is not DEFAULT_LOCALE,
    // so getTranslationsBatch ran and returned no rows for these keys.
    expect(nl.industry).toBe(IND);
  } finally {
    await db.delete(ontologyAttributes).where(eq(ontologyAttributes.entity_id, row!.id));
    await db
      .delete(ontologyEntities)
      .where(and(eq(ontologyEntities.id, row!.id), eq(ontologyEntities.industry, IND)));
    invalidateOntologyCache();
  }
});

test('compileEffective(locale=nl) localizes attribute descriptions + relation labels (3.7)', async () => {
  const en = await compileEffective('insurance', 'Claims', { locale: 'en' });
  const nl = await compileEffective('insurance', 'Claims', { locale: 'nl' });

  // Attribute description: the Claims-desk Claim's adjuster_notes.
  const claimNl = nl.entities.find((e) => e.name === 'Claim')!;
  const notesNl = claimNl.attributes.find((a) => a.name === 'adjuster_notes')!;
  expect(notesNl.description).toBe('Vrije triage-/onderzoeksnotities.');
  // A relation label is localized (Claim —under→ Policy = "filed under" → nl).
  const underNl = nl.relations.find((r) => r.from === 'Claim' && r.to === 'Policy' && r.predicate === 'under')!;
  expect(underNl.label).toBe('ingediend onder');

  // Predicate stays canonical en — only display prose moves.
  expect(underNl.predicate).toBe('under');

  // ⛔ AN `expect(amountNl.description).toBe(amountEn.description)` USED TO SIT HERE AS THE
  // "fallback" proof. It was vacuous: `Claim.amount` has no `en` description, so it compared null
  // to null and could not fail. Removed rather than repaired — the fallback is proven above, on an
  // inserted fixture whose English text is non-empty by construction. Kept as a marker so nobody
  // re-adds an en-vs-nl comparison on a field that is null in both.
  const amountNl = claimNl.attributes.find((a) => a.name === 'amount')!;
  expect(amountNl.description, 'Claim.amount has no en description — do not use it as a fallback example').toBeNull();
});

test('⛔ compileEffective(locale=nl) localizes the HIDDEN list, not just `entities`', async () => {
  // ⛔ THE DEFECT, AND IT IS A CONTRADICTION VISIBLE IN ONE SCREENSHOT. `hidden[]` is built from
  // the raw `g.label` — the en base column — while `entities` goes through `localizeEntityLabels`.
  // /ontology renders the two on the SAME screen: the graph nodes, and the "Verborgen" chip row
  // beneath them (+page.svelte). So a Dutch admin read the chip "Adjuster" six pixels under a graph
  // whose every node read Dutch, for the SAME entity — and the chip is the ONLY place a tombstoned
  // entity appears at all, so the label they were deciding whether to unhide was the one label the
  // overlay never reached.
  //
  // Exercised through `hideGlobalEntity`, the real route handler's own service call, so the fixture
  // is a tombstone of the shape production writes rather than a hand-built row that might not be.
  const ORG = '00000000-0000-0000-0000-00000e18a001';
  const en = await compileEffective('insurance', 'Claims', { locale: 'en' });
  const adjusterEn = en.entities.find((e) => e.name === 'Adjuster');
  // ⛔ NON-VACUITY FIRST. Every assertion below reads `hidden[0]`. If the seed stopped shipping
  // `Adjuster` into this cell, `hidden` would be empty and a `not.toBe('Adjuster')` written the
  // lazy way would pass against nothing at all.
  expect(adjusterEn, 'the seed no longer puts Adjuster in insurance/Claims').toBeDefined();
  expect(adjusterEn!.label).toBe('Adjuster');

  await db.insert(tenants).values({
    id: ORG,
    name: 'I18n Hidden Co',
    slug: 'i18n-hidden-co',
    industry: 'insurance',
  });
  try {
    await hideGlobalEntity(ORG, adjusterEn!.id);
    invalidateOntologyCache();

    const nl = await compileEffective('insurance', 'Claims', { tenantId: ORG, locale: 'nl' });
    expect(nl.hidden, 'the tombstone did not reach hidden[]').toHaveLength(1);
    const chip = nl.hidden[0]!;
    expect(chip.name, 'the canonical NAME is the wire key and must stay en').toBe('Adjuster');
    // ⛔ THE ASSERTION THAT INVERTS ON A REVERT. The overlay's own word, asserted as a literal
    // rather than against another compile — comparing nl to en is how a null-vs-null pair passes.
    expect(chip.label).toBe('Schade-expert');

    // …and the chip now agrees with the graph the reader is looking at. This is the actual ask:
    // ONE word per entity per screen. (Adjuster itself is filtered OUT of `entities` while hidden,
    // so the agreement is asserted against the en→nl mapping the graph uses, not a live node.)
    expect(chip.label).not.toBe(adjusterEn!.label);

    // The default locale is untouched — `hidden[]` keeps the base column, no overlay, no query.
    const enHidden = await compileEffective('insurance', 'Claims', { tenantId: ORG, locale: 'en' });
    expect(enHidden.hidden).toHaveLength(1);
    expect(enHidden.hidden[0]!.label).toBe('Adjuster');

    // A locale with NO seeded translation for this entity falls back to the en base column rather
    // than to an empty chip — a blank chip reads as an entity the page could not load.
    const he = await compileEffective('insurance', 'Claims', { tenantId: ORG, locale: 'he' });
    expect(he.hidden).toHaveLength(1);
    expect(he.hidden[0]!.label.length, 'the chip went blank in a locale with no row').toBeGreaterThan(0);
  } finally {
    await db.delete(ontologyEntities).where(eq(ontologyEntities.tenant_id, ORG));
    await db.delete(tenants).where(eq(tenants.id, ORG));
    invalidateOntologyCache();
  }
});
