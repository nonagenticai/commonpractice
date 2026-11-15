// src/host/storage-notify-client.ts — registers/deregisters a MinIO bucket-notification
// rule with storage_service when a user creates/deletes a `storage` + `webhook` connector,
// so the dataset's object pushes change-events to /api/connectors/events with NO operator
// `mc` step. storage_service (the only in-cluster MinIO-cred holder) sets the per-bucket rule
// pointing at the ONE shared, pre-provisioned webhook target — we never mint a target here
// (MinIO targets are static). System path: storage_service is operator-configured + SSRF-
// guarded (governedSystemRequest), NOT the user egress allowlist.
//
// Best-effort by design: a failure NEVER blocks connector create/delete — the connector still
// works via manual sync; we just don't get live push until re-registered. Auth to
// storage_service is trusted-network pass-through (in-cluster) with NO `X-Tenant-Id` header:
// storage_service has no tenant scoping and pins a non-licence tenant to its default anyway,
// so a literal tenant here was a false assertion (it would break once storage enforces
// credentials). The shared events secret is NOT sent here — it lives on the connector row as
// its event_secret; storage_service's shared target already carries it.
import { connectorNotificationsConfig } from '../config';
import { governedSystemRequest } from './egress-guard';
import { log } from './logger';

function notifyUrl(storageUrl: string, bucket: string): string {
  return `${storageUrl}/api/buckets/${encodeURIComponent(bucket)}/notifications/register`;
}

function statusUrl(storageUrl: string, bucket: string): string {
  return `${storageUrl}/api/buckets/${encodeURIComponent(bucket)}/notifications`;
}

async function call(method: 'POST' | 'DELETE', bucket: string, prefix: string): Promise<boolean> {
  const cfg = connectorNotificationsConfig();
  if (!cfg.enabled || !cfg.storageUrl) return false;
  try {
    const res = await governedSystemRequest(notifyUrl(cfg.storageUrl, bucket), {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prefix }),
    });
    return res.status >= 200 && res.status < 300;
  } catch (err) {
    // Network/SSRF/timeout — swallow; the connector still syncs manually. Log so a persistently
    // failing notification rule is visible to operators instead of silently degrading to manual sync.
    log.warn('connector_notify_rule_failed', { component: 'connector-notify', method, bucket, err });
    return false;
  }
}

/** Register (or replace) the bucket-notification rule for a storage connector's object key.
 *  Returns true on a 2xx from storage_service; false if disabled/unconfigured or on any error. */
export function registerConnectorNotification(bucket: string, prefix: string): Promise<boolean> {
  return call('POST', bucket, prefix);
}

/** Remove the bucket-notification rule for (bucket, prefix). Idempotent on the storage side. */
export function deregisterConnectorNotification(bucket: string, prefix: string): Promise<boolean> {
  return call('DELETE', bucket, prefix);
}

/** Read the bucket's LIVE notification-rule prefixes from storage_service (MinIO ground truth).
 *  Returns `{ prefixes }` on a 2xx (empty list = bucket has no rules), or `null` when storage is
 *  disabled/unconfigured/unreachable or returns a non-2xx. The caller MUST treat `null` as
 *  "couldn't check" — distinct from a 200 empty list ("definitely no rule") — and never flip a
 *  stored `notifyRegistered: true` to false on a transient unreachable. */
export async function bucketNotificationStatus(
  bucket: string,
): Promise<{ prefixes: string[] } | null> {
  const cfg = connectorNotificationsConfig();
  if (!cfg.enabled || !cfg.storageUrl) return null;
  try {
    const res = await governedSystemRequest(statusUrl(cfg.storageUrl, bucket), {
      method: 'GET',
    });
    if (res.status < 200 || res.status >= 300) return null;
    const body = JSON.parse(res.text || '{}') as { rules?: Array<{ prefix?: string }> };
    return { prefixes: (body.rules ?? []).map((r) => r.prefix ?? '') };
  } catch (err) {
    // Network/SSRF/timeout/parse — couldn't check. Caller treats null as "unknown" (never flips a
    // stored notifyRegistered:true to false). Log so a persistently-unreachable verify is visible.
    log.warn('connector_notify_status_check_failed', { component: 'connector-notify', bucket, err });
    return null;
  }
}
