// src/lib/api/data-findings.ts — the ONE reader for the `findings` array a data-validation answer
// carries, on BOTH the refusal and the success body.
//
// ⛔ THE DEFECT. `POST /api/runs` pre-flights every injected dataset against the ontology entity it
// is bound to (backend/src/datasets/ontology-validation.ts). Two rules: `type_mismatch`, and
// `pii_uncovered` — whose own message says the values "would be injected UNREDACTED". The
// governance policy `data.validation_mode` ships as `warn`, and in `warn` the run PROCEEDS. Until
// this module existed, `runs.ts` declared `findings?: unknown[]` and nothing anywhere read it: in
// `block` the tester got one bare sentence with no column named, and in `warn` — the default — the
// tester got NOTHING, watching a green run while PII went into the sandbox in the clear.
//
// ⛔ WHY THIS IS A SIBLING OF `graph-issues.ts` AND NOT A WIDENING OF `ScanFinding`.
// `ScanFinding` (api/blocks.ts) is the static block-source scanner's hit: it has a `line` and no
// `dataset`. `DataValidationFinding` is its mirror image — a dataset/column/attribute and no line.
// A union of the two could only be guarded down to what BOTH promise, i.e. `rule` + `message`,
// which is precisely the information loss `graph-issues.ts`'s header says these modules exist to
// prevent. Two shapes, two guards, no lowest common denominator.
import type { DataValidationFinding, DataValidationMode } from '$lib/types/flows';

/** The `details` bag on a typed client's error, as far as this module cares about it. */
export interface FindingCarryingDetails {
	findings?: unknown;
	[key: string]: unknown;
}

/** The `dataValidation` envelope a 201 carries when the run proceeded DESPITE findings. */
export interface DataValidationReport {
	mode: DataValidationMode;
	findings: DataValidationFinding[];
}

/**
 * Structural check that one entry is a `DataValidationFinding`.
 *
 * `findings` is literally whatever the backend put in the body, and `raw as DataValidationFinding[]`
 * would be a claim about data nothing ever inspected. It is not even always a finding: `route()`'s
 * ZodError branch (backend/src/utils/http.ts) emits `details: { issues: … }` on the same error
 * class, and a `flow_invalid` 422 puts GraphIssues there — neither has a `dataset`. Requiring the
 * four addressing fields is what keeps those out of the rendered list.
 *
 * ⛔ `rule` is deliberately checked as a plain `string`, NOT re-declared as the two-value
 * `DataValidationRule` union in backend/src/datasets/ontology-validation.ts. Mirroring that union
 * would mean a THIRD rule shipped backend-first fails this guard and VANISHES from the UI —
 * reintroducing the exact silence this module was written to end. An unrecognised rule still
 * carries a human-readable `message`, and `dataFindingLabel` falls back to it.
 *
 * `count`/`expected` are NOT required: they are `type_mismatch`-only, and a backend one deploy
 * behind ships neither. Demanding them would blank the list during a rolling deploy.
 */
export function isDataFinding(v: unknown): v is DataValidationFinding {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	if (typeof o.rule !== 'string' || typeof o.message !== 'string') return false;
	if (typeof o.dataset !== 'string' || typeof o.column !== 'string') return false;
	if (typeof o.attribute !== 'string') return false;
	if (o.count !== undefined && typeof o.count !== 'number') return false;
	return o.expected === undefined || typeof o.expected === 'string';
}

/** Every well-formed finding in a `details` bag, or `[]` when there are none. */
export function dataFindingsFrom(details: FindingCarryingDetails | undefined): DataValidationFinding[] {
	const raw = details?.findings;
	if (!Array.isArray(raw)) return [];
	return raw.filter(isDataFinding);
}

/**
 * The `dataValidation` envelope off a SUCCESS body, or null.
 *
 * Null when the key is absent — which is the normal, clean-run case: the backend omits it entirely
 * rather than shipping an empty array, so the caller's test is `!== null` and never a length
 * compare (backend/src/host/run-controller.ts spells out why the spread is conditional).
 *
 * Also null when the envelope survives the guards but holds no well-formed finding, because a pill
 * announcing a violation it cannot name is worse than no pill.
 */
export function dataValidationFrom(body: unknown): DataValidationReport | null {
	if (typeof body !== 'object' || body === null) return null;
	const dv = (body as Record<string, unknown>).dataValidation;
	if (typeof dv !== 'object' || dv === null) return null;
	const o = dv as Record<string, unknown>;
	const findings = dataFindingsFrom(o as FindingCarryingDetails);
	if (!findings.length) return null;
	// An unrecognised mode is read as `warn`: the run is on the success path, so it PROCEEDED —
	// which is what `warn` means. Trusting an unknown string here would let it reach the template.
	return { mode: o.mode === 'block' ? 'block' : 'warn', findings };
}
