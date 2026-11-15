// src/lib/blocks/line-diff.ts — Phase 4 (AI-fix loop): a tiny, dependency-free line
// diff for the propose-a-patch review. An LCS over lines gives a clean unified diff
// (removed / added / unchanged) that BlockDiffView renders. Pure → unit-tested.

export type DiffRowType = 'context' | 'add' | 'remove';

export interface DiffRow {
	type: DiffRowType;
	text: string;
	/** 1-based line number in the OLD text (context + remove rows). */
	oldLine?: number;
	/** 1-based line number in the NEW text (context + add rows). */
	newLine?: number;
}

/** Longest-common-subsequence line diff of `oldText` → `newText`. */
export function diffLines(oldText: string, newText: string): DiffRow[] {
	const a = oldText.split('\n');
	const b = newText.split('\n');
	const n = a.length;
	const m = b.length;

	// LCS length table (n+1 × m+1).
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
		}
	}

	const rows: DiffRow[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			rows.push({ type: 'context', text: a[i]!, oldLine: i + 1, newLine: j + 1 });
			i++;
			j++;
		} else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
			rows.push({ type: 'remove', text: a[i]!, oldLine: i + 1 });
			i++;
		} else {
			rows.push({ type: 'add', text: b[j]!, newLine: j + 1 });
			j++;
		}
	}
	while (i < n) rows.push({ type: 'remove', text: a[i]!, oldLine: ++i });
	while (j < m) rows.push({ type: 'add', text: b[j]!, newLine: ++j });
	return rows;
}

/** Counts for a quick "+N −M" summary above the diff. */
export function diffStat(rows: DiffRow[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const r of rows) {
		if (r.type === 'add') added++;
		else if (r.type === 'remove') removed++;
	}
	return { added, removed };
}
