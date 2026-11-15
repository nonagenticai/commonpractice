// src/lib/i18n/ops-event-label.ts — the ONE place a /it-dash "Recent platform events" row becomes
// words a reader can read.
//
// ⛔ THE DEFECT. `FeedEvent.text` is composed in backend/src/host/ops-metrics.ts as an English
// fragment — "published claims-parser v3", "ran Weekly intake → ok", "sandbox suspended · billing"
// — and rendered raw under a Dutch heading. The wire now carries the KIND plus the machine fields
// (`block`/`version`, `flow`/`runStatus`, `project`); the browser owns the words. Same split as
// `ops-alert-label.ts`.
//
// ⛔ `{actor}` MOVES INSIDE THE SENTENCE. The old markup was
//     <span class="feed-actor">{item.actor}</span> {item.text}
// i.e. the name was CONCATENATED in front of a fragment. That is untranslatable: Arabic and Hebrew
// put the verb before the subject and run right-to-left, so a fixed name-then-fragment order hands
// the visual result to the Unicode bidi algorithm instead of to someone who speaks the language.
// The rule is the one `format.ts:duration` and `challenge-state.ts:161` already state — number,
// name and unit live INSIDE the catalog message so the translator owns the order.
//
// ⚠️ THE COST, RECORDED HONESTLY: on the localized branch the actor's name is part of one
// interpolated string, so it can no longer carry the bold `.feed-actor` span. That is why this
// module returns a DISCRIMINATED LINE rather than a bare string — `FeedItem.svelte` keeps the
// original two-node markup byte-identical on the legacy branch and drops the bold on the localized
// one. Getting the bold back would need either a rich-text message format this catalog does not
// have, or splitting the sentence again — which is the defect. Correct word order beats a bold
// name, and the trade-off is repeated at the render site.
//
// ⛔ THE FALLBACK IS THREE-BRANCH — see the long note in `ops-alert-label.ts`; identical reasoning,
// identical rolling-deploy hazard, and the same rule that an unknown kind degrades to PROSE and
// never to a raw `block_published` token.
//
// ⛔ PRESENCE CHECKS ARE `=== undefined`, NEVER TRUTHINESS. `version`, `block` and `flow` are
// strings where `''` is a legal wire value (the backend coalesces a NULL subject to ''), and a
// `!item.version` guard would push a real publish into the English branch. `project` is
// `string | null | undefined` and each of the three means something different, so it gets an
// explicit `=== undefined` for "old pod" and an explicit `=== null` for "no project".
import * as m from '$lib/paraglide/messages';
import { runStatusLabel } from '$lib/i18n/run-status-label';
import type { FeedEvent, FeedEventProse } from '$lib/types/ops';

/**
 * One feed row, ready to render.
 *
 * `localized: false` is the mid-roll / unknown-kind branch and hands back the actor and the
 * backend's English fragment SEPARATELY, so the render site can keep the pre-change markup exactly
 * as it was — the same bold name in the same span, on the same wire shape that produced it.
 */
export type OpsEventLine =
	| { localized: true; text: string }
	| { localized: false; actor: string; text: string };

/** The reader's line for one platform event. */
export function opsEventLine(item: FeedEvent): OpsEventLine {
	switch (item.kind) {
		case 'block_published':
			if (item.block === undefined || item.version === undefined) return legacy(item);
			// `block` is a SLUG and `version` a version string — identifiers, interpolated verbatim.
			return {
				localized: true,
				text: m.ops_event_block_published({
					actor: item.actor,
					block: item.block,
					version: item.version
				})
			};
		case 'run_finished':
			if (item.flow === undefined || item.runStatus === undefined) return legacy(item);
			// ⛔ REUSES `runStatusLabel`. `flow_runs.status` is running|ok|partial|failed and that
			// vocabulary already exists, catalogued and tested, for the /sandboxes run drawer. A
			// second `ops_event_run_status_ok` family would be a drifting duplicate of it.
			return {
				localized: true,
				text: m.ops_event_run_finished({
					actor: item.actor,
					flow: item.flow,
					status: runStatusLabel(item.runStatus)
				})
			};
		case 'sandbox_suspended':
			if (item.project === undefined) return legacy(item);
			// ⚠️ "{actor}'s sandbox was suspended", NOT "{actor} suspended a sandbox". `actor` here is
			// the sandbox's OWNER (the backend query joins `sandboxes.owner_id`), not whoever
			// suspended it. The old English fragment was vague enough to hide that; a real sentence
			// has to pick a subject, and the true one is the passive.
			//
			// A null project picks its OWN sentence rather than interpolating an empty string, which
			// renders as a dangling separator and reads as a bug.
			return {
				localized: true,
				text:
					item.project === null
						? m.ops_event_sandbox_suspended_no_project({ actor: item.actor })
						: m.ops_event_sandbox_suspended({ actor: item.actor, project: item.project })
			};
		default:
			// `item` narrows to `never`: the union is exhaustive by construction. An event kind added
			// backend-first is nonetheless a REAL wire shape, so widen and read the prose.
			return legacy(item as FeedEventProse);
	}
}

/**
 * The same line as one flat string — for tests, exports and any consumer without markup.
 *
 * Defined in terms of `opsEventLine` rather than repeating the switch, so the two can never
 * disagree about which branch a payload takes.
 */
export function opsEventText(item: FeedEvent): string {
	const line = opsEventLine(item);
	return line.localized ? line.text : `${line.actor} ${line.text}`;
}

function legacy(item: { actor: string; text: string }): OpsEventLine {
	return { localized: false, actor: item.actor, text: item.text };
}
