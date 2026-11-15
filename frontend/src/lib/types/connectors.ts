// src/lib/types/connectors.ts — 1:1 with the /api/connectors response shapes (backend
// src/routes/connectors.ts + db/dataset-types.ts connector half). A connector is a
// live, read-only data source the host materializes into a dataset on refresh.
import type { DatasetColumn } from './datasets';

export type ConnectorSourceType = 'postgres' | 'storage' | 'http';
export type ConnectorEventSource = 'webhook' | 'pg_notify' | 'none';

export interface ConnectorMeta {
	kind: ConnectorSourceType;
	host: string;
	database?: string;
	queryPreview?: string;
	bucket?: string;
	key?: string;
	format?: string;
	/** storage+webhook only: whether the MinIO bucket-notification rule is wired. `false` =
	 *  registration failed → manual sync only (offer a re-register). Absent for other connectors. */
	notifyRegistered?: boolean;
	// ⛔ Deliberately NO `url` field. An `http` connector's raw URL is never returned to a client —
	// only `host` (+`format`) survive, the same "keep only known-safe" shape `database` and
	// `bucket`/`key` already give postgres/storage. See the design comment on `httpMetaOut` in
	// backend src/datasets/connectors/index.ts. If a component ever needs to show "where does this
	// come from", use `host` (present for every connector kind) — never assume `.url`.
}

export interface Connector {
	id: string;
	slug: string;
	name: string;
	sourceType: ConnectorSourceType;
	status: string;
	eventSource: ConnectorEventSource;
	meta: ConnectorMeta | null;
	columns: DatasetColumn[];
	rowCount: number;
	sizeBytes: number;
	sandboxId: string | null;
	lastSyncedAt: string | null;
	/**
	 * ⛔ THE SERVER'S OWN ENGLISH, PERSISTED — `"<code>: <err.message>"`, straight off
	 * `datasets.sync_error`. Never render it directly: pass it through `syncErrorText(code, text,
	 * detail)` (lib/api/error-message.ts), which puts the catalog first and lands here only for a
	 * pre-0074 row or a code whose sentence needs a field `syncErrorDetail` does not carry.
	 */
	syncError: string | null;
	/** The wire code behind `syncError` (`EgressBlockedError.code`, a reachable `HttpError.code`,
	 *  or `'sync_failed'`). `null` on every row written before migration 0074. */
	syncErrorCode: string | null;
	/** Machine tokens for that sentence — `{ host?, reason?, …whatever the raise site knew }`. The
	 *  refresh catch spreads `HttpError.details` over `{ host, reason }`, so this also carries
	 *  `key` (storage_format_unknown), `actualMb`/`limitMb` (xlsx_too_large, as NUMBERS) and
	 *  `resolved` (bad_config/key_escapes_bucket), and `reason` is that code's snake_case
	 *  DISCRIMINATOR rather than English prose whenever the thrower supplied one. Unvalidated by
	 *  the database, so every field is treated as possibly absent; see `DatasetSyncErrorDetail`. */
	syncErrorDetail: Record<string, unknown> | null;
	createdAt: string;
	updatedAt: string;
}

export interface ConnectorList {
	items: Connector[];
	total: number;
	page: number;
	pageSize: number;
	/** Whether the caller may manage connectors (tenant_admin / platform). */
	canManage?: boolean;
	/**
	 * Whether self-serve storage notifications are switched on for this deployment
	 * (`CP_CONNECTOR_NOTIFICATIONS_ENABLED`). Gates Verify / Re-register / Reconcile, all three of
	 * which the backend refuses `400 notifications_disabled` when it is off.
	 *
	 * ⚠️ OPTIONAL, AND ABSENT MUST NOT MEAN `false`. A backend one roll behind omits it, and reading
	 * that as "the feature is off" would grey out three working controls during every deploy. The
	 * page defaults an absent value to enabled and relies on the localized refusal for that window.
	 */
	notificationsEnabled?: boolean;
}

export interface RefreshOutcome {
	ok: boolean;
	skipped?: boolean;
	rowCount?: number;
	truncated?: number;
	reason?: string;
}

export interface ConnectorCreated extends Connector {
	/** Shown ONCE for webhook connectors — not recoverable later. */
	eventSecret: string | null;
	ingestUrl: string | null;
	firstSync: RefreshOutcome;
	/**
	 * Present only for auto-registered storage+webhook connectors (the self-serve MinIO
	 * bucket-notification path). `true` = the live-notification rule was wired; `false` = best-effort
	 * registration failed and the connector falls back to manual sync. Absent for all other connectors.
	 */
	notifyRegistered?: boolean;
}

export interface ConnectorDetail extends Connector {
	rows: Record<string, unknown>[];
	/** W8/P7 — columns whose values this reader may not see. Optional for a rolling deploy. */
	maskedColumns?: string[];
}

/** Result of GET /api/connectors/:slug/notifications/status — the connector with its LIVE
 *  MinIO-rule state. `notifyLive` is ground truth (not the stored flag); `drift` = stored ≠ live;
 *  `reachable` = storage_service answered (false → state unknown, stored flag preserved). */
export interface ConnectorNotificationStatus extends Connector {
	notifyLive: boolean;
	reachable: boolean;
	drift: boolean;
}

/** Result of POST /api/connectors/notifications/reconcile — a tenant-wide re-assert pass. */
export interface NotificationReconcileReport {
	checked: number;
	repaired: number;
	failed: number;
}

/** The per-source config the create form collects (sent as `config`). */
export type ConnectorConfigInput =
	| { url: string; query: string }
	| { baseUrl: string; bucket: string; key: string; token?: string; format?: 'csv' | 'json' | 'xlsx' }
	| { url: string; format?: 'csv' | 'json' };

export const CONNECTOR_SOURCE_TYPES: ConnectorSourceType[] = ['postgres', 'storage', 'http'];
