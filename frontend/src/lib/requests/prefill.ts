// src/lib/requests/prefill.ts — W8/P5: turn an APPROVED member request into the prefill of an
// EXISTING admin create screen. The approver still reviews and saves there, through the same gated
// call as always (POST /api/ontology/entities, POST /api/datasets) — nothing here writes anything.

/** `?fromRequest=<id>` on the current URL, or null. Read from `location` (client-only callers). */
export function fromRequestParam(search: string | undefined = globalThis.location?.search): string | null {
	if (!search) return null;
	const id = new URLSearchParams(search).get('fromRequest');
	return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

function words(s: string): string[] {
	return s
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

/** "Policy holder" → "PolicyHolder" (an entity's name). */
export function pascalName(s: string): string {
	return words(s)
		.map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
		.join('');
}

/** "policy number" → "policyNumber" (an attribute's name). */
export function camelName(s: string): string {
	const p = pascalName(s);
	return p ? p[0]!.toLowerCase() + p.slice(1) : '';
}

export interface EntityPrefill {
	name: string;
	label: string;
	description: string;
	attributes: { name: string; type: string; pii: boolean; synonyms: string }[];
}

/** The create-entity form, prefilled from a "missing information" request. Attribute types start
 *  as text; the reviewer sets the real type and the personal-data flag before saving. */
export function entityPrefill(req: { name: string; description: string | null; fieldNames: string[] }): EntityPrefill {
	const seen = new Set<string>();
	const attributes = req.fieldNames
		.map((f) => ({ name: camelName(f), synonyms: f }))
		.filter((a) => a.name && !seen.has(a.name) && seen.add(a.name))
		.map((a) => ({ name: a.name, type: 'string', pii: false, synonyms: a.synonyms }));
	return { name: pascalName(req.name) || req.name, label: req.name, description: req.description ?? '', attributes };
}

/** The datasets "paste" drawer, prefilled from an example-records request (as JSON rows). */
export function datasetPrefill(rec: { name: string; rows: Record<string, unknown>[] }): { name: string; content: string } {
	return { name: rec.name, content: JSON.stringify(rec.rows, null, 2) };
}
