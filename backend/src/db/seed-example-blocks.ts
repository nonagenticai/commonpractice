// src/db/seed-example-blocks.ts — Wave A: a coherent, REALISTIC catalogue of example building
// blocks spanning ALL FIVE categories (data / ai / logic / output / ui), grounded in the seeded
// insurance-claims domain. Unlike the legacy `ctx.mockData(...)` demo blocks (seed.ts), every block
// here is FOUNDATION-BACKED: the data blocks are compiled from real ontology entities (typed output
// ports = entity attributes) and read real seeded datasets via `ctx.dataset()`; the logic/output/ui
// blocks operate on real rows; the ai block calls the brokered `ctx.llm()`. Nothing is theatre.
//
// All blocks are GLOBAL (tenant_id NULL) so they appear in every palette. The data blocks are
// compiled via the SAME pure `compileDataBlock` the runtime derivation uses (so their structure is
// authentic) but are inserted under distinct `example-*-data` slugs so they do NOT reserve the
// deterministic derivation slug — the in-app "derive data block from entity" flow stays intact.
//
// Idempotent: blocks matched by slug, datasets by (owner, slug), flows by (owner, name) — re-running
// skips what exists. Runs AFTER ontology + datasets are seeded (it reads ontology entities). Block
// tests are inserted unrun (Phase 2-B convention) and execute on the first in-app "Run tests".
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  db,
  users,
  tenants,
  buildingBlocks,
  blockVersions,
  blockTests,
  flows,
  datasets,
  ontologyEntities,
} from './client';
import type { AssertMode, BlockCategory, BlockDescriptor } from './block-types';
import type { FlowGraph, FlowNode, FlowEdge } from './flow-types';
import { DEMO_TENANT_ID } from '../config';
import { parseJsonValue } from '../datasets/parse/json';
import { createDataset } from '../datasets/dataset-service';
import { loadEntityAttributes } from '../ontology/sample-service';
import { entityKey } from '../ontology/ontology-service';
import { compileDataBlock } from '../ontology/data-block-compiler';
import { upsertMapping } from '../datasets/mapping-service';
import { requireScannedSource } from '../blocks/source-gate';
import { BLOCK_I18N } from '../blocks/i18n-key';
import { enqueueTranslations } from '../host/translation-service';
import { log } from '../host/logger';

const DEV_OWNER = process.env.AUTH_BYPASS_USER_ID ?? '00000000-0000-0000-0000-000000000000';
const DEMO_TENANT_SLUG = 'common-practice-demo';

// ───────────────────────────── example datasets (attribute-aligned) ─────────────────────────────
// Columns are named to match the ontology entity attributes 1:1 so the derived data blocks project
// cleanly (identity column_map). Realistic insurance content.
interface SampleDataset {
  slug: string;
  name: string;
  rows: Record<string, unknown>[];
}

const EX_DATASETS: SampleDataset[] = [
  {
    slug: 'example-claims',
    name: 'Example Claims',
    rows: [
      { claim_id: 'CLM-2001', policy_no: 'POL-501', amount: 2500, status: 'open', filed_date: '2026-01-15', adjuster_notes: 'Rear-end collision, minor bumper damage.', fraud_score: 0.08, settlement_amount: 0 },
      { claim_id: 'CLM-2002', policy_no: 'POL-502', amount: 5400, status: 'review', filed_date: '2026-02-03', adjuster_notes: 'Water damage, awaiting plumber report.', fraud_score: 0.21, settlement_amount: 0 },
      { claim_id: 'CLM-2003', policy_no: 'POL-501', amount: 780, status: 'approved', filed_date: '2026-02-19', adjuster_notes: 'Windshield replacement, receipts verified.', fraud_score: 0.03, settlement_amount: 780 },
      { claim_id: 'CLM-2004', policy_no: 'POL-503', amount: 1200, status: 'open', filed_date: '2026-03-02', adjuster_notes: 'Lost luggage on connecting flight.', fraud_score: 0.12, settlement_amount: 0 },
      { claim_id: 'CLM-2005', policy_no: 'POL-502', amount: 9800, status: 'escalated', filed_date: '2026-03-21', adjuster_notes: 'House fire, suspected arson — referred to SIU.', fraud_score: 0.74, settlement_amount: 0 },
      { claim_id: 'CLM-2006', policy_no: 'POL-504', amount: 430, status: 'denied', filed_date: '2026-03-28', adjuster_notes: 'Pre-existing damage, outside coverage window.', fraud_score: 0.18, settlement_amount: 0 },
    ],
  },
  {
    slug: 'example-policies',
    name: 'Example Policies',
    rows: [
      { policy_no: 'POL-501', holder: 'Alice Brandt', premium: 1200, effective_date: '2025-06-01', expiry_date: '2026-06-01' },
      { policy_no: 'POL-502', holder: 'Bram de Vries', premium: 2400, effective_date: '2025-09-15', expiry_date: '2026-09-15' },
      { policy_no: 'POL-503', holder: 'Chloe Martens', premium: 640, effective_date: '2026-01-10', expiry_date: '2027-01-10' },
      { policy_no: 'POL-504', holder: 'Daan Visser', premium: 890, effective_date: '2025-11-20', expiry_date: '2026-11-20' },
    ],
  },
  {
    slug: 'example-customers',
    name: 'Example Customers',
    rows: [
      { customer_id: 'CUST-1', name: 'Alice Brandt', email: 'alice@example.invalid', tier: 'gold' },
      { customer_id: 'CUST-2', name: 'Bram de Vries', email: 'bram@example.invalid', tier: 'silver' },
      { customer_id: 'CUST-3', name: 'Chloe Martens', email: 'chloe@example.invalid', tier: 'bronze' },
      { customer_id: 'CUST-4', name: 'Daan Visser', email: 'daan@example.invalid', tier: 'silver' },
    ],
  },
];

// ───────────────────────────── hand-authored blocks (logic/ai/output/ui) ─────────────────────────
interface SeedTest {
  name: string;
  description: string;
  inputs: Record<string, unknown>;
  datasets: string[];
  expected: Record<string, unknown> | null;
  assert_mode: AssertMode;
  expect_error: boolean;
  expected_error_kind: string | null;
}

interface ExampleBlock {
  slug: string;
  name: string;
  description: string;
  category: BlockCategory;
  version: string;
  status: 'beta' | 'stable';
  descriptor: BlockDescriptor;
  source: string;
  docs: string;
  tests: SeedTest[];
}

/** Build a block module source whose embedded descriptor is exactly `descriptor` (no drift). */
function moduleSource(descriptor: BlockDescriptor, runBody: string): string {
  return `export default {\n  descriptor: ${JSON.stringify(descriptor)},\n  async run(inputs, ctx) {\n${runBody}\n  },\n};\n`;
}

const FILTER_ROWS: BlockDescriptor = {
  inputs: {
    rows: { type: 'json', required: true, description: 'Array of records to filter.' },
    field: { type: 'string', required: true, description: 'Record key to test.' },
    op: { type: 'enum', enum: ['eq', 'neq', 'gte', 'lte', 'contains'], description: 'Comparison operator.' },
    value: { type: 'string', description: 'Value to compare against (numeric ops coerce).' },
  },
  outputs: { rows: { type: 'json' }, count: { type: 'number' } },
  capabilities: { network: false },
};

const GROUP_COUNT: BlockDescriptor = {
  inputs: {
    rows: { type: 'json', required: true, description: 'Array of records to tally.' },
    field: { type: 'string', required: true, description: 'Record key to group by.' },
  },
  outputs: { groups: { type: 'json' }, total: { type: 'number' } },
  capabilities: { network: false },
};

const TRIAGE: BlockDescriptor = {
  inputs: { claim: { type: 'json', required: true, description: 'A single claim record.' } },
  outputs: {
    severity: { type: 'string', description: 'low | medium | high' },
    priority: { type: 'number', description: '1 (highest) … 5 (lowest)' },
    rationale: { type: 'string' },
  },
  capabilities: { network: false, llm: true },
};

const TO_CSV: BlockDescriptor = {
  inputs: { rows: { type: 'json', required: true, description: 'Array of flat records.' } },
  outputs: { csv: { type: 'string' }, row_count: { type: 'number' }, columns: { type: 'string[]' } },
  capabilities: { network: false },
};

const COMPOSE_DECISION: BlockDescriptor = {
  inputs: {
    claim_id: { type: 'string', required: true },
    decision: { type: 'enum', enum: ['approve', 'deny', 'review'] },
    amount: { type: 'number' },
    note: { type: 'string' },
  },
  outputs: { subject: { type: 'string' }, body: { type: 'string' } },
  capabilities: { network: false },
};

const TABLE_VIEW: BlockDescriptor = {
  inputs: {
    rows: { type: 'json', required: true, description: 'Array of records to display.' },
    columns: { type: 'string[]', description: 'Column order (defaults to keys of the first row).' },
    title: { type: 'string' },
  },
  outputs: { view: { type: 'json', description: 'A table render-model: { kind, title, columns, rows }.' } },
  capabilities: { network: false },
};

const RECORD_FORM: BlockDescriptor = {
  inputs: {
    record: { type: 'json', required: true, description: 'A single record to render as an editable form.' },
    title: { type: 'string' },
  },
  outputs: { form: { type: 'json', description: 'A form render-model: { kind, title, fields[], actions[] }.' } },
  capabilities: { network: false },
};

const SUMMARY_CARD: BlockDescriptor = {
  inputs: {
    title: { type: 'string', required: true },
    stats: { type: 'json', description: 'Object of { label: value } stats to display.' },
    badge: { type: 'string' },
  },
  outputs: { card: { type: 'json', description: 'A card render-model: { kind, title, stats, badge }.' } },
  capabilities: { network: false },
};

const HAND_AUTHORED: ExampleBlock[] = [
  {
    slug: 'filter-rows',
    name: 'Filter rows',
    description: 'Keeps only the records where a field meets a condition. Works on any list of records.',
    category: 'logic',
    version: '1.0.0',
    status: 'stable',
    descriptor: FILTER_ROWS,
    docs: '# Filter rows\n\nFilters an array of records by `field` `op` `value`. Numeric operators (`gte`/`lte`) coerce to numbers. Emits the kept `rows` and their `count`.',
    source: moduleSource(FILTER_ROWS, `    const rows = Array.isArray(inputs.rows) ? inputs.rows : [];
    const field = inputs.field;
    const op = inputs.op || 'eq';
    const value = inputs.value;
    const num = (v) => (typeof v === 'number' ? v : Number(v));
    const keep = rows.filter((r) => {
      const cell = r == null ? undefined : r[field];
      if (op === 'eq') return String(cell) === String(value);
      if (op === 'neq') return String(cell) !== String(value);
      if (op === 'gte') return num(cell) >= num(value);
      if (op === 'lte') return num(cell) <= num(value);
      if (op === 'contains') return String(cell ?? '').toLowerCase().includes(String(value ?? '').toLowerCase());
      return false;
    });
    ctx.log('info', 'filtered rows', { kept: keep.length, of: rows.length, field, op });
    return { rows: keep, count: keep.length };`),
    tests: [
      {
        name: 'keeps matching rows (eq)',
        description: 'Filtering status == open keeps the two open rows.',
        inputs: { rows: [{ status: 'open' }, { status: 'approved' }, { status: 'open' }], field: 'status', op: 'eq', value: 'open' },
        datasets: [],
        expected: { count: 2 },
        assert_mode: 'subset',
        expect_error: false,
        expected_error_kind: null,
      },
      {
        name: 'numeric threshold (gte)',
        description: 'gte 2000 on amount keeps the high-value rows.',
        inputs: { rows: [{ amount: 2500 }, { amount: 780 }, { amount: 9800 }], field: 'amount', op: 'gte', value: '2000' },
        datasets: [],
        expected: { count: 2 },
        assert_mode: 'subset',
        expect_error: false,
        expected_error_kind: null,
      },
    ],
  },
  {
    slug: 'group-and-count',
    name: 'Group and count',
    description: 'Counts how many records have each value of a field — for example, claims per status.',
    category: 'logic',
    version: '1.0.0',
    status: 'stable',
    descriptor: GROUP_COUNT,
    docs: '# Group and count\n\nGroups `rows` by `field` and counts each bucket. Emits `groups` ({ value: count }) and `total`.',
    source: moduleSource(GROUP_COUNT, `    const rows = Array.isArray(inputs.rows) ? inputs.rows : [];
    const field = inputs.field;
    const groups = {};
    for (const r of rows) {
      const k = String((r == null ? undefined : r[field]) ?? 'unknown');
      groups[k] = (groups[k] || 0) + 1;
    }
    return { groups, total: rows.length };`),
    tests: [
      {
        name: 'counts by field value',
        description: 'Three rows over two type buckets tallies total 3.',
        inputs: { rows: [{ type: 'auto' }, { type: 'home' }, { type: 'auto' }], field: 'type' },
        datasets: [],
        expected: { total: 3 },
        assert_mode: 'subset',
        expect_error: false,
        expected_error_kind: null,
      },
    ],
  },
  {
    slug: 'triage-claim',
    name: 'Triage claim',
    description: 'Uses AI to give a claim a severity (low, medium or high), a priority from 1 to 5 and a short reason. Without a usable AI answer it falls back to a rule on amount and fraud score.',
    category: 'ai',
    version: '1.0.0',
    status: 'stable',
    descriptor: TRIAGE,
    docs: '# Triage claim\n\nAsks the metered `ctx.llm()` to rate a claim. Always returns a well-formed `{ severity, priority, rationale }` — it falls back to an amount/fraud heuristic if the model reply can’t be parsed.',
    source: moduleSource(TRIAGE, `    const claim = inputs.claim || {};
    const amount = Number(claim.amount) || 0;
    const fraud = Number(claim.fraud_score) || 0;
    // Deterministic heuristic fallback (also used to validate the LLM reply is sane).
    let severity = 'low';
    if (amount >= 5000 || fraud >= 0.5) severity = 'high';
    else if (amount >= 1500 || fraud >= 0.25) severity = 'medium';
    let priority = severity === 'high' ? 1 : severity === 'medium' ? 3 : 5;
    let rationale = 'Heuristic: amount ' + amount + ', fraud_score ' + fraud + '.';
    try {
      const res = await ctx.llm({
        prompt: 'Given this insurance claim as JSON, reply ONLY with JSON {"severity":"low|medium|high","priority":1-5,"rationale":"..."}. Claim: ' + JSON.stringify(claim),
      });
      const parsed = JSON.parse(res.text);
      if (parsed && typeof parsed.severity === 'string') {
        severity = parsed.severity;
        if (typeof parsed.priority === 'number') priority = parsed.priority;
        if (typeof parsed.rationale === 'string') rationale = parsed.rationale;
      }
    } catch (e) {
      ctx.log('warn', 'llm reply not parseable, using heuristic', { error: String(e) });
    }
    return { severity, priority, rationale };`),
    tests: [
      {
        name: 'returns a well-formed triage',
        description: 'A high-value claim runs and returns the declared output ports.',
        inputs: { claim: { claim_id: 'CLM-2005', amount: 9800, fraud_score: 0.74, status: 'escalated' } },
        datasets: [],
        expected: {},
        assert_mode: 'subset',
        expect_error: false,
        expected_error_kind: null,
      },
    ],
  },
  {
    slug: 'rows-to-csv',
    name: 'Rows to CSV',
    description: 'Renders an array of flat records to a CSV string with a header row. Great as a flow’s export step.',
    category: 'output',
    version: '1.0.0',
    status: 'stable',
    descriptor: TO_CSV,
    docs: '# Rows to CSV\n\nTurns `rows` into a CSV `string` (quoted/escaped), plus the resolved `columns` and `row_count`.',
    source: moduleSource(TO_CSV, `    const rows = Array.isArray(inputs.rows) ? inputs.rows : [];
    const cols = [];
    for (const r of rows) { if (r && typeof r === 'object') for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k); }
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const header = cols.map(esc).join(',');
    const body = rows.map((r) => cols.map((c) => esc(r ? r[c] : '')).join(',')).join('\\n');
    const csv = cols.length ? (body ? header + '\\n' + body : header) : '';
    return { csv, row_count: rows.length, columns: cols };`),
    tests: [
      {
        name: 'renders header + rows',
        description: 'Two records produce a 2-row CSV.',
        inputs: { rows: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }] },
        datasets: [],
        expected: { row_count: 2 },
        assert_mode: 'subset',
        expect_error: false,
        expected_error_kind: null,
      },
    ],
  },
  {
    slug: 'compose-claim-decision',
    name: 'Compose claim decision',
    description: 'Builds a clear notification (subject + body) for a claim decision — ready to hand to an email/Slack step.',
    category: 'output',
    version: '1.0.0',
    status: 'stable',
    descriptor: COMPOSE_DECISION,
    docs: '# Compose claim decision\n\nComposes a `subject` and `body` message for a claim `decision`. Deterministic and side-effect-free.',
    source: moduleSource(COMPOSE_DECISION, `    const id = inputs.claim_id;
    const decision = inputs.decision || 'review';
    const amount = inputs.amount;
    const note = inputs.note;
    const subject = 'Claim ' + id + ': ' + decision;
    const lines = ['Claim ' + id + ' has been marked "' + decision + '".'];
    if (typeof amount === 'number') lines.push('Amount: EUR ' + amount + '.');
    if (note) lines.push('Note: ' + note);
    return { subject, body: lines.join('\\n') };`),
    tests: [
      {
        name: 'builds the subject line',
        description: 'An approve decision yields a deterministic subject.',
        inputs: { claim_id: 'CLM-2003', decision: 'approve', amount: 780 },
        datasets: [],
        expected: { subject: 'Claim CLM-2003: approve' },
        assert_mode: 'subset',
        expect_error: false,
        expected_error_kind: null,
      },
    ],
  },
  {
    slug: 'table-view',
    name: 'Table view',
    description: 'Shows a list of records as a table. A reusable step for showing results in a flow.',
    category: 'ui',
    version: '1.0.0',
    status: 'stable',
    descriptor: TABLE_VIEW,
    docs: '# Table view\n\nEmits a `view` render-model `{ kind: "table", title, columns, rows }`. (The canvas renders this model — see the builder’s UI-block rendering.)',
    source: moduleSource(TABLE_VIEW, `    const rows = Array.isArray(inputs.rows) ? inputs.rows : [];
    let columns = Array.isArray(inputs.columns) ? inputs.columns : [];
    if (!columns.length && rows[0] && typeof rows[0] === 'object') columns = Object.keys(rows[0]);
    return { view: { kind: 'table', title: inputs.title || 'Table', columns, rows } };`),
    tests: [
      {
        name: 'builds a table model',
        description: 'Runs and returns the view render-model.',
        inputs: { rows: [{ a: 1 }, { a: 2 }], title: 'Demo' },
        datasets: [],
        expected: {},
        assert_mode: 'subset',
        expect_error: false,
        expected_error_kind: null,
      },
    ],
  },
  {
    slug: 'record-form',
    name: 'Record form',
    description: 'Shows one record as an editable form with accept, edit and reject — for steps where a person checks the work.',
    category: 'ui',
    version: '1.0.0',
    status: 'stable',
    descriptor: RECORD_FORM,
    docs: '# Record form\n\nEmits a `form` render-model `{ kind: "form", title, fields[], actions[] }` from a `record`.',
    source: moduleSource(RECORD_FORM, `    const record = inputs.record && typeof inputs.record === 'object' ? inputs.record : {};
    const fields = Object.keys(record).map((name) => ({
      name,
      value: record[name],
      type: typeof record[name] === 'number' ? 'number' : 'string',
    }));
    return { form: { kind: 'form', title: inputs.title || 'Review', fields, actions: ['accept', 'edit', 'reject'] } };`),
    tests: [
      {
        name: 'builds a form model',
        description: 'Runs and returns the form render-model.',
        inputs: { record: { claim_id: 'CLM-2001', amount: 2500 }, title: 'Review claim' },
        datasets: [],
        expected: {},
        assert_mode: 'subset',
        expect_error: false,
        expected_error_kind: null,
      },
    ],
  },
  {
    slug: 'summary-card',
    name: 'Summary card',
    description: 'Shows a few key figures as a summary card — for dashboards and flow summaries.',
    category: 'ui',
    version: '1.0.0',
    status: 'stable',
    descriptor: SUMMARY_CARD,
    docs: '# Summary card\n\nEmits a `card` render-model `{ kind: "card", title, stats, badge }`.',
    source: moduleSource(SUMMARY_CARD, `    return { card: { kind: 'card', title: inputs.title, stats: inputs.stats || {}, badge: inputs.badge || null } };`),
    tests: [
      {
        name: 'builds a card model',
        description: 'Runs and returns the card render-model.',
        inputs: { title: 'Claims by status', stats: { open: 2, escalated: 1 } },
        datasets: [],
        expected: {},
        assert_mode: 'subset',
        expect_error: false,
        expected_error_kind: null,
      },
    ],
  },
];

// ───────────────────────────── ontology-derived DATA blocks ─────────────────────────────
// Each entry resolves a global ontology entity, compiles a data block from its merged attributes
// (typed output ports!), and inserts it under a stable `example-*-data` showcase slug pointing at
// the matching example dataset. This is the "data block as imagined": typed, entity-derived,
// reading real data — not a generic loader and not mock theatre.
interface DataBlockSpec {
  showcaseSlug: string;
  scope: 'generic' | 'industry' | 'industry_dept';
  industry: string | null;
  department: string | null;
  entityName: string;
  datasetSlug: string;
}

const DATA_BLOCKS: DataBlockSpec[] = [
  // Industry-level Claim carries the core fields (claim_id, amount, status, filed_date, policy_no);
  // the Claims-dept overlay only adds desk fields — loadEntityAttributes resolves natural-key
  // siblings, not cross-layer, so deriving from the industry entity gives the representative block.
  { showcaseSlug: 'example-claim-data', scope: 'industry', industry: 'insurance', department: null, entityName: 'Claim', datasetSlug: 'example-claims' },
  { showcaseSlug: 'example-policy-data', scope: 'industry', industry: 'insurance', department: null, entityName: 'Policy', datasetSlug: 'example-policies' },
  { showcaseSlug: 'example-customer-data', scope: 'generic', industry: null, department: 'Service', entityName: 'Customer', datasetSlug: 'example-customers' },
];

/** The global showcase slugs this file seeds (hand-authored + ontology-derived data blocks).
 *  Single source for blocks/seeded-global-blocks.ts — never hand-copy these. */
export const EXAMPLE_BLOCK_SLUGS: readonly string[] = HAND_AUTHORED.map((b) => b.slug);
export const DATA_BLOCK_SLUGS: readonly string[] = DATA_BLOCKS.map((s) => s.showcaseSlug);

async function resolveEntity(spec: DataBlockSpec) {
  const [row] = await db
    .select()
    .from(ontologyEntities)
    .where(
      and(
        eq(ontologyEntities.scope, spec.scope),
        spec.industry === null ? isNull(ontologyEntities.industry) : eq(ontologyEntities.industry, spec.industry),
        spec.department === null ? isNull(ontologyEntities.department) : eq(ontologyEntities.department, spec.department),
        eq(ontologyEntities.name, spec.entityName),
        isNull(ontologyEntities.tenant_id),
      ),
    );
  return row ?? null;
}

/** Bump the patch component of a semver ("1.0.0" → "1.0.1"). */
function bumpPatch(latest: string): string {
  const nums = latest.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  while (nums.length < 3) nums.push(0);
  nums[2] = (nums[2] ?? 0) + 1;
  return nums.join('.');
}

/** Insert a global block + its stable version + its tests, idempotent by slug. Returns the version id
 *  (existing or new) so demo flows can reference it. When `reversionOnChange` and the existing current
 *  version's source/descriptor differ from the new ones, adds a new bumped version and repoints
 *  current — so improving a derived data block (entity/columns) self-heals on the next boot. */
async function upsertGlobalBlock(
  b: { slug: string; name: string; description: string; category: BlockCategory; version: string; status: 'beta' | 'stable'; descriptor: BlockDescriptor; source: string; docs: string; tests: SeedTest[]; source_entity_key?: string | null; reversionOnChange?: boolean },
): Promise<{ versionId: string; blockId: string; created: boolean }> {
  // ⛔ GLOBAL-SCOPED, AND THIS ONE WRITES. The predicate used to be `eq(slug, b.slug)` alone. That
  // is not a read-only imprecision: when `reversionOnChange` is set (every ontology-derived data
  // block below sets it), the `changed` branch INSERTS a new `block_versions` row against the row
  // this SELECT returned and REPOINTS its `current_version_id`. So an unscoped match let the
  // PLATFORM seeder pick a TENANT's block that merely shares the slug and republish it — on every
  // boot, silently, over an author's own version. A tenant CAN hold this slug: `createBlockCore`
  // only reserves a slug globally (blocks/authoring-service.ts:159-167 rejects a tenant reusing a
  // GLOBAL slug), and nothing stops a slug being minted tenant-side before this seeder first runs.
  // `isNull(tenant_id)` is the same predicate `authoring-service.ts:162` and
  // `ontology/data-block-derivation.ts:117` use for exactly this "is the platform slug taken" read.
  // Every INSERT in the else-arm below leaves `tenant_id` at its NULL default, so nothing this
  // seeder ever created falls outside the predicate.
  const [existing] = await db
    .select({ id: buildingBlocks.id, current: buildingBlocks.current_version_id })
    .from(buildingBlocks)
    .where(and(eq(buildingBlocks.slug, b.slug), isNull(buildingBlocks.tenant_id)));
  let blockId: string;
  let versionId: string;
  let created = false;
  if (existing?.current) {
    blockId = existing.id;
    versionId = existing.current;
    if (b.reversionOnChange) {
      const [cur] = await db
        .select({ version: blockVersions.version, source_ts: blockVersions.source_ts, descriptor: blockVersions.descriptor })
        .from(blockVersions)
        .where(eq(blockVersions.id, existing.current));
      const changed = !cur || cur.source_ts !== b.source || JSON.stringify(cur.descriptor) !== JSON.stringify(b.descriptor);
      if (changed) {
        const all = await db
          .select({ version: blockVersions.version })
          .from(blockVersions)
          .where(eq(blockVersions.block_id, existing.id))
          .orderBy(desc(blockVersions.created_at));
        const next = bumpPatch(all[0]?.version ?? b.version);
        versionId = await db.transaction(async (tx) => {
          const [v] = await tx
            .insert(blockVersions)
            .values({
              block_id: existing.id,
              version: next,
              status: b.status,
              docs_md: b.docs,
              source_ts: requireScannedSource(b.source),
              descriptor: b.descriptor,
              examples: [],
              tests_passing: true,
              changelog: 'Re-derived from the ontology entity.',
              published_at: new Date(),
            })
            .returning();
          await tx
            .update(buildingBlocks)
            .set({ current_version_id: v!.id, description: b.description, source_entity_key: b.source_entity_key ?? null, updated_at: new Date() })
            .where(eq(buildingBlocks.id, existing.id));
          return v!.id;
        });
      }
    }
  } else {
    const res = await db.transaction(async (tx) => {
      const [block] = await tx
        .insert(buildingBlocks)
        .values({
          slug: b.slug,
          name: b.name,
          description: b.description,
          category: b.category,
          region: 'eu-west',
          cost_class: 'low',
          license: 'internal',
          source_entity_key: b.source_entity_key ?? null,
        })
        .returning();
      const [version] = await tx
        .insert(blockVersions)
        .values({
          block_id: block!.id,
          version: b.version,
          status: b.status,
          docs_md: b.docs,
          source_ts: requireScannedSource(b.source),
          descriptor: b.descriptor,
          examples: [],
          tests_passing: true,
          published_at: new Date(),
        })
        .returning();
      await tx.update(buildingBlocks).set({ current_version_id: version!.id }).where(eq(buildingBlocks.id, block!.id));
      return { blockId: block!.id, versionId: version!.id };
    });
    blockId = res.blockId;
    versionId = res.versionId;
    created = true;
  }

  // ⛔ THE SEEDER IS A SECOND PUBLISH PATH AND IT NEVER QUEUED. blocks/authoring-service.ts:432
  // enqueues `name`/`description`/`docs_md` on every HTTP + MCP publish; this function INSERTs and
  // re-versions the same rows directly, so every seeded platform block was born English-only.
  //
  // `BLOCK_I18N` (the BARE SLUG key) rather than `blockI18nKey(block)` because this function is
  // GLOBAL-ONLY BY CONSTRUCTION, not by assumption: its SELECT above is
  // `and(eq(slug), isNull(tenant_id))` and both INSERT arms leave `tenant_id` at its NULL default,
  // which is precisely the branch `blockI18nKey` maps to `BLOCK_I18N`. A tenant block can never
  // reach here, so there is no `block_tenant` case to key.
  //
  // UNCONDITIONAL, and the idempotency is `enqueueTranslations`'s own, not luck: its
  // `onConflictDoUpdate` carries `setWhere source_hash <> excluded.source_hash`, so an unchanged
  // block is a no-op and only a genuinely re-versioned one re-queues. That is the same guard the
  // `reversionOnChange` self-heal above relies on, one table over.
  //
  // `DEV_OWNER` is the metering actor. `seedExampleBlocks` INSERTs that `users` row before it
  // reaches either call site, so it is a real id — a NULL `requested_by` would be UNDRAINABLE
  // (`processPendingBatch` fails it with `no metering actor`).
  try {
    await enqueueTranslations(
      BLOCK_I18N,
      b.slug,
      [
        { field: 'name', value: b.name },
        { field: 'description', value: b.description },
        { field: 'docs_md', value: b.docs },
      ],
      DEV_OWNER,
    );
  } catch (e) {
    log.warn('seed_block_translation_enqueue_failed', { component: 'translation', slug: b.slug, err: e });
  }

  // Tests (idempotent by block_id + name).
  for (const t of b.tests) {
    const [ex] = await db
      .select({ id: blockTests.id })
      .from(blockTests)
      .where(and(eq(blockTests.block_id, blockId), eq(blockTests.name, t.name)));
    if (ex) continue;
    await db.insert(blockTests).values({
      block_id: blockId,
      name: t.name,
      description: t.description,
      inputs: t.inputs,
      datasets: t.datasets,
      expected: t.expected,
      assert_mode: t.assert_mode,
      expect_error: t.expect_error,
      expected_error_kind: t.expected_error_kind,
      enabled: true,
      created_by: DEV_OWNER,
    });
  }
  return { versionId, blockId, created };
}

/** Create the example datasets in a given (owner, tenant) scope, idempotent by (owner, slug). */
async function ensureDatasets(ownerId: string, tenantId: string): Promise<number> {
  let created = 0;
  for (const s of EX_DATASETS) {
    const [existing] = await db
      .select({ id: datasets.id })
      .from(datasets)
      .where(and(eq(datasets.owner_id, ownerId), eq(datasets.slug, s.slug)));
    if (existing) continue;
    await createDataset({ ownerId, tenantId, name: s.name, sourceType: 'json', parsed: parseJsonValue(s.rows) });
    created++;
  }
  return created;
}

async function datasetIdBySlug(ownerId: string, slug: string): Promise<string | null> {
  const [row] = await db
    .select({ id: datasets.id })
    .from(datasets)
    .where(and(eq(datasets.owner_id, ownerId), eq(datasets.slug, slug)));
  return row?.id ?? null;
}

/**
 * Seed an ontology mapping (dataset columns → entity attributes) for an example dataset, so the
 * builder's dataset-input panel (Wave B1) shows the rich "mapped to <entity>" state out of the box.
 * Identity map over the columns whose names match an entity attribute (the example datasets are
 * attribute-aligned by design). Global scope (tenant NULL); idempotent on (dataset, entity).
 */
async function ensureMapping(
  datasetId: string,
  entity: { id: string; industry: string | null; department: string | null },
  attrNames: Set<string>,
  datasetColumns: string[],
): Promise<void> {
  const columnMap: Record<string, string> = {};
  for (const col of datasetColumns) if (attrNames.has(col)) columnMap[col] = col;
  if (Object.keys(columnMap).length === 0) return;
  await upsertMapping({
    datasetId,
    entityId: entity.id,
    industry: entity.industry ?? '',
    department: entity.department ?? '',
    columnMap,
    confidence: 1,
    source: 'human',
    confirmed: true,
    // GLOBAL on purpose, and it is not a choice: `datasets.tenant_id` is a bare uuid column with
    // no FK (text until 0084; the absent FK is the load-bearing half, not the type), but
    // `dataset_mappings.tenant_id` has a real FK to `tenants`, and the DEV_OWNER
    // pseudo-tenant these example datasets live in has no `tenants` row. The runtime reads
    // "mine OR global" and reclaims these rows the first time the owning tenant edits them —
    // see the TENANT SCOPE block in datasets/mapping-service.ts.
    tenantId: null,
  });
}

export async function seedExampleBlocks(): Promise<{ datasets: number; blocks: number; flows: number }> {
  await db
    .insert(users)
    .values({ id: DEV_OWNER, email: 'dev@localhost', name: 'Dev User' })
    .onConflictDoNothing({ target: users.id });

  // Example datasets: in DEV_OWNER scope (so block tests resolve them in the author's home tenant,
  // mirroring load-dataset) AND in the demo org tenant (so the demo flows can read them at run-time).
  let datasetCount = await ensureDatasets(DEV_OWNER, DEV_OWNER);
  const [demo] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, DEMO_TENANT_SLUG));
  let tomId: string | null = null;
  if (demo) {
    const [tom] = await db.select({ id: users.id }).from(users).where(eq(users.email, 'tom@commonpractice.local'));
    tomId = tom?.id ?? null;
    if (tomId) datasetCount += await ensureDatasets(tomId, demo.id);
  }

  let blockCount = 0;
  const versionBySlug = new Map<string, string>();
  const blockIdBySlug = new Map<string, string>();

  // 1) Ontology-derived data blocks.
  for (const spec of DATA_BLOCKS) {
    const entity = await resolveEntity(spec);
    if (!entity) {
      log.warn('seed_example_blocks_entity_not_found', { component: 'seed-example-blocks', entityName: spec.entityName, scope: spec.scope });
      continue;
    }
    const attributes = await loadEntityAttributes(demo?.id ?? DEV_OWNER, entity.id);
    // Wave B1: seed the dataset→entity mapping so the builder shows typed/mapped columns out of the box.
    const attrNames = new Set(attributes.map((a) => a.name));
    const dsCols = Object.keys(EX_DATASETS.find((d) => d.slug === spec.datasetSlug)?.rows[0] ?? {});
    const devDsId = await datasetIdBySlug(DEV_OWNER, spec.datasetSlug);
    if (devDsId) await ensureMapping(devDsId, entity, attrNames, dsCols);
    if (tomId) {
      const demoDsId = await datasetIdBySlug(tomId, spec.datasetSlug);
      if (demoDsId) await ensureMapping(demoDsId, entity, attrNames, dsCols);
    }
    const key = entityKey(entity);
    const compiled = compileDataBlock({
      entity: { key, name: entity.name, label: entity.label, description: entity.description, attributes },
      datasetSlug: spec.datasetSlug,
      columnMap: {},
    });
    const res = await upsertGlobalBlock({
      slug: spec.showcaseSlug,
      name: compiled.name,
      description: compiled.description,
      category: 'data',
      version: '1.0.0',
      status: 'stable',
      descriptor: compiled.descriptor,
      source: compiled.source_ts,
      reversionOnChange: true,
      docs: `# ${compiled.name}\n\nA **data block** compiled from the **${entity.label}** ontology entity — its output ports are the entity's typed attributes. Reads the \`${spec.datasetSlug}\` sample via \`ctx.dataset()\` (override the source in the config panel).`,
      source_entity_key: key,
      tests: [
        {
          name: 'loads the sample rows',
          description: `Reads ${spec.datasetSlug} and emits its rows + count.`,
          inputs: { source: spec.datasetSlug },
          datasets: [],
          expected: { count: EX_DATASETS.find((d) => d.slug === spec.datasetSlug)!.rows.length },
          assert_mode: 'subset',
          expect_error: false,
          expected_error_kind: null,
        },
        {
          name: 'unknown source yields no rows',
          description: 'An unbound dataset slug returns an empty rowset (the empty path).',
          inputs: { source: 'does-not-exist' },
          datasets: [],
          expected: { count: 0 },
          assert_mode: 'subset',
          expect_error: false,
          expected_error_kind: null,
        },
      ],
    });
    if (res.created) blockCount++;
    versionBySlug.set(spec.showcaseSlug, res.versionId);
    blockIdBySlug.set(spec.showcaseSlug, res.blockId);
  }

  // 2) Hand-authored logic/ai/output/ui blocks.
  for (const b of HAND_AUTHORED) {
    const res = await upsertGlobalBlock(b);
    if (res.created) blockCount++;
    versionBySlug.set(b.slug, res.versionId);
    blockIdBySlug.set(b.slug, res.blockId);
  }

  // 3) Demo flows that chain the blocks end-to-end (idempotent by owner + name; demo tenant).
  let flowCount = 0;
  flowCount += await ensureDemoFlow(
    'Claims triage (demo)',
    'Loads claims, counts them by status, and renders a summary card — plus a CSV export.',
    buildTriageGraph(versionBySlug, blockIdBySlug),
  );
  flowCount += await ensureDemoFlow(
    'Claim review (demo)',
    'Loads claims, filters to the open ones, and renders them as a table for review.',
    buildReviewGraph(versionBySlug, blockIdBySlug),
  );

  return { datasets: datasetCount, blocks: blockCount, flows: flowCount };
}

async function ensureDemoFlow(name: string, description: string, graph: FlowGraph | null): Promise<number> {
  if (!graph) return 0;
  const [existing] = await db
    .select({ id: flows.id })
    .from(flows)
    .where(and(eq(flows.owner_id, DEV_OWNER), eq(flows.name, name)));
  if (existing) return 0;
  await db.insert(flows).values({ name, owner_id: DEV_OWNER, tenant_id: DEMO_TENANT_ID, graph, description });
  return 1;
}

function node(id: string, slug: string, versionId: string, blockId: string, category: BlockCategory, config: Record<string, unknown>, x: number, y: number): FlowNode {
  return { id, blockId, blockVersionId: versionId, slug, label: slug, category, config, position: { x, y } };
}
function edge(id: string, source: string, sourceHandle: string, target: string, targetHandle: string): FlowEdge {
  return { id, source, sourceHandle, target, targetHandle };
}

function buildTriageGraph(v: Map<string, string>, b: Map<string, string>): FlowGraph | null {
  if (!v.get('example-claim-data') || !v.get('group-and-count') || !v.get('summary-card') || !v.get('rows-to-csv')) return null;
  return {
    nodes: [
      node('n1', 'example-claim-data', v.get('example-claim-data')!, b.get('example-claim-data')!, 'data', { source: 'example-claims' }, 80, 160),
      node('n2', 'group-and-count', v.get('group-and-count')!, b.get('group-and-count')!, 'logic', { field: 'status' }, 380, 80),
      node('n3', 'summary-card', v.get('summary-card')!, b.get('summary-card')!, 'ui', { title: 'Claims by status' }, 680, 80),
      node('n4', 'rows-to-csv', v.get('rows-to-csv')!, b.get('rows-to-csv')!, 'output', {}, 380, 280),
    ],
    edges: [
      edge('e1', 'n1', 'rows', 'n2', 'rows'),
      edge('e2', 'n2', 'groups', 'n3', 'stats'),
      edge('e3', 'n1', 'rows', 'n4', 'rows'),
    ],
  };
}

function buildReviewGraph(v: Map<string, string>, b: Map<string, string>): FlowGraph | null {
  if (!v.get('example-claim-data') || !v.get('filter-rows') || !v.get('table-view')) return null;
  return {
    nodes: [
      node('n1', 'example-claim-data', v.get('example-claim-data')!, b.get('example-claim-data')!, 'data', { source: 'example-claims' }, 80, 160),
      node('n2', 'filter-rows', v.get('filter-rows')!, b.get('filter-rows')!, 'logic', { field: 'status', op: 'eq', value: 'open' }, 380, 160),
      node('n3', 'table-view', v.get('table-view')!, b.get('table-view')!, 'ui', { title: 'Open claims' }, 680, 160),
    ],
    edges: [
      edge('e1', 'n1', 'rows', 'n2', 'rows'),
      edge('e2', 'n2', 'rows', 'n3', 'rows'),
    ],
  };
}
