// src/lib/i18n/enum-option-label.ts — the words a reader sees for one option of an enum input.
//
// The option VALUE (`gte`, `formal`) is what the node config stores and the block reads, so it never
// changes. Only its label does. Known values come from the catalog in the reader's locale; any other
// value falls back to the humanised value ("starts_with" → "Starts with"), never the raw code.
// Keyed on the value alone: these words mean the same thing in every block that uses them.
import * as m from '$lib/paraglide/messages';
import { humanizeFieldName } from './port-label';

const LABELS: Record<string, () => string> = {
	eq: m.nodecfg_opt_eq,
	neq: m.nodecfg_opt_neq,
	gte: m.nodecfg_opt_gte,
	lte: m.nodecfg_opt_lte,
	contains: m.nodecfg_opt_contains,
	neutral: m.nodecfg_opt_neutral,
	formal: m.nodecfg_opt_formal,
	friendly: m.nodecfg_opt_friendly,
	html: m.nodecfg_opt_html,
	note: m.nodecfg_opt_note,
	accept: m.nodecfg_opt_accept,
	edit: m.nodecfg_opt_edit,
	reject: m.nodecfg_opt_reject,
	approve: m.nodecfg_opt_approve,
	deny: m.nodecfg_opt_deny,
	review: m.nodecfg_opt_review
};

/** The label for an enum option value: the catalog entry when there is one, else the humanised value. */
export function enumOptionLabel(value: string): string {
	const label = Object.hasOwn(LABELS, value) ? LABELS[value] : undefined;
	return label ? label() : humanizeFieldName(value);
}

/** The values with a catalog label — exported so a test can check every one renders. */
export const LABELLED_ENUM_VALUES: readonly string[] = Object.keys(LABELS);
