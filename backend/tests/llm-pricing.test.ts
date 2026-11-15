// tests/llm-pricing.test.ts — what a brokered call COSTS (ai/llm/pricing.ts).
//
// Net-new: nothing previously asserted pricing at all. The old broker test only checked
// `costUsd > 0`, which the flat two-constant estimate satisfied for every model on earth —
// including the free and local ones it was overcharging. These tests pin the precedence rules
// instead: provider-reported beats table, table beats flat, and free really is free.
//
// Pure functions, no DB, no network — safe to run alongside anything.
import { test, expect } from 'bun:test';
import {
  ACCEPTED_UNPRICED_MODELS,
  findUnpricedAllowlistedModels,
  findUnallowlistedCatalogModels,
  parsePricingTable,
  parseRate,
  priceCall,
  pricingKey,
  type PricingTable,
} from '../src/ai/llm/pricing';
import { defaultModelPricing, providerCatalog } from '../src/ai/llm/provider-catalog';

// The flat tier, per TOKEN. Deliberately NOT config.llm's values (0.00001/0.000025 since
// 2026-08-12): this file tests the pricing FUNCTION, so it supplies its own rates and stays green
// when an operator retunes the real ones. The two must not be conflated — a test that read the
// config would assert nothing about the arithmetic.
const FLAT_IN = 0.000003;
const FLAT_OUT = 0.000015;

// ⚠ No `local/*` entry, mirroring the catalog since 2026-08-12 — see the CORRECTION block in
// pricing.ts. `local-llm` is deliberately UNPRICED so it reaches the flat tier; a table that still
// carried the wildcard would keep answering $0 for the preset-routed path and this file would go
// on proving the opposite of what the product does.
const TABLE_RAW: Record<string, string> = {
  'anthropic/claude-sonnet-4-6': '3/15',
  'anthropic/claude-haiku-4-5': '1/5',
};
const TABLE: PricingTable = parsePricingTable(TABLE_RAW);

const price = (over: Partial<Parameters<typeof priceCall>[0]> = {}) =>
  priceCall({
    model: 'claude-sonnet-4-6',
    presetKey: 'anthropic',
    tokensIn: 1_000_000,
    tokensOut: 1_000_000,
    table: TABLE,
    flatInRateUsd: FLAT_IN,
    flatOutRateUsd: FLAT_OUT,
    ...over,
  });

// ---- 1. table lookup -------------------------------------------------------------------------

test('a table-priced model is charged its published per-model rate, not the flat estimate', () => {
  // 1M in + 1M out at $3/$15 per Mtok = exactly $18.
  const out = price();
  expect(out.costUsd).toBe(18);
  expect(out.source).toBe('table');
  // And it is genuinely DIFFERENT per model — the whole point.
  const haiku = price({ model: 'claude-haiku-4-5' });
  expect(haiku.costUsd).toBe(6); // $1 + $5
  expect(haiku.costUsd).not.toBe(out.costUsd);
});

test('sub-million token counts price proportionally and round to numeric(12,6)', () => {
  const out = price({ tokensIn: 1000, tokensOut: 500 });
  // 1000/1e6*3 + 500/1e6*15 = 0.003 + 0.0075 = 0.0105
  expect(out.costUsd).toBe(0.0105);
  expect(out.source).toBe('table');
});

// ---- 2. provider-reported cost wins ----------------------------------------------------------

test('a provider-REPORTED cost always beats the table (it is the invoice, not an estimate)', () => {
  const out = price({ reportedCostUsd: 0.421337 });
  expect(out.costUsd).toBe(0.421337);
  expect(out.source).toBe('provider');
  // Emphatically not the table's answer for the same call.
  expect(out.costUsd).not.toBe(18);
});

test('a reported cost of exactly 0 is honoured, not mistaken for "unreported"', () => {
  // The absent-vs-zero distinction: `?? 0` or a truthiness check here would silently re-price a
  // genuinely free generation at the table/flat rate.
  const out = price({ presetKey: 'openrouter', model: 'some/paid-model', reportedCostUsd: 0 });
  expect(out.costUsd).toBe(0);
  expect(out.source).toBe('provider');
});

test('a nonsensical reported cost is ignored rather than written to the ledger', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const out = price({ reportedCostUsd: bad });
    expect(out.source).toBe('table');
    expect(out.costUsd).toBe(18);
  }
});

// ---- 3. local = the flat NOTIONAL tier; vendor-free = $0 --------------------------------------
//
// ⚠ INVERTED 2026-08-12. This section used to assert that the in-cluster local model costs $0 "via
// its preset AND via a bare model id" — the two zeros PR #157 installed. Every `usage_events` row
// this deployment has ever written is `local-llm`, so those two rules priced 100% of real traffic
// at $0.00: the `LLM_*_RATE_USD` knobs became unreachable, and `spend.weekly_spend_ceiling`
// evaluated `0 + 0 > 15` forever while /governance showed it enabled. Local inference is now
// priced notionally at the flat tier and labelled `flat`, because an internal chargeback estimate
// for our own hardware is exactly that: an estimate.

test('the in-cluster local model reaches the FLAT tier — via its preset AND via a bare model id', () => {
  // BOTH paths must land on the same number, and that is the whole point of asserting them
  // together: the two zeros lived at different layers (a model-id hardcode in pricing.ts and a
  // `local/*` wildcard in the catalog table), so removing either one alone leaves the other
  // silently answering $0 for half the traffic. The preset path is the agent-chat path in prod
  // (`presetKeyFor` resolves the router base_url to `local`); the no-preset path is the runner's
  // ENV fallback.
  const viaPreset = price({ presetKey: 'local', model: 'local-llm' });
  const viaEnvFallback = price({ presetKey: undefined, model: 'local-llm' });

  // 1M in + 1M out at this file's flat rates = $3 + $15 = $18.
  expect(viaPreset.costUsd).toBe(18);
  expect(viaPreset.source).toBe('flat');
  expect(viaEnvFallback.costUsd).toBe(18);
  expect(viaEnvFallback.source).toBe('flat');
});

test('an operator CAN still price local from the governance table, and that wins over the flat tier', () => {
  // The escape hatch the catalog comment promises: `models.pricing` is operator-editable and a
  // stored key beats the catalog default (`policy-store.ts asModelPricing`), so a deployment that
  // wants a firm local rate — or a hard zero back — sets one on the Governance screen without a
  // deploy. Pinned so the "deliberately unpriced" default is never mistaken for "unpriceable".
  const withLocalRow = parsePricingTable({ ...TABLE_RAW, 'local/*': '0/0' });
  const out = price({ presetKey: 'local', model: 'local-llm', table: withLocalRow });
  expect(out.costUsd).toBe(0);
  expect(out.source).toBe('table');
});

test('an OpenRouter :free model costs $0 whatever the table says', () => {
  // ⛔ THE SURVIVING ZERO, and it survives for a different reason than the one that was removed.
  // `:free` is OpenRouter stating that this generation is billed at zero — a VENDOR fact, so
  // pricing it notionally would invent spend against an invoice that will read $0.00. `local-llm`
  // was OUR policy about OUR hardware, and only that half was reversed. Whoever finishes the job
  // by deleting `isFreeModelId` should fail here.
  const out = price({ presetKey: 'openrouter', model: 'google/gemma-4-26b-a4b-it:free' });
  expect(out.costUsd).toBe(0);
  expect(out.source).toBe('table');

  // And it holds with NO table at all — it is a rule, not a row that could go stale.
  const noTable = price({ presetKey: 'openrouter', model: 'some/other:free', table: {} });
  expect(noTable.costUsd).toBe(0);
  expect(noTable.source).toBe('table');
});

// ---- 4. unknown-model fallback ---------------------------------------------------------------

test('an unpriced model falls back to the flat estimate and is LABELLED as flat', () => {
  const out = price({ presetKey: 'custom', model: 'someone/unknown-model' });
  // 1M * 0.000003 + 1M * 0.000015 = 3 + 15 = 18 — same number the old code produced for
  // everything. The difference now is that it is marked as the estimate it is.
  expect(out.costUsd).toBe(18);
  expect(out.source).toBe('flat');
});

test('an unknown model still costs something — under-reporting would defeat the spend ceiling', () => {
  const out = price({ presetKey: undefined, model: 'mystery', tokensIn: 10, tokensOut: 5 });
  expect(out.costUsd).toBeGreaterThan(0);
  expect(out.source).toBe('flat');
});

// ---- 5. operator-edit robustness -------------------------------------------------------------

test('a malformed governance price entry is skipped, not parsed into NaN', () => {
  for (const bad of ['', 'free', '3', '3/15/20', 'abc/def', '-3/15', 5, null, {}]) {
    expect(parseRate(bad)).toBeUndefined();
  }
  expect(parseRate('3/15')).toEqual({ inUsdPerMtok: 3, outUsdPerMtok: 15 });
  expect(parseRate(' 0.5 / 1.5 ')).toEqual({ inUsdPerMtok: 0.5, outUsdPerMtok: 1.5 });
});

test('one bad entry degrades that model only — the rest of the table survives', () => {
  const table = parsePricingTable({
    'anthropic/claude-sonnet-4-6': 'not-a-price',
    'anthropic/claude-haiku-4-5': '1/5',
  });
  expect(Object.keys(table)).toEqual(['anthropic/claude-haiku-4-5']);
  const broken = priceCall({
    model: 'claude-sonnet-4-6',
    presetKey: 'anthropic',
    tokensIn: 1_000_000,
    tokensOut: 1_000_000,
    table,
    flatInRateUsd: FLAT_IN,
    flatOutRateUsd: FLAT_OUT,
  });
  expect(broken.source).toBe('flat'); // fell through, did not become NaN
  expect(Number.isFinite(broken.costUsd)).toBe(true);
});

// ---- 6. the seeded defaults are coherent -----------------------------------------------------

test('the catalog seed leaves local UNPRICED, and every entry it does ship parses', () => {
  const seed = defaultModelPricing();
  // ⚠ Was `expect(seed['local/*']).toBe('0/0')`. That entry is the third and least visible of
  // #157's zeros: `policy-store.ts asModelPricing` merges the stored governance row OVER these
  // defaults per key, so as long as the catalog shipped `local/*: 0/0`, deleting the row from a
  // live database put it straight back. Its absence is now the assertion.
  expect(seed[pricingKey('local', '*')]).toBeUndefined();
  expect(Object.keys(seed).some((k) => k.startsWith('local/'))).toBe(false);

  // And the seeded defaults really do send a local call to the flat tier — the fact above matters
  // only because of this consequence, so they are asserted together.
  const viaSeed = price({
    presetKey: 'local',
    model: 'local-llm',
    table: parsePricingTable(seed),
  });
  expect(viaSeed.source).toBe('flat');
  expect(viaSeed.costUsd).toBe(18);

  const parsed = parsePricingTable(seed);
  // Nothing in the shipped defaults may be malformed — a typo here would silently unprice a model.
  expect(Object.keys(parsed).sort()).toEqual(Object.keys(seed).sort());
});

// ---- 7. allowlist ⇄ pricing drift guard ------------------------------------------------------
//
// `models.allowlist` and `models.pricing` are independent, operator-edited governance rows with
// nothing tying them together. This is the guard that makes the two falling out of sync VISIBLE
// (see pricing.ts findUnpricedAllowlistedModels for the full rationale + server.ts for the
// boot-time WARN that calls it).

// The catalog's curated model ids, deduped — mirrors seed-platform.ts's CATALOG_MODELS derivation
// (the default seed for `models.allowlist`).
const CATALOG_MODELS = [...new Set(providerCatalog().flatMap((p) => p.models))];
const CATALOG_PRICING = parsePricingTable(defaultModelPricing());

test('reproduces the live prod drift: an allowlisted claude-opus-4-7 has no price entry', () => {
  // Today's live shape: the seeded catalog allowlist PLUS the one model a governance edit added
  // that the catalog (and therefore the pricing table) has never heard of.
  const allowlist = [...CATALOG_MODELS, 'claude-opus-4-7'];

  const drift = findUnpricedAllowlistedModels({
    allowlistedModels: allowlist,
    modelPricing: CATALOG_PRICING,
  });
  // Assert the exact model set, not just that something was found — a guard that flags the wrong
  // model is as useless as one that flags nothing.
  expect(drift).toEqual(['claude-opus-4-7']);
});

test('the drift clears once the model is priced', () => {
  const allowlist = [...CATALOG_MODELS, 'claude-opus-4-7'];
  const priced = { ...CATALOG_PRICING, [pricingKey('anthropic', 'claude-opus-4-7')]: parseRate('5/25')! };

  const drift = findUnpricedAllowlistedModels({ allowlistedModels: allowlist, modelPricing: priced });
  expect(drift).toEqual([]);
});

test('the drift clears once the model is added to the accepted-unpriced list', () => {
  const allowlist = [...CATALOG_MODELS, 'claude-opus-4-7'];
  const accepted = new Set([...ACCEPTED_UNPRICED_MODELS, 'claude-opus-4-7']);

  const drift = findUnpricedAllowlistedModels(
    { allowlistedModels: allowlist, modelPricing: CATALOG_PRICING },
    accepted,
  );
  expect(drift).toEqual([]);
});

test('the accepted-unpriced escape list is the Cohere Command A family plus local-llm (custom preset models are empty today)', () => {
  // `local-llm` joined this list on 2026-08-12 and it is REQUIRED, not decorative: it used to be
  // rescued from the drift guard by `isZeroCostModel`, and emptying ZERO_COST_MODELS without this
  // entry makes the guard denounce the platform's own always-allowlisted default model as
  // governance drift on every boot (server.ts WARNs on it).
  expect([...ACCEPTED_UNPRICED_MODELS].sort()).toEqual(
    ['command-a-03-2025', 'command-a-plus-05-2026', 'command-a-reasoning-08-2025', 'local-llm'].sort(),
  );
});

test('the three unpriced Cohere Command A ids are NOT reported as drift, even with an empty price table', () => {
  const cohereCommandA = [
    'command-a-plus-05-2026',
    'command-a-reasoning-08-2025',
    'command-a-03-2025',
  ];
  const drift = findUnpricedAllowlistedModels({
    allowlistedModels: cohereCommandA,
    modelPricing: {},
  });
  expect(drift).toEqual([]);
});

test('the full catalog-seeded allowlist has zero unaccepted drift against its own pricing seed', () => {
  // A meta-check on the catalog itself: whatever the catalog currently ships as its default
  // allowlist + default pricing, the guard should find nothing to flag (the 3 Cohere gaps are
  // accepted, everything else is priced). If this ever fails, either a new model was added to a
  // preset's `models` without a matching `pricing` entry, or the accepted list needs updating —
  // exactly the class of drift this guard exists to catch, now caught at test time too.
  const drift = findUnpricedAllowlistedModels({
    allowlistedModels: CATALOG_MODELS,
    modelPricing: CATALOG_PRICING,
  });
  expect(drift).toEqual([]);
});

test('local-llm and the :free suffix are never flagged as drift, even with no table at all', () => {
  // Same outcome as before 2026-08-12, now reached two different ways — worth stating, because the
  // two ids in this list are no longer the same kind of thing. `:free` is still zero-cost by
  // construction (`isZeroCostModel`); `local-llm` is priced at the flat tier and is unflagged only
  // because it is on the ACCEPTED_UNPRICED list.
  const allowlist = ['local-llm', 'google/gemma-4-26b-a4b-it:free', 'openrouter/some-model:free'];
  const drift = findUnpricedAllowlistedModels({ allowlistedModels: allowlist, modelPricing: {} });
  expect(drift).toEqual([]);
});

test('an allowlist with no drift at all returns an empty array, not a falsy non-array', () => {
  const drift = findUnpricedAllowlistedModels({
    allowlistedModels: ['claude-sonnet-4-6'],
    modelPricing: CATALOG_PRICING,
  });
  expect(drift).toEqual([]);
  expect(Array.isArray(drift)).toBe(true);
});

test('a repeated allowlist entry is reported once, not once per occurrence', () => {
  const drift = findUnpricedAllowlistedModels({
    allowlistedModels: ['claude-opus-4-7', 'claude-opus-4-7', 'claude-opus-4-7'],
    modelPricing: CATALOG_PRICING,
  });
  expect(drift).toEqual(['claude-opus-4-7']);
});

// ---- the guard's SCOPE, pinned so nobody turns it into a false promise -------------------------

test('a `custom` preset reusing a priced model id reports NO drift yet bills flat — by design', () => {
  // The one reachable consequence of matching on the model-half of a table key (see the SCOPE note
  // in pricing.ts). `routes/llm-settings.ts:81` skips catalog validation for `custom` presets, so a
  // tenant with a BYO OpenAI-compatible endpoint can store ANY model string — including one this
  // table already prices under a DIFFERENT preset. The guard then sees a priced bare id and reports
  // nothing, while `lookupRate`'s exact `(presetKey, model)` lookup misses and flat-estimates.
  //
  // Both halves are asserted TOGETHER on purpose. The flat fallback is correct: 0053 declares every
  // `custom`-preset model unpriceable, because CP cannot know a third party's rate for an endpoint
  // it does not operate, and `price_source: 'flat'` keeps the Usage screen calling it an estimate.
  // What would be WRONG is reading the guard as "every allowlisted model prices from the table".
  // If someone later "fixes" the guard to model `custom`, this test should fail and make them
  // justify it — the honest answer is that the drift guard and per-call pricing answer different
  // questions.
  expect(
    findUnpricedAllowlistedModels({
      allowlistedModels: ['claude-opus-4-8'],
      modelPricing: CATALOG_PRICING,
    }),
  ).toEqual([]); // no governance drift: claude-opus-4-8 IS priced, under `anthropic`

  const viaCustom = priceCall({
    model: 'claude-opus-4-8',
    presetKey: 'custom',
    tokensIn: 1_000_000,
    tokensOut: 1_000_000,
    table: CATALOG_PRICING,
    flatInRateUsd: FLAT_IN,
    flatOutRateUsd: FLAT_OUT,
  });
  expect(viaCustom.source).toBe('flat'); // NOT 'table' — there is no `custom/claude-opus-4-8` key
  // And the same id under its real preset does price from the table, which is what makes the
  // asymmetry above a scope limit rather than a lookup bug.
  const viaAnthropic = priceCall({
    model: 'claude-opus-4-8',
    presetKey: 'anthropic',
    tokensIn: 1_000_000,
    tokensOut: 1_000_000,
    table: CATALOG_PRICING,
    flatInRateUsd: FLAT_IN,
    flatOutRateUsd: FLAT_OUT,
  });
  expect(viaAnthropic.source).toBe('table');
  expect(viaAnthropic.costUsd).toBeGreaterThan(viaCustom.costUsd); // flat UNDER-bills opus
});

test('`local-llm` stays unflagged via ACCEPTED_UNPRICED_MODELS, not via the `local/*` wildcard', () => {
  // `modelIdFromTableKey('local/*')` yields the literal '*', so the wildcard NEVER contributes
  // `local-llm` to the guard's priced-id set — it is unflagged only because it is hand-listed.
  // That coupling is invisible and DID bite exactly as this test's original comment predicted: it
  // said "would bite whoever removes the hardcode while leaving `local/*` as the only pricing
  // entry", and on 2026-08-12 the hardcode (`ZERO_COST_MODELS`) was removed. What caught the fall
  // is the new `ACCEPTED_UNPRICED_MODELS` entry, not the wildcard, which is what this pins.
  expect(
    findUnpricedAllowlistedModels({
      allowlistedModels: ['local-llm'],
      modelPricing: { 'local/*': { inUsdPerMtok: 0, outUsdPerMtok: 0 } },
    }),
  ).toEqual([]); // rescued by ACCEPTED_UNPRICED_MODELS (was: by ZERO_COST_MODELS)

  // A different local-ish id that is NOT hardcoded is NOT rescued by `local/*`, proving the
  // wildcard plays no part in the guard's matching.
  expect(
    findUnpricedAllowlistedModels({
      allowlistedModels: ['some-other-local-model'],
      modelPricing: { 'local/*': { inUsdPerMtok: 0, outUsdPerMtok: 0 } },
    }),
  ).toEqual(['some-other-local-model']);
});

// ---- the INVERSE drift: catalog models the allowlist omits ------------------------------------

test('findUnallowlistedCatalogModels reproduces the live prod gap — 4 whole providers refused', () => {
  // The exact `models.allowlist` value found in live prod on 2026-07-30: 7 ids, against 21 in the
  // catalog. Every OpenAI, DeepSeek, xAI and Cohere model was selectable in the tenant LLM-settings
  // dropdown (it validates against `preset.models`, which they DO satisfy), saved cleanly, and was
  // then refused by `llm-broker.ts reserveCall` with `model_not_allowed` on every single call.
  const PROD_ALLOWLIST = [
    'local-llm',
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    'google/gemma-4-26b-a4b-it:free',
    'nvidia/nemotron-3-super-120b-a12b',
    'z-ai/glm-5.2',
  ];
  const missing = findUnallowlistedCatalogModels({ allowlistedModels: PROD_ALLOWLIST });
  // Asserted as an exact set, not a count — a count would still pass if the wrong models moved.
  expect(new Set(missing)).toEqual(
    new Set([
      'claude-opus-4-8',
      'claude-fable-5',
      'gpt-4o',
      'gpt-4.1',
      'o4-mini',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'grok-4.5',
      'grok-4.3',
      'grok-4.20-0309-reasoning',
      'grok-4.20-0309-non-reasoning',
      'command-a-plus-05-2026',
      'command-a-reasoning-08-2025',
      'command-a-03-2025',
      'command-r-plus-08-2024',
    ]),
  );
});

test('a catalog-complete allowlist reports no drift', () => {
  const everything = [...new Set(providerCatalog().flatMap((p) => p.models))];
  expect(findUnallowlistedCatalogModels({ allowlistedModels: everything })).toEqual([]);
});

test('an ABSENT or EMPTY allowlist means "no restriction" — mirroring the broker, not flagging all 21', () => {
  // `llm-broker.ts reserveCall` gates on `allowlist && allowlist.length > 0`, so an empty list
  // permits everything. A guard that disagreed with the enforcer would be worse than no guard:
  // here it would report all 21 catalog models as broken on a platform where all 21 work.
  expect(findUnallowlistedCatalogModels({ allowlistedModels: [] })).toEqual([]);
  expect(
    findUnallowlistedCatalogModels({ allowlistedModels: undefined as unknown as string[] }),
  ).toEqual([]);
});
