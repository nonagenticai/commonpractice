// src/lib/api/information-requests.ts — W8/P5: member requests about a challenge's information
// ("missing information", example records) and the approvers' queue. See
// backend/src/routes/information-requests.ts for the rules: a request never writes the ontology or a
// dataset, and approving only records the decision and names the existing screen to continue on.
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, detailsFrom } from './parse';
import { ApiError } from './blocks';

export { ApiError };

export type InformationRequestKind = 'missing_information' | 'example_records';
export type InformationRequestStatus = 'pending' | 'approved' | 'rejected';

export interface InformationRequest {
	id: string;
	challengeId: string;
	challengeTitle: string | null;
	kind: InformationRequestKind;
	status: InformationRequestStatus;
	name: string;
	description: string | null;
	fieldNames: string[];
	fileName: string | null;
	columns: { name: string; type: string }[];
	rowCount: number | null;
	createdByName: string | null;
	mine: boolean;
	createdAt: string;
	reviewedAt: string | null;
	reviewNote: string | null;
}

export interface InformationRequestDetail extends InformationRequest {
	rows: Record<string, unknown>[];
	/** True for the member who made it: every value is masked. */
	masked: boolean;
	canReview: boolean;
}

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

export const informationRequestsApi = {
	/** The reader's own requests on a challenge (an approver: everyone's). */
	async forChallenge(challengeId: string): Promise<{ items: InformationRequest[]; canReview: boolean }> {
		return unwrap(await authFetch(`/api/challenges/${encodeURIComponent(challengeId)}/information-requests`));
	},

	async requestMissing(
		challengeId: string,
		input: { name: string; description?: string; fieldNames?: string[] }
	): Promise<InformationRequest> {
		return unwrap(
			await authFetch(`/api/challenges/${encodeURIComponent(challengeId)}/information-requests`, json(input))
		);
	},

	async uploadRecords(challengeId: string, file: File, name?: string): Promise<InformationRequest> {
		const form = new FormData();
		form.append('file', file);
		if (name) form.append('name', name);
		return unwrap(
			await authFetch(`/api/challenges/${encodeURIComponent(challengeId)}/information-requests/upload`, {
				method: 'POST',
				body: form
			})
		);
	},

	/** Approvers: the queue. */
	async list(status: 'pending' | 'all' = 'pending'): Promise<{ items: InformationRequest[]; pendingCount: number }> {
		return unwrap(await authFetch(`/api/information-requests?status=${status}`));
	},

	async get(id: string): Promise<InformationRequestDetail> {
		return unwrap(await authFetch(`/api/information-requests/${encodeURIComponent(id)}`));
	},

	/** Approvers: every stored record, for the dataset screen's prefill. */
	async records(id: string): Promise<{ name: string; columns: { name: string; type: string }[]; rows: Record<string, unknown>[] }> {
		return unwrap(await authFetch(`/api/information-requests/${encodeURIComponent(id)}/records`));
	},

	async approve(id: string, note?: string): Promise<{ item: InformationRequest; next: { href: string } }> {
		return unwrap(
			await authFetch(`/api/information-requests/${encodeURIComponent(id)}/approve`, json(note ? { note } : {}))
		);
	},

	async reject(id: string, note: string): Promise<{ item: InformationRequest }> {
		return unwrap(await authFetch(`/api/information-requests/${encodeURIComponent(id)}/reject`, json({ note })));
	}
};
