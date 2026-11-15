// scripts/seed-dataset.ts — load a dataset from a local file (`bun run seed:dataset
// <file> [name]`). Detects the source type by extension, parses it, and persists it
// owned by the dev/bypass user so it shows up immediately in the Datasets screen.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { db, closeConnection, users } from '../src/db/client';
import { parseDataset } from '../src/datasets/parse';
import { createDataset } from '../src/datasets/dataset-service';
import type { DatasetSourceType } from '../src/db/dataset-types';

const DEV_OWNER = process.env.AUTH_BYPASS_USER_ID ?? '00000000-0000-0000-0000-000000000000';

const EXT_TO_TYPE: Record<string, DatasetSourceType> = {
  '.csv': 'csv',
  '.tsv': 'csv',
  '.xlsx': 'xlsx',
  '.xls': 'xlsx',
  '.json': 'json',
  '.txt': 'text',
};

const file = process.argv[2];
if (!file) {
  console.error('usage: bun run seed:dataset <file> [name]');
  process.exit(1);
}
const ext = path.extname(file).toLowerCase();
const sourceType = EXT_TO_TYPE[ext];
if (!sourceType) {
  console.error(`unsupported extension '${ext}' (csv/tsv/xlsx/xls/json/txt)`);
  process.exit(1);
}
const name = process.argv[3] ?? path.basename(file, ext);

const buf = await readFile(file);
const binary = new Uint8Array(buf);
const parsed = await parseDataset({
  sourceType,
  binary,
  text: sourceType === 'xlsx' ? undefined : new TextDecoder().decode(binary),
});

await db
  .insert(users)
  .values({ id: DEV_OWNER, email: 'dev@localhost', name: 'Dev User' })
  .onConflictDoNothing({ target: users.id });

const dataset = await createDataset({
  ownerId: DEV_OWNER,
  tenantId: DEV_OWNER,
  name,
  sourceType,
  parsed,
});

console.log(
  `[seed:dataset] '${dataset.name}' (${dataset.slug}) — ${dataset.row_count} rows, ${dataset.columns.length} columns${parsed.truncated ? `, truncated ${parsed.truncated}` : ''}`,
);
await closeConnection();
process.exit(0);
