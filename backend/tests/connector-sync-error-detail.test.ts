// tests/connector-sync-error-detail.test.ts — what a FAILED connector sync persists for the reader.
//
// ⛔ THE DEFECT. `datasets/connector-refresh.ts`'s catch wrote `sync_error_detail: { host, reason }`
// and nothing else, where `reason` is `err.message` — English prose. The reader's browser composes
// its sentence from `sync_error_code` + `sync_error_detail`
// (frontend/src/lib/api/error-message.ts `syncErrorText`), and three of the codes reachable on this
// path need a field that bag does not carry:
//
//     storage_format_unknown  needs details.key
//     xlsx_too_large          needs details.actualMb AND details.limitMb, as NUMBERS
//     bad_config              switches on details.reason as a snake_case DISCRIMINATOR
//
// Each entry returns `null` when its field is missing, which lands the reader on the English
// `sync_error` COLUMN. So a Dutch admin read English on /connectors — and because it is a column
// and not a response, it survived reload and re-login until that connector next synced cleanly.
//
// ⛔ THE FIELDS WERE NEVER MISSING. Every one of those raise sites already passes them to
// `badRequest(...)` as `HttpError.details`; the catch was throwing them away. The fix spreads
// `err.details` over `{ host, reason }` — LAST, so a thrower's own `reason` discriminator beats
// `err.message` — and this file is the persistence half of the proof.
//
// ⚠️ NOTHING HERE IS INJECTED AT THE SEAM. All three failures are raised by the real code on the
// real refresh path:
//   • bad_config/key_escapes_bucket — `connectors/storage.ts`'s request-time re-assertion of the
//     bucket boundary, which is the ONE of `bad_config`'s eight reasons a sync can reach at all
//     (`validateConnectorConfig` runs only on the save/test endpoints, so the other seven cannot).
//   • storage_format_unknown — `connectors/storage.ts`'s `guessFormat`, on an object whose
//     extension and content-type name no parser.
//   • xlsx_too_large — `parse/xlsx.ts`'s pre-parse guard, on a workbook whose worksheet entry
//     DECLARES 69 MB. Declared central-directory metadata is exactly what that guard reads by
//     design ("no decompression — entry sizes are declared metadata"), which is what makes a
//     faithful fixture 300 bytes instead of the 450,000-row one dataset-parse.test.ts needs.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { __setEgressHooksForTests } from '../src/host/egress-guard';
import { invalidatePolicyCache } from '../src/host/policy-store';
import { snapshotPolicies, restorePolicies, CONNECTOR_POLICY_KEYS } from './helpers/policy-snapshot';
import { createConnector } from '../src/datasets/connector-service';
import { refreshConnector } from '../src/datasets/connector-refresh';
import { db, users, datasets, datasetRows, policies, auditLog } from '../src/db/client';
import type { User } from '../src/types';

const OWNER_ID = '00000000-0000-0000-0000-0000c0de0001';
const owner: User = {
  id: OWNER_ID,
  email: 'syncdetail@test',
  name: 'Sync Detail Owner',
  roles: ['super_admin', 'employee'],
  tenantId: OWNER_ID,
};
const STORAGE_HOST = 'storage.detail.invalid';
const BASE_URL = `http://${STORAGE_HOST}:8391`;

/**
 * A minimal ZIP declaring `declaredUncompressed` bytes for one `xl/worksheets/*.xml` entry.
 *
 * ⚠️ THE DECLARATION *IS* THE ATTACK, not a shortcut around one. `assertWorksheetSizeBounded`
 * deliberately reads the central directory's declared sizes and never decompresses — that is the
 * whole point of a guard that must run BEFORE `wb.xlsx.load()` materializes the document. A file
 * that declares 69 MB of worksheet XML is precisely the shape it exists to refuse, so building the
 * central directory by hand exercises the real predicate on real bytes at ~300 bytes and ~1 ms.
 */
function xlsxDeclaringWorksheetBytes(declaredUncompressed: number): Uint8Array {
  const name = Buffer.from('xl/worksheets/sheet1.xml', 'utf8');
  const body = Buffer.from('<worksheet/>', 'utf8');

  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0); // local file header
  lfh.writeUInt16LE(20, 4); // version needed
  lfh.writeUInt16LE(0, 8); // method: stored
  lfh.writeUInt32LE(body.length, 18); // compressed size
  lfh.writeUInt32LE(declaredUncompressed, 22); // uncompressed size — the declaration
  lfh.writeUInt16LE(name.length, 26);
  const local = Buffer.concat([lfh, name, body]);

  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0); // central directory header
  cdh.writeUInt16LE(20, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(0, 10); // method: stored
  cdh.writeUInt32LE(body.length, 20);
  cdh.writeUInt32LE(declaredUncompressed, 24);
  cdh.writeUInt16LE(name.length, 28);
  cdh.writeUInt32LE(0, 42); // offset of the local header
  const central = Buffer.concat([cdh, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return new Uint8Array(Buffer.concat([local, central, eocd]));
}

const OVERSIZE_XLSX = xlsxDeclaringWorksheetBytes(69 * 1024 * 1024);

async function setAllowlist(allow: string[]) {
  for (const [key, value, control, category, label] of [
    ['models.external_http', true, 'toggle', 'models_tools', 'External HTTP'],
    ['data.egress_allowlist', allow, 'list', 'models_tools', 'Egress allowlist'],
  ] as const) {
    await db
      .insert(policies)
      .values({ key, value, control, category, label })
      .onConflictDoUpdate({ target: policies.key, set: { value } });
  }
  invalidatePolicyCache();
}

/** ⛔ THE DB IS SHARED WITH OTHER SESSIONS — every row this file writes is scoped to OWNER_ID and
 *  removed in both hooks. `audit_log.actor_id` is ON DELETE SET NULL, not cascade, so it has to go
 *  before the user or it is orphaned rather than deleted. */
async function cleanup() {
  const owned = await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.owner_id, OWNER_ID));
  for (const d of owned) await db.delete(datasetRows).where(eq(datasetRows.dataset_id, d.id));
  await db.delete(datasets).where(eq(datasets.owner_id, OWNER_ID));
  await db.delete(auditLog).where(eq(auditLog.actor_id, OWNER_ID));
  await db.delete(users).where(eq(users.id, OWNER_ID));
}

/** Captured in `beforeAll`, put back verbatim — never a literal. See helpers/policy-snapshot.ts. */
let POLICY_SNAPSHOT: Map<string, unknown>;

beforeAll(async () => {
  POLICY_SNAPSHOT = await snapshotPolicies(CONNECTOR_POLICY_KEYS);
  await cleanup();
  // `datasets.owner_id` is a real FK to `users.id`, and this file writes connectors directly
  // instead of going through the route that would have touched the user into existence.
  // `tenant_id` is left NULL — it is an FK to `tenants`, and nothing on the refresh path reads it
  // (`datasets.tenant_id` is a bare uuid with no FK — since 0084; it was text — and is set from
  // `createConnector`'s argument).
  await db.insert(users).values({ id: OWNER_ID, email: owner.email, name: owner.name });
  __setAuthOverridesForTests({ validateAuth: async () => owner });
  __setEgressHooksForTests({
    // The SSRF guard hard-blocks loopback, so the fake storage host resolves to a public IP.
    lookup: async () => ['93.184.216.34'],
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith('.xlsx')) {
        return new Response(OVERSIZE_XLSX, {
          headers: {
            'content-type':
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          },
        });
      }
      // No extension the guesser knows, and a content-type that names no parser either — the
      // input `guessFormat` is written to refuse.
      return new Response('\x00\x01binary', {
        headers: { 'content-type': 'application/octet-stream' },
      });
    },
  });
  await setAllowlist([STORAGE_HOST]);
}, 30_000);

afterAll(async () => {
  await cleanup();
  await restorePolicies(POLICY_SNAPSHOT);
  __setAuthOverridesForTests(undefined);
  __setEgressHooksForTests(undefined);
}, 30_000);

/**
 * Create a storage connector and sync it, returning the persisted failure row.
 *
 * ⛔ `createConnector` DIRECTLY, NOT `POST /api/connectors`. `validateConnectorConfig` rejects a
 * traversal key at save time, which is correct and must stay — so the only way to hold a stored
 * connector whose key escapes its bucket (a row written before that check, or a config edited
 * underneath it) is to write one. That is the row `storage.ts`'s request-time re-assertion exists
 * for, and it is the only `bad_config` reason a sync can reach.
 */
async function syncAndRead(name: string, key: string, format?: 'csv' | 'json' | 'xlsx') {
  const { dataset } = await createConnector({
    ownerId: OWNER_ID,
    tenantId: OWNER_ID,
    name,
    kind: 'storage',
    config: { kind: 'storage', baseUrl: BASE_URL, bucket: 'cp-detail-bucket', key, format },
    meta: { kind: 'storage', host: STORAGE_HOST, bucket: 'cp-detail-bucket', key, format },
    eventSource: 'none',
  });
  const outcome = await refreshConnector(dataset.id, { actorId: OWNER_ID });
  expect(outcome.ok, `the sync of '${name}' SUCCEEDED — there is no failure to assert about`).toBe(false);
  expect(outcome.skipped, `the sync of '${name}' was skipped by the advisory lock`).toBeUndefined();
  const [row] = await db.select().from(datasets).where(eq(datasets.id, dataset.id));
  expect(row, 'the connector row vanished').toBeTruthy();
  expect(row!.status).toBe('error');
  return row!;
}

test('THE DEFECT: xlsx_too_large persists actualMb + limitMb as NUMBERS, not just prose', async () => {
  const row = await syncAndRead('Detail Oversize Sheet', 'ledger.xlsx', 'xlsx');
  expect(row.sync_error_code).toBe('xlsx_too_large');
  const detail = row.sync_error_detail as Record<string, unknown> | null;
  expect(detail, 'nothing was persisted for the reader to compose a sentence from').toBeTruthy();

  // ⛔ THE ASSERTION THAT MATTERS, AND THE ONE A KEY-PRESENCE CHECK WOULD FAKE. `detailNum` in
  // frontend/src/lib/api/error-message.ts requires `typeof v === 'number'`: a jsonb round-trip that
  // handed back "69" instead of 69 makes the catalog entry return null, the reader falls back to
  // the English column, and the defect is intact while this test is green.
  expect(typeof detail!.actualMb, `actualMb came back as ${typeof detail!.actualMb}`).toBe('number');
  expect(typeof detail!.limitMb, `limitMb came back as ${typeof detail!.limitMb}`).toBe('number');
  expect(detail!.limitMb).toBe(60);
  expect(detail!.actualMb as number).toBeGreaterThan(60);
  // The host is still there — the fields are ADDED to the old bag, never swapped for it.
  expect(detail!.host).toBe(STORAGE_HOST);

  // ⛔ AND THE ENGLISH COLUMN SURVIVES VERBATIM. `ai/mcp/tools.ts`'s `describe_data` reads it, and
  // it is the documented fall-through for every pre-0074 row and every backend-first code.
  expect(row.sync_error).toStartWith('xlsx_too_large: ');
  expect(row.sync_error).toContain('over the 60 MB limit');
});

test('THE DEFECT: storage_format_unknown persists the object key the sentence names', async () => {
  const row = await syncAndRead('Detail Unknown Format', 'quarterly-extract');
  expect(row.sync_error_code).toBe('storage_format_unknown');
  const detail = row.sync_error_detail as Record<string, unknown> | null;
  expect(detail).toBeTruthy();
  // `carrying('key', …)` reads this and nothing else; without it the entry returns null.
  expect(detail!.key).toBe('quarterly-extract');
  expect(typeof detail!.key).toBe('string');
  expect(detail!.host).toBe(STORAGE_HOST);
  expect(row.sync_error).toStartWith('storage_format_unknown: ');
});

test('THE DEFECT: bad_config persists the DISCRIMINATOR, and it beats the English prose', async () => {
  const row = await syncAndRead('Detail Escaping Key', '../cp-victim-tenant/secret.csv', 'csv');
  expect(row.sync_error_code).toBe('bad_config');
  const detail = row.sync_error_detail as Record<string, unknown> | null;
  expect(detail).toBeTruthy();

  // ⛔ THE SPREAD-ORDER ASSERTION. `reason` starts out as `err.message` — the English sentence —
  // and `err.details.reason` is the snake_case token `byReason()` switches on. Spreading the
  // details LAST is what makes the discriminator win; reverse the order and this reads back a
  // whole English sentence and the eight-armed entry falls through to it.
  expect(detail!.reason, 'the English prose overwrote the discriminator').toBe('key_escapes_bucket');
  expect(typeof detail!.resolved).toBe('string');
  expect(detail!.resolved as string).toContain('/api/files/cp-victim-tenant/secret.csv');
  expect(detail!.host).toBe(STORAGE_HOST);

  // The prose the discriminator displaced is NOT lost — it is still the whole English column.
  expect(row.sync_error).toStartWith('bad_config: ');
  expect(row.sync_error).toContain('escapes its bucket');
});

test('THE CONTROL: a code whose thrower carries no details still persists exactly { host, reason }', async () => {
  // ⛔ THE OVER-CORRECTION GUARD. `EgressBlockedError` is not an `HttpError` and has no `details`
  // at all; a fix that reached for `.details` unconditionally, or that stopped writing `reason`,
  // would blank the one field the pre-0074 fall-through and the audit row both depend on. A
  // non-allowlisted host is the shortest way to that arm.
  await setAllowlist(['some.other.invalid']);
  try {
    const row = await syncAndRead('Detail Blocked Host', 'blocked.csv', 'csv');
    expect(row.sync_error_code).toBe('egress_host_not_allowlisted');
    const detail = row.sync_error_detail as Record<string, unknown> | null;
    expect(detail).toBeTruthy();
    expect(Object.keys(detail!).sort()).toEqual(['host', 'reason']);
    // Still the English prose, because this thrower supplied no discriminator to displace it.
    expect(detail!.reason as string).toContain('allowlist');
    expect(detail!.host).toBe(STORAGE_HOST);
  } finally {
    await setAllowlist([STORAGE_HOST]);
  }
});
