// src/lib/api/notifications.ts — the in-app notification feed.
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, detailsFrom } from './parse';
import { ApiError } from './blocks';
import type { AppNotification } from '$lib/types/admin';

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

export const notificationsApi = {
	async list(opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<{
		notifications: AppNotification[];
		unread: number;
	}> {
		const qs = new URLSearchParams();
		if (opts.unreadOnly) qs.set('unread', '1');
		if (opts.limit) qs.set('limit', String(opts.limit));
		const suffix = qs.toString() ? `?${qs.toString()}` : '';
		return unwrap(await authFetch(`/api/notifications${suffix}`));
	},
	async unreadCount(): Promise<{ unread: number }> {
		return unwrap(await authFetch('/api/notifications/unread-count'));
	},
	async markRead(id: string): Promise<{ id: string; read: boolean }> {
		return unwrap(await authFetch(`/api/notifications/${id}/read`, { method: 'POST' }));
	},
	async markAllRead(): Promise<{ read: number }> {
		return unwrap(await authFetch('/api/notifications/read-all', { method: 'POST' }));
	}
};
