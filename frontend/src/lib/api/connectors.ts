// src/lib/api/connectors.ts — typed client for the live data-connector API (Phase 2-A).
// CRUD + manual sync + event-secret rotation, plus a fetch-based SSE subscription to
// connector status changes (so the screen updates reactively, never polling). Mirrors
// the datasets client (authFetch + unwrap) and reuses the SSE framing parser.
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, detailsFrom } from './parse';
import { ApiError } from './blocks';
import { parseBlock } from '$lib/services/sse';
import type {
	Connector,
	ConnectorConfigInput,
	ConnectorCreated,
	ConnectorDetail,
	ConnectorEventSource,
	ConnectorList,
	ConnectorNotificationStatus,
	ConnectorSourceType,
	NotificationReconcileReport,
	RefreshOutcome
} from '$lib/types/connectors';
import type { ConnectionTestResult } from '$lib/i18n/connection-test-label';

export { ApiError };

async function unwrap<T>(res: Response): Promise<T> {
	const text = await res.text();
	const body = parseBody(text);
	if (!res.ok) {
		// `detailsFrom` forwards the offender's name to the localized catalog — see the ⛔ block on
		// `ApiError` (./blocks). Every sibling `unwrap` in this directory carries the same line.
		throw new ApiError(
			res.status,
			body?.error ?? 'error',
			body?.message ?? body?.error ?? nonJsonErrorMessage(res, text),
			detailsFrom(body)
		);
	}
	return body as T;
}

export interface CreateConnectorInput {
	name: string;
	sourceType: ConnectorSourceType;
	config: ConnectorConfigInput;
	eventSource?: ConnectorEventSource;
	sandboxId?: string | null;
}

export const connectorsApi = {
	/**
	 * TWO SOURCE PARAMETERS, AND THE DIFFERENCE IS THE WHOLE POINT.
	 *
	 * · `source` NARROWS — the route ANDs it, so `{ q: 'claims', source: 'storage' }` means
	 *   "storage connectors whose text matches claims". Two independent restrictions.
	 * · `qSource` WIDENS — the route ORs it into the `q` predicate, so
	 *   `{ q: 'Postgres', qSource: 'postgres' }` means "connectors whose text matches Postgres **or**
	 *   whose kind is postgres". It is `q` read a second way, never a restriction on it.
	 *
	 * ⛔ THE /connectors PAGE SENDS `q` + `qSource`, AND THIS DOC USED TO SAY IT SENT `source`
	 * INSTEAD OF `q`. That was the defect: "Postgres" is BOTH the enum value and its localized label
	 * in all eight catalogs, so substituting the filter for the text turned a name search into a
	 * category filter and made an `http` connector named "Postgres bridge" unfindable by its own
	 * name. A category reading must never delete rows the text reading would have found.
	 *
	 * An unknown value for either is a 400 (`invalid_source`), not a silently unfiltered list.
	 */
	async list(
		params: {
			q?: string;
			page?: number;
			source?: ConnectorSourceType;
			qSource?: ConnectorSourceType;
		} = {}
	): Promise<ConnectorList> {
		const qs = new URLSearchParams();
		if (params.q) qs.set('q', params.q);
		if (params.source) qs.set('source', params.source);
		if (params.qSource) qs.set('qSource', params.qSource);
		if (params.page && params.page > 1) qs.set('page', String(params.page));
		const suffix = qs.toString() ? `?${qs.toString()}` : '';
		return unwrap(await authFetch(`/api/connectors${suffix}`));
	},

	/** One connector plus a WINDOW of its rows. `offset`/`limit` mirror `datasetsApi.get` exactly —
	 *  the two screens render the same drawer over the same `dataset_rows` table, and the backend
	 *  clamps at `DATASET_PREVIEW_ROWS * 4`. Omit both for the server's default window. */
	async get(
		slug: string,
		opts: { offset?: number; limit?: number } = {}
	): Promise<ConnectorDetail> {
		const qs = new URLSearchParams();
		if (opts.offset) qs.set('offset', String(opts.offset));
		if (opts.limit) qs.set('limit', String(opts.limit));
		const suffix = qs.toString() ? `?${qs.toString()}` : '';
		return unwrap(await authFetch(`/api/connectors/${encodeURIComponent(slug)}${suffix}`));
	},

	async create(input: CreateConnectorInput): Promise<ConnectorCreated> {
		return unwrap(
			await authFetch('/api/connectors', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(input)
			})
		);
	},

	/** Validate a draft connector config before saving — a non-persisting live probe. */
	/**
	 * ⛔ THIS ENDPOINT ANSWERS HTTP 200 EVEN WHEN THE TEST FAILS — deliberately: a bad credential is
	 * a normal test RESULT, not a transport error. So nothing throws, `errorText` never runs, and
	 * `detail` (an English sentence built server-side) used to be rendered raw on screen, success
	 * path included. `code`/`params` carry the machine facts; `$lib/i18n/connection-test-label`
	 * turns them into the reader's words and falls back to `detail` for a code it does not know.
	 *
	 * Both are OPTIONAL because an old pod mid-roll ships neither.
	 */
	async test(input: { sourceType: ConnectorSourceType; config: ConnectorConfigInput }): Promise<ConnectionTestResult> {
		return unwrap(
			await authFetch('/api/connectors/test', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(input)
			})
		);
	},

	/**
	 * Manual refresh. Returns the connector as re-read AFTER the refresh (ground truth for every
	 * branch, including the ones that send no NOTIFY) plus the typed outcome.
	 *
	 * `sync` used to be `unknown`, which type-erased the one field describing what happened —
	 * the reason a lock-skipped sync could leave a row spinning on "Syncing" with a green suite.
	 * `RefreshOutcome` already existed in $lib/types/connectors (it types `ConnectorCreated.firstSync`);
	 * this is the same shape off the same backend interface, deliberately NOT a second declaration.
	 *
	 * ⚠️ `Connector`, NOT `ConnectorDetail`. The route returns `connectorOut(...)` — the LIST row
	 * shape — while `ConnectorDetail extends Connector { rows: … }`. Nothing breaks today (the one
	 * caller spreads the result into `items`, and a missing key spreads to nothing), but the wider
	 * type is a promise the server does not keep: `(await sync(slug)).rows.map(…)` compiles clean
	 * and throws at runtime. Widen this again only alongside the route that starts sending `rows`.
	 */
	async sync(slug: string): Promise<Connector & { sync: RefreshOutcome }> {
		return unwrap(
			await authFetch(`/api/connectors/${encodeURIComponent(slug)}/sync`, { method: 'POST' })
		);
	},

	async rotateSecret(slug: string): Promise<{ eventSecret: string; ingestUrl: string }> {
		return unwrap(
			await authFetch(`/api/connectors/${encodeURIComponent(slug)}/rotate-secret`, { method: 'POST' })
		);
	},

	/** Manually (re)register the MinIO bucket-notification rule for a storage+webhook connector
	 *  whose auto-registration failed. Returns the refreshed connector + the new outcome. */
	async reregisterNotifications(slug: string): Promise<Connector & { notifyRegistered: boolean }> {
		return unwrap(
			await authFetch(`/api/connectors/${encodeURIComponent(slug)}/register-notifications`, {
				method: 'POST'
			})
		);
	},

	/** Probe storage_service for the connector's LIVE MinIO rule and self-heal the stored flag.
	 *  Returns the refreshed connector plus `notifyLive`/`reachable`/`drift` (ground truth). */
	async verifyNotifications(slug: string): Promise<ConnectorNotificationStatus> {
		return unwrap(
			await authFetch(`/api/connectors/${encodeURIComponent(slug)}/notifications/status`)
		);
	},

	/** Re-assert every storage+webhook connector's MinIO rule for the caller's tenant (recovery
	 *  after a MinIO restart). Returns a {checked, repaired, failed} summary. */
	async reconcileNotifications(): Promise<NotificationReconcileReport> {
		return unwrap(
			await authFetch('/api/connectors/notifications/reconcile', { method: 'POST' })
		);
	},

	async remove(slug: string): Promise<void> {
		await unwrap(await authFetch(`/api/connectors/${encodeURIComponent(slug)}`, { method: 'DELETE' }));
	}
};

/** Subscribe to connector status changes via the SSE stream (fetch + ReadableStream so
 *  the Keycloak bearer rides along — EventSource cannot). Calls `onSynced` with the
 *  updated connector. Returns a close handle.
 *
 *  `onPushError` fires on the server's `event: error` frame — a push the backend could not
 *  complete (routes/connectors.ts's detached continuation: a failed row lookup or a failed
 *  enqueue). ⛔ IT IS THE OTHER HALF OF THAT FIX AND NOT AN OPTIONAL EXTRA. This parser used to
 *  match `block.event === 'synced'` and nothing else, so every other frame fell through the `if`
 *  in silence — emitting an `error` frame no client listens for would have been a fix that changes
 *  nothing. The frame carries `{code:'push_failed'}` and DELIBERATELY no detail: one NOTIFY reaches
 *  every subscribed stream on the pod, so the connector id and the server's error text would cross
 *  a tenant boundary. The subscriber's answer is therefore to re-read its OWN list, not to trust
 *  anything in the frame. */
export function streamConnectors(
	onSynced: (c: Connector) => void,
	onPushError?: () => void
): { close: () => void } {
	const ac = new AbortController();
	let closed = false;

	async function connect(): Promise<void> {
		while (!closed) {
			try {
				const res = await authFetch('/api/connectors/stream', {
					headers: { Accept: 'text/event-stream' },
					signal: ac.signal
				});
				if (!res.ok || !res.body) return;
				const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
				let buf = '';
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += value;
					let idx: number;
					while ((idx = buf.indexOf('\n\n')) >= 0) {
						const raw = buf.slice(0, idx);
						buf = buf.slice(idx + 2);
						const block = parseBlock(raw);
						if (block?.event === 'synced' && block.data) {
							try {
								onSynced(JSON.parse(block.data) as Connector);
							} catch {
								/* ignore a malformed frame */
							}
						} else if (block?.event === 'error') {
							// No `JSON.parse` and no payload read on purpose — see the ⛔ on the parameter.
							// The frame is a SIGNAL, not data: its only content is "a push was lost", and
							// reading anything out of it would be reading across a tenant boundary.
							onPushError?.();
						}
					}
				}
				if (closed) return;
			} catch {
				if (closed || ac.signal.aborted) return;
				await new Promise((r) => setTimeout(r, 1000));
			}
		}
	}

	void connect();
	return {
		close() {
			closed = true;
			ac.abort();
		}
	};
}
