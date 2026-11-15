// src/lib/i18n/port-label.ts — the words a non-technical reader sees for a block's input/output.
//
// The descriptor key (`force_ocr`) is a wire identifier: edges, node config and the run trace are
// keyed on it, so it never changes. What changes is how it is SHOWN. A label from the block's own
// metadata wins; otherwise the key is turned into a sentence-case phrase ("Force OCR").
//
// The label comes from `GET /api/blocks/:slug`'s `portLabels`, already resolved for the reader's
// locale (backend blocks/port-labels.ts: locale → the author's descriptor label → en). /build merges
// it into its CACHED copy of the descriptors with `applyPortLabels` — never into a descriptor that is
// saved back (block editor, fork picker), where a Dutch label would become the author's base label.
import type { BlockDetail, FieldSpec } from '$lib/types/blocks';

/** Kept uppercase wherever they appear. Plural forms get a lowercase `s` ("IDs", "URLs"). */
const ACRONYMS = new Set(['ocr', 'pdf', 'id', 'url', 'ai', 'api', 'csv']);

function word(w: string): string {
	const lower = w.toLowerCase();
	if (ACRONYMS.has(lower)) return lower.toUpperCase();
	if (lower.length > 2 && lower.endsWith('s') && ACRONYMS.has(lower.slice(0, -1)))
		return `${lower.slice(0, -1).toUpperCase()}s`;
	return lower;
}

/** `force_ocr` → "Force OCR", `ocr_used` → "OCR used", `userId` → "User ID". */
export function humanizeFieldName(name: string): string {
	const parts = name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(/[\s_\-.]+/)
		.filter(Boolean)
		.map(word);
	if (parts.length === 0) return name;
	const [first, ...rest] = parts;
	const head = first === first.toLowerCase() ? first.charAt(0).toUpperCase() + first.slice(1) : first;
	return [head, ...rest].join(' ');
}

/** The label to show for a port: block metadata first, the humanised key otherwise. */
export function portLabel(name: string, meta?: object | null): string {
	// `object`: callers pass a FieldSpec, tests pass arbitrary shapes; the label is checked at runtime.
	const label = meta ? (meta as { label?: unknown }).label : undefined;
	if (typeof label === 'string' && label.trim() !== '') return label.trim();
	return humanizeFieldName(name);
}

function withLabels(specs: Record<string, FieldSpec>, labels: Record<string, string> | undefined) {
	if (!labels) return specs;
	const out: Record<string, FieldSpec> = {};
	for (const [key, spec] of Object.entries(specs ?? {})) {
		const label = labels[key];
		out[key] = typeof label === 'string' && label.trim() !== '' ? { ...spec, label } : spec;
	}
	return out;
}

/**
 * A copy of `detail` whose version descriptors carry the resolved `portLabels` as each field's
 * `label`, so `portLabel()` renders them. The input is not mutated. A detail without `portLabels`
 * (a backend one deploy behind) is returned as is.
 */
export function applyPortLabels(detail: BlockDetail): BlockDetail {
	const pl = detail.portLabels;
	if (!pl) return detail;
	return {
		...detail,
		versions: detail.versions.map((v) =>
			v.descriptor
				? {
						...v,
						descriptor: {
							...v.descriptor,
							inputs: withLabels(v.descriptor.inputs, pl.inputs),
							outputs: withLabels(v.descriptor.outputs, pl.outputs)
						}
					}
				: v
		)
	};
}
