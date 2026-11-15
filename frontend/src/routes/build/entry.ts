// src/routes/build/entry.ts — the two pure decisions behind CommonPractice's central loop entry
// point (challenge → build → submit → vote → weekly winner).
//
// Both used to be inline in `+page.svelte`, where neither could be tested without mounting
// SvelteFlow, the SSE agent stream and the keycloak chain — and both were wrong in a way that made
// the loop unenterable: the boot redirect rebuilt its URL from `id` alone and dropped the
// `?challenge=` the CTA had put there, and the submit never built a `POST /api/solutions` payload
// at all. Same split as `stores/builder-graph.ts` (runes-free logic here, reactive wrapper there),
// for the same reason.
import type { ReadonlyURL } from '$app/state';
import type { CreateSolutionInput } from '$lib/types/solutions';

/** `createSolutionSchema`'s `blocks_used` cap — `z.array(...).max(40)`, backend/src/routes/solutions.ts. */
export const MAX_BLOCKS_USED = 40;
/** `createSolutionSchema`'s `title` cap — `z.string().min(1).max(160)`. */
export const MAX_TITLE_LENGTH = 160;

/**
 * Where `/build` sends the browser when it was opened without a `?id=`.
 *
 * MUST carry `?challenge=` across. The challenge page's "Build a solution" CTA links to
 * `/build?challenge=<id>` with no `?id=`, so this redirect fires on the ONE path into the builder
 * that names a challenge. Rebuilding the URL from the flow id alone discarded it a tick after
 * `onMount`, which silently took out the challenge data panel, the agent's challenge context, and
 * the only thing that says which challenge a submitted solution answers.
 */
export function builderBootUrl(current: ReadonlyURL, flowId: string): string {
	const qs = new URLSearchParams({ id: flowId });
	const challenge = current.searchParams.get('challenge');
	if (challenge) qs.set('challenge', challenge);
	return `/build?${qs.toString()}`;
}

/**
 * Does this flow name carry no human intent — i.e. is it still the name `/build` invented?
 *
 * `/build` auto-creates every new flow as `m.build_new_flow_default_name()` and Submit copies that
 * name verbatim into `solutions.title`. The product's first ever user-submitted solution is
 * literally titled "Untitled flow", and it is about to be crowned a weekly winner and become a
 * pipeline card of the same name. The backend cannot help: `title` is `z.string().min(1).max(160)`
 * and must stay that way — "must not equal one of eight localized strings" would refuse a
 * legitimately named flow forever. So the refusal is a CLIENT gate, and this is its whole decision.
 *
 * PARAGLIDE-FREE ON PURPOSE (the `lib/admin/license-chip.ts` convention): the caller supplies the
 * defaults, so this stays a testable pure function AND the caller is free to pass ALL EIGHT locales'
 * default names rather than only the current one — a flow created in English and opened with the UI
 * in Dutch must not sail through the gate.
 *
 * EXACT trimmed match, never `includes`: "Untitled flow v2" is a name a human chose.
 *
 * @param name the current flow name (draft or committed)
 * @param defaults every string the product uses as an auto-generated flow name
 */
export function isDefaultFlowName(name: string, defaults: readonly string[]): boolean {
	const trimmed = name.trim();
	// Empty / whitespace-only is unnamed by definition — and `min(1)` would 400 it anyway, with a
	// Zod body that carries no `message`, so the author would lose the submission to an opaque error.
	if (trimmed.length === 0) return true;
	return defaults.some((d) => d.trim() === trimmed);
}

export interface SolutionSubmissionInput {
	/** The challenge in context (`?challenge=`). Required — a solution belongs to a challenge. */
	challengeId: string;
	/** The flow's name; becomes the solution title. */
	title: string;
	/** The flow to publish. */
	flowId: string;
	/** `data.slug` for every canvas node, in canvas order. Loop containers have none. */
	nodeSlugs: readonly (string | null | undefined)[];
}

/**
 * The `POST /api/solutions` request body for the current canvas.
 *
 * ⚠️ `createSolutionSchema` is `.strict()`, so an undeclared key is a 400 that loses the whole
 * submission. That is why the optional `blocks_used` is OMITTED when empty rather than sent as
 * `[]`/`undefined`, and why nothing else about the canvas rides along here.
 *
 * `title` is truncated rather than passed through: a name over `max(160)` is a guaranteed 400 whose
 * Zod body carries no `message`, so the author would lose the submission to an opaque error. An
 * EMPTY name is deliberately left to the backend — there is no honest default to invent for it, and
 * `min(1)` refusing it is the correct outcome.
 */
export function solutionSubmissionPayload(input: SolutionSubmissionInput): CreateSolutionInput {
	const slugs = input.nodeSlugs.filter((s): s is string => typeof s === 'string' && s.length > 0);
	const blocks = [...new Set(slugs)].slice(0, MAX_BLOCKS_USED);
	const payload: CreateSolutionInput = {
		challenge_id: input.challengeId,
		title: input.title.trim().slice(0, MAX_TITLE_LENGTH),
		flow_id: input.flowId
	};
	if (blocks.length) payload.blocks_used = blocks;
	return payload;
}
