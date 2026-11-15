// src/datasets/connectors/index.ts — connector dispatch + config↔meta derivation.
// A connector's SECRET config (ConnectorConfig) is encrypted at rest and only ever
// decrypted on the host at refresh time; the NON-secret meta (ConnectorMeta — host,
// bucket, query preview) is stored plaintext for display + egress derivation and is
// safe to return to a client. fetchConnector() runs the right read-only fetcher; every
// fetcher routes its outbound call through the egress guard.
import { badRequest } from '../../utils/http';
import type { GovernanceSnapshot } from '../../host/policy-store';
import { parseTarget } from '../../host/egress-guard';
import type { ConnectorConfig, ConnectorMeta } from '../../db/dataset-types';
import type { ParseResult } from '../parse';
import { fetchPostgres, assertReadOnlySelect } from './postgres';
import { fetchStorage } from './storage';
import { fetchHttp } from './http';

/** Run the read-only fetch for a connector config. Returns the typed {columns, rows}. */
export async function fetchConnector(
  cfg: ConnectorConfig,
  snapshot: GovernanceSnapshot,
): Promise<ParseResult> {
  switch (cfg.kind) {
    case 'postgres':
      return fetchPostgres(cfg, snapshot);
    case 'storage':
      return fetchStorage(cfg, snapshot);
    case 'http':
      return fetchHttp(cfg, snapshot);
    default:
      // `cfg.kind` narrows to `never` here but still carries the offending value at runtime —
      // put it on the wire so a catalog can name the kind instead of re-parsing the sentence.
      throw badRequest('unknown_connector', `unsupported connector kind`, {
        kind: (cfg as { kind?: unknown }).kind,
      });
  }
}

/**
 * Project ANY `http` connector meta — freshly derived or read back out of a pre-redesign row —
 * down to the only two fields considered structurally safe to ever return to a client: `host`
 * and the declared `format`. This replaced a name-based `SECRET_QUERY_PARAMS` blocklist (see this
 * file's git history) after an adversarial review ran the real function and showed a blocklist
 * can never be sufficient, by construction:
 *
 *   1. It never touches the PATH at all — `https://api.example.com/v1/sk_live_51H8x.../export.csv`
 *      came back byte-for-byte unchanged; the secret was never in a query param to strip.
 *   2. Any provider whose param names aren't on the list survives untouched — GCS presigned URLs
 *      (`X-Goog-Signature`, `X-Goog-Credential`) leaked in full on the same day AWS's `X-Amz-*`
 *      equivalents were added to the list; the next provider is the same gap with a new name.
 *   3. It matches by NAME, not shape — `?export=eyJhbGci...` (a JWT under an innocuous key) is
 *      indistinguishable from a legitimate param by any name-based rule.
 *
 * There is no allowlist of "safe" URL *positions* either — path and query string are both
 * free-form, attacker/operator-controlled text with no structural guarantee either one is
 * credential-free. The only part of an `http` connector's URL that is NEVER a credential by
 * construction is the hostname (userinfo, which sits in the same URL component family, is
 * already excluded — it isn't part of `host`). So `http` now matches its `postgres` (host +
 * database only) and `storage` (host + bucket + key only) siblings: keep only what cannot carry
 * a secret, drop everything else, rather than trying to enumerate what can.
 *
 * CAPABILITY LOST: the UI can no longer show a connector's path or query string — only its host
 * — so two `http` connectors on the same host are no longer visually distinguishable by URL.
 * They remain distinguishable by the connector's user-given `name` (required at create, same as
 * `postgres`/`storage`), and the full URL is still available to whoever configured the connector,
 * in the encrypted `ConnectorConfig` — never in this plaintext meta.
 *
 * Applied on BOTH the write path (`metaFromConfig` below) and the read path (`redactMeta` in
 * routes/connectors.ts), so a pre-redesign row that still has a `url` key (raw, or partially
 * redacted by the old blocklist) has that key dropped on every read regardless of what's actually
 * sitting in the `connection_meta` column. Idempotent by construction: re-applying it to its own
 * output is a no-op, since the output has nothing left to strip.
 */
export function httpMetaOut(meta: { host: string; format?: string }): ConnectorMeta {
  return { kind: 'http', host: meta.host, format: meta.format };
}

/** Derive the non-secret ConnectorMeta from a (validated) ConnectorConfig. */
export function metaFromConfig(cfg: ConnectorConfig): ConnectorMeta {
  switch (cfg.kind) {
    case 'postgres': {
      const { host } = parseTarget(cfg.url);
      let database: string | undefined;
      try {
        database = new URL(cfg.url).pathname.replace(/^\//, '') || undefined;
      } catch {
        database = undefined;
      }
      const preview = cfg.query.trim().replace(/\s+/g, ' ').slice(0, 200);
      return { kind: 'postgres', host, database, queryPreview: preview };
    }
    case 'storage': {
      const { host } = parseTarget(cfg.baseUrl);
      return { kind: 'storage', host, bucket: cfg.bucket, key: cfg.key, format: cfg.format };
    }
    case 'http': {
      const { host } = parseTarget(cfg.url);
      return httpMetaOut({ host, format: cfg.format });
    }
  }
}

/**
 * Reject any path component that could escape the segment it is meant to occupy.
 *
 * ⛔ `encodeURIComponent` is NOT sufficient here and that is the whole point: it percent-encodes
 * `/` but leaves `.` untouched, so a `..` segment passes through encoding intact and the URL
 * parser normalises it away before the request is ever sent. Encoding protects the INSIDE of a
 * segment; it does nothing about a segment that IS a traversal.
 *
 * Also rejects backslashes (some servers normalise them to `/`), raw or encoded, and empty
 * segments (`a//b` collapses on some stacks). Percent-decoding first defeats `%2e%2e` and the
 * double-encoded `%252e%252e`, which would otherwise decode into `..` downstream.
 *
 * `bad_config` carries eight different sentences, so each refusal below ships a `details.reason`
 * (the stable snake_case discriminator a locale catalog keys on) plus the interpolated `field`.
 */
export function assertNoTraversal(value: string, field: string): void {
  let decoded = value;
  // ⛔ Decode to a FIXED POINT, not a fixed number of rounds. This used to run exactly twice, which
  // its own comment described as defeating `%2e%2e` and `%252e%252e` — but a TRIPLE-encoded
  // `%25252e%25252e` decoded only to `%2e%2e`, which is not literally `..`, so the segment check
  // passed it. That was inert in practice ONLY because `storage.ts` re-encodes the raw value and
  // re-checks the resolved pathname, so the surviving `%` never became a dot-segment the URL parser
  // would normalise. Relying on the second layer's incidental behaviour to cover the first layer's
  // off-by-one is not a design. Bounded at 8 rounds so a pathological input cannot spin.
  for (let i = 0; i < 8; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      // A malformed escape cannot be safely reasoned about — refuse it outright.
      throw badRequest('bad_config', `${field} contains an invalid percent-escape`, {
        reason: 'percent_escape',
        field,
      });
    }
  }
  if (/\\/.test(decoded)) {
    throw badRequest('bad_config', `${field} must not contain a backslash`, {
      reason: 'backslash',
      field,
    });
  }
  for (const segment of decoded.split('/')) {
    if (segment === '.' || segment === '..') {
      throw badRequest('bad_config', `${field} must not contain a '.' or '..' path segment`, {
        reason: 'dot_segment',
        field,
      });
    }
  }
  if (decoded.startsWith('/')) {
    throw badRequest('bad_config', `${field} must be relative, not absolute`, {
      reason: 'absolute',
      field,
    });
  }
}

/** Validate + normalize a raw connector config from the API. Throws badRequest on a
 *  malformed config; runs the SELECT guard for postgres so a bad query 400s at create
 *  time, not at first refresh. */
export function validateConnectorConfig(kind: string, raw: unknown): ConnectorConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string): string => {
    const v = o[k];
    if (typeof v !== 'string' || !v.trim()) {
      throw badRequest('bad_config', `'${k}' is required`, { reason: 'required', field: k });
    }
    return v.trim();
  };
  switch (kind) {
    case 'postgres': {
      const url = str('url');
      const query = str('query');
      assertReadOnlySelect(query);
      if (!/^postgres(ql)?:\/\//i.test(url)) {
        throw badRequest(
          'bad_config',
          'postgres url must start with postgres:// or postgresql://',
          { reason: 'postgres_scheme' },
        );
      }
      return { kind: 'postgres', url, query };
    }
    case 'storage': {
      const fmt = o.format as 'csv' | 'json' | 'xlsx' | undefined;
      const bucket = str('bucket');
      const key = str('key');
      // ⛔ PATH TRAVERSAL. `bucket` and `key` are concatenated into a storage-service URL, and
      // `encodeURIComponent` does NOT encode dots — so a `..` segment survives encoding intact and
      // the URL parser then normalises it away BEFORE the request is sent, escaping the bucket:
      //
      //   key = "../cp-victim-tenant/secret.csv"
      //   built:  /api/files/cp-mine/../cp-victim-tenant/secret.csv
      //   sent:   /api/files/cp-victim-tenant/secret.csv        ← bucket boundary gone
      //
      // That defeated per-tenant bucket isolation outright: any tenant_admin could read another
      // tenant's objects into their own dataset. With `bucket: ".."` it reached ANY path on the
      // storage host, not just other buckets. The egress allowlist could not help — it matches
      // host+port only, never path, and the storage host is legitimately allowlisted.
      // Rejected HERE (config validation) so a bad connector can never be persisted, and asserted
      // again at request time in `storage.ts` — the URL builder must not trust its own caller.
      assertNoTraversal(bucket, 'bucket');
      assertNoTraversal(key, 'key');
      return {
        kind: 'storage',
        baseUrl: str('baseUrl'),
        bucket,
        key,
        token: typeof o.token === 'string' && o.token ? o.token : undefined,
        format: fmt,
      };
    }
    case 'http': {
      const url = str('url');
      if (!/^https?:\/\//i.test(url)) {
        throw badRequest('bad_config', 'http url must start with http(s)://', {
          reason: 'http_scheme',
        });
      }
      const headers =
        o.headers && typeof o.headers === 'object' && !Array.isArray(o.headers)
          ? (o.headers as Record<string, string>)
          : undefined;
      return { kind: 'http', url, headers, format: o.format as 'csv' | 'json' | undefined };
    }
    default:
      throw badRequest('unknown_connector', `unsupported connector kind '${kind}'`, { kind });
  }
}
