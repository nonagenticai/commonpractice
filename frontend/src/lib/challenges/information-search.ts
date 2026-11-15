// src/lib/challenges/information-search.ts — the "Information involved" picker's search (W8/P2).
// Matches the reader's words against each option's LOCALIZED name and its synonyms, ignoring case
// and accents ("schade" finds "Schadeclaim", "reclamacion" finds "Reclamación").
import type { InformationOption } from '$lib/types/challenges';

/** Lower-case, accent-free form used for matching only. */
export function foldText(s: string): string {
	return s
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLocaleLowerCase()
		.trim();
}

/** The options whose name or a synonym contains every word of `query`. Empty query ⇒ all. */
export function matchInformation(options: InformationOption[], query: string): InformationOption[] {
	const words = foldText(query).split(/\s+/).filter(Boolean);
	if (!words.length) return options;
	return options.filter((o) => {
		const hay = [o.label, ...(o.synonyms ?? [])].map(foldText);
		return words.every((w) => hay.some((h) => h.includes(w)));
	});
}
