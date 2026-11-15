// tests/adapter-identity.test.ts — WHO a stored provider key belongs to
// (`ai/llm/provider-catalog.ts adapterIdentityFor`).
//
// ⛔ NET-NEW BECAUSE THE FUNCTION HAD NO DIRECT TEST AT ALL. It was covered only THROUGH the PUT
// route in llm-settings.test.ts, and a route case can only ever exercise the pairs it happens to
// save — so two mutations survived the whole suite:
//   • dropping the `${family}|` prefix (21/21 route cases + 8/8 frontend contract cases still
//     green), which makes an Anthropic key and an OpenAI-completions key at ONE host the same
//     identity. The route then carries an `sk-ant-…` onto `adapters/openai.ts`, which sends it as
//     `Authorization: Bearer` instead of `x-api-key` — a key handed to the wrong reader, at the
//     same company, by the same leak shape the family prefix exists to stop.
//   • `baseUrl?.trim() || DEFAULT` → `baseUrl ?? DEFAULT`, which gives `''` and `'   '` their OWN
//     identity instead of the adapter default the request actually goes to. A form that round-trips
//     a cleared field then reads as a vendor change and costs the tenant their key for nothing.
// The frontend mirror's structural grep cannot catch either: it matches the formula's TEXT.
//
// Pure functions, no DB, no network.
import { test, expect } from 'bun:test';
import { adapterIdentityFor } from '../src/ai/llm/provider-catalog';
import { OPENAI_DEFAULT_BASE } from '../src/ai/llm/adapters/openai';
import { ANTHROPIC_DEFAULT_BASE } from '../src/ai/llm/adapters/anthropic';

/** Prod's in-cluster router: plaintext http, non-default port, and the base every tenant uses. */
const LOCAL_BASE = 'http://inference-router.inference-router.svc.cluster.local:8150/api';

test('the FAMILY separates two adapters at one host — they send different auth headers', () => {
  // ⛔ THE SURVIVING MUTATION. `x-api-key` (anthropic) vs `Authorization: Bearer` (openai) is not a
  // cosmetic difference: it is a different party reading the secret out of a different header.
  const host = 'https://api.anthropic.com/v1';
  expect(adapterIdentityFor('anthropic', host)).not.toBe(adapterIdentityFor('openai_compatible', host));
  expect(adapterIdentityFor('anthropic', host)).not.toBe(adapterIdentityFor('openai', host));
  // …and it holds at a neutral host too, so this is the family and not something about that URL.
  expect(adapterIdentityFor('anthropic', 'https://proxy.example/v1')).not.toBe(
    adapterIdentityFor('openai_compatible', 'https://proxy.example/v1'),
  );
});

test('`openai` and `openai_compatible` at one host are ONE family — one adapter serves both', () => {
  // The other half of the same rule: over-separating would wipe a key for a dropdown relabel.
  expect(adapterIdentityFor('openai', 'https://api.x.ai/v1')).toBe(
    adapterIdentityFor('openai_compatible', 'https://api.x.ai/v1'),
  );
});

test('the SCHEME is part of the identity — https→http is a vendor change, not a path move', () => {
  // ⛔ Measured before this: `https://api.openai.com/v1` → `http://api.openai.com/v1` returned 200
  // and KEPT the key, which then went out in cleartext to a host anyone on the path can read.
  expect(adapterIdentityFor('openai_compatible', 'http://api.openai.com/v1')).not.toBe(
    adapterIdentityFor('openai_compatible', 'https://api.openai.com/v1'),
  );
  expect(adapterIdentityFor('anthropic', 'http://api.anthropic.com')).not.toBe(
    adapterIdentityFor('anthropic', 'https://api.anthropic.com'),
  );
});

test('…but plain http is NOT rejected — the in-cluster router round-trips unchanged', () => {
  // ⛔ THE OVER-CORRECTION GUARD, AND IT IS THE PRODUCTION PATH. Requiring https here would break
  // every tenant: prod runs OPENAI_BASE_URL at this plaintext in-cluster address. The rule is
  // "http↔https is a CHANGE", never "http is invalid".
  const local = adapterIdentityFor('openai_compatible', LOCAL_BASE);
  expect(local).toBe(adapterIdentityFor('openai_compatible', LOCAL_BASE));
  // Same identity in → same identity out when only the path or the trailing slash moves, i.e. a
  // model-only edit keeps the key.
  expect(adapterIdentityFor('openai_compatible', `${LOCAL_BASE}/`)).toBe(local);
  expect(adapterIdentityFor('openai_compatible', 'http://inference-router.inference-router.svc.cluster.local:8150/v1')).toBe(local);
  // The PORT is part of the host: a second router on another port is another target.
  expect(adapterIdentityFor('openai_compatible', 'http://inference-router.inference-router.svc.cluster.local:9150/api')).not.toBe(local);
});

test('an empty / whitespace base url resolves to the ADAPTER DEFAULT, not to its own identity', () => {
  // ⛔ THE `baseUrl ?? DEFAULT` MUTATION. `''` is what a cleared form field round-trips as; giving
  // it a distinct identity reads as a vendor change and disowns a key that is going to exactly the
  // same host it always did.
  const openaiDefault = adapterIdentityFor('openai', null);
  expect(adapterIdentityFor('openai', '')).toBe(openaiDefault);
  expect(adapterIdentityFor('openai', '   ')).toBe(openaiDefault);
  expect(openaiDefault).toBe(adapterIdentityFor('openai', OPENAI_DEFAULT_BASE));

  const anthropicDefault = adapterIdentityFor('anthropic', null);
  expect(adapterIdentityFor('anthropic', '')).toBe(anthropicDefault);
  expect(adapterIdentityFor('anthropic', '  \t ')).toBe(anthropicDefault);
  expect(anthropicDefault).toBe(adapterIdentityFor('anthropic', ANTHROPIC_DEFAULT_BASE));
});

test('casing and trailing slashes are normalized; two custom hosts stay distinct', () => {
  const openai = adapterIdentityFor('openai_compatible', 'https://api.openai.com/v1');
  expect(adapterIdentityFor('openai_compatible', 'https://API.OpenAI.com/v1/')).toBe(openai);
  expect(adapterIdentityFor('openai_compatible', 'HTTPS://api.openai.com/v2')).toBe(openai);
  expect(adapterIdentityFor('openai_compatible', 'https://vendor-a.example/v1')).not.toBe(
    adapterIdentityFor('openai_compatible', 'https://vendor-b.example/v1'),
  );
});

test('an unparseable half-typed url does not collapse every such row onto one identity', () => {
  expect(adapterIdentityFor('openai_compatible', 'vendor-a')).not.toBe(
    adapterIdentityFor('openai_compatible', 'vendor-b'),
  );
  // …and it still carries the family, so the unparseable branch cannot cross adapters either.
  expect(adapterIdentityFor('anthropic', 'vendor-a')).not.toBe(
    adapterIdentityFor('openai_compatible', 'vendor-a'),
  );
});
