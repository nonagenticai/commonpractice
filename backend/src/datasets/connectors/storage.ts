// src/datasets/connectors/storage.ts — read-only storage_service connector (Phase 2-A).
// storage_service (storage-api.storage.svc.cluster.local:8391 / https://storage.example.com)
// is the platform's MinIO proxy; it is the ONLY holder of MinIO credentials. We GET one
// object read-only and parse it by format. Auth = a license token via
// `X-Tenant-Id: Bearer <token>` (or trusted-network pass-through in-cluster). The egress
// guard authorizes the storage host before any socket.
import { badRequest } from '../../utils/http';
import { governedFetch } from '../../host/egress-guard';
import type { GovernanceSnapshot } from '../../host/policy-store';
import { parseCsv, parseJson, parseXlsx } from '../parse';
import type { ParseResult } from '../parse';

type StorageFormat = 'csv' | 'json' | 'xlsx';

function guessFormat(key: string, contentType: string): StorageFormat {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'json') return 'json';
  if (ext === 'xlsx' || ext === 'xls') return 'xlsx';
  if (contentType.includes('csv')) return 'csv';
  if (contentType.includes('json')) return 'json';
  if (contentType.includes('sheet') || contentType.includes('excel')) return 'xlsx';
  throw badRequest('storage_format_unknown', `cannot infer a format for object '${key}'`, { key });
}

export async function fetchStorage(
  cfg: { baseUrl: string; bucket: string; key: string; token?: string; format?: StorageFormat },
  snapshot: GovernanceSnapshot,
): Promise<ParseResult> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const keyPath = cfg.key.split('/').map(encodeURIComponent).join('/');
  const bucketSeg = encodeURIComponent(cfg.bucket);
  const url = `${base}/api/files/${bucketSeg}/${keyPath}`;

  // ⛔ POST-CONDITION, not decoration. `encodeURIComponent` does not encode dots, so a `..` segment
  // survives it and the URL parser silently normalises the bucket away BEFORE the request is sent:
  //   "/api/files/cp-mine/../cp-victim/secret.csv"  ->  "/api/files/cp-victim/secret.csv"
  // That defeated per-tenant bucket isolation entirely, and the egress allowlist could not catch it
  // because it matches host+port only, never path.
  //
  // `validateConnectorConfig` rejects traversal at config time, so a stored connector cannot carry
  // one. This re-asserts it on the CONSTRUCTED url anyway, because that check lives in another file
  // and this function is also reachable from the un-audited draft "test connection" path. Asserting
  // the parsed pathname — rather than re-inspecting the inputs — is what makes it robust: it catches
  // any encoding trick, present or future, by checking the only thing that actually matters, which
  // is where the request will really go.
  const resolved = new URL(url).pathname;
  const expectedPrefix = `/api/files/${bucketSeg}/`;
  if (!resolved.startsWith(expectedPrefix)) {
    throw badRequest(
      'bad_config',
      `storage key escapes its bucket (resolved to '${resolved}') — '.' and '..' segments are not allowed`,
      // 8th `bad_config` sentence — see connectors/index.ts for the `reason` discriminator.
      { reason: 'key_escapes_bucket', resolved },
    );
  }
  const headers: Record<string, string> = cfg.token
    ? { 'X-Tenant-Id': `Bearer ${cfg.token}` }
    : {};

  const res = await governedFetch(url, snapshot, { headers });
  const fmt = cfg.format ?? guessFormat(cfg.key, res.contentType);
  if (fmt === 'csv') return parseCsv(res.text);
  if (fmt === 'json') return parseJson(res.text);
  return parseXlsx(res.raw);
}
