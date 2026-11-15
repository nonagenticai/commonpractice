// tests/locale-negotiation.test.ts — THE DEFECT, at the surface it happens on: `GET /api/me`
// answering `en` to a Dutch browser.
//
// ⛔ WHY THIS FILE EXISTS SEPARATELY FROM `locale.test.ts`. That file already covers
// `negotiateLocale` as a PURE FUNCTION — `negotiateLocale(req, null)` → `ar` — and it passed for
// the entire life of the bug. It could not fail: it hands the negotiator a `null` that the
// database was structurally incapable of producing. `users.locale` was `NOT NULL DEFAULT 'en'`
// (0009), so `routes/me.ts`'s `negotiateLocale(req, row?.locale)` ALWAYS received a supported
// string, and `utils/locale.ts` returns a supported `userPref` immediately — the Accept-Language
// loop underneath was unreachable for every user that existed. A green unit test on an argument
// no caller can ever pass is exactly the shape that let a Dutch reader, on a Dutch browser, in a
// Dutch insurance workspace, be served an English UI.
//
// So every case here goes through the ROUTE, against a REAL ROW, with a REAL `Accept-Language`
// header — the three things the unit test replaces with a literal.
//
// THE RED, PRECISELY. Two different shapes, deliberately:
//   • The structural case fails on the CATALOG (`is_nullable = 'NO'`, `column_default = ''en''`) —
//     the root cause, stated where it lives.
//   • The behavioural cases fail on the ANSWER: `Expected: "nl" / Received: "en"`. That is the bug
//     as a Dutch reader experienced it, and it is why `clearStoredPreference()` below SWALLOWS the
//     not-null violation instead of letting it abort the test. A red that reads "23502" describes
//     a schema; a red that reads "you sent nl-NL and got en" describes the defect.
//
// MEASURED, so nobody has to take the above on trust: with the behaviour reverted (column back to
// NOT NULL DEFAULT 'en', schema.ts back to `.notNull().default('en')`) this file runs 4 fail / 2
// pass; with 0081 applied, 6 pass. ⚠️ THE TWO THAT PASS ON BOTH SIDES ARE NOT WITNESSES AND ARE
// NOT CLAIMED TO BE:
//   • the CONTROL ("an explicit preference still wins") — green on both sides BY DESIGN, because
//     that is what proves the fix opened a fall-through rather than demoting the stored preference;
//   • "no header at all → en" — green on both sides for an uninteresting reason: pre-0081 the
//     route answered `en` to everything, so it was right by accident. It is kept because it pins
//     the contract the frontend depends on (`/api/me` NEVER answers a null locale), which a
//     nullable column could plausibly have broken. Judge the fix on the other four.
import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { eq, sql, getTableColumns } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerMeRoutes } from '../src/routes/me';
import { db, users } from '../src/db/client';
import type { User } from '../src/types';

const UID = '00000000-0000-0000-0000-00000c10ca27';
const user: User = { id: UID, email: 'negotiate@test', name: 'Neg Otiate', roles: ['employee'] };

const router = new Router();
registerMeRoutes(router);

/** `GET /api/me` with an explicit header set — `locale.test.ts`'s helper cannot send one. */
async function getMe(headers?: Record<string, string>) {
  const matched = router.match('GET', '/api/me');
  if (!matched) throw new Error('no route for GET /api/me');
  const req = new Request('http://localhost/api/me', { method: 'GET', headers });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function patchLocale(locale: string) {
  const matched = router.match('PATCH', '/api/me/locale');
  if (!matched) throw new Error('no route for PATCH /api/me/locale');
  const req = new Request('http://localhost/api/me/locale', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ locale }),
  });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** Pin an EXPLICIT preference — the state that has always been representable. */
async function setStoredLocale(locale: string) {
  await db.update(users).set({ locale }).where(eq(users.id, UID));
}

/**
 * Put the row into "this person has never expressed a preference" — the state 0081 created.
 *
 * ⛔ THE `catch` IS NOT DEFENSIVE PADDING; REMOVING IT CHANGES WHAT THE REDS SAY. On a pre-0081
 * database this UPDATE raises `23502 null value in column "locale" violates not-null constraint`,
 * and an uncaught raise makes every case below fail identically inside `beforeEach` — including
 * the CONTROL, which is supposed to be green on both sides. Swallowing it leaves the row on the
 * column default ('en'), which is EXACTLY the production state being reproduced: a user who never
 * chose anything, holding 'en' because the schema had no other option. The behavioural tests then
 * fail on the answer they got rather than on the arrange step, and name the defect instead of the
 * schema. It is narrowed to that one SQLSTATE so a genuine write failure still surfaces.
 *
 * ⚠️ THE SQLSTATE IS ON THE `cause`, NOT ON THE ERROR. Drizzle wraps every driver error in a
 * `DrizzleQueryError` that carries the SQL text and the params but NO `code`, so the obvious
 * `err.code === '23502'` matches nothing and rethrows every time — which silently restores the
 * uninformative red this helper exists to avoid. Walk the cause chain.
 */
function sqlStateOf(err: unknown): string | undefined {
  for (let e: unknown = err, hops = 0; e && hops < 5; e = (e as { cause?: unknown }).cause, hops++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

async function clearStoredPreference() {
  try {
    await db.update(users).set({ locale: null }).where(eq(users.id, UID));
  } catch (err) {
    if (sqlStateOf(err) !== '23502') throw err;
    // ⛔ AND THE FALLBACK MUST WRITE 'en', NOT GIVE UP. A bare swallow leaves the row holding
    // whatever the PREVIOUS test pinned, so on a pre-0081 database the cases below would pass or
    // fail on each other's leftovers rather than on the defect — one of them went green that way.
    // 'en' is the column default, i.e. precisely what a pre-0081 user who never chose anything
    // holds. Reproduce that state faithfully or the red is not evidence of anything.
    await db.update(users).set({ locale: 'en' }).where(eq(users.id, UID));
  }
}

async function storedLocale(): Promise<string | null | undefined> {
  const [row] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, UID));
  return row?.locale;
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks (see locale.test.ts).
beforeAll(async () => {
  __setAuthOverridesForTests({ validateAuth: async () => user, requireRole: async () => user });
  // Deliberately WITHOUT a locale: this is the shape `ensureUser`'s `upsertRow` and
  // `provisioning.upsertLocalUserTx` both write — neither of them touches this column. Post-0081
  // that lands a NULL; pre-0081 the column default silently filled in 'en', which is the whole
  // defect and the reason the arrange step below is explicit rather than trusting the insert.
  await db
    .insert(users)
    .values({ id: UID, email: user.email, name: user.name })
    .onConflictDoNothing({ target: users.id });
}, 30_000);

beforeEach(async () => {
  await clearStoredPreference();
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  await db.delete(users).where(eq(users.id, UID));
}, 30_000);

test('⛔ users.locale can represent "no preference" at all', async () => {
  // The structural precondition for every behavioural case below. Asserted against the LIVE
  // catalog rather than schema.ts, because schema.ts is a TypeScript description of the database
  // and the database is what `me.ts` reads. Before 0081: is_nullable = 'NO', column_default =
  // "'en'::text" — and no amount of route logic could have reached the negotiator.
  const rows = await db.execute(sql`
    SELECT is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'locale'
  `);
  const col = (rows as unknown as Array<{ is_nullable: string; column_default: string | null }>)[0];
  expect(col).toBeDefined();
  expect(col!.is_nullable).toBe('YES');
  expect(col!.column_default).toBeNull();
  // And the row we provisioned WITHOUT a locale is genuinely unset, not defaulted to English.
  expect(await storedLocale()).toBeNull();
});

test('no stored preference + a Dutch browser → GET /api/me negotiates nl', async () => {
  const r = await getMe({ 'accept-language': 'nl-NL,nl;q=0.9' });
  expect(r.status).toBe(200);
  // ⛔ The literal defect. This answered 'en' for every user in production.
  expect(r.json.locale).toBe('nl');
});

test('no stored preference + a German browser → de (the header is READ, not pattern-matched to nl)', async () => {
  // The second locale matters: a fix that hard-coded the demo locale would pass the case above and
  // fail here, and the two together are what make "negotiated" a defensible word.
  const r = await getMe({ 'accept-language': 'de' });
  expect(r.status).toBe(200);
  expect(r.json.locale).toBe('de');
});

test('CONTROL — an explicit stored preference still beats the browser', async () => {
  // Green before AND after 0081, on purpose. Its job is to prove the fix opened a fall-through
  // rather than demoting the stored preference to a hint: a Dutch user on a borrowed English
  // laptop must still get Dutch.
  await setStoredLocale('nl');
  const r = await getMe({ 'accept-language': 'en-US,en;q=0.9' });
  expect(r.status).toBe(200);
  expect(r.json.locale).toBe('nl');
});

test('no stored preference + no Accept-Language header at all → en (the base fallback)', async () => {
  // The contract `routes/me.ts` and the frontend both depend on: `/api/me` ALWAYS answers a
  // concrete supported locale. A nullable column must not become a null in the response body —
  // `locale.init(auth.user?.locale)` would then leave the UI on whatever Paraglide guessed.
  const r = await getMe();
  expect(r.status).toBe(200);
  expect(r.json.locale).toBe('en');
});

test('PATCH /api/me/locale stores an explicit preference, and it survives a Dutch browser', async () => {
  // ⛔ 'en' SPECIFICALLY, because that is the value 0081's backfill treats as "never chosen" and
  // the one the old NOT NULL DEFAULT made impossible to actually pin. After a real user-driven
  // switch it must stick, and it must beat Accept-Language exactly like any other preference —
  // otherwise the backfill would have traded one unrepresentable state for another.
  expect((await getMe({ 'accept-language': 'nl' })).json.locale).toBe('nl'); // unset → negotiated
  const patched = await patchLocale('en');
  expect(patched.status).toBe(200);
  expect(patched.json.locale).toBe('en');
  expect(await storedLocale()).toBe('en');
  expect((await getMe({ 'accept-language': 'nl' })).json.locale).toBe('en'); // chosen → pinned
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Q-VALUE ORDERING — the branch THIS PR made reachable, so the branch this PR has to be right about
//
// ⛔ WHY THIS BLOCK IS PART OF THE SAME CHANGE. Until 0081 `/api/me` never reached the
// Accept-Language loop at all, so its ignoring `q` cost nothing there: `nl;q=0.1,de;q=0.9`
// returned `nl` — the client's LAST choice — and no user was affected. Making that loop reachable
// for every user who has never chosen a locale is a behaviour change, and shipping it while the
// newly-live parser mis-ranks its input would trade a fixed defect for a live one.
//
// ⚠️ AND IT WAS NEVER QUITE DEAD. `negotiateLocale(req)` (no stored preference) already ran on
// FOURTEEN other call sites — challenges, blocks, agent, marketplace-summary, datasets, search,
// ontology, solutions, templates. The mis-ranking was invisible there only because the SPA's
// `authFetch` sets Accept-Language to a SINGLE bare tag (`getLocale()`), which has no q to get
// wrong. Anything that does NOT go through authFetch — an MCP/agent client, a curl, a first paint
// before the locale runtime is ready (auth-fetch.ts's catch branch drops the header) — has always
// handed this parser a real browser header. So this is a fix to live code, not only to newly-live
// code.
//
// These run through GET /api/me on a row with NO stored preference, because that is the shape the
// rule now decides for.
//
// ⚠️ "EACH FAILS IF YOU REVERT THE q HANDLING" IS NOT TRUE, AND SAYING SO WOULD BE THE USUAL LIE.
// Reverting to the pre-PR source-order parser kills only TWO of the seven (11 pass / 2 fail) — the
// other five pass against it BY COINCIDENCE, because source order happens to agree with weighted
// order on their inputs. They are not weaker for that; they guard DIFFERENT wrong implementations,
// and the only honest way to grade them is one mutant per rule. Measured, 7 mutants / 7 killed:
//
//   q1  source-order-first (the pre-PR parser, q ignored)     → RANK, q=0 REFUSAL
//   q2  an absent q sorts LOWEST instead of highest           → ABSENT q means 1.0
//   q3  bare Number(raw), no q-value grammar check            → malformed q          (Number('')===0)
//   q4  q=0 merely ranked last instead of dropped             → q=0 REFUSAL
//   q5  * resolves to a real locale                           → * matches nothing
//   q6  tie broken in reverse source order                    → equal weights keep SOURCE order
//   q7  only the top-ranked tag considered                    → unsupported tag WALKED PAST, *
//
// Every test above is a witness for at least one; no mutant survived. Add a rule here, add a
// mutant for it, or the new case is decoration.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('q-values RANK the header — the last-listed language can be the chosen one', async () => {
  // ⛔ THE REGRESSION THIS WHOLE BLOCK EXISTS FOR. Source-order-first returns 'nl' here, which is
  // the language the client ranked lowest.
  expect((await getMe({ 'accept-language': 'nl;q=0.1,de;q=0.9' })).json.locale).toBe('de');
});

test('an ABSENT q means 1.0 — the highest weight, not the lowest', async () => {
  // The tempting inversion: "no q" reads like "no opinion", so a naive implementation sorts it to
  // the bottom and answers 'nl'. RFC 9110 §12.4.2 says an absent qvalue is 1.
  expect((await getMe({ 'accept-language': 'de,nl;q=0.9' })).json.locale).toBe('de');
});

test('an unsupported tag is WALKED PAST, not stopped on', async () => {
  // `xx` outranks `nl` (both default to 1.0, `xx` is first) but we do not serve it. The loop must
  // continue to the next candidate rather than give up and fall back to en.
  expect((await getMe({ 'accept-language': 'xx,nl' })).json.locale).toBe('nl');
});

test('q=0 is an explicit REFUSAL — the entry is dropped, not merely ranked last', async () => {
  // Ranking it last would still select it when nothing else matches, i.e. serve the client exactly
  // the language it said it could not accept.
  expect((await getMe({ 'accept-language': 'nl;q=0' })).json.locale).toBe('en');
  // …and with a real alternative present, the refusal must not win despite being listed first.
  expect((await getMe({ 'accept-language': 'nl;q=0,de' })).json.locale).toBe('de');
});

test('a malformed q is treated as 1.0, and never throws', async () => {
  // ⚠️ THE DOCUMENTED JUDGEMENT CALL (utils/locale.ts): an unreadable q means we do not know HOW
  // STRONGLY, not that the language was not asked for. So `nl` keeps weight 1.0 and beats de@0.9.
  // ⛔ The specific trap: `Number('') === 0`, so a `Number()`-based parse reads the malformed `q=`
  // as the one value that means REFUSAL and silently discards a language the client did list.
  expect((await getMe({ 'accept-language': 'nl;q=abc,de;q=0.9' })).json.locale).toBe('nl');
  expect((await getMe({ 'accept-language': 'nl;q=,de;q=0.9' })).json.locale).toBe('nl');
  expect((await getMe({ 'accept-language': 'nl;q=-1,de;q=0.9' })).json.locale).toBe('nl');
});

test('* matches no locale', async () => {
  // Resolving the wildcard to "any locale we have" would hand an arbitrary language to a client
  // that expressed no preference. It falls through to the base fallback…
  expect((await getMe({ 'accept-language': '*' })).json.locale).toBe('en');
  // …and, ranked first at 1.0, must not shadow a real tag behind it.
  expect((await getMe({ 'accept-language': '*,nl;q=0.5' })).json.locale).toBe('nl');
});

test('equal weights keep SOURCE order', async () => {
  // The tiebreaker is explicit in the parser rather than left to sort stability; assert it, or a
  // future rewrite could reorder ties without anything noticing.
  expect((await getMe({ 'accept-language': 'fr;q=0.5,es;q=0.5' })).json.locale).toBe('fr');
  expect((await getMe({ 'accept-language': 'es;q=0.5,fr;q=0.5' })).json.locale).toBe('es');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SCHEMA ↔ MIGRATION AGREEMENT — a RUNTIME guard, because the one that existed was an accident
//
// ⛔ THE HOLE THIS FILLS, MEASURED. Revert `schema.ts` to `.notNull().default('en')` while leaving
// migration 0081 applied — the "half-reverted" mutant, and the likeliest real-world shape of this
// drift, because a rebase or a bad merge resolves one file and not the other. Before this block,
// that mutant scored 13 pass / 0 fail AT RUNTIME. It was caught only by `bun run typecheck`, and
// only because one line of this file happens to write `locale: null`:
//   locale-negotiation.test.ts(104,34): TS2322: Type 'null' is not assignable to type 'string'.
// The typecheck IS in the gating job, so the guard was real — but it was INCIDENTAL. Delete or
// rephrase that single line, for any unrelated reason, and the mutant walks past a green suite.
// A guard that exists because of where a `null` literal happens to sit is not a guard.
//
// ⛔ SO IT IS ASSERTED RELATIVELY, NOT ABSOLUTELY. The test above ("can represent no preference")
// pins the ABSOLUTE expected shape and dies when the migration has not been applied. This one pins
// AGREEMENT: whatever `schema.ts` declares, the live column must match. The two fail on opposite
// halves of the same drift, and only the second one can see a `schema.ts` that has moved.
//
// Whole-table on purpose rather than `locale` alone. It costs one extra query, it catches the next
// column this happens to, and it is what makes the check NON-VACUOUS: `users` carries all three
// shapes at once (notNull+default `role`/`created_at`, notNull-no-default `email`, nullable-no-
// default `locale`), so a broken introspection that reported one shape for everything could not
// pass. `id` also pins that a `sql`-expression default counts as a default on both sides.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('⛔ schema.ts and the applied migrations agree about every users column', async () => {
  const rows = await db.execute(sql`
    SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name = 'users'
  `);
  const live = new Map(
    (rows as unknown as Array<{ column_name: string; is_nullable: string; column_default: string | null }>)
      .map((r) => [r.column_name, r]),
  );

  const declared = Object.values(getTableColumns(users));
  // Non-vacuity, stated rather than assumed: an empty declaration list or an empty catalog read
  // would make every comparison below trivially true.
  expect(declared.length).toBeGreaterThan(5);
  expect(live.size).toBeGreaterThan(5);
  expect(live.has('locale')).toBe(true);

  const disagreements: string[] = [];
  for (const col of declared) {
    const row = live.get(col.name);
    if (!row) {
      disagreements.push(`${col.name}: declared in schema.ts, ABSENT from the database`);
      continue;
    }
    const dbNotNull = row.is_nullable === 'NO';
    const dbHasDefault = row.column_default !== null;
    if (dbNotNull !== col.notNull || dbHasDefault !== col.hasDefault) {
      disagreements.push(
        `${col.name}: schema.ts says {notNull: ${col.notNull}, hasDefault: ${col.hasDefault}}, ` +
          `the database says {notNull: ${dbNotNull}, default: ${JSON.stringify(row.column_default)}}`,
      );
    }
  }
  expect(
    disagreements,
    'schema.ts has drifted from the applied migrations — fix the file that is behind, ' +
      'do NOT relax this assertion:\n  ' + disagreements.join('\n  '),
  ).toEqual([]);
});
