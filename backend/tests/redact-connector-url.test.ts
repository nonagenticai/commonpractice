// tests/redact-connector-url.test.ts — unit tests for `httpMetaOut` in
// src/datasets/connectors/index.ts, the function that decides what an `http` connector's
// NON-secret meta is allowed to carry before it's persisted (or re-projected on read) into
// `connection_meta`, a plaintext jsonb column returned by GET /api/connectors[/:slug] to ANY
// tenant member (those routes only call resolveTenant, not requireDataManager — see
// tests/connectors-routes.test.ts for the end-to-end version of this hunt).
//
// HISTORY: this file used to test `redactConnectorUrl`, a function that returned a "cleaned" URL
// string by stripping userinfo, the fragment, and a curated `SECRET_QUERY_PARAMS` blocklist of
// query-param NAMES. A follow-up adversarial review ran that real function against three shapes
// it never covered and got the URL back completely unchanged in every case:
//
//   1. A credential embedded in the PATH, not a query param at all:
//      IN : https://api.example.com/v1/sk_live_51H8xyzSECRETTOKEN/reports/export.csv
//      OUT: https://api.example.com/v1/sk_live_51H8xyzSECRETTOKEN/reports/export.csv   (unchanged)
//
//   2. GCS presigned-URL params — the list had AWS's `X-Amz-*` trio but not GCS's equivalents,
//      and the next provider is the same gap with a different name:
//      IN : https://storage.googleapis.com/b/o.csv?X-Goog-Signature=LIVEGOOGSIG&X-Goog-Credential=GOOGCREDVALUE
//      OUT: https://storage.googleapis.com/b/o.csv?X-Goog-Signature=LIVEGOOGSIG&X-Goog-Credential=GOOGCREDVALUE   (unchanged)
//
//   3. A JWT under an innocuous param name — the list matches by NAME, not by value shape:
//      IN : https://internal.example.com/export.csv?export=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.SIGNATUREPART
//      OUT: https://internal.example.com/export.csv?export=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.SIGNATUREPART  (unchanged)
//
// (All three verified by running the actual pre-redesign function; see this PR's description for
// the reproduction script.) The conclusion: a name-based blocklist of query params can never be
// sufficient — it structurally cannot reach a path-embedded secret, and any unlisted param name
// (present or future, any provider) survives by construction.
//
// THE FIX is not a bigger list. `httpMetaOut` now keeps ONLY `host` (+ the declared `format`) —
// nothing that can carry the URL's path or query string survives AT ALL, so there is no leaking
// position left to find. This mirrors `postgres` (host + database only) and `storage` (host +
// bucket + key only), which never stored a raw URL to begin with.
//
// Pure/DB-free on purpose, same as tests/storage-path-traversal.test.ts.
import { test, expect } from 'bun:test';
import { httpMetaOut, metaFromConfig } from '../src/datasets/connectors';

test('a path-embedded secret is gone — the whole path is dropped, not filtered', () => {
  const out = metaFromConfig({
    kind: 'http',
    url: 'https://api.example.com/v1/sk_live_51H8xyzSECRETTOKEN/reports/export.csv',
  });
  expect(out).toEqual({ kind: 'http', host: 'api.example.com', format: undefined });
  expect(JSON.stringify(out)).not.toContain('sk_live_51H8xyzSECRETTOKEN');
  expect(JSON.stringify(out)).not.toContain('/v1/');
});

test('GCS presigned-URL params are gone — not because they are on a list, but because no query string survives', () => {
  const out = metaFromConfig({
    kind: 'http',
    url: 'https://storage.googleapis.com/b/o.csv?X-Goog-Signature=LIVEGOOGSIG&X-Goog-Credential=GOOGCREDVALUE',
  });
  expect(out).toEqual({ kind: 'http', host: 'storage.googleapis.com', format: undefined });
  expect(JSON.stringify(out)).not.toContain('LIVEGOOGSIG');
  expect(JSON.stringify(out)).not.toContain('GOOGCREDVALUE');
  expect(JSON.stringify(out)).not.toContain('?');
});

test('a JWT under an innocuous param name is gone — no name-matching was needed', () => {
  const out = metaFromConfig({
    kind: 'http',
    url: 'https://internal.example.com/export.csv?export=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.SIGNATUREPART',
  });
  expect(out).toEqual({ kind: 'http', host: 'internal.example.com', format: undefined });
  expect(JSON.stringify(out)).not.toContain('eyJhbGci');
});

test('userinfo and the fragment are gone too (the cases the old blocklist did handle)', () => {
  const out = metaFromConfig({
    kind: 'http',
    url: 'https://user:pass@api.example.com/data?keep=yes#access_token=LIVEFRAGMENTSECRET',
  });
  expect(out).toEqual({ kind: 'http', host: 'api.example.com', format: undefined });
  const s = JSON.stringify(out);
  expect(s).not.toContain('user');
  expect(s).not.toContain('pass');
  expect(s).not.toContain('LIVEFRAGMENTSECRET');
  expect(s).not.toContain('#');
});

// ── the old selective test asserted a non-secret query param (`keep=yes`) survived redaction —
// proof the old function was a SELECTIVE stripper, not a blanket one. That assertion is now
// deliberately WRONG: this design keeps nothing from the path or query string, on the principle
// that no position in an `http` connector's URL is structurally guaranteed credential-free (see
// the design comment on `httpMetaOut`). A harmless-looking `keep=yes` today is indistinguishable,
// by any general rule, from tomorrow's `sid=<live-session-id>` — so the update here is not a
// weakening, it's closing the exact gap the blocklist could never close. ─────────────────────────
test('a non-secret query param does NOT survive — this is the deliberate behavior change', () => {
  const out = metaFromConfig({ kind: 'http', url: 'https://h.example.com/x?keep=yes' });
  expect(out).toEqual({ kind: 'http', host: 'h.example.com', format: undefined });
  expect(JSON.stringify(out)).not.toContain('keep');
});

test('format survives — it is a declared field of the config, never derived from the URL', () => {
  const out = metaFromConfig({ kind: 'http', url: 'https://h.example.com/x', format: 'csv' });
  expect(out).toEqual({ kind: 'http', host: 'h.example.com', format: 'csv' });
});

test('idempotent: re-applying httpMetaOut to its own output is a no-op', () => {
  const once = metaFromConfig({ kind: 'http', url: 'https://user:pass@h.example.com/x?token=SECRET' });
  expect(httpMetaOut(once)).toEqual(once);
});

// ── belt-and-braces: `httpMetaOut` is also what the READ path (routes/connectors.ts `redactMeta`)
// applies to whatever is actually sitting in `connection_meta`, including a pre-redesign row that
// still has a `url` key. Prove it strips a `url` key even when handed one directly (simulating
// that stored shape), not just when deriving fresh meta from a config. ────────────────────────────
test('a legacy stored meta object with a leftover url key has it dropped on projection', () => {
  const legacyStored = {
    kind: 'http' as const,
    host: 'legacy.example.com',
    url: 'https://user:pass@legacy.example.com/x?api_key=STILLSECRET',
    format: 'json',
  };
  const out = httpMetaOut(legacyStored);
  expect(out).toEqual({ kind: 'http', host: 'legacy.example.com', format: 'json' });
  expect('url' in out).toBe(false);
});
