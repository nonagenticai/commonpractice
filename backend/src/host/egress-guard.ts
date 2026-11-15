// src/host/egress-guard.ts — the outbound gate for read-only data connectors
// (Phase 2-A). EVERY live-source fetch (postgres / storage / http) passes through
// assertEgressAllowed() before a socket opens. Three layers, in order:
//
//   1. models.external_http must be ON (the same master switch the run-gate uses).
//   2. The target host (host or host:port) must match the data.egress_allowlist
//      policy — the operator's explicit, per-host trust decision (the SPEC's point).
//   3. SSRF guard: resolve the host and ALWAYS refuse loopback + link-local/metadata
//      (e.g. 169.254.169.254). RFC1918 / CGNAT / ULA are permitted only because the
//      host is allowlisted — that is how legitimate in-cluster targets
//      (storage.example.com, postgres.example.com, *.svc.cluster.local) are reached.
//
// Known limitation (documented, not silently ignored): DNS is re-resolved by the
// driver/fetch after this check (TOCTOU). The allowlist — an explicit operator trust
// decision — is the primary control; the resolve-check is defense in depth.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { GovernanceSnapshot } from './policy-store';
import {
  CONNECTOR_FETCH_MAX_BYTES,
} from '../db/dataset-types';

/** Thrown when an outbound connector target is refused. Carries a stable `code` so
 *  routes map it to 422 + an audited reason (never leak the secret/url). */
export class EgressBlockedError extends Error {
  constructor(
    readonly code:
      | 'egress_disabled'
      | 'egress_host_not_allowlisted'
      | 'egress_ssrf_blocked'
      | 'egress_bad_target',
    message: string,
  ) {
    super(message);
    this.name = 'EgressBlockedError';
  }
}

/** Parse a URL or bare host[:port] into { host, port }. postgres:// and http(s)://
 *  URLs both parse via URL; a bare `host:5432` is accepted too. */
export function parseTarget(target: string | URL): { host: string; port: number | null } {
  if (target instanceof URL) {
    return { host: target.hostname, port: target.port ? Number(target.port) : null };
  }
  const raw = String(target).trim();
  if (raw.includes('://')) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new EgressBlockedError('egress_bad_target', 'unparseable connection target');
    }
    return { host: u.hostname, port: u.port ? Number(u.port) : null };
  }
  // bare host[:port] (IPv6 in brackets unsupported here — connectors use names/URLs)
  const idx = raw.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(raw.slice(idx + 1))) {
    return { host: raw.slice(0, idx), port: Number(raw.slice(idx + 1)) };
  }
  return { host: raw, port: null };
}

/** Does `host`(/`port`) match one allowlist entry? Entry forms:
 *    example.com           — exact host (any port)
 *    example.com:443       — exact host + port
 *    *.svc.cluster.local   — suffix wildcard (any port)
 *    *.PRIVATE-TLD:5432       — suffix wildcard + port  */
function entryMatches(entry: string, host: string, port: number | null): boolean {
  const e = entry.trim().toLowerCase();
  if (!e) return false;
  let pat = e;
  let entryPort: number | null = null;
  const pIdx = e.lastIndexOf(':');
  if (pIdx > 0 && /^\d+$/.test(e.slice(pIdx + 1))) {
    pat = e.slice(0, pIdx);
    entryPort = Number(e.slice(pIdx + 1));
  }
  if (entryPort !== null && port !== null && entryPort !== port) return false;
  const h = host.toLowerCase();
  if (pat.startsWith('*.')) {
    const suffix = pat.slice(1); // ".svc.cluster.local"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return h === pat;
}

function hostAllowlisted(host: string, port: number | null, allowlist: string[]): boolean {
  return allowlist.some((e) => entryMatches(e, host, port));
}

/** Is an IP loopback or link-local/metadata — ALWAYS refused, even if allowlisted? */
function isHardBlockedIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) {
    const o = ip.split('.').map(Number);
    if (o[0] === 127) return true; // 127/8 loopback
    if (o[0] === 169 && o[1] === 254) return true; // 169.254/16 link-local + metadata
    if (o[0] === 0) return true; // 0.0.0.0/8 "this host"
    return false;
  }
  if (fam === 6) {
    const lc = ip.toLowerCase();
    if (lc === '::1' || lc === '::') return true; // loopback / unspecified
    if (lc.startsWith('fe80')) return true; // link-local
    // IPv4-mapped (::ffff:a.b.c.d) → re-check the v4 tail
    const m = lc.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isHardBlockedIp(m[1]!);
    return false;
  }
  return false;
}

export interface EgressTarget {
  host: string;
  port: number | null;
  ips: string[];
}

// Test seam (house pattern — like __setAuthOverridesForTests). The SSRF guard ALWAYS
// hard-blocks loopback, so an offline test cannot point a connector at 127.0.0.1; the
// hooks let a test resolve a fake allowlisted host to a public IP and serve a canned
// body. Production never touches these (defaults delegate to node:dns + global fetch).
type LookupFn = (host: string) => Promise<string[]>;
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const defaultLookup: LookupFn = async (host) =>
  (await lookup(host, { all: true })).map((r) => r.address);
let _lookup: LookupFn = defaultLookup;
let _fetch: FetchFn = fetch;
export function __setEgressHooksForTests(
  hooks?: { lookup?: LookupFn; fetch?: FetchFn },
): void {
  _lookup = hooks?.lookup ?? defaultLookup;
  _fetch = hooks?.fetch ?? fetch;
}

/**
 * Enforce the egress policy for a connector target. Throws EgressBlockedError on any
 * refusal; returns the resolved target on success. Pure of audit — the caller records
 * the outcome with its connector/actor context.
 */
export async function assertEgressAllowed(
  target: string | URL,
  snapshot: GovernanceSnapshot,
): Promise<EgressTarget> {
  if (!snapshot.externalHttp) {
    throw new EgressBlockedError(
      'egress_disabled',
      'External HTTP is disabled by policy (models.external_http).',
    );
  }
  const { host, port } = parseTarget(target);
  if (!host) throw new EgressBlockedError('egress_bad_target', 'no host in connection target');

  if (!hostAllowlisted(host, port, snapshot.egressAllowlist)) {
    throw new EgressBlockedError(
      'egress_host_not_allowlisted',
      `Host '${host}${port ? `:${port}` : ''}' is not on the connector egress allowlist.`,
    );
  }

  const ips = await resolveAndAssertNotSsrf(host);
  return { host, port, ips };
}

/** Resolve a host and refuse if ANY address is loopback/link-local/metadata. Shared by
 *  the connector egress gate (assertEgressAllowed) and the system storage WRITE path
 *  (governedUpload) so there is ONE SSRF implementation. A literal IP target skips DNS. */
async function resolveAndAssertNotSsrf(host: string): Promise<string[]> {
  let ips: string[];
  if (isIP(host)) {
    ips = [host];
  } else {
    try {
      ips = await _lookup(host);
    } catch {
      throw new EgressBlockedError('egress_bad_target', `cannot resolve host '${host}'`);
    }
  }
  if (!ips.length) throw new EgressBlockedError('egress_bad_target', `host '${host}' resolved to no address`);
  for (const ip of ips) {
    if (isHardBlockedIp(ip)) {
      throw new EgressBlockedError(
        'egress_ssrf_blocked',
        `Host '${host}' resolves to a blocked address (loopback/link-local/metadata).`,
      );
    }
  }
  return ips;
}

export interface GovernedFetchResult {
  /** UTF-8 decoded body (use for csv/json/text sources). */
  text: string;
  /** Raw bytes (use for binary sources, e.g. an xlsx object from storage). */
  raw: Uint8Array;
  contentType: string;
  bytes: number;
  target: EgressTarget;
}

/**
 * Egress-gated HTTP GET for the storage/http connectors: assert the target, then
 * fetch read-only with a wall-clock timeout and a hard body-size cap. Returns the
 * decoded body + content-type so the caller picks a parser. Never follows to a host
 * the allowlist would reject (redirects are not auto-followed).
 */
export async function governedFetch(
  url: string,
  snapshot: GovernanceSnapshot,
  opts: { headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number } = {},
): Promise<GovernedFetchResult> {
  const target = await assertEgressAllowed(url, snapshot);
  const maxBytes = opts.maxBytes ?? CONNECTOR_FETCH_MAX_BYTES;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await _fetch(url, {
      method: 'GET',
      headers: opts.headers,
      redirect: 'manual',
      signal: ac.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      throw new EgressBlockedError('egress_bad_target', `redirect (${res.status}) refused — point the connector at the final URL`);
    }
    if (!res.ok) {
      throw new EgressBlockedError('egress_bad_target', `source returned HTTP ${res.status}`);
    }
    const clen = Number(res.headers.get('content-length') ?? '0');
    if (clen && clen > maxBytes) {
      throw new EgressBlockedError('egress_bad_target', `source body ${clen}B exceeds the ${maxBytes}B cap`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new EgressBlockedError('egress_bad_target', `source body exceeds the ${maxBytes}B cap`);
    }
    return {
      text: new TextDecoder().decode(buf),
      raw: buf,
      contentType: res.headers.get('content-type') ?? '',
      bytes: buf.byteLength,
      target,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Egress-gated outbound request for a DELIVERY dispatch (Phase 5B — "Forward to delivery").
 * Unlike governedFetch (a read-only connector GET that THROWS on any non-2xx, destroying the
 * body) this is a WRITE to a tenant_admin-configured target (a Jira site / ADO org), so it:
 *   (a) enforces the FULL connector egress policy — externalHttp + the data.egress_allowlist
 *       + the SSRF hard-block, via assertEgressAllowed. (NOT governedUpload's allowlist-
 *       bypassing system-write path: a delivery `base_url` is user-controlled, so the
 *       allowlist is the actual trust control.)
 *   (b) returns { status, text } WITHOUT throwing on non-2xx, so the adapter can read the
 *       created issue (201 + key) OR surface the target's own 4xx/5xx error body.
 * Redirects are refused (`manual` → the real 3xx is returned verbatim; the adapter treats any
 * non-2xx as a failure). A timeout/network error throws (the caller maps it to a failed
 * delivery). No body-size cap — target API responses are small.
 */
export async function governedSend(
  url: string,
  snapshot: GovernanceSnapshot,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; text: string }> {
  await assertEgressAllowed(url, snapshot);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await _fetch(url, {
      method: opts.method ?? 'POST',
      headers: opts.headers,
      body: opts.body,
      redirect: 'manual',
      signal: ac.signal,
    });
    const text = await res.text().catch(() => '');
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Egress-gated SYSTEM JSON request (self-serve connector notification register/deregister).
 * The JSON twin of governedUpload: a SYSTEM call to an OPERATOR-configured host
 * (storage_service, CP_NOTIFY_STORAGE_URL), so it does NOT consult the user-connector egress
 * policy — it is infra wiring, not a user-controlled target. It STILL applies the SSRF
 * hard-block (loopback/link-local/metadata). Returns { status, text } WITHOUT throwing on
 * non-2xx so the caller treats register/deregister as best-effort. Redirects refused; a
 * timeout/network error throws (the caller swallows it — the connector still syncs manually).
 */
export async function governedSystemRequest(
  url: string,
  opts: { method: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<{ status: number; text: string }> {
  const { host } = parseTarget(url);
  if (!host) throw new EgressBlockedError('egress_bad_target', 'no host in request target');
  await resolveAndAssertNotSsrf(host);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await _fetch(url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      redirect: 'manual',
      signal: ac.signal,
    });
    const text = await res.text().catch(() => '');
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Egress-gated object-storage WRITE (Phase 2-F compliance export). Unlike
 * governedFetch (the user-data-connector GET path), this is a SYSTEM write to an
 * OPERATOR-CONFIGURED host (AUDIT_EXPORT_STORAGE_URL), so it does NOT consult the
 * user-connector egress policy (models.external_http / the data.egress_allowlist) — a
 * compliance export must not be disableable by flipping a user-data switch. It STILL
 * applies the SSRF hard-block (loopback/link-local/metadata) so a misconfigured target
 * can't be pointed at e.g. 169.254.169.254. In-cluster, the NetworkPolicy is the
 * primary control (egress is already pinned to the Service CIDR). Redirects refused.
 */
export async function governedUpload(
  url: string,
  opts: { body: FormData; headers?: Record<string, string>; timeoutMs?: number },
): Promise<{ status: number; text: string }> {
  const { host } = parseTarget(url);
  if (!host) throw new EgressBlockedError('egress_bad_target', 'no host in upload target');
  await resolveAndAssertNotSsrf(host);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await _fetch(url, {
      method: 'POST',
      headers: opts.headers,
      body: opts.body,
      redirect: 'manual',
      signal: ac.signal,
    });
    const text = await res.text().catch(() => '');
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}
