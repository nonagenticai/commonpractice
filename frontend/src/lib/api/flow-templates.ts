// src/lib/api/flow-templates.ts — typed client for /api/flow-templates (+ a solution's use-as-start).
// Same shape as the sibling clients: authFetch + unwrap + the shared ApiError.
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, detailsFrom } from './parse';
import { ApiError } from './blocks';
import type { FlowTemplateSummary, UseFlowTemplateResult } from '$lib/types/flow-templates';

export { ApiError };

async function unwrap<T>(res: Response): Promise<T> {
	const text = await res.text();
	const body = parseBody(text);
	if (!res.ok) {
		throw new ApiError(
			res.status,
			body?.error ?? 'error',
			body?.message ?? body?.error ?? nonJsonErrorMessage(res, text),
			detailsFrom(body)
		);
	}
	return body as T;
}

const json = (body: unknown): RequestInit => ({
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body)
});

export const flowTemplatesApi = {
	async list(): Promise<FlowTemplateSummary[]> {
		const body = await unwrap<{ templates: FlowTemplateSummary[] }>(await authFetch('/api/flow-templates'));
		return body.templates;
	},

	/** Save the reader's own flow as an organisation template (developer / admin). */
	async create(body: { flowId: string; name: string; description?: string }): Promise<FlowTemplateSummary> {
		const res = await unwrap<{ template: FlowTemplateSummary }>(
			await authFetch('/api/flow-templates', json(body))
		);
		return res.template;
	},

	/**
	 * A draft flow owned by the reader, copied from the template. `into` = the EMPTY draft on the
	 * reader's canvas: the server writes the template into it instead of adding a second flow (and
	 * makes a new one if it is not an empty draft of the reader's after all).
	 */
	async use(id: string, opts: { into?: string | null } = {}): Promise<UseFlowTemplateResult> {
		const path = `/api/flow-templates/${encodeURIComponent(id)}/use`;
		return unwrap(
			await authFetch(path, opts.into ? json({ into: opts.into }) : { method: 'POST' })
		);
	},

	async archive(id: string): Promise<void> {
		const res = await authFetch(`/api/flow-templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
		if (!res.ok && res.status !== 204) await unwrap(res);
	},

	/** A new draft flow copied from a solution's published flow (same organisation). */
	async useSolution(solutionId: string): Promise<UseFlowTemplateResult> {
		return unwrap(
			await authFetch(`/api/solutions/${encodeURIComponent(solutionId)}/use-as-start`, { method: 'POST' })
		);
	}
};
