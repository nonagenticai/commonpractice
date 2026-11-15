// src/host/storage-writer.ts — the WRITE twin of datasets/connectors/storage.ts.
// Uploads one object to the platform storage_service (the MinIO proxy that is the only
// holder of MinIO credentials). Used by the Phase 2-F compliance export to archive the
// audit log. Auth mirrors the read connector: a license token via
// `X-Tenant-Id: Bearer <token>`, OR — in-cluster — trusted-network pass-through with NO
// `X-Tenant-Id` header at all (a plain caller-asserted tenant is ignored by storage_service
// and would be a false assertion). The egress write helper (governedUpload)
// SSRF-guards the operator-configured host before any socket opens.
import { governedUpload } from './egress-guard';

export interface StorageUploadResult {
  bucket: string;
  objectKey: string;
  bytes: number;
}

export interface StorageWriterConfig {
  /** e.g. http://storage-api.storage.svc.cluster.local:8391 (no trailing /). */
  baseUrl: string;
  bucket: string;
  /** Optional license token — sent as `X-Tenant-Id: Bearer <token>` for non-trusted nets. */
  token?: string;
  timeoutMs?: number;
}

/** Thrown when storage_service rejects the upload (non-2xx). Carries the status so the
 *  caller persists a stable error without leaking the body/secret. */
export class StorageWriteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'StorageWriteError';
  }
}

/**
 * PUT one object into the configured bucket via storage_service `POST /api/files/upload`
 * (multipart: bucket, object_key, file, content_type). Returns the stored coordinates.
 */
export async function uploadObject(
  cfg: StorageWriterConfig,
  objectKey: string,
  body: Uint8Array | string,
  contentType: string,
): Promise<StorageUploadResult> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  if (!base) throw new StorageWriteError(0, 'storage base URL is not configured');
  const url = `${base}/api/files/upload`;

  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const form = new FormData();
  form.set('bucket', cfg.bucket);
  form.set('object_key', objectKey);
  form.set('content_type', contentType);
  form.set('file', new Blob([bytes], { type: contentType }), objectKey.split('/').pop() ?? 'object');

  const headers: Record<string, string> = cfg.token ? { 'X-Tenant-Id': `Bearer ${cfg.token}` } : {};

  const res = await governedUpload(url, { body: form, headers, timeoutMs: cfg.timeoutMs });
  if (res.status < 200 || res.status >= 300) {
    throw new StorageWriteError(res.status, `storage_service returned HTTP ${res.status}`);
  }
  return { bucket: cfg.bucket, objectKey, bytes: bytes.byteLength };
}
