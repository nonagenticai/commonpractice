// src/lib/api/templates.ts — typed client for the Block Template API (seeded starter catalog).
// Mirrors the ontology/datasets clients (authFetch + unwrap + ApiError).
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, detailsFrom } from './parse';
import { ApiError } from './blocks';
import type { BlockCategory, BlockDescriptor } from '$lib/types/blocks';
import type { TemplateDetail, TemplateListResult, TemplateStep } from '$lib/types/templates';

export { ApiError };

async function unwrap<T>(res: Response): Promise<T> {
	const text = await res.text();
	const body = parseBody(text);
	if (!res.ok) {
		// `detailsFrom` forwards the offender's name to the localized catalog — see the ⛔ block on
		// `ApiError` (./blocks). Every sibling `unwrap` in this directory carries the same line.
		//
		// ⛔ `findings` IS THE FIFTH ARGUMENT AND IT WAS BEING DROPPED. This constructed the canonical
		// `ApiError` (imported from `./blocks`, which declares `readonly findings?: ScanFinding[]`)
		// with only four arguments, so the field was silently `undefined` on every refusal from this
		// client. That is not hypothetical here: `backend/src/templates/templates-service.ts:13` calls
		// `assertBlockSourceSafe`, so a save-as-template REALLY CAN be refused by the block-source
		// lint — and the finding list, the only thing that tells the author WHICH line offended, was
		// thrown away at the client boundary. The reader got "that source failed the safety scan" and
		// nothing to act on. `./blocks.ts:83` has always passed it; this is the same line.
		throw new ApiError(
			res.status,
			body?.error ?? 'error',
			body?.message ?? body?.error ?? nonJsonErrorMessage(res, text),
			detailsFrom(body),
			body?.findings
		);
	}
	return body as T;
}

export const templatesApi = {
	/** List starter templates, filtered by category / domain / search, with facets for the filters. */
	async list(opts: { category?: string; domain?: string; q?: string } = {}): Promise<TemplateListResult> {
		const qs = new URLSearchParams();
		if (opts.category) qs.set('category', opts.category);
		if (opts.domain) qs.set('domain', opts.domain);
		if (opts.q) qs.set('q', opts.q);
		const s = qs.toString();
		return unwrap(await authFetch(`/api/templates${s ? `?${s}` : ''}`));
	},

	/** One template's full scaffold (descriptor + source skeleton + docs + formal structure). */
	async get(id: string): Promise<TemplateDetail> {
		const body = await unwrap<{ template: TemplateDetail }>(
			await authFetch(`/api/templates/${encodeURIComponent(id)}`)
		);
		return body.template;
	},

	/** Phase 5D: save a finished block design as a reusable tenant template. Developer-only;
	 *  throws ApiError(409, 'template_name_taken') when the (category, domain, name) already exists. */
	async create(body: CreateTemplateBody): Promise<TemplateDetail> {
		const res = await unwrap<{ template: TemplateDetail }>(
			await authFetch('/api/templates', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			})
		);
		return res.template;
	},

	/** Delete an own-tenant template (developer-only). Throws ApiError(404) for a global / other id. */
	async delete(id: string): Promise<void> {
		await unwrap<{ ok: true }>(
			await authFetch(`/api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' })
		);
	}
};

export interface CreateTemplateBody {
	name: string;
	label: string;
	category: BlockCategory;
	description?: string;
	domain?: string | null;
	tags?: string[];
	descriptor: BlockDescriptor;
	source_ts?: string;
	docs_md?: string;
	preconditions?: string[];
	postconditions?: string[];
	steps?: TemplateStep[];
}
