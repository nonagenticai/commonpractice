// src/datasets/connectors/http.ts — read-only HTTP/JSON connector (Phase 2-A).
// GETs a configured URL through the egress guard (allowlist + SSRF + size/time caps)
// and parses the body as JSON (default) or CSV. Optional static headers (e.g. a bearer
// token) are stored encrypted in the connector config and applied host-side only.
import { governedFetch } from '../../host/egress-guard';
import type { GovernanceSnapshot } from '../../host/policy-store';
import { parseCsv, parseJson } from '../parse';
import type { ParseResult } from '../parse';

export async function fetchHttp(
  cfg: { url: string; headers?: Record<string, string>; format?: 'csv' | 'json' },
  snapshot: GovernanceSnapshot,
): Promise<ParseResult> {
  const res = await governedFetch(cfg.url, snapshot, { headers: cfg.headers });
  const fmt = cfg.format ?? (res.contentType.includes('csv') ? 'csv' : 'json');
  return fmt === 'csv' ? parseCsv(res.text) : parseJson(res.text);
}
