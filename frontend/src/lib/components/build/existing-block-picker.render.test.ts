// @vitest-environment jsdom
//
// Render guard for the backend-error localization sweep.
//
// Nothing in this app asserted that a screen SHOWS localized copy when a client rejects, which is
// exactly how ~130 catch blocks drifted into rendering the backend's English developer strings
// ("Developer role required", "Tenant scope mismatch") verbatim in all 8 locales. This test mounts
// a real component, rejects its client with a real 403 ApiError, and asserts the DOM does not
// contain the backend `message`.
//
// ExistingBlockPicker is the smallest honest subject: it renders `{error}` straight into a banner,
// and its only collaborators are blocksApi + Skeleton.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import type { BlockCategory } from '$lib/types/blocks';

class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string
	) {
		super(message);
		this.name = 'ApiError';
	}
}

const list = vi.fn();
const get = vi.fn();

vi.mock('$lib/api/blocks', () => ({ ApiError, blocksApi: { list, get } }));

// Only the two keys this component's error path can reach need real-ish copy; the rest just have
// to exist. The sentinel values make the assertions unambiguous.
vi.mock('$lib/paraglide/messages', () => ({
	error_developer_required: () => 'LOCALIZED: you need the Developer role',
	error_forbidden: () => 'LOCALIZED: no permission',
	error_load_failed: () => 'LOCALIZED: could not load',
	error_license_required: () => 'x',
	error_license_inactive: () => 'x',
	error_license_expired: () => 'x',
	error_license_unavailable: () => 'x',
	error_seat_limit_reached: () => 'x',
	error_license_app_mismatch: () => 'x',
	error_license_tenant_mismatch: () => 'x',
	error_super_admin_required: () => 'x',
	error_admin_required: () => 'x',
	error_tenant_admin_required: () => 'x',
	error_data_manager_required: () => 'x',
	error_ontology_manager_required: () => 'x',
	error_tenant_id_claim_required: () => 'x',
	error_tenant_not_provisioned: () => 'x',
	error_tenant_scope_mismatch: () => 'x',
	error_user_offboarded: () => 'x',
	error_flow_not_owner: () => 'x',
	error_fr_feedback_forbidden: () => 'x',
	blockedit_existing_hint: () => 'hint',
	blockedit_existing_search_ph: () => 'search',
	blockedit_existing_none: () => 'none',
	blockedit_existing_use: () => 'use',
	blockedit_import_ontology_loading: () => 'loading'
}));

const BACKEND_MESSAGE = 'Developer role required';

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	list.mockReset();
	get.mockReset();
});

afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

async function render(): Promise<string> {
	const { default: ExistingBlockPicker } = await import('./ExistingBlockPicker.svelte');
	app = mount(ExistingBlockPicker, {
		target: host,
		props: { category: 'logic' as BlockCategory, onPick: () => {} }
	});
	flushSync();
	// Let the rejected `blocksApi.list` promise settle and the effect re-render.
	await Promise.resolve();
	await Promise.resolve();
	await tick();
	flushSync();
	return host.textContent ?? '';
}

describe('ExistingBlockPicker — a 403 renders localized copy, not the backend string', () => {
	it('shows the mapped message and never the raw backend `message`', async () => {
		list.mockRejectedValue(new ApiError(403, 'developer_required', BACKEND_MESSAGE));

		const text = await render();

		// The regression this whole change exists to prevent.
		expect(text).not.toContain(BACKEND_MESSAGE);
		expect(text).toContain('LOCALIZED: you need the Developer role');
		// …and specifically NOT the pre-change flattened generic copy.
		expect(text).not.toContain('LOCALIZED: no permission');
	});

	it('falls back to the screen-level translated copy for a non-permission failure', async () => {
		list.mockRejectedValue(new ApiError(500, 'internal', 'relation "blocks" does not exist'));

		const text = await render();

		expect(text).not.toContain('relation "blocks" does not exist');
		expect(text).toContain('LOCALIZED: could not load');
	});
});
