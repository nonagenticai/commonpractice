// src/lib/i18n/ontology-action-label.ts — the ONE place an `ontology.*` audit action becomes words,
// and the one place we decide whether a target id is fit to show a human.
//
// ⛔ THE DEFECT. "Recente wijzigingen" on /ontology rendered:
//
//     {c.action.replace('ontology.', '').replace(/_/g, ' ')}
//     {#if c.targetId}<span class="ch-target">{c.targetId}</span>{/if}
//
// so after any ontology edit a Dutch reader got "Mary de Vries · entity create ·
// 3f1c8b2e-…-a8b2 · 2u geleden". Two separate problems in one line:
//
//  1. `c.action` is a BACKEND ENUM — `ontology.entity_create`, `ontology.relation_delete`,
//     `ontology.sample_bind`, … (backend/src/routes/ontology.ts). Stripping the prefix and swapping
//     underscores is not translation, it is English with the punctuation removed. Same species as
//     `stageLabel` beside this file, and fixed the same way.
//  2. `c.targetId` is whatever `recordAudit` was handed. For ten of the eleven ontology actions that
//     is a row UUID — an opaque 36-character string in the position a reader expects a NAME. The
//     eleventh (`derive_block`) records a block SLUG, which is genuinely readable.
//
// ⚠️ THE FEED THIS DESCRIBED IS NO LONGER THE ONE IT READS, AND THAT MATTERS FOR THE ACTION SET.
// This block used to say the panel calls `auditApi.list({ category: 'data', q: 'ontology' })` —
// the PLATFORM audit endpoint, matched server-side with `ilike(auditLog.action, '%ontology%')`.
// That was the tenant leak WS-4 fixed: the panel now calls `ontologyApi.recentChanges()` →
// `GET /api/ontology/recent-changes`, which matches `action like 'ontology.%'` (an ANCHORED
// prefix, not a substring) and attributes every row to a workspace before returning it. Two
// consequences for this file: the actions that arrive are exactly the `ontology.*` set below, and
// the `q`-also-matches-`target_id`-and-actor-name accident named further down can no longer bring a
// non-ontology row here. The raw-id fallback stays anyway — see its own note.
//
// ⛔ THE ACTION ENUM IS NOT OURS TO SHORTEN. `c.action` keeps travelling verbatim — it is what the
// backend filter matches on and what /audit renders in its badge. This module produces DISPLAY TEXT
// beside it and changes nothing on the wire.
import * as m from '$lib/paraglide/messages';

/**
 * The reader's words for an ontology audit action.
 *
 * Takes the FULL action id (`ontology.entity_create`), not the stripped tail, so the switch is
 * literally the strings `grep -n "action: 'ontology\." backend/src/routes/ontology.ts` prints —
 * the version that gets checked against the source in the test beside this file.
 *
 * An unrecognised action returns THE RAW ACTION ID. Deliberately uglier than the old
 * strip-and-despace: dressing an unknown enum up as prose is how "entity create" looked like a
 * translated label for two releases, and a raw dotted id reads as an id.
 *
 * ⚠️ The ORIGINAL reason given here was that the old `/api/audit` feed's `q` also matched
 * `target_id` and the actor's name (audit.ts:72-74), so a non-ontology row could reach this panel.
 * That route is gone (see the header) and `action like 'ontology.%'` cannot do it. The fallback
 * stays for the reason that outlives the endpoint: a NEW `ontology.*` action ships from the backend
 * the moment a route is added, and there is no compile-time link between that enum and this switch
 * — the sibling test compares the two, but only after someone runs it.
 */
export function ontologyActionLabel(action: string): string {
	switch (action) {
		case 'ontology.entity_create':
			return m.ontology_action_entity_create();
		case 'ontology.entity_update':
			return m.ontology_action_entity_update();
		case 'ontology.entity_delete':
			return m.ontology_action_entity_delete();
		case 'ontology.entity_hide':
			return m.ontology_action_entity_hide();
		case 'ontology.entity_unhide':
			return m.ontology_action_entity_unhide();
		case 'ontology.entity_translate':
			return m.ontology_action_entity_translate();
		case 'ontology.sample_bind':
			return m.ontology_action_sample_bind();
		case 'ontology.sample_unbind':
			return m.ontology_action_sample_unbind();
		case 'ontology.derive_block':
			return m.ontology_action_derive_block();
		case 'ontology.relation_create':
			return m.ontology_action_relation_create();
		case 'ontology.relation_delete':
			return m.ontology_action_relation_delete();
		default:
			return action;
	}
}

/** A canonical v1–v8 UUID, the shape every `ontology_entity` / `ontology_relation` row id has. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The target of an ontology change, IF it is something a person can read — otherwise `null`, and
 * the caller omits the element entirely.
 *
 * ⛔ WHY OMIT RATHER THAN TRUNCATE OR RESOLVE.
 *  • Truncating ("3f1c…a8b2") keeps the noise and adds the false impression that the full string
 *    means something to the reader. It was already effectively truncated by CSS; that is the bug.
 *  • Resolving the uuid to a name is not possible from this row: nine of the eleven actions record
 *    a row that may since have been DELETED (`entity_delete`, `relation_delete`, `sample_unbind`),
 *    and the audit row deliberately does not denormalise a name. Faking a lookup would print
 *    "unknown" more often than a name on exactly the actions people audit most.
 *  • The line is not information-free without it: actor + action + timestamp is a complete
 *    sentence, and `result` (which DOES carry the human name — `Custom entity 'Policy'`) is the
 *    field to surface next if anyone wants more.
 *
 * `derive_block` is the one action that records a readable target (a block SLUG), and it survives
 * this filter for free — which is why the rule is "is it a uuid", not an action allowlist.
 */
export function ontologyTargetLabel(targetId: string | null | undefined): string | null {
	if (!targetId) return null;
	const trimmed = targetId.trim();
	if (!trimmed) return null;
	if (UUID.test(trimmed)) return null;
	return trimmed;
}
