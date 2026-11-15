// tests/storage-writer.test.ts — the Phase 2-F egress-gated object-storage WRITE path.
// Unit tests over uploadObject(): the multipart POST shape to storage_service, the
// trusted-network (NO X-Tenant-Id) vs token auth header, and the SSRF hard-block (the write path is
// decoupled from the user-connector policy but STILL refuses loopback/metadata). DNS +
// fetch are injected via the egress test seam so the run is offline + deterministic.
import { test, expect, afterEach } from 'bun:test';
import { uploadObject, StorageWriteError } from '../src/host/storage-writer';
import { __setEgressHooksForTests } from '../src/host/egress-guard';

const BASE = 'http://storage-api.storage.svc.cluster.local:8391';

afterEach(() => __setEgressHooksForTests(undefined));

test('uploadObject POSTs multipart to /api/files/upload with NO tenant header on the trusted network', async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  __setEgressHooksForTests({
    lookup: async () => ['10.43.1.7'], // a ClusterIP — private, allowed (no allowlist on the write path)
    fetch: async (input, init) => {
      captured = { url: String(input), init: init ?? {} };
      return new Response(JSON.stringify({ etag: 'x' }), { status: 200 });
    },
  });

  const res = await uploadObject(
    { baseUrl: BASE, bucket: 'artifacts' },
    'audit/2099/01/15/audit_log.ndjson',
    'a\nb\n',
    'application/x-ndjson',
  );

  expect(res).toEqual({ bucket: 'artifacts', objectKey: 'audit/2099/01/15/audit_log.ndjson', bytes: 4 });
  expect(captured!.url).toBe(`${BASE}/api/files/upload`);
  expect((captured!.init as { method: string }).method).toBe('POST');
  const headers = (captured!.init.headers ?? {}) as Record<string, string>;
  // trusted-network: no caller-asserted tenant at all (storage_service would ignore it anyway)
  expect(new Headers(headers).has('x-tenant-id')).toBe(false);
  const form = captured!.init.body as FormData;
  expect(form.get('bucket')).toBe('artifacts');
  expect(form.get('object_key')).toBe('audit/2099/01/15/audit_log.ndjson');
  expect(form.get('content_type')).toBe('application/x-ndjson');
  expect(form.get('file')).toBeInstanceOf(Blob);
});

test('a license token is sent as `Bearer <token>` (non-trusted / on-prem)', async () => {
  let headers: Record<string, string> = {};
  __setEgressHooksForTests({
    lookup: async () => ['93.184.216.34'],
    fetch: async (_input, init) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return new Response('{}', { status: 201 });
    },
  });
  await uploadObject(
    { baseUrl: BASE, bucket: 'compliance', token: 'lic-abc' },
    'k.json',
    '{}',
    'application/json',
  );
  expect(headers['X-Tenant-Id']).toBe('Bearer lic-abc');
});

test('SSRF: a target resolving to loopback is refused before any upload', async () => {
  let fetched = false;
  __setEgressHooksForTests({
    lookup: async () => ['127.0.0.1'],
    fetch: async () => {
      fetched = true;
      return new Response('{}', { status: 200 });
    },
  });
  await expect(
    uploadObject({ baseUrl: BASE, bucket: 'artifacts' }, 'k', 'x', 'text/plain'),
  ).rejects.toMatchObject({ code: 'egress_ssrf_blocked' });
  expect(fetched).toBe(false);
});

test('a non-2xx storage response throws StorageWriteError carrying the status', async () => {
  __setEgressHooksForTests({
    lookup: async () => ['10.43.1.7'],
    fetch: async () => new Response('bucket not found', { status: 400 }),
  });
  const err = await uploadObject({ baseUrl: BASE, bucket: 'nope' }, 'k', 'x', 'text/plain').catch(
    (e) => e,
  );
  expect(err).toBeInstanceOf(StorageWriteError);
  expect((err as StorageWriteError).status).toBe(400);
});

test('an unconfigured base URL throws before resolving', async () => {
  const err = await uploadObject({ baseUrl: '', bucket: 'b' }, 'k', 'x', 'text/plain').catch((e) => e);
  expect(err).toBeInstanceOf(StorageWriteError);
});
