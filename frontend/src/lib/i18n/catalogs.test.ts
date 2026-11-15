// src/lib/i18n/catalogs.test.ts — §5B guard: every locale catalog must carry the
// exact same key set as the base (en) catalog, so no screen falls back to a raw
// key. Values may be English placeholders (framework-first); only keys are checked.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { NAV_GROUPS, NAV_ITEMS } from '$lib/layout/navConfig';
// The repo's source-tree walker — `$lib/test/number-sites` owns it because the number inventory
// needed it first; it is a generic `sourceFiles()`/`rel()` pair, not a number-specific one.
import { sourceFiles, rel } from '$lib/test/number-sites';
import { stripComments } from '$lib/test/source-scan';
import { resolve } from 'node:path';

const LOCALES = ['en', 'nl', 'pl', 'fr', 'es', 'de', 'ar', 'he'] as const;
const dir = resolve(process.cwd(), 'messages');

function keysOf(locale: string): string[] {
  const obj = JSON.parse(readFileSync(resolve(dir, `${locale}.json`), 'utf8'));
  return Object.keys(obj).filter((k) => k !== '$schema').sort();
}

describe('i18n catalogs', () => {
  const enKeys = keysOf('en');

  it('has the 8 SPEC §5B locales', () => {
    expect([...LOCALES]).toHaveLength(8);
  });

  it('en carries the full UI string set', () => {
    expect(enKeys.length).toBeGreaterThan(500);
  });

  for (const locale of LOCALES) {
    it(`${locale}.json has exactly the en key set`, () => {
      expect(keysOf(locale)).toEqual(enKeys);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────
  // ⛔ THE SIDEBAR'S GROUP HEADINGS MUST BE DISTINGUISHABLE *WITHIN* A LOCALE.
  //
  // Key parity above cannot see this class at all: every locale had all three keys, and every
  // value was a real translation. `nl` nonetheless rendered TWO IDENTICAL HEADINGS — both
  // `nav_group_operate` and `nav_group_administer` were "Beheren" — so the Dutch sidebar showed
  // "BEHEREN" twice, over two different groups, on every screen in the product. Dutch is the
  // demo language; this was measured in the browser (walk 2026-08-15), not inferred.
  //
  // It is the same shape as the placeholder-parity guard: a per-locale INTERNAL consistency rule
  // that a cross-locale key comparison is structurally blind to. `Beheren` is a perfectly good
  // translation of BOTH words in isolation — which is exactly why a translator, and a reviewer
  // reading one key at a time, would never catch it.
  //
  // ⚠️ Deliberately scoped to the three NAV GROUP headings rather than "all values must be
  // unique". Duplicate values elsewhere are legitimate and common (a noun reused as a column
  // header and a filter label). These three are different: they are rendered SIMULTANEOUSLY, as
  // siblings, as the only thing distinguishing one region of the sidebar from another.
  //
  // ⛔ DERIVED FROM `navConfig.ts`, NOT HAND-LISTED. The first version hard-coded the three keys and
  // its own comment named "a fourth group silently escaping it" as the failure mode to watch for —
  // which documents a hole instead of closing it. `NAV_GROUPS` is the real source of truth, so a
  // fourth group is guarded the moment it exists.
  const NAV_GROUP_KEYS = NAV_GROUPS.map((g) => g.labelKey);

  it('the nav config exposes the groups this guard is about', () => {
    // Non-vacuity: an empty list would make every per-locale assertion below trivially true.
    expect(NAV_GROUP_KEYS.length).toBeGreaterThan(2);
    expect(NAV_GROUP_KEYS).toContain('nav_group_operate');
  });

  for (const locale of LOCALES) {
    it(`${locale}.json gives each sidebar group a distinct heading`, () => {
      const obj = JSON.parse(readFileSync(resolve(dir, `${locale}.json`), 'utf8'));
      // ⚠️ NORMALIZED, BECAUSE THE SIDEBAR UPPERCASES THESE (`app.css` `.nav-group-label`,
      // `text-transform: uppercase`). Adversarial review defeated the raw comparison twice — each
      // leaving "BEHEREN" over BOTH groups on screen with this file 18/18 green:
      //     nav_group_operate: "beheren"    → PASSED
      //     nav_group_operate: "Beheren "   → PASSED
      // What the reader sees is the trimmed, uppercased form, so that is what must be distinct.
      const headings = NAV_GROUP_KEYS.map((k) => String(obj[k] ?? '').trim().toUpperCase());
      // Every key must actually exist — a missing one would collapse to `''` and make the
      // uniqueness check pass for the wrong reason (two blanks are caught, but one is not).
      for (const [i, k] of NAV_GROUP_KEYS.entries()) {
        expect(obj[k], `${locale}.${k} is missing`).toBeTypeOf('string');
        expect(headings[i], `${locale}.${k} is blank`).not.toBe('');
      }
      expect(new Set(headings).size, `${locale} renders duplicate sidebar group headings: ${headings.join(' / ')}`).toBe(
        NAV_GROUP_KEYS.length,
      );
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────
  // ⛔ AN EYEBROW MUST NOT NAME A SIDEBAR REGION THE PAGE IS NOT IN — the SECOND defect the group
  // rename above left behind, and the guard directly under it could not see it.
  //
  // The rename that fixed the duplicate "BEHEREN" headings gave `nav_group_operate` = "Bedienen"
  // and `nav_group_administer` = "Beheren". It did not touch `itdash_eyebrow`, which still read
  // "Platform · Beheer" — the noun of the group /it-dash is NOT in. So a Dutch reader was told, at
  // the top of the page, to look for it under the wrong heading. Both guards above stayed green:
  // key parity sees a present, non-empty, perfectly-translated string, and the uniqueness check
  // reads the three group labels and nothing else. Nothing in the repo related an eyebrow to a nav
  // group at all.
  //
  // ⛔ WHAT IS ASSERTED IS "NOT A FOREIGN REGION", NOT "IS ITS OWN REGION", and that asymmetry is
  // measured rather than chosen. `itdash_eyebrow` shares a stem with its group label in five of the
  // eight catalogs (en Operations/Operate, nl Bediening/Bedienen, es Operaciones/Operar, de
  // Betrieb/Betreiben, he תפעול/תפעול) and in three it legitimately does not: fr says "Opérations"
  // under a group called "Exploiter", ar "العمليات" under "تشغيل", pl "Operacje" under "Zarządzaj".
  // Those are synonyms, not misdirection — they point at no region, which costs the reader nothing.
  // Demanding a stem match would red three good translations to catch one bad one, and would be
  // "fixed" by inventing copy. The harm is only ever CLAIMING THE WRONG REGION.
  //
  // ⚠️ THE 4-CHARACTER THRESHOLD IS THE MEASURED SEPARATION AND THE MARGIN IS ONE CHARACTER. Across
  // every eyebrow × every locale × every group in the tree: the largest overlap with a FOREIGN group
  // is 3 (nl "Ontologie" vs "Ontdekken" — a coincidence of spelling) and the smallest overlap with
  // its OWN group is 4 (de "Betrieb" vs "Betreiben"). The defect this exists for sat at exactly 4
  // the wrong way: "Beheer" vs "Beheren" is 4, against 2 for "Bedienen". Both ends are pinned as
  // assertions below, READ OUT OF THE LIVE CATALOGS, so a future edit that narrows the margin reds
  // here with this paragraph attached instead of quietly turning the threshold into a rubber stamp.
  //
  // ⛔⛔ AND THE THRESHOLD IS SPENT BEFORE IT STARTS IN ARABIC, WHICH MADE THIS GUARD A TRAP.
  // `overlap()` is a common PREFIX, and every Arabic definite noun opens with the article `ال`.
  // `nav_group_administer` is "الإدارة", so any noun beginning "الإد…" is handed 4 free characters
  // and trips the threshold on spelling alone. Adversarial review supplied a perfectly ordinary
  // translation — `datasets_eyebrow` = "المنصة · الإدخال" ("Platform · Input") on an operate page —
  // and this guard reported it as claiming the ADMINISTER region. That is the precise outcome the
  // paragraph above says the design avoids, and it would have fired on the next Arabic pass, on
  // copy that was never wrong. The shipped strings already sit at the ceiling: "الإرسال" vs
  // "الإدارة" is 3, one below the threshold, and it is the widest foreign overlap in the tree.
  //
  // So the article is normalized away before comparing, for exactly the reason case is: it is a
  // bound morpheme carrying no lexical content, and leaving it in compares grammar instead of
  // meaning. After normalization "الإدخال"/"الإدارة" is 2 and "الإرسال"/"الإدارة" is 1.
  //
  // ⚠️ HEBREW'S `ה` IS DELIBERATELY LEFT ALONE, and the asymmetry is not an oversight. Arabic's
  // article is dangerous because BOTH strings carry it, so it donates a shared prefix. Hebrew's is a
  // single character in position 0, so a definite noun compared against an indefinite group label
  // diverges at once and scores 0 — it can only ever cause a MISS, never a false claim, which is the
  // safe direction for a guard whose entire job is to not cry wolf. Stripping it would create the
  // shared-prefix problem rather than remove one.
  //
  // ⛔ THE EYEBROW→GROUP MAP IS DERIVED FROM THE ROUTES, NOT HAND-LISTED — the lesson the block
  // above already records ("a fourth group silently escaping it"). The keys are read off the
  // `m.<…>eyebrow…()` calls in `routes/**/+page.svelte`, and the route's own path is matched to a
  // `NAV_ITEMS` href. A new screen with a new eyebrow is therefore guarded the day it is written.
  const NAV_GROUP_BY_HREF = new Map(NAV_ITEMS.map((i) => [i.href, i.group]));

  /** Strip what grammar adds and meaning does not: letter case, and the Arabic article `ال`. */
  const stem = (s: string): string => s.trim().toLowerCase().replace(/^ال/, '');

  /** Longest common prefix of two stems — "how much of the same word is this?". */
  const overlap = (a: string, b: string): number => {
    const x = stem(a);
    const y = stem(b);
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i++;
    return i;
  };
  const MIN_OVERLAP = 4;

  /** The group labels in `locale` that an eyebrow VALUE lays claim to, by segment. */
  function regionsClaimed(value: string, obj: Record<string, unknown>): string[] {
    const claimed = new Set<string>();
    // Eyebrows are "Area · Topic"; each side is judged on its own, because only one of them is
    // ever the region word and which one it is differs by screen.
    for (const seg of value.split('·').map((s) => s.trim()).filter(Boolean))
      for (const g of NAV_GROUPS)
        if (overlap(seg, String(obj[g.labelKey] ?? '')) >= MIN_OVERLAP) claimed.add(g.group);
    return [...claimed];
  }

  /** Every `m.…eyebrow…()` rendered by a route, with the nav group that route belongs to. */
  const EYEBROWS = (() => {
    const out = new Map<string, { file: string; group: string | undefined }>();
    for (const abs of sourceFiles(/\+page\.svelte$/)) {
      const file = rel(abs);
      if (!file.startsWith('routes/')) continue;
      // `routes/(tenant)/usage/+page.svelte` → `/usage`: SvelteKit group segments are not URL.
      const href =
        '/' +
        file
          .slice('routes/'.length)
          .replace(/\+page\.svelte$/, '')
          .replace(/\([^)]*\)\//g, '')
          .replace(/\/$/, '');
      // ⛔ COMMENTS STRIPPED — this scan borrowed `sourceFiles`/`rel` from `number-sites.ts` and
      // forgot the third thing that module never scans without. Adversarial review added ONE line
      // to `routes/challenges/[id]/+page.svelte`:
      //     // TODO: this page should get its own m.challenge_detail_eyebrow() header …
      // and the suite went to 9 failed / 21 passed, reporting `en.challenge_detail_eyebrow is
      // missing or blank` for a key nobody ever meant to create. A guard that a TODO can red, with
      // a message that sends the reader after a non-existent key, is a guard that gets deleted.
      for (const m of stripComments(readFileSync(abs, 'utf8')).matchAll(/\bm\.([A-Za-z0-9_]*eyebrow[A-Za-z0-9_]*)\(/g))
        out.set(m[1]!, { file, group: NAV_GROUP_BY_HREF.get(href) });
    }
    return out;
  })();

  it('the eyebrow scan read the real routes and mapped every one to a nav group', () => {
    // ⛔ NON-VACUITY. The per-locale assertion below is a `toEqual([])` on a filtered list — the
    // exact shape that passes when the scan reads nothing. So the scan's OUTPUT is asserted first:
    // it found the eyebrows, it found the one this guard exists for, and — the part that actually
    // rots — every key it found resolved to a real group. An unresolved route would otherwise make
    // that page's eyebrow unguardable while the suite stayed green.
    expect(EYEBROWS.size, 'the eyebrow scan found nothing — its whole point').toBeGreaterThan(15);
    expect([...EYEBROWS.keys()]).toContain('itdash_eyebrow');
    expect(EYEBROWS.get('itdash_eyebrow')?.group).toBe('operate');
    const unmapped = [...EYEBROWS.entries()].filter(([, v]) => v.group === undefined).map(([k, v]) => `${k} (${v.file})`);
    expect(unmapped, 'an eyebrow’s route does not match any NAV_ITEMS href — it cannot be guarded').toEqual([]);
  });

  it('⛔ the detector still fires on the Dutch string that shipped', () => {
    // The regression itself, as a fixture: "Platform · Beheer" under nl's post-rename group labels
    // must be read as a claim on `administer`. Without this, the whole guard below is satisfied by
    // an `overlap()` that always returns 0.
    const nl = JSON.parse(readFileSync(resolve(dir, 'nl.json'), 'utf8'));
    expect(regionsClaimed('Platform · Beheer', nl)).toEqual(['administer']);
    // …and the fix points at the right one, rather than merely at nothing. Asserted for nl only:
    // it is the demo language, it is the one that broke, and it is one of the five catalogs where
    // the eyebrow and the group label share a stem at all (see the paragraph above).
    expect(regionsClaimed(String(nl.itdash_eyebrow), nl)).toEqual(['operate']);
  });

  it('⛔ an ordinary Arabic noun does not read as a region — the article is normalized away', () => {
    // The false red this guard shipped with, as a fixture. "المنصة · الإدخال" is a plain
    // translation of "Platform · Input"; before `stem()` stripped the article it scored 4 against
    // "الإدارة" and reported an operate page as claiming the administer region.
    const ar = JSON.parse(readFileSync(resolve(dir, 'ar.json'), 'utf8'));
    expect(regionsClaimed('المنصة · الإدخال', ar)).toEqual([]);
    // ⛔ ASSERTED IN BOTH DIRECTIONS, because "it returns []" is also what a broken `overlap()`
    // returns. The raw prefix really did reach the threshold, and the stem really does not.
    const rawOverlap = (a: string, b: string) => {
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return i;
    };
    expect(rawOverlap('الإدخال', String(ar.nav_group_administer))).toBeGreaterThanOrEqual(MIN_OVERLAP);
    expect(overlap('الإدخال', String(ar.nav_group_administer))).toBeLessThan(MIN_OVERLAP);
  });

  it('⛔ the 4-character threshold still separates a synonym from a misdirection', () => {
    // ⛔⛔ READ OUT OF THE CATALOGS, NOT HARD-CODED — the first version of this test pinned the
    // STRING `'Betrieb'`, so it asserted a fact about a literal rather than about the shipped copy.
    // Adversarial review changed `de.itdash_eyebrow` to "Plattform · Ops", destroying German's only
    // own-group match, and this file stayed 30 passed / 0 failed while claiming in its own comment
    // that "a future catalog edit that narrows it reds HERE". It did not. It does now.
    //
    // ⚠️ AND THIS IS WHERE THE GUARD'S REAL REACH IS WRITTEN DOWN. Across all 24 eyebrows × 8
    // locales, exactly ONE key ever produces an own-group match: `itdash_eyebrow`, in 5 of the 8.
    // The other 23 name their page's own topic ("Platform · Audit log") and score 0–3 against every
    // group in every locale. So this guard is not a broad net — it is a tripwire on the single
    // eyebrow in the product that names a REGION, plus a standing check that none of the other 23
    // ever starts claiming one. That is worth having, and it is worth not overstating.
    const cat = Object.fromEntries(
      LOCALES.map((l) => [l, JSON.parse(readFileSync(resolve(dir, `${l}.json`), 'utf8'))]),
    );
    const own = (l: string) =>
      Math.max(
        ...String(cat[l].itdash_eyebrow)
          .split('·')
          .map((s) => overlap(s, String(cat[l].nav_group_operate))),
      );
    // The five catalogs whose eyebrow shares a stem with its group label, and the three that
    // legitimately use a synonym. Both halves asserted: a translator who breaks the first, or
    // "fixes" the second by inventing copy, reds here and re-reads the reasoning above.
    for (const l of ['en', 'nl', 'es', 'de', 'he'])
      expect(own(l), `${l}.itdash_eyebrow no longer echoes its own nav group ("${cat[l].nav_group_operate}")`).toBeGreaterThanOrEqual(MIN_OVERLAP);
    for (const l of ['ar', 'fr', 'pl'])
      expect(own(l), `${l}.itdash_eyebrow now echoes its nav group — good, but move it to the list above`).toBeLessThan(MIN_OVERLAP);
    // The tightest TRUE match in the tree (de) and the widest FALSE one (nl Ontologie/Ontdekken).
    // If a catalog edit ever makes these two meet, the threshold has stopped discriminating.
    expect(own('de')).toBe(MIN_OVERLAP);
    expect(overlap('Ontologie', String(cat.nl.nav_group_discover))).toBeLessThan(MIN_OVERLAP);
  });

  for (const locale of LOCALES) {
    it(`${locale}.json points no eyebrow at a sidebar region its page is not in`, () => {
      const obj = JSON.parse(readFileSync(resolve(dir, `${locale}.json`), 'utf8'));
      const misdirected: string[] = [];
      for (const [key, { group }] of EYEBROWS) {
        const value = String(obj[key] ?? '');
        expect(value, `${locale}.${key} is missing or blank`).not.toBe('');
        for (const claimed of regionsClaimed(value, obj))
          if (claimed !== group)
            misdirected.push(`${key} = "${value}" reads as the "${obj[`nav_group_${claimed}`]}" group, but its page is in "${group}"`);
      }
      expect(misdirected, `${locale} sends a reader to the wrong part of the sidebar`).toEqual([]);
    });
  }
});
