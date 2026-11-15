// src/db/dataset-types.ts
// Shared TS shapes for the Datasets subsystem (Phase 2.0). A dataset is developer-
// supplied test data (CSV / Excel / SQL-paste / text / JSON), parsed into a typed
// column schema + JSONB rows. These shapes cross the host→runner trust boundary:
// the trusted host resolves a flow's referenced datasets and injects {columns,rows}
// into the runner's one-shot init frame, so the runner gains NO DB/network access.
// Kept free of drizzle imports so the spawned runner can share it without the DB
// layer. The frontend keeps a 1:1 copy in lib/types/datasets.ts.

/** Inferred column types — a deliberately small, display-friendly set. `date` and
 *  `json` are stored as their string/object JSON form in the row payload. */
export type DatasetColumnType = 'string' | 'number' | 'boolean' | 'date' | 'json';

export interface DatasetColumn {
  name: string;
  type: DatasetColumnType;
  /** Heuristic or dev-confirmed PII flag. PII values are redacted at the host
   *  before injection unless the run's PII policy permits them. */
  pii?: boolean;
  /** A data manager's EXPLICIT "not personal" mark: members see (and their runs read) the column's
   *  real values (datasets/member-view.ts). Only ever set by a human through
   *  `PATCH /api/datasets/:slug` (data managers) — never inferred. `pii: true` overrides it. */
  nonPersonal?: boolean;
  /** A representative value (first non-empty), for the schema preview. */
  sample?: unknown;
}

/** Static, hand-uploaded sources (Phase 2.0). The upload route validates against
 *  these; the parsers in datasets/parse/ handle them. */
export const DATASET_SOURCE_TYPES = ['csv', 'xlsx', 'sql', 'text', 'json'] as const;
export type DatasetUploadSourceType = (typeof DATASET_SOURCE_TYPES)[number];

/** Live, read-only sources a connector materializes into dataset_rows on refresh
 *  (Phase 2-A). The host fetches these (never the runner) through the egress guard;
 *  rows are then served exactly like any dataset via ctx.dataset(slug). */
export const CONNECTOR_SOURCE_TYPES = ['postgres', 'storage', 'http'] as const;
export type ConnectorSourceType = (typeof CONNECTOR_SOURCE_TYPES)[number];

/** Every dataset source_type (upload + connector). The DB enum carries all of them. */
export const ALL_DATASET_SOURCE_TYPES = [
  ...DATASET_SOURCE_TYPES,
  ...CONNECTOR_SOURCE_TYPES,
] as const;
export type DatasetSourceType = (typeof ALL_DATASET_SOURCE_TYPES)[number];

export const isConnectorSource = (t: string): t is ConnectorSourceType =>
  (CONNECTOR_SOURCE_TYPES as readonly string[]).includes(t);

export const DATASET_STATUSES = ['ready', 'parsing', 'error', 'syncing'] as const;
export type DatasetStatus = (typeof DATASET_STATUSES)[number];

/** How a connector learns its upstream changed and should re-materialize.
 *  - 'webhook'   — an external system POSTs /api/connectors/events (e.g. a MinIO
 *                  bucket notification) with the connector's event secret.
 *  - 'pg_notify' — reserved for a source that can emit Postgres NOTIFY.
 *  - 'none'      — the source cannot push; refreshed on create + the admin "Sync
 *                  now" escape hatch only. NEVER silently polled. */
export const CONNECTOR_EVENT_SOURCES = ['webhook', 'pg_notify', 'none'] as const;
export type ConnectorEventSource = (typeof CONNECTOR_EVENT_SOURCES)[number];

/** Secret connection config — encrypted at rest (secret-box), decrypted only on the
 *  host at refresh time, NEVER returned to a client. One variant per source kind. */
export type ConnectorConfig =
  | { kind: 'postgres'; url: string; query: string }
  | {
      kind: 'storage';
      baseUrl: string;
      bucket: string;
      key: string;
      token?: string;
      format?: 'csv' | 'json' | 'xlsx';
    }
  | {
      kind: 'http';
      url: string;
      headers?: Record<string, string>;
      format?: 'csv' | 'json';
    };

/** Non-secret connector metadata (stored in datasets.connection_meta, safe to
 *  return + used to derive the egress host). Mirrors ConnectorConfig minus secrets. */
export type ConnectorMeta =
  | { kind: 'postgres'; host: string; database?: string; queryPreview: string }
  | {
      kind: 'storage';
      host: string;
      bucket: string;
      key: string;
      format?: string;
      /** Whether the MinIO bucket-notification rule is wired for this connector. Set on
       *  create + on a manual re-register (self-serve notifications). undefined = not an
       *  auto-registered storage connector (or registration was never attempted). */
      notifyRegistered?: boolean;
    }
  // ⛔ Deliberately NOT a `url` field — see the design comment on `httpMetaOut` in
  // src/datasets/connectors/index.ts. `postgres` keeps only host+database, `storage` keeps only
  // host+bucket+key; `http`'s config is a single opaque URL that mixes resource identity with
  // auth (path-embedded API keys, query-string tokens), so there is no structurally-safe way to
  // keep any more of it than the host.
  | { kind: 'http'; host: string; format?: string };

/**
 * The machine tokens behind a failed connector sync — `datasets.sync_error_detail` (0074).
 *
 * Written beside `sync_error_code` by `datasets/connector-refresh.ts` so the reader's BROWSER can
 * compose the sentence instead of being handed the server's English (`frontend/src/lib/api/
 * error-message.ts` → `syncErrorText`).
 *
 * ⚠️ EVERY FIELD IS OPTIONAL AND THE READER MUST TREAT IT SO. `host` comes from
 * `connection_meta`, which is nullable on a row whose connector was created before the meta
 * redesign; `reason` is the raw `err.message`, which is the empty string for a thrown non-Error.
 * The column is jsonb and the database validates nothing, so a reader that assumes a field is
 * present renders `undefined` into a sentence. The catalog entries return `null` instead, which
 * lands the reader on the English `sync_error` — the documented fall-through, not a bug.
 *
 * ⚠️ THE BAG IS OPEN, because the thrower decides what is in it. `connector-refresh.ts`'s catch
 * spreads `HttpError.details` over `{ host, reason }`, so whatever the RAISE SITE knew rides along:
 * `key` (storage_format_unknown), `actualMb`/`limitMb` (xlsx_too_large), `resolved`
 * (bad_config/key_escapes_bucket), `field` (the bad_config arms that only the save/test endpoints
 * can reach). The index signature keeps those typechecking without this file having to enumerate a
 * set that every new `badRequest(...)` extends. Purely a type widening — no runtime effect.
 */
export interface DatasetSyncErrorDetail {
  /** The connector's egress host, when it has one. */
  host?: string;
  /** The sub-DISCRIMINATOR when the thrower supplied one — `key_escapes_bucket` and the other
   *  `bad_config` arms that `error-message.ts`'s `byReason()` switches on. Otherwise the RAW
   *  English `err.message` the code was concatenated onto, kept so a catalog entry that genuinely
   *  needs the specifics can still show them and so the audit row and the dataset row cannot
   *  disagree about what happened. The spread in `connector-refresh.ts` is ordered so the
   *  discriminator wins over the prose whenever both exist. */
  reason?: string;
  /** Whatever else the raise site put in `HttpError.details` — see the note above. `unknown`, not
   *  `string`: `xlsx_too_large` ships raw NUMBERS, and the reader's `detailNum` requires them to
   *  survive the jsonb round-trip as numbers. */
  [field: string]: unknown;
}

/** One column an ingest had to rename to keep names unique within a dataset. Reported all the way
 *  out to the upload response + the audit row, never applied silently — a reader who uploaded a
 *  sheet with two `Amount` headers has to be able to tell which one became `Amount_1`. */
export interface ColumnRename {
  /** The name as it appeared in the source header. */
  from: string;
  /** The disambiguated name the dataset actually carries. */
  to: string;
}

/** A parser's output: the inferred schema + the row objects. */
export interface ParsedDataset {
  columns: DatasetColumn[];
  rows: Record<string, unknown>[];
}

/** The host→runner injection shape (one entry per referenced dataset slug). */
export interface InjectedDataset {
  columns: DatasetColumn[];
  rows: Record<string, unknown>[];
}

export interface MergedColumns {
  columns: DatasetColumn[];
  /** Names of columns where a human-set `pii: true` would have been dropped by the
   *  fresh heuristic inference and was kept instead — worth a note in the sync's
   *  audit row (the caller decides whether to log it). */
  piiPreserved: string[];
  /** Column names present in `inferred` but not in `existing` (a connector refresh
   *  changed the source's shape). */
  added: string[];
  /** Column names present in `existing` but not in `inferred`. */
  removed: string[];
}

/**
 * Merge a connector refresh's freshly heuristic-inferred columns with the dataset's
 * EXISTING (possibly human-edited) columns, matched by name. A refresh must never
 * silently discard a human's PATCH /api/datasets/:slug PII correction:
 *
 *   - `pii: true` is STICKY. Inference may only ever ADD protection, never remove it
 *     — a column the human confirmed as PII stays PII even if the fresh inference
 *     (name heuristic over the newly-fetched sample) would not have flagged it.
 *   - Every other attribute (type, sample) follows the fresh inference — a column's
 *     shape is allowed to genuinely change on refresh.
 *   - A column that disappeared from the source is dropped; a newly-appeared column
 *     takes the inferred value as-is (nothing human-set exists for it yet).
 */
export function mergeRefreshedColumns(
  existing: DatasetColumn[] | null | undefined,
  inferred: DatasetColumn[],
): MergedColumns {
  const prevByName = new Map((existing ?? []).map((c) => [c.name, c]));
  const inferredNames = new Set(inferred.map((c) => c.name));
  const piiPreserved: string[] = [];
  const columns = inferred.map((col) => {
    const prev = prevByName.get(col.name);
    // `nonPersonal` is a human decision with no inferred counterpart: a refresh keeps it.
    const kept = prev?.nonPersonal === true ? { ...col, nonPersonal: true } : col;
    if (prev?.pii && !col.pii) {
      piiPreserved.push(col.name);
      return { ...kept, pii: true };
    }
    return kept;
  });
  const added = inferred.filter((c) => !prevByName.has(c.name)).map((c) => c.name);
  const removed = (existing ?? []).filter((c) => !inferredNames.has(c.name)).map((c) => c.name);
  return { columns, piiPreserved, added, removed };
}

// ---- Caps (SPEC-PHASE2 §2.7) ----
/** Max rows persisted per dataset; over-cap → truncated at parse (logged). */
export const DATASET_MAX_ROWS = 50_000;
/** Max upload/body size accepted by the parser (bytes). */
export const DATASET_MAX_BYTES = 25 * 1024 * 1024;
/** Max rows injected into a runner init frame; over-cap → sample-on-inject (logged). */
export const DATASET_INJECT_ROW_CAP = 10_000;
/** Max rows a single connector refresh will fetch/persist (LIMIT applied at source
 *  where possible; row-capped at parse otherwise). Keeps a live source from blowing
 *  past the dataset row cap. */
export const CONNECTOR_FETCH_ROW_CAP = DATASET_MAX_ROWS;
/** Max bytes a connector fetch will read from an HTTP/storage body before refusing. */
export const CONNECTOR_FETCH_MAX_BYTES = DATASET_MAX_BYTES;
/** Rows returned in an API schema preview. */
export const DATASET_PREVIEW_ROWS = 50;

/** Placeholder substituted for a redacted PII cell at the host. */
export const PII_REDACTION = '[redacted]';
