// tests/seed-ontology-tenant-locales.test.ts — the demo tenant's own ontology entity must be
// readable in EVERY locale this product ships, not just the ones it was demoed in.
//
// ⛔ THE DEFECT THIS PINS, measured against the PRODUCTION database rather than inferred.
// `seed-ontology-tenant.ts` seeded `BrokerNote`'s label and description in `nl` and `de` only, under
// a comment that described itself as "a couple of locales … so `?locale=nl` shows a localized
// *custom* object" — an honest Phase 3.7 proof-of-concept that then stayed. Counting
// `content_translations` in prod:
//
//     nl | 350 rows | 9 entity types        ar | 346 rows | 8 entity types
//     de | 350 rows | 9 entity types        he | 346 rows | 8 entity types
//                                           es/fr/pl | 346 | 8
//
// The whole difference was this one entity: `ontology_entity_tenant`, fields `label` and
// `description` = 4 rows, present for nl/de and absent for the other five. (Those 4 span two
// entity_ids but only ONE live tenant; the second id belongs to a tenant no longer in `tenants`
// and is never read — see migrations/0082_broker_note_all_locales.sql.) It was the ONLY place in
// the entire corpus where two locales carried content the rest did not. An Arabic or Hebrew reader browsing the demo org's ontology got the English "Broker Note"
// while a Dutch reader got theirs — and Arabic and Hebrew are primary markets.
//
// ⚠️ WHY A DERIVED SET AND NOT A LISTED ONE. The bug was not that someone chose the wrong two
// locales; it was that the set was hand-written, so it could not notice the product growing past
// it. Deriving from `SUPPORTED_LOCALES` means a ninth locale fails HERE, with a message naming the
// gap, instead of silently reproducing the same English fallback for the newcomer.
import { describe, it, expect } from 'bun:test';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from '../src/utils/locale';
import { BROKER_NOTE_I18N } from '../src/db/seed-ontology-tenant';

const REQUIRED = SUPPORTED_LOCALES.filter((l) => l !== DEFAULT_LOCALE);

describe('tenant ontology demo entity is localized everywhere', () => {
  it('covers every shipped locale except the base', () => {
    const seeded = BROKER_NOTE_I18N.map((r) => r.locale).sort();
    const missing = REQUIRED.filter((l) => !seeded.includes(l));
    expect(
      missing,
      'BrokerNote has no translation for these locales, so their readers get the English base ' +
        'while nl/de readers get theirs — the exact gap this file exists to close.',
    ).toEqual([]);
    expect(seeded).toEqual([...REQUIRED].sort());
  });

  // ⛔ `en` must NOT appear. `getTranslationsBatch` short-circuits the base locale and returns an
  // empty map, so an `en` row here is unreachable by construction — it would read as coverage while
  // doing nothing, which is worse than an obvious gap.
  it('does not seed the base locale', () => {
    expect(BROKER_NOTE_I18N.map((r) => r.locale)).not.toContain(DEFAULT_LOCALE);
  });

  // Non-vacuity plus the thing a coverage check alone misses: a row that exists but is blank.
  // The service overlay treats blank as absence (`if (typeof v !== 'string' || v.trim() === '')
  // continue;`), so an empty string is an English fallback wearing a translation's clothes.
  it('every entry carries real label and description text', () => {
    expect(BROKER_NOTE_I18N.length).toBe(REQUIRED.length);
    for (const row of BROKER_NOTE_I18N) {
      expect(row.label.trim(), `${row.locale} label is blank`).not.toBe('');
      expect(row.description.trim(), `${row.locale} description is blank`).not.toBe('');
    }
  });

  // And that they are not just the English pasted in — the failure mode where a catalog looks
  // complete and reads identically.
  it('no entry is the untranslated English', () => {
    const english = { label: 'Broker Note', description: "A broker's note attached to a claim" };
    for (const row of BROKER_NOTE_I18N) {
      expect(row.label, `${row.locale} label is still the English`).not.toBe(english.label);
      expect(row.description.startsWith(english.description), `${row.locale} description is still the English`).toBe(false);
    }
  });
});
