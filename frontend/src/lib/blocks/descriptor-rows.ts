// src/lib/blocks/descriptor-rows.ts — the block editor's input/output rows ⇄ descriptor fields.
// Pure + framework-free so the save round-trip is unit-tested (descriptor-rows.test.ts).
//
// ⛔ WHATEVER `toRows` READS, `fromRows` MUST WRITE BACK. The editor rebuilds the saved descriptor
// from these rows alone, so a field property missing here is DELETED on the next save. `label` (the
// author's port label) has no input in the editor yet; it is carried so a save does not drop it.
import type { FieldSpec, FieldType } from '$lib/types/blocks';

export interface FieldRow {
	name: string;
	type: FieldType;
	required: boolean;
	pii: boolean;
	enumText: string;
	/** The author's port label. Not editable in the editor yet; carried so a save does not drop it. */
	label?: string;
}

type RowSpec = Pick<FieldSpec, 'type' | 'required' | 'pii' | 'enum' | 'label'>;

export function toRows(rec: Record<string, RowSpec>): FieldRow[] {
	return Object.entries(rec).map(([name, s]) => ({
		name,
		type: s.type,
		required: s.required ?? false,
		pii: s.pii ?? false,
		enumText: (s.enum ?? []).join(', '),
		...(s.label ? { label: s.label } : {})
	}));
}

export function fromRows(rows: FieldRow[]): Record<string, RowSpec> {
	const out: Record<string, RowSpec> = {};
	for (const r of rows) {
		if (!r.name.trim()) continue;
		const spec: RowSpec = { type: r.type };
		if (r.required) spec.required = true;
		if (r.pii) spec.pii = true;
		if (r.label) spec.label = r.label;
		if (r.type === 'enum') spec.enum = r.enumText.split(',').map((s) => s.trim()).filter(Boolean);
		out[r.name.trim()] = spec;
	}
	return out;
}
