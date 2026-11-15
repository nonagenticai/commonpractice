// src/lib/api/graph-issues.test.ts — the structural guard on `details.issues` admits what the
// backend really sends and rejects what would render as garbage, and NOTHING in between.
//
// ⛔ THE DEFECT THIS EXISTS TO CATCH is a tightening. `detail` is a backend-first field: the whole
// reason `rule` is a plain `string` here is that an issue must never VANISH from the list because
// this build has not heard of part of it. A guard that rejects an unknown `detail` key trades a
// field the UI would simply ignore for the entire sentence — the exact information loss the module
// was written to prevent, and silently, because a filtered-out issue leaves no trace. Nothing else
// in the suite would notice: `graphIssueLabel` is tested on hand-built objects that never pass
// through `isGraphIssue`.
import { describe, it, expect } from 'vitest';
import { isGraphIssue, graphIssuesFrom } from './graph-issues';

const BASE = { rule: 'missing-required-input', message: "Node 'x' requires input 'y'", ref: 'n1' };

describe('isGraphIssue', () => {
	it('accepts the shapes the backend actually sends', () => {
		// Pre-`detail` (an old pod mid-roll), and post-`detail`.
		expect(isGraphIssue(BASE)).toBe(true);
		expect(isGraphIssue({ ...BASE, detail: { node: 'x', handle: 'y' } })).toBe(true);
		expect(isGraphIssue({ rule: 'cycle', message: 'Flow contains a cycle' })).toBe(true);
		expect(isGraphIssue({ ...BASE, detail: {} })).toBe(true);
	});

	it('⛔ ACCEPTS an unknown `detail` key rather than dropping the issue', () => {
		// The doctrine, asserted. A thirteenth field shipped backend-first costs the reader nothing:
		// `graphIssueLabel` ignores it and renders the sentence it can build.
		expect(isGraphIssue({ ...BASE, detail: { node: 'x', handle: 'y', futureField: 'z' } })).toBe(true);
		expect(isGraphIssue({ ...BASE, detail: { onlyUnknownFields: 'z' } })).toBe(true);
	});

	it('rejects a `detail` that is not a plain object of strings', () => {
		// An ARRAY indexes numerically, so every named field would read `undefined` and the sentence
		// would interpolate it. `null` throws on property access. A number or a nested object
		// interpolates as `[object Object]` / a bare numeral into a quoted identifier slot.
		expect(isGraphIssue({ ...BASE, detail: [] })).toBe(false);
		expect(isGraphIssue({ ...BASE, detail: ['x'] })).toBe(false);
		expect(isGraphIssue({ ...BASE, detail: null })).toBe(false);
		expect(isGraphIssue({ ...BASE, detail: 'node=x' })).toBe(false);
		expect(isGraphIssue({ ...BASE, detail: { node: 3 } })).toBe(false);
		expect(isGraphIssue({ ...BASE, detail: { node: { slug: 'x' } } })).toBe(false);
		expect(isGraphIssue({ ...BASE, detail: { node: null } })).toBe(false);
	});

	it('still rejects the Zod-error shape `route()` puts in the same `details.issues` slot', () => {
		// backend/src/utils/http.ts:130 — `details: { issues: err.issues }`, and a Zod issue has
		// `code`/`path`, no `rule`. This is why the guard exists at all.
		expect(isGraphIssue({ code: 'unrecognized_keys', path: ['name'], message: 'Unrecognized key' })).toBe(false);
		expect(isGraphIssue(null)).toBe(false);
		expect(isGraphIssue('nope')).toBe(false);
		expect(isGraphIssue({ rule: 'cycle' })).toBe(false);
		expect(isGraphIssue({ ...BASE, ref: 7 })).toBe(false);
	});
});

describe('graphIssuesFrom', () => {
	it('keeps the well-formed issues and drops only the malformed ones', () => {
		const kept = { ...BASE, detail: { node: 'x', handle: 'y' } };
		const alsoKept = { ...BASE, detail: { node: 'x', unknownButHarmless: 'z' } };
		const out = graphIssuesFrom({
			issues: [kept, { code: 'invalid_type', path: [] }, alsoKept, { ...BASE, detail: [] }]
		});
		expect(out).toEqual([kept, alsoKept]);
	});

	it('returns [] for a details bag with no issues array', () => {
		expect(graphIssuesFrom(undefined)).toEqual([]);
		expect(graphIssuesFrom({})).toEqual([]);
		expect(graphIssuesFrom({ issues: 'not an array' })).toEqual([]);
	});
});
