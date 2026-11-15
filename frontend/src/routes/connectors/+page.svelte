<script lang="ts">
	// Platform "Connectors" — connect read-only LIVE data sources (Postgres SELECT, the
	// storage_service object API, HTTP/JSON). The host fetches + materializes the rows
	// into a dataset (egress-allowlisted + PII-redacted), which blocks read via the same
	// dataset picker. Refresh is event-driven (a webhook ingest URL + secret); status
	// changes stream over SSE (no polling). Phase 2-A. RTL-safe (logical CSS), localized.
	import { onMount, onDestroy } from 'svelte';
	import { connectorsApi, streamConnectors, ApiError } from '$lib/api/connectors';
	import type {
		Connector,
		ConnectorCreated,
		ConnectorDetail,
		ConnectorEventSource,
		ConnectorSourceType
	} from '$lib/types/connectors';
	import { timeAgo, num } from '$lib/utils/format';
	// `locale.current` is the APP's locale, not the browser's — see format.ts for the defect
	// and for why these helpers take it as an argument instead of importing this store.
	import { locale } from '$lib/stores/locale.svelte';
	import { connectionTestLabel, type ConnectionTestResult } from '$lib/i18n/connection-test-label';
	import * as m from '$lib/paraglide/messages';
	import { errorText, writeErrorText, syncErrorText } from '$lib/api/error-message';
	import { confirmDialog } from '$lib/stores/confirm.svelte';
	import LoadingRows from '$lib/components/LoadingRows.svelte';
	import Pager from '$lib/components/ui/Pager.svelte';
	import { syncOutcomeNotice } from './sync-outcome';
	import { MASKED_CELL } from '$lib/datasets/masked';

	let items = $state<Connector[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	// A failed ACTION (sync/rotate/re-register/verify/reconcile/delete/inspect), kept separate from
	// `error` (the LOAD error). `error` renders inside the `{#if denied}…{:else if error}` chain
	// below, which is mutually exclusive with the connector table — so writing a button failure
	// there replaced the whole page the message was supposed to explain. This one renders ABOVE the
	// chain and leaves the table in place. Same pattern as `voteError` on the challenge pages (#210).
	let actionError = $state<string | null>(null);
	let denied = $state(false);
	let canManage = $state(false);
	/**
	 * Whether self-serve storage notifications are switched on for this deployment.
	 *
	 * ⛔ THREE CONTROLS ON THIS SCREEN COULD ONLY EVER FAIL WITHOUT IT. Verify, Re-register and
	 * Reconcile are all refused `400 notifications_disabled` when
	 * `CP_CONNECTOR_NOTIFICATIONS_ENABLED` is not `'true'` — and it is absent from `.env`,
	 * `.env.example`, `.env.local` and `docker-compose.yml`, so it is off everywhere the demo runs.
	 * The state is reachable, not theoretical: `POST /api/connectors` accepts
	 * `eventSource: 'webhook'` unconditionally (only the auto-registration is gated) and the create
	 * modal offers it, so a tenant admin can build exactly the connector these three buttons act on.
	 *
	 * ⚠️ DEFAULTS TO TRUE, AND THAT IS THE SAFE DIRECTION. A backend one roll behind omits the
	 * field; reading absent as `false` would grey out three working controls through every rolling
	 * deploy. When we are wrong that way the click still happens and now reaches a LOCALIZED
	 * refusal rather than "Dat is niet gelukt" — see `verify`.
	 */
	let notificationsEnabled = $state(true);
	/**
	 * Why those three are inert, or `null` when they are not.
	 *
	 * ⛔ A REASON, NOT A BOOLEAN, and ⛔ DISABLED RATHER THAN HIDDEN — both are this repo's own
	 * settled doctrine, stated at `VoteButton.svelte`: a control that goes inert without saying why
	 * is the defect, and a control that vanishes is its own confusion. The sentence is the one the
	 * BACKEND's refusal already resolves to (`error-message.ts` maps `notifications_disabled` →
	 * `error_notifications_disabled`), so the tooltip and the error strip cannot say two things.
	 */
	const notifyBlockedReason = $derived(
		notificationsEnabled ? null : m.error_notifications_disabled()
	);
	let q = $state('');

	// ⛔ THE LIST IS PAGED, AND THIS SCREEN USED TO PRETEND IT WAS NOT. `GET /api/connectors` pages at
	// twelve (backend/src/routes/connectors.ts's `PAGE_SIZE`, applied as `.limit(PAGE_SIZE)`) and
	// answers with `total`/`page`/`pageSize` precisely so a client can say how much it is not
	// showing. Both call sites here asked for `connectorsApi.list()` — no arguments — kept `.items`
	// and dropped the rest, so a tenant with thirteen connectors saw twelve of them forever with
	// nothing on screen admitting the thirteenth existed. /datasets, /sandboxes, /solutions and
	// /challenges all page; /connectors was the one tenant list page that did not.
	//
	// ⛔ AND `q` USED TO BE A CLIENT-SIDE FILTER over those twelve rows, which is the worse half:
	// typing the thirteenth connector's own name produced `connectors_no_match` — the page telling a
	// reader that a connector sitting in their own database does not exist. Silence you might
	// notice; a denial you believe. `q` now goes to the server, which matches `name`/`slug` across
	// the WHOLE set (connectors.ts's `ilike` pair).
	//
	// ⚠️ The server matches name+slug only. The old client filter also matched the source label and
	// the host — deliberately NOT reimplemented on top of the page's rows, because a filter that
	// searches two fields across everything and four fields across the current twelve is a worse
	// contract than either: it would find a `db-3.example.com` on page one and deny the identical host
	// on page two. Widening it belongs in the route's `where`, not here.
	let page = $state(1);
	let total = $state(0);
	let pageSize = $state(1);
	// `loaded`, not `items.length` — a search that legitimately matches nothing must not send the
	// NEXT keystroke back through the first-load skeleton (and past the search box that produced it).
	let loaded = $state(false);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	const totalPages = $derived(Math.max(1, Math.ceil(total / Math.max(1, pageSize))));

	// Create drawer.
	let creating = $state(false);
	let createBusy = $state(false);
	let createError = $state<string | null>(null);
	let kind = $state<ConnectorSourceType>('postgres');
	let name = $state('');
	let eventSource = $state<ConnectorEventSource>('none');
	// per-source fields
	let pgUrl = $state('');
	let pgQuery = $state('');
	let stBaseUrl = $state('');
	let stBucket = $state('');
	let stKey = $state('');
	let stToken = $state('');
	let httpUrl = $state('');

	// Secret reveal (once).
	let revealed = $state<{ ingestUrl: string | null; secret: string } | null>(null);
	// ⛔ THE SECRET IS SHOWN EXACTLY ONCE AND CANNOT BE RECOVERED — the server stores a hash
	// (`rotateEventSecret`), so the only way back is a rotation, which invalidates whatever the
	// caller already wired up. It rendered in a bare readonly `<input>` with no copy control, which
	// left "select the text in a narrow drawer without missing a character" as the ONLY way to keep
	// it. `null` = not attempted; the two other states are both reported, because a copy button
	// that silently does nothing on failure is worse than no button at all — `navigator.clipboard`
	// is undefined outside a secure context and rejects when the document is not focused, and a
	// reader who believes they copied a once-only secret and did not has lost it.
	let secretCopy = $state<'copied' | 'failed' | null>(null);

	async function copySecret() {
		if (!revealed) return;
		try {
			await navigator.clipboard.writeText(revealed.secret);
			secretCopy = 'copied';
		} catch {
			secretCopy = 'failed';
		}
	}

	// Self-serve storage connectors auto-register a MinIO bucket-notification rule (no secret to
	// reveal). Surface whether that wiring succeeded: 'ok' = live notifications wired, 'failed' =
	// created but falling back to manual sync. null = not an auto-registered connector.
	let notifyNotice = $state<'ok' | 'failed' | null>(null);
	// The bucket the connector actually landed in. With per-tenant isolation the server rewrites a
	// plain name (e.g. "sales") to cp-<tenantToken>-sales, so surface the resulting bucket on create.
	let notifyBucket = $state<string | null>(null);
	// Outcome of a Verify (per-connector live probe) or Reconcile (tenant-wide re-assert) action.
	let actionNotice = $state<{ tone: 'ok' | 'warn'; text: string } | null>(null);

	// Preview drawer.
	let selected = $state<ConnectorDetail | null>(null);
	let drawerLoading = $state(false);
	// ⛔ THE SERVER'S CEILING, ASKED FOR EXPLICITLY. This page used to send NO window at all, so it
	// got the route's default of 50 while the drawer header rendered `rowCount` — "10.000 rijen"
	// above a table holding fifty, with nothing on screen admitting the other 9 950 existed. The
	// backend clamps `?limit` at `DATASET_PREVIEW_ROWS * 4` (routes/connectors.ts, matching
	// routes/datasets.ts), so this is the largest window it will honour; asking for more would be
	// silently clamped and the constant would start lying about what arrives. A preview is still a
	// preview — hence the "showing N of M" line under the table, which is what makes the remaining
	// cap the reader's knowledge instead of the server's secret.
	const PREVIEW_LIMIT = 200;

	let stream: { close: () => void } | null = null;

	function statusLabel(s: string): string {
		if (s === 'ready') return m.connectors_status_ready();
		if (s === 'syncing') return m.connectors_status_syncing();
		if (s === 'error') return m.connectors_status_error();
		return m.connectors_status_parsing();
	}
	function sourceLabel(s: ConnectorSourceType): string {
		if (s === 'postgres') return m.connectors_source_postgres();
		if (s === 'storage') return m.connectors_source_storage();
		return m.connectors_source_http();
	}

	/**
	 * ⛔ THE SEARCH BOX COULD NOT FIND THE WORD THIS TABLE PRINTS. The source column renders through
	 * `sourceLabel()` above — in the demo locale `m.connectors_source_storage()` is "Opslagdienst" —
	 * while the server's `q` predicate (`backend/src/routes/connectors.ts`) matches `name`, `slug`,
	 * `source_type::text` and `connection_meta->>'host'`, i.e. the raw enum `storage` and never the
	 * label. A Dutch tester typed the badge word off their own screen and was told there was no
	 * match, with three rows carrying that badge in front of them.
	 *
	 * ⛔ AND IT IS FIXED HERE, IN THE BROWSER, RATHER THAN IN THE DATABASE. The route's own comment
	 * used to conclude that fixing this "means giving the enum labels a DB-side representation,
	 * which is a schema change" — corrected in the same commit as this. It does not: there are
	 * exactly three enum members and this file already owns all eight translations of each. The
	 * reader's word never reaches SQL; it is resolved against the catalog HERE and sent as the enum
	 * via `?qSource=`, which the route validates against `CONNECTOR_SOURCE_TYPES`.
	 *
	 * ⛔ AND THIS DOC USED TO PROMISE `?source=` — THE NARROWING PARAMETER — WHICH MADE THE PROMISE
	 * BELOW FALSE FOR ONE WORD. `sourceFromQuery` returning a member does NOT mean the input stops
	 * being text: `listParams()` sends BOTH readings and the route ORs them. It has to, because
	 * "Postgres" is simultaneously the `postgres` enum value and its label in all eight catalogs, so
	 * the substitution hid an `http` connector named "Postgres bridge" from a search on its own name.
	 *
	 * ⚠️ WHOLE-INPUT, EXACT, CASE-INSENSITIVE — AND A PREFIX RULE WAS CONSIDERED AND REJECTED.
	 * "Opslag" would be nicer to type, but a prefix match silently converts six typed letters into a
	 * WHOLE-CATEGORY filter, and it can collide across the eight catalogs (the labels are not
	 * chosen to be prefix-free). An exact whole-input match has no false positives and is the only
	 * rule a reader can predict. A partial stays ordinary text and behaves exactly as it does today.
	 *
	 * ⚠️ CURRENT LOCALE ONLY, STATED AS A BOUND. A Dutch reader typing the ENGLISH "Storage service"
	 * still gets nothing. Matching all eight catalogs at once would let one locale's label silently
	 * filter another locale's screen, which is a stranger surprise than a miss.
	 */
	function sourceFromQuery(text: string): ConnectorSourceType | undefined {
		const needle = text.trim().replace(/\s+/g, ' ').toLocaleLowerCase(locale.current);
		if (!needle) return undefined;
		const SOURCES: ConnectorSourceType[] = ['postgres', 'storage', 'http'];
		return SOURCES.find(
			(t) => sourceLabel(t).trim().replace(/\s+/g, ' ').toLocaleLowerCase(locale.current) === needle
		);
	}

	/** The query the screen is currently showing — the one thing every read of the list must send. */
	function listParams() {
		const text = q.trim();
		const source = sourceFromQuery(text);
		// ⛔ THE LABEL READING ACCOMPANIES THE TEXT, IT DOES NOT REPLACE IT — AND THE FIRST VERSION OF
		// THIS FUNCTION GOT THAT WRONG, WHICH BROKE A SEARCH THAT USED TO WORK. It returned
		// `{ source, page }` INSTEAD of `q` whenever the input resolved to a label, reasoning that the
		// route ANDs `source` with `q` and the label matches no `name`/`slug`/enum/`host`. That
		// reasoning holds for "Opslagdienst" and fails for **"Postgres", which is BOTH the enum value
		// and its localized label in all eight catalogs**: an `http` connector named "Postgres bridge"
		// was findable by the word printed in its own name row before that change and unfindable
		// after it. Substituting a category filter for a text search can only ever LOSE rows.
		//
		// ⛔ SO BOTH GO, AND THE ROUTE UNIONS THEM. `qSource` is an extra ARM of the server's `q`
		// predicate, never an extra AND (that is `?source=`, which this page does not send and which
		// keeps its narrowing contract for API callers). "Opslagdienst" still finds exactly the
		// storage rows — no name contains the word, so the text arm contributes nothing — and
		// "Postgres" now finds the postgres rows AND "Postgres bridge", which is what the word means.
		return { q: text || undefined, qSource: source, page };
	}

	async function load() {
		loading = true;
		error = null;
		denied = false;
		try {
			const list = await connectorsApi.list(listParams());
			items = list.items;
			total = list.total;
			pageSize = list.pageSize;
			canManage = list.canManage ?? false;
			// `?? true` — see the field's note: absent is an older backend, not a disabled feature.
			notificationsEnabled = list.notificationsEnabled ?? true;
			loaded = true;
			// A page past the end (a connector deleted under the reader, or a `page` carried across a
			// reload) returns zero items with a non-zero total — and the pager sits INSIDE the table
			// arm, after both empty-state arms, so the reader would be told the account is empty with
			// no control to page back with. Clamp once and re-ask; `page` is 1 on the retry, so this
			// cannot recurse further. Same shape as /datasets and /solutions, which hit it first.
			if (list.items.length === 0 && page > 1) {
				page = 1;
				await load();
				return;
			}
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) denied = true;
			else error = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}

	function onSearch() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			// A new query re-numbers the result set, so page 3 of the old one means nothing.
			page = 1;
			void load();
		}, 250);
	}
	function goPage(p: number) {
		page = Math.min(Math.max(1, p), totalPages);
		void load();
	}

	function openCreate() {
		creating = true;
		createError = null;
		notifyNotice = null;
		notifyBucket = null;
		kind = 'postgres';
		name = '';
		eventSource = 'none';
		pgUrl = '';
		pgQuery = '';
		// ⛔ `stBaseUrl` WAS THE ONE FIELD THIS RESET FORGOT, and it is the one that decides WHERE the
		// request goes. Every other credential field below was cleared, so a second storage connector
		// opened with a blank bucket/key/token and the FIRST connector's storage host still in the
		// baseUrl input — a form that looks empty and is not. `baseUrl` is load-bearing server-side:
		// it is the egress target (`connectors/index.ts:87` derives the meta host from it) and the
		// base of the object URL (`storage.ts:30`), so a stale value silently points a new connector
		// at the previous host. Pinned by `connectors-page.create-reset.render.test.ts`.
		stBaseUrl = '';
		stBucket = '';
		stKey = '';
		stToken = '';
		httpUrl = '';
	}

	function buildConfig() {
		if (kind === 'postgres') return { url: pgUrl.trim(), query: pgQuery.trim() };
		if (kind === 'storage')
			return {
				baseUrl: stBaseUrl.trim(),
				bucket: stBucket.trim(),
				key: stKey.trim(),
				token: stToken.trim() || undefined
			};
		return { url: httpUrl.trim() };
	}

	let testBusy = $state(false);
	// ⛔ TYPED `ConnectionTestResult`, NOT `{ ok, detail }`. The narrow shape was a LIE that
	// typechecked: the API really does return `code`/`params` at runtime, JS assignment does not
	// strip them, and `connectionTestLabel` reads them — so the localized sentence worked while the
	// declared type said those fields did not exist. The next reader would have "cleaned up" the
	// label module's params handling as dead code.
	let testResult = $state<ConnectionTestResult | null>(null);
	async function testCreate() {
		if (testBusy) return;
		testBusy = true;
		testResult = null;
		try {
			testResult = await connectorsApi.test({ sourceType: kind, config: buildConfig() });
		} catch (e) {
			// Deliberate exception to the sweep: `detail` IS the diagnostic the connection test
			// exists to produce ("ECONNREFUSED 10.0.0.4:5432"), so the raw message stays the
			// fallback. A 403 on the test endpoint still gets localized copy.
			testResult = { ok: false, detail: errorText(e, e instanceof Error ? e.message : String(e)) };
		} finally {
			testBusy = false;
		}
	}

	async function submitCreate() {
		if (!name.trim()) return;
		createBusy = true;
		createError = null;
		notifyNotice = null;
		notifyBucket = null;
		try {
			const created: ConnectorCreated = await connectorsApi.create({
				name: name.trim(),
				sourceType: kind,
				config: buildConfig(),
				eventSource
			});
			creating = false;
			if (created.eventSecret) {
				revealed = { ingestUrl: created.ingestUrl, secret: created.eventSecret };
			secretCopy = null;
			}
			// Auto-registered storage connectors carry no secret to reveal; tell the user whether the
			// live bucket-notification rule was wired (vs. a manual-sync fallback). undefined = N/A.
			notifyNotice =
				created.notifyRegistered === undefined ? null : created.notifyRegistered ? 'ok' : 'failed';
			// Surface the bucket the connector landed in (per-tenant isolation may have rewritten it).
			notifyBucket = notifyNotice && created.meta?.bucket ? created.meta.bucket : null;
			// ⚠️ BACK TO PAGE ONE. The new connector is the most recently updated, so the server puts
			// it first — which is page one and nowhere else. Reloading page three would create a
			// connector the reader is then told, by a table that did not change, was not created.
			// (`q` is deliberately LEFT alone: /datasets does the same, and silently discarding a
			// reader's query is its own surprise.) Same reset as /datasets' `afterCreate`.
			page = 1;
			await load();
		} catch (e) {
			createError = writeErrorText(e, m.error_create_failed());
		} finally {
			createBusy = false;
		}
	}

	async function syncNow(c: Connector) {
		actionError = null;
		actionNotice = null;
		// Optimistic: show syncing immediately; the response (and, later, the SSE 'synced' event)
		// reconciles.
		items = items.map((i) => (i.id === c.id ? { ...i, status: 'syncing' } : i));
		try {
			const { sync, ...fresh } = await connectorsApi.sync(c.slug);

			// ⛔ THE ROW FROM THE RESPONSE IS THE FIX, not the notice below. The route re-reads the
			// connector AFTER `refreshConnector` returns, so `fresh` is the real post-sync state on
			// EVERY branch — including the lock-skipped one, which writes no status and fires no
			// NOTIFY. Without this assignment that branch left the optimistic "Syncing" pill spinning
			// until the user reloaded the page by hand. This does not depend on SSE arriving at all.
			items = items.map((i) => (i.id === c.id ? { ...i, ...fresh } : i));

			const n = syncOutcomeNotice(sync);
			if (n.slot === 'error') {
				// `actionError`, NEVER `error`. See the note on `actionError` above: `error` renders
				// inside the `{#if denied}…{:else if error}` chain and would replace the table.
				// ⛔ `syncErrorText`, NOT THE BARE `n.reason`. `RefreshOutcome.reason` on the failure
				// branch is `code` — the SAME machine token `connector-refresh.ts` writes to
				// `datasets.sync_error_code` in the same catch — so this interpolated it straight into
				// "Synchronisatie mislukt: {reason}" and the user read
				// "Synchronisatie mislukt: egress_host_not_allowlisted". The Dutch copy for these codes
				// already existed and was already rendering TWO PANES AWAY: the drawer notice and the
				// status-badge tooltip both resolve the PERSISTED column through `syncErrorText`. Only
				// the live action response walked past it — so one failure was Dutch after a reload and
				// English at the moment it happened.
				//
				// ⚠️ THE CODE ITSELF IS THE FALLBACK, AND THAT IS A DELIBERATE DEPARTURE FROM
				// `syncErrorText`'S OWN "⛔ NEVER `code` ITSELF" NOTE. That note is written for a caller
				// that HAS the backend's English sentence to fall back to (the `sync_error` column); this
				// branch has nothing else — `RefreshOutcome` carries a code and no prose. So the real
				// choice is between naming the cause and hiding it behind `error_action_failed()`, and a
				// token the reader can quote to an admin beats a generic sentence that says nothing.
				// `legacyText` is exactly that "this is all I have".
				actionError = n.reason
					? m.connectors_sync_failed({ reason: syncErrorText(n.reason, n.reason) })
					: m.error_action_failed();
			} else if (n.key === 'connectors_sync_truncated') {
				actionNotice = {
					tone: n.tone,
					text: m.connectors_sync_truncated({
						rows: num(n.rows ?? 0, locale.current),
						truncated: num(n.truncated ?? 0, locale.current)
					})
				};
			} else if (n.key === 'connectors_sync_locked') {
				actionNotice = { tone: n.tone, text: m.connectors_sync_locked() };
			} else {
				actionNotice = { tone: n.tone, text: m.connectors_sync_ok({ rows: num(n.rows ?? 0, locale.current) }) };
			}
		} catch (e) {
			actionError = writeErrorText(e, m.error_action_failed());
			await load();
		}
	}

	// `background: true` is the SSE refresh (see the streamConnectors handler in onMount), NOT a
	// click. It must not touch `actionError` in either direction:
	//   * clearing it would ERASE AN UNREAD FAILURE with no user input at all — a backend NOTIFY
	//     for this connector (a scheduled sync completing) would silently wipe the "Sync failed"
	//     banner the user is still reading. That is the same defect this PR rejects folding into
	//     `voteError` for, arriving through a path where not even a click is required.
	//   * setting it would paint a red banner for something the user never asked for. A stale
	//     drawer until the next real interaction is the better failure: the next click surfaces a
	//     genuine error, and the user is not told their action failed when they took none.
	async function inspect(slug: string, opts: { background?: boolean } = {}) {
		if (!opts.background) actionError = null;
		drawerLoading = true;
		selected = null;
		try {
			selected = await connectorsApi.get(slug, { limit: PREVIEW_LIMIT });
		} catch (e) {
			if (!opts.background) actionError = errorText(e, m.error_load_failed());
		} finally {
			drawerLoading = false;
		}
	}

	async function rotate(c: Connector) {
		actionError = null;
		try {
			const r = await connectorsApi.rotateSecret(c.slug);
			revealed = { ingestUrl: r.ingestUrl, secret: r.eventSecret };
			secretCopy = null;
		} catch (e) {
			actionError = writeErrorText(e, m.error_action_failed());
		}
	}

	async function reregister(c: Connector) {
		// Manual retry for a storage+webhook connector whose auto-registration fell back to
		// manual-sync-only. Updates the row in place and surfaces the outcome via the notice.
		actionError = null;
		try {
			const r = await connectorsApi.reregisterNotifications(c.slug);
			items = items.map((i) => (i.id === c.id ? r : i));
			notifyNotice = r.notifyRegistered ? 'ok' : 'failed';
			// The bucket is unchanged on re-register (and already visible in the row) — don't show it.
			notifyBucket = null;
		} catch (e) {
			actionError = writeErrorText(e, m.error_action_failed());
		}
	}

	async function verify(c: Connector) {
		// Probe storage_service for the LIVE MinIO rule and self-heal the stored flag, so the row
		// reflects ground truth (catches a "false-green" whose rule was lost out-of-band).
		//
		// ⛔ `writeErrorText`, AND THE NOTE THAT USED TO SIT HERE WAS THE DEFECT ITSELF. It read: "GET —
		// a read/diagnostic probe like `testCreate` above, not a mutation — so this stays on
		// `errorText`, not `writeErrorText`." The rule it invokes is about the 400/422 VALIDATION
		// sentences a WRITE produces. But this route answers `400 notifications_disabled`, and
		// `errorText` maps NO 400 at all (402 / 403 / 409-seat_limit / 503 / 401 only) — so the one
		// refusal that actually happens in the field came out as the bare `error_action_failed`, "Dat is
		// niet gelukt. Probeer het opnieuw.", advising a retry that can never work. The two SIBLING
		// buttons answering the IDENTICAL wire code (`reregister`, `reconcileAll`) were already on
		// `writeErrorText` and got the correct Dutch sentence. One screen, one refusal, two answers.
		//
		// ⚠️ STRICTLY ADDITIVE: `writeErrorText` consults `VALIDATION_MESSAGES` for 400/422/409 and
		// falls through to `errorText` for everything else, so no other status changes behaviour here.
		// The copy already existed in all eight catalogs (`error-message.ts` →
		// `error_notifications_disabled`); nothing on this path could reach it.
		actionError = null;
		try {
			const r = await connectorsApi.verifyNotifications(c.slug);
			items = items.map((i) => (i.id === c.id ? r : i));
			actionNotice = !r.reachable
				? { tone: 'warn', text: m.connectors_verify_unreachable() }
				: r.notifyLive
					? { tone: 'ok', text: m.connectors_verify_live() }
					: { tone: 'warn', text: m.connectors_verify_drift() };
		} catch (e) {
			actionError = writeErrorText(e, m.error_action_failed());
		}
	}

	async function reconcileAll() {
		// Re-assert every storage+webhook connector's MinIO rule for this tenant (recovery after a
		// MinIO restart). Idempotent; reloads to reflect any repaired rows.
		actionError = null;
		try {
			const r = await connectorsApi.reconcileNotifications();
			await load();
			actionNotice = {
				tone: r.failed > 0 ? 'warn' : 'ok',
				text: m.connectors_reconcile_result({
					checked: num(r.checked, locale.current),
					repaired: num(r.repaired, locale.current)
				})
			};
		} catch (e) {
			actionError = writeErrorText(e, m.error_action_failed());
		}
	}

	async function remove(c: Connector) {
		if (!(await confirmDialog({ message: m.connectors_confirm_delete() }))) return;
		actionError = null;
		try {
			await connectorsApi.remove(c.slug);
			if (selected?.slug === c.slug) selected = null;
			await load();
		} catch (e) {
			actionError = writeErrorText(e, m.error_delete_failed());
		}
	}

	// ⛔ THE SERVER LOST A PUSH — RE-READ THE LIST RATHER THAN GUESS AT IT. The `error` frame
	// (routes/connectors.ts's detached continuation, mirrored in `streamConnectors`) is a bare
	// signal: it carries no connector id, deliberately, because one NOTIFY reaches every subscribed
	// stream on the pod and naming the connector would cross a tenant boundary. So we do not know
	// WHICH row the lost frame would have updated — and `syncNow`'s optimistic "Syncing" pill only
	// ever leaves that state on a frame, which is how a failed push used to spin a row forever. One
	// re-read replaces every optimistic status with the server's real one, and it is the honest
	// answer besides: the server's row is ground truth, a guessed status is not.
	//
	// ⚠️ BACKGROUND, in the exact sense the note on `inspect` sets out. It must not touch `loading`
	// (that would blank the table into `LoadingRows` for something the user never asked for), must
	// not write `error` (that renders in the `{#if denied}…{:else if error}` chain and would REPLACE
	// the table), and must not write OR clear `actionError` — clearing it would erase a failure the
	// user is still reading, with no user input at all.
	async function reconcileAfterLostPush() {
		try {
			// ⚠️ `listParams()`, NOT a bare `list()`. A background re-read that drops the reader's query
			// would silently throw them back to page one of the unfiltered list while they were
			// reading page three — a lost NOTIFY frame is not a reason to move the screen under them.
			const list = await connectorsApi.list(listParams());
			items = list.items;
			total = list.total;
			pageSize = list.pageSize;
			canManage = list.canManage ?? canManage;
		} catch {
			// A stale table until the next real interaction is the better failure — the next click
			// surfaces a genuine error, and the user is not told an action failed when they took none.
		}
	}

	onMount(() => {
		void load();
		// Reactive status updates — the backend NOTIFYs on every sync completion.
		stream = streamConnectors(
			(c) => {
				items = items.map((i) => (i.id === c.id ? c : i));
				if (selected?.id === c.id) void inspect(c.slug, { background: true });
			},
			() => void reconcileAfterLostPush()
		);
	});
	onDestroy(() => {
		stream?.close();
		// The debounce outlives the component otherwise, and its callback writes `$state` on a page
		// that is gone.
		clearTimeout(searchTimer);
	});
</script>

<div class="page">
	<header class="page-head">
		<div>
			<div class="eyebrow">{m.connectors_eyebrow()}</div>
			<h1>{m.connectors_title()}</h1>
			<p>{m.connectors_subtitle()}</p>
		</div>
		<div class="head-actions">
			<a class="btn-import" href="/datasets">{m.connector_import_cta()}</a>
			{#if canManage && items.some((c) => c.sourceType === 'storage' && c.eventSource === 'webhook')}
				<!-- ⛔ THE REASON LIVES ON A WRAPPER, NOT ON THE BUTTON. A disabled button fires no pointer
				     events, so a `title` on it never surfaces a tooltip — the rule `VoteButton.svelte` already
				     states for this codebase. And a tooltip alone is not keyboard-reachable, which is why the
				     same sentence is also rendered on screen, below the governance banner. -->
				<span class="gate-wrap" title={notifyBlockedReason ?? undefined}>
					<button class="btn-secondary" onclick={reconcileAll} disabled={notifyBlockedReason !== null} aria-disabled={notifyBlockedReason !== null}>{m.connectors_reconcile()}</button>
				</span>
			{/if}
			{#if canManage}
				<button class="btn-primary" onclick={openCreate}>{m.connectors_new()}</button>
			{/if}
		</div>
	</header>

	<div class="governance-banner">
		<span class="gov-tag">{m.connector_governance_title()}</span>
		<span class="gov-note">{m.connector_governance_note()}</span>
	</div>

	<!-- ⛔ THE KEYBOARD-REACHABLE HALF OF THE REASON. The wrappers carry it as a `title`, and a
	     title is neither reliably announced nor reachable without a pointer — so the fact is stated
	     once, plainly, wherever the three gated controls are on screen. `role="status"`, not
	     `"alert"`: nothing failed, a capability is simply switched off for this workspace.
	     ⚠️ Gated on `canManage` too — a member never sees any of the three controls, so telling
	     them why those controls are inert would name a feature they cannot reach either way. -->
	{#if canManage && notifyBlockedReason}
		<p class="notice warn" role="status" data-testid="notifications-disabled">{notifyBlockedReason}</p>
	{/if}

	{#if notifyNotice}
		<div class="notice {notifyNotice === 'ok' ? 'ok' : 'warn'}" role="status">
			<span>
				{notifyNotice === 'ok' ? m.connectors_notify_registered() : m.connectors_notify_failed()}
				{#if notifyBucket}<span class="notice-bucket mono">{m.connectors_created_bucket({ bucket: notifyBucket })}</span>{/if}
			</span>
			<button class="notice-x" onclick={() => { notifyNotice = null; notifyBucket = null; }} aria-label={m.connectors_close()}>✕</button>
		</div>
	{/if}

	{#if actionNotice}
		<div class="notice {actionNotice.tone}" role="status">
			<span>{actionNotice.text}</span>
			<button class="notice-x" onclick={() => (actionNotice = null)} aria-label={m.connectors_close()}>✕</button>
		</div>
	{/if}

	{#if actionError}
		<div class="notice error">{actionError}</div>
	{/if}

	{#if denied}
		<div class="notice error">{m.connectors_denied()}</div>
	{:else if loading && !loaded}
		<LoadingRows />
	{:else if error}
		<div class="notice error">{error}</div>
	{:else}
		<!-- ⛔ THE SEARCH BOX LIVES OUTSIDE THE STATE CHAIN, and that is the whole point of the move.
		     It used to render inside the arm that also renders the table, so the moment a query
		     matched nothing the input that produced the query DISAPPEARED — the reader could not
		     correct their typo without reloading the page. /datasets puts its filter bar here for the
		     same reason. -->
		<div class="search-bar">
			<input class="search" type="search" placeholder={m.connectors_search_placeholder()} bind:value={q} oninput={onSearch} aria-label={m.connectors_search_placeholder()} />
		</div>
		{#if items.length === 0 && q.trim()}
			<!-- A no-match SEARCH is not an empty account. `q` is a SERVER-side filter now, so
			     `items.length === 0` answers two different questions and needs two different arms.
			     ⛔ NO CTA ON THIS ARM: offering "New connector" to someone whose search missed pushes
			     them toward re-creating a connector they already have. -->
			<div class="notice">{m.connectors_no_match()}</div>
		{:else if items.length === 0}
			<div class="notice empty-cta">
				<span>{m.connectors_empty()}</span>
				{#if canManage}
					<button class="btn-primary" onclick={openCreate}>{m.connectors_new()}</button>
				{/if}
			</div>
		{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th>{m.connectors_col_name()}</th>
						<th>{m.connectors_col_source()}</th>
						<th>{m.connectors_col_host()}</th>
						<th>{m.connectors_col_status()}</th>
						<th class="num">{m.connectors_col_rows()}</th>
						<th>{m.connectors_col_synced()}</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each items as c (c.id)}
						<tr>
							<td>
								<div class="ds-name">{c.name}</div>
								<div class="ds-slug">{c.slug}</div>
							</td>
							<td><span class="badge teal">{sourceLabel(c.sourceType)}</span></td>
							<td class="muted mono">{c.meta?.host ?? m.connectors_host_unknown()}</td>
							<td>
								<!-- ⛔ NOT `c.syncError`. That is the server's English, persisted onto the row — this
								     tooltip put it inside a Dutch page and kept it there across reloads. `syncErrorText`
								     resolves the wire code through the catalog and falls back to the English only for a
								     pre-0074 row or a code whose sentence needs a field the row does not carry. -->
								<span class="badge status {c.status}" title={syncErrorText(c.syncErrorCode, c.syncError, c.syncErrorDetail)}>{statusLabel(c.status)}</span>
								{#if c.sourceType === 'storage' && c.eventSource === 'webhook' && c.meta?.notifyRegistered === false}
									<span class="badge warn" title={m.connectors_notify_failed()}>{m.connectors_notify_off()}</span>
								{/if}
							</td>
							<td class="num">{num(c.rowCount, locale.current)}</td>
							<td class="muted">{c.lastSyncedAt ? timeAgo(c.lastSyncedAt) : m.connectors_never_synced()}</td>
							<!--
								⛔ EVERY ACTION HERE EXCEPT PREVIEW IS `requireDataManager` ON THE WIRE — sync
								(connectors.ts:522), rotate (:542), verify (:734), re-register (:576) and delete
								(:797) all refuse anyone who is not a tenant_admin. They used to render for every
								member of the org, so an ordinary reader got five buttons (one of them a red
								Delete) that answer 403. `canManage` is the SAME flag the header's "New
								connector"/"Reconcile" already key off, taken from the list response — no second
								role expression to drift from the server's.
								Preview stays ungated on purpose: `getConnector` is `resolveTenant`
								(connectors.ts:507), so browsing a connector's rows is a member's to do.
							-->
							<td class="num row-actions">
								{#if canManage}
									<button class="btn-sm" onclick={() => syncNow(c)} disabled={c.status === 'syncing'}>{m.connectors_sync()}</button>
								{/if}
								<button class="btn-sm" onclick={() => inspect(c.slug)}>{m.connectors_preview()}</button>
								{#if canManage && c.eventSource === 'webhook'}
									<button class="btn-sm" onclick={() => rotate(c)}>{m.connectors_rotate()}</button>
								{/if}
								<!-- ⛔ DISABLED, NOT HIDDEN, AND WITH THE REASON. Both of these answer
								     `400 notifications_disabled` whenever the feature is off, and it ships off — so before
								     this they were controls that could only ever fail, and pressing one produced a bare
								     "Actie mislukt" (see `verify`). Hiding them would have been the cheaper fix and the worse
								     one: a control that vanishes leaves the reader unable to tell "this workspace cannot do
								     that" from "I am looking at the wrong row". The `title` is on the WRAPPER because a
								     disabled button fires no pointer events — VoteButton.svelte's rule. -->
								{#if canManage && c.sourceType === 'storage' && c.eventSource === 'webhook'}
									<span class="gate-wrap" title={notifyBlockedReason ?? undefined}>
										<button class="btn-sm" onclick={() => verify(c)} disabled={notifyBlockedReason !== null} aria-disabled={notifyBlockedReason !== null}>{m.connectors_verify()}</button>
									</span>
								{/if}
								{#if canManage && c.sourceType === 'storage' && c.eventSource === 'webhook' && c.meta?.notifyRegistered === false}
									<span class="gate-wrap" title={notifyBlockedReason ?? undefined}>
										<button class="btn-sm" onclick={() => reregister(c)} disabled={notifyBlockedReason !== null} aria-disabled={notifyBlockedReason !== null}>{m.connectors_reregister()}</button>
									</span>
								{/if}
								{#if canManage}
									<button class="btn-sm danger" onclick={() => remove(c)}>{m.connectors_delete()}</button>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<!-- The SHARED pager (`$lib/components/ui/Pager.svelte`), not a fifth hand-rolled copy of the
		     same markup + CSS + four-key catalog family. /solutions already uses it; the three inline
		     copies on /challenges, /sandboxes and /datasets are the legacy its own header calls out.
		     It renders nothing at all when there is only one page, so a tenant with three connectors
		     sees no change. -->
		<Pager {page} {totalPages} shown={items.length} {total} onPage={goPage} />
		{/if}
	{/if}
</div>

<!-- Create drawer -->
{#if creating}
	<div class="scrim" role="button" tabindex="0" aria-label={m.connectors_close()} onclick={() => (creating = false)} onkeydown={(e) => e.key === 'Escape' && (creating = false)}></div>
	<aside class="drawer">
		<header class="drawer-head">
			<div class="drawer-name">{m.connectors_create_title()}</div>
			<button class="icon-x" onclick={() => (creating = false)} aria-label={m.connectors_close()}>✕</button>
		</header>
		<div class="chips">
			<button class="chip" class:active={kind === 'postgres'} onclick={() => (kind = 'postgres')}>{m.connectors_source_postgres()}</button>
			<button class="chip" class:active={kind === 'storage'} onclick={() => (kind = 'storage')}>{m.connectors_source_storage()}</button>
			<button class="chip" class:active={kind === 'http'} onclick={() => (kind = 'http')}>{m.connectors_source_http()}</button>
		</div>
		<div class="create-body">
			<label class="field">
				<span class="field-label">{m.connectors_name_label()}</span>
				<input type="text" bind:value={name} placeholder="live-claims" />
			</label>

			{#if kind === 'postgres'}
				<label class="field">
					<span class="field-label">{m.connectors_pg_url()}</span>
					<input type="text" bind:value={pgUrl} placeholder="postgres://user:pass@host:5432/db" />
				</label>
				<label class="field">
					<span class="field-label">{m.connectors_pg_query()}</span>
					<textarea rows="4" bind:value={pgQuery} placeholder="SELECT id, amount FROM claims LIMIT 1000"></textarea>
				</label>
			{:else if kind === 'storage'}
				<label class="field">
					<span class="field-label">{m.connectors_st_baseurl()}</span>
					<input type="text" bind:value={stBaseUrl} placeholder="https://…" />
				</label>
				<label class="field">
					<span class="field-label">{m.connectors_st_bucket()}</span>
					<input type="text" bind:value={stBucket} placeholder="artifacts" />
				</label>
				<label class="field">
					<span class="field-label">{m.connectors_st_key()}</span>
					<input type="text" bind:value={stKey} placeholder="exports/claims.csv" />
				</label>
				<label class="field">
					<span class="field-label">{m.connectors_st_token()}</span>
					<input type="password" bind:value={stToken} />
				</label>
			{:else}
				<label class="field">
					<span class="field-label">{m.connectors_http_url()}</span>
					<input type="text" bind:value={httpUrl} placeholder="https://api.example.com/rows.json" />
				</label>
			{/if}

			<label class="field">
				<span class="field-label">{m.connectors_event_label()}</span>
				<select bind:value={eventSource}>
					<option value="none">{m.connectors_event_none()}</option>
					<option value="webhook">{m.connectors_event_webhook()}</option>
				</select>
			</label>

			<div class="create-actions">
				<button class="btn-ghost" type="button" onclick={testCreate} disabled={testBusy}>
					{testBusy ? m.connectors_testing() : m.connectors_test()}
				</button>
				<button class="btn-primary" onclick={submitCreate} disabled={createBusy || !name.trim()}>
					{createBusy ? m.connectors_creating() : m.connectors_create_submit()}
				</button>
			</div>
			<!-- ⛔ `{testResult.detail}` WAS THE DEFECT, AND ITS SUCCESS BRANCH WAS THE WORST OF IT.
			     This endpoint answers HTTP 200 whether the test passed or failed (a bad credential is a
			     normal RESULT, not a transport error), so nothing throws and `errorText` — the one
			     helper that localizes a backend code — is never reached on this path. A Dutch admin
			     testing a connector that WORKS read "Connected — read 5 columns, 3 sample rows."
			     The counts are now machine `params` and the sentence is chosen here. -->
			{#if testResult}<div class="notice {testResult.ok ? 'ok' : 'error'}">{connectionTestLabel(testResult, locale.current)}</div>{/if}
			{#if createError}<div class="notice error">{createError}</div>{/if}
		</div>
	</aside>
{/if}

<!-- Secret reveal (once) -->
{#if revealed}
	<div class="scrim" role="button" tabindex="0" aria-label={m.connectors_close()} onclick={() => (revealed = null)} onkeydown={(e) => e.key === 'Escape' && (revealed = null)}></div>
	<aside class="drawer">
		<header class="drawer-head">
			<div class="drawer-name">{m.connectors_secret_title()}</div>
			<button class="icon-x" onclick={() => (revealed = null)} aria-label={m.connectors_close()}>✕</button>
		</header>
		<div class="create-body">
			<p class="warn">{m.connectors_secret_warn()}</p>
			{#if revealed.ingestUrl}
				<label class="field">
					<span class="field-label">{m.connectors_ingest_url()}</span>
					<input type="text" readonly value={revealed.ingestUrl} />
				</label>
			{/if}
			<div class="field">
				<span class="field-label" id="connector-secret-label">{m.connectors_secret_label()}</span>
				<!-- ⚠️ NOT a `<label>` any more, and the button is why: a `<button>` inside a `<label>`
				     is activated a second time by the label's own click forwarding. `aria-labelledby`
				     keeps the input named without the wrapper.
				     `dir="ltr"` on the value: a secret is an opaque token, and under an RTL paragraph
				     direction (ar/he) the browser would reorder what the reader must copy exactly. -->
				<div class="secret-row">
					<input class="mono" type="text" dir="ltr" readonly value={revealed.secret} aria-labelledby="connector-secret-label" />
					<button class="btn-sm" onclick={copySecret}>
						{secretCopy === 'copied' ? m.connectors_secret_copied() : m.connectors_secret_copy()}
					</button>
				</div>
			</div>
			<!-- role="status" so the confirmation is announced, not only seen — the button's own
			     label changing is invisible to a screen reader that is not on the button. -->
			{#if secretCopy === 'copied'}
				<div class="notice ok" role="status">{m.connectors_secret_copied()}</div>
			{:else if secretCopy === 'failed'}
				<div class="notice error" role="status">{m.connectors_secret_copy_failed()}</div>
			{/if}
		</div>
	</aside>
{/if}

<!-- Preview drawer -->
{#if selected || drawerLoading}
	<div class="scrim" role="button" tabindex="0" aria-label={m.connectors_close()} onclick={() => (selected = null)} onkeydown={(e) => e.key === 'Escape' && (selected = null)}></div>
	<aside class="drawer wide">
		{#if drawerLoading || !selected}
			<div class="drawer-pad">{m.connectors_loading()}</div>
		{:else}
			<header class="drawer-head">
				<div>
					<div class="drawer-name">{selected.name}</div>
					<div class="ds-slug">{selected.slug} · {num(selected.rowCount, locale.current)} {m.connectors_rows_word()}</div>
				</div>
				<button class="icon-x" onclick={() => (selected = null)} aria-label={m.connectors_close()}>✕</button>
			</header>
			<!-- ⛔ THE SENTENCE, NOT THE STORED PROSE. The condition still reads `syncError` on purpose:
			     the notice's job is "did the last sync fail", and a pre-0074 row answers that with the
			     English column alone. `syncErrorText` then decides which words to show. -->
			{#if selected.syncError || selected.syncErrorCode}
				<div class="notice error">{m.connectors_sync_error_label()}: {syncErrorText(selected.syncErrorCode, selected.syncError, selected.syncErrorDetail)}</div>
			{/if}
			<div class="drawer-section">{m.connectors_sample_rows()}</div>
			<div class="sample-wrap">
				<table class="sample">
					<thead>
						<!-- ⛔ KEYED BY INDEX, NOT `(c.name)`. A connector materializes a LIVE source, and a
						     SELECT joining two tables that both have `id` is the ordinary way to end up with two
						     columns of one name. That threw `each_key_duplicate` (not dev-only) and, with no
						     `<svelte:boundary>` in this tree, blanked the WHOLE /connectors page — the drawer,
						     the table behind it and the sync controls. Refresh now de-duplicates at parse, but
						     ⛔ NOTHING REPAIRED WHAT WAS ALREADY STORED — migration `0069` was withdrawn before it
						     ever merged (boot-wedge risk; its target population measured ZERO in prod, dev and the
						     union DB on 2026-08-19), so this keying is the only guard for a legacy row. A column
						     list is positional and the index is already its identity.
						     Guarded by `connectors-page.duplicate-columns.render.test.ts`. -->
						<tr>{#each selected.columns as c, ci (ci)}<th>{c.name}</th>{/each}</tr>
					</thead>
					<tbody>
						{#each selected.rows as r, ri (ri)}
							<tr>
								{#each selected.columns as c, ci (ci)}
									<!-- W8/P7: a column this reader may not see arrives blanked; show "•••" with the
									     same tooltip as DatasetPreviewTable rather than the server's placeholder. -->
									{#if selected.maskedColumns?.includes(c.name)}
										<td><span class="masked" title={m.dataset_preview_masked()} aria-label={m.dataset_preview_masked()}>{MASKED_CELL}</span></td>
									{:else}
										<td>{r[c.name] === null || r[c.name] === undefined ? '' : typeof r[c.name] === 'object' ? JSON.stringify(r[c.name]) : String(r[c.name])}</td>
									{/if}
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
				<!--
					⛔ THE CEILING IS SAID OUT LOUD. The header two elements up renders `rowCount`; without
					this line a 10 000-row connector showed that figure over a table of 200 and claimed,
					by omission, that 200 was all of it. `dataset_preview_more` is the SAME sentence
					/datasets' preview table (lib/components/DatasetPreviewTable.svelte) puts under the
					same situation — reused rather than reinvented so the two screens say one thing, and
					so it needs no new key in eight catalogs.
					⚠️ The condition is `rows.length < rowCount`, NOT `=== PREVIEW_LIMIT`: `rowCount` is
					the connector's own count and the window is whatever the server actually returned, so
					this stays true if either the constant or the server's clamp ever moves.
				-->
				{#if selected.rows.length < selected.rowCount}
					<div class="sample-more">{m.dataset_preview_more({ shown: num(selected.rows.length, locale.current), total: num(selected.rowCount, locale.current) })}</div>
				{/if}
			</div>
		{/if}
	</aside>
{/if}

<style>
	.masked {
		color: var(--c-faint);
		letter-spacing: 1px;
		cursor: help;
	}
	.page { max-width: 1180px; }
	.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
	.eyebrow { font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600; color: var(--c-teal-dark); margin-bottom: 8px; }
	h1 { font-family: var(--font-display); font-size: 28px; margin: 0 0 4px; color: var(--c-midnight); }
	.page-head p { color: var(--c-muted); font-size: 13.5px; margin: 0; max-width: 680px; }
	.create-actions { display: flex; gap: 8px; }
	.btn-ghost { background: var(--c-white); color: var(--c-ink); font-weight: 500; font-size: 13px; padding: 9px 16px; border-radius: var(--r); white-space: nowrap; border: 1px solid var(--c-border); cursor: pointer; }
	.btn-ghost:disabled { opacity: 0.6; cursor: not-allowed; }
	.btn-primary { background: var(--c-teal); color: #fff; font-weight: 600; font-size: 13px; padding: 9px 16px; border-radius: var(--r); white-space: nowrap; border: none; cursor: pointer; }
	.btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
	.btn-secondary { background: var(--c-surface); color: var(--c-teal-dark); font-weight: 600; font-size: 13px; padding: 9px 16px; border-radius: var(--r); white-space: nowrap; border: 1px solid var(--c-teal-light); cursor: pointer; }
	.btn-secondary:disabled { opacity: 0.6; cursor: not-allowed; }
	.head-actions { display: flex; align-items: center; gap: 8px; }
	.btn-import { font-size: 13px; font-weight: 600; color: var(--c-teal-dark); background: var(--c-teal-light); padding: 9px 16px; border-radius: var(--r); white-space: nowrap; text-decoration: none; }
	.governance-banner { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; background: var(--c-amber-light, #fef3c7); border: 1px solid var(--c-amber, #f59e0b); border-radius: var(--r); padding: 10px 14px; margin-bottom: 18px; }
	.gov-tag { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #92400e; background: #fff; border: 1px solid var(--c-amber, #f59e0b); padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
	.gov-note { font-size: 12.5px; color: #92400e; }
	.search-bar { margin-bottom: 12px; }
	.search { font-size: 12.5px; color: var(--c-ink); background: var(--c-white); border: 1px solid var(--c-border); padding: 8px 12px; border-radius: var(--r); min-width: 240px; }
	/* Phone width (the shell drawer breakpoint, app.css): the header's actions wrap under the title. */
	@media (max-width: 767.98px) {
		.page-head { flex-wrap: wrap; }
		.head-actions, .create-actions { flex-wrap: wrap; }
		.search { min-width: 0; width: 100%; }
	}
	.search::placeholder { color: var(--c-muted); }
	.table-wrap { background: var(--c-white); border: 1px solid var(--c-border); border-radius: var(--r-lg); overflow: hidden; }
	table { width: 100%; border-collapse: collapse; }
	th { text-align: start; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--c-muted); font-weight: 600; padding: 12px 16px; border-bottom: 1px solid var(--c-border); background: var(--c-surface); }
	td { padding: 12px 16px; font-size: 13px; color: var(--c-ink); border-bottom: 1px solid var(--c-border); vertical-align: middle; }
	tbody tr:last-child td { border-bottom: none; }
	tbody tr:hover { background: var(--c-surface); }
	.num { text-align: end; font-variant-numeric: tabular-nums; }
	.muted { color: var(--c-muted); }
	.mono { font-family: var(--font-mono); font-size: 11.5px; }
	.ds-name { font-weight: 500; color: var(--c-ink); }
	.ds-slug { font-family: var(--font-mono); font-size: 11px; color: var(--c-muted); margin-top: 1px; }
	.badge { font-size: 11px; font-weight: 500; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
	.badge.teal { background: var(--c-teal-light); color: var(--c-teal-dark); }
	.badge.status.ready { background: var(--c-teal-light); color: var(--c-teal-dark); }
	.badge.status.syncing { background: var(--c-amber-light, #fef3c7); color: var(--c-amber-dark, #92400e); }
	.badge.status.error { background: var(--c-coral-pale); color: var(--c-coral-dark); }
	.badge.status.parsing { background: var(--c-surface); color: var(--c-muted); }
	.badge.warn { background: var(--c-amber-light, #fef3c7); color: var(--c-amber-dark, #92400e); margin-inline-start: 6px; }  /* logical: physical margin-left flipped to the wrong side of the badge in RTL */
	.row-actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
	.btn-sm { font-size: 12px; font-weight: 500; color: var(--c-ink); background: var(--c-white); border: 1px solid var(--c-border); padding: 5px 11px; border-radius: var(--r); cursor: pointer; }
	.btn-sm:hover:not(:disabled) { border-color: var(--c-border-strong); }
	.btn-sm:disabled { opacity: 0.45; cursor: not-allowed; }
	.btn-sm.danger { color: var(--c-rose); }
	.notice { padding: 24px; text-align: center; color: var(--c-muted); font-size: 13.5px; background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); margin-top: 12px; }
	.empty-cta { display: flex; flex-direction: column; align-items: center; gap: 14px; }
	.notice.error { color: var(--c-coral-dark); background: var(--c-coral-pale); border-color: var(--c-coral-light); }
	.notice.ok, .notice.warn { display: flex; align-items: center; justify-content: space-between; gap: 12px; text-align: start; padding: 12px 14px; }  /* logical: `left` left the notice text LTR-aligned in RTL */
	.notice.ok { color: var(--c-teal-dark); background: var(--c-teal-pale); border-color: var(--c-teal-light); }
	.notice.warn { color: var(--c-amber-dark); background: var(--c-amber-pale); border-color: var(--c-amber-light); }
	/* logical: physical margin-left collapsed the gap on the wrong side in RTL */
	.notice-bucket { margin-inline-start: 8px; opacity: 0.85; }
	.notice-x { background: none; border: none; font-size: 14px; line-height: 1; color: inherit; cursor: pointer; padding: 2px 4px; opacity: 0.7; }
	.notice-x:hover { opacity: 1; }
	.warn { font-size: 12.5px; color: var(--c-coral-dark); background: var(--c-coral-pale); border: 1px solid var(--c-coral-light); border-radius: var(--r-sm); padding: 10px 12px; margin: 0; }
	/* Drawer */
	.scrim { position: fixed; inset: 0; background: rgba(11, 20, 55, 0.32); z-index: 40; }
	.drawer { position: fixed; top: 0; inset-inline-end: 0; bottom: 0; width: 460px; max-width: 92vw; background: var(--c-white); border-inline-start: 1px solid var(--c-border); box-shadow: var(--sh-lg); z-index: 41; overflow-y: auto; padding: 20px 22px; }
	.drawer.wide { width: 560px; }
	.drawer-pad { color: var(--c-muted); font-size: 13px; padding: 12px 0; }
	.drawer-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
	.drawer-name { font-weight: 600; font-size: 16px; color: var(--c-midnight); }
	.icon-x { background: none; border: none; font-size: 16px; color: var(--c-muted); cursor: pointer; padding: 4px; }
	.chips { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
	.chip { font-size: 12.5px; font-weight: 500; color: var(--c-muted); background: var(--c-white); border: 1px solid var(--c-border); padding: 6px 12px; border-radius: 999px; cursor: pointer; }
	.chip.active { background: var(--c-midnight); color: #fff; border-color: var(--c-midnight); }
	.create-body { display: flex; flex-direction: column; gap: 12px; }
	.field { display: flex; flex-direction: column; gap: 5px; }
	.field-label { font-size: 11.5px; font-weight: 600; color: var(--c-muted); }
	.field input, .field select, .field textarea { font-size: 12.5px; padding: 7px 10px; border: 1px solid var(--c-border); border-radius: var(--r-sm); background: var(--c-white); font-family: inherit; width: 100%; box-sizing: border-box; }
	.field textarea { font-family: var(--font-mono); resize: vertical; }
	.drawer-section { font-size: 12.5px; font-weight: 600; color: var(--c-ink); margin: 16px 0 8px; }
	.sample-wrap { overflow-x: auto; border: 1px solid var(--c-border); border-radius: var(--r-sm); }
	table.sample { font-size: 11.5px; }
	table.sample th, table.sample td { padding: 6px 10px; white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
	/* Same figures as lib/components/DatasetPreviewTable.svelte's `.sample-more`, so the ceiling
	   notice reads identically on /connectors and /datasets. */
	.sample-more { font-size: 11px; color: var(--c-faint); padding: 8px 10px; }
	.secret-row { display: flex; align-items: center; gap: 8px; }
	.secret-row input { flex: 1 1 auto; min-width: 0; }
	/* The gate wrapper exists to hold a `title` a disabled button cannot. `display: contents` keeps
	   it out of the row's flex layout entirely, so the action cell is spaced exactly as before.
	   ⚠️ `contents` removes the box, not the tooltip: the title still resolves from the child. */
	.gate-wrap {
		display: contents;
	}
</style>
