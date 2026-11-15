// @vitest-environment jsdom
//
// src/lib/components/marketplace/cadence-strip.period-bar.render.test.ts — the MONTH/YEAR phase bar.
//
// ⛔ TWO DEFECTS FOUND BY A BROWSER WALK (2026-10-14):
//   1. The voting segment and its legend swatch were `--c-coral-pale` (#FFF7ED) on a white card —
//      contrast 1.04:1, i.e. invisible. Asserted here against the WCAG 1.4.11 non-text floor (3:1),
//      computed from the REAL tokens.css values, so swapping in any other pale token goes red too.
//   2. The bar carried no dates: a month bar with no "1 Oct … 31 Oct" says nothing about WHEN.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mount, unmount, flushSync } from 'svelte';
import type { CycleState } from '$lib/types/cycle';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

import CadenceStrip from './CadenceStrip.svelte';
import { dayMonth } from '$lib/utils/format';
import { locale } from '$lib/stores/locale.svelte';

const SRC = readFileSync(resolve(process.cwd(), 'src/lib/components/marketplace/CadenceStrip.svelte'), 'utf8');
const TOKENS = readFileSync(resolve(process.cwd(), 'src/lib/styles/tokens.css'), 'utf8');

/** The hex a `--c-*` token resolves to in tokens.css. */
function token(name: string): string {
	const m = new RegExp(`${name.replace(/[-]/g, '\\-')}:\\s*(#[0-9a-fA-F]{6})`).exec(TOKENS);
	expect(m, `token ${name} not found in tokens.css`).not.toBeNull();
	return m![1]!;
}
function luminance(hex: string): number {
	const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
	const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi! + 0.05) / (lo! + 0.05);
}
/** The `background: var(--x)` token inside one CSS rule of the component. */
function backgroundOf(selector: string): string {
	const start = SRC.indexOf(`${selector} {`);
	expect(start, `rule ${selector} not found`).toBeGreaterThan(-1);
	const body = SRC.slice(start, SRC.indexOf('}', start));
	const m = /background:\s*var\((--[\w-]+)\)/.exec(body);
	expect(m, `rule ${selector} has no token background`).not.toBeNull();
	return m![1]!;
}

describe('the voting segment is visible', () => {
	it('⛔ segment AND legend swatch clear 3:1 against the white card (was --c-coral-pale, 1.04:1)', () => {
		const white = token('--c-white');
		for (const sel of ['.pb-seg.voting', '.pb-key.voting::before']) {
			const t = backgroundOf(sel);
			expect(contrast(token(t), white), `${sel} uses ${t}`).toBeGreaterThanOrEqual(3);
		}
	});
});

describe('the bar carries its dates', () => {
	let target: HTMLElement;
	let component: Record<string, unknown> | null = null;
	beforeEach(() => {
		target = document.createElement('div');
		document.body.appendChild(target);
	});
	afterEach(() => {
		if (component) unmount(component);
		component = null;
		target.remove();
	});

	it('⛔ a month bar shows its first and LAST day (UTC), not the next period’s first instant', () => {
		const cycle: CycleState = {
			week: '2026-10',
			periodKind: 'month',
			periodKey: '2026-10',
			periodStart: '2026-10-01T00:00:00.000Z',
			phase: 'voting',
			votingEndsAt: '2026-10-22T00:00:00.000Z',
			solutionEndsAt: '2026-11-01T00:00:00.000Z',
			closesAt: '2026-11-01T00:00:00.000Z'
		};
		component = mount(CadenceStrip, { target, props: { cycle } }) as Record<string, unknown>;
		flushSync();
		expect(target.querySelector('[data-testid="cadence-period-bar"]'), 'the bar never rendered').not.toBeNull();
		const start = target.querySelector('[data-testid="period-bar-start"]')?.textContent;
		const end = target.querySelector('[data-testid="period-bar-end"]')?.textContent;
		expect(start).toBe(dayMonth('2026-10-01T00:00:00.000Z', locale.current, 'UTC'));
		expect(end).toBe(dayMonth('2026-10-31T12:00:00.000Z', locale.current, 'UTC'));
		expect(end).not.toBe(dayMonth('2026-11-01T00:00:00.000Z', locale.current, 'UTC'));
	});

	it('⛔ a QUARTER renders the phase bar (not the Mon–Fri cards): voting 2 of 3 months, Oct 1 → Dec 31', () => {
		const cycle: CycleState = {
			week: '2026-Q4',
			periodKind: 'quarter',
			periodKey: '2026-Q4',
			periodStart: '2026-10-01T00:00:00.000Z',
			phase: 'voting',
			votingEndsAt: '2026-12-01T00:00:00.000Z',
			solutionEndsAt: '2027-01-01T00:00:00.000Z',
			closesAt: '2027-01-01T00:00:00.000Z'
		};
		component = mount(CadenceStrip, { target, props: { cycle } }) as Record<string, unknown>;
		flushSync();
		expect(target.querySelector('[data-testid="cadence-period-bar"]'), 'the bar never rendered').not.toBeNull();
		expect(target.querySelectorAll('.cadence .day').length).toBe(0);
		// Oct + Nov = 61 of 92 days.
		const voting = target.querySelector<HTMLElement>('.pb-seg.voting')!;
		expect(Number.parseFloat(voting.style.width)).toBeCloseTo((61 / 92) * 100, 1);
		expect(target.querySelector('[data-testid="period-bar-start"]')?.textContent).toBe(
			dayMonth('2026-10-01T00:00:00.000Z', locale.current, 'UTC')
		);
		expect(target.querySelector('[data-testid="period-bar-end"]')?.textContent).toBe(
			dayMonth('2026-12-31T12:00:00.000Z', locale.current, 'UTC')
		);
	});

	it('a QUARTER cadence with no row yet shows the neutral waiting line, never the day cards', () => {
		component = mount(CadenceStrip, { target, props: { cycle: null, kind: 'quarter' } }) as Record<string, unknown>;
		flushSync();
		expect(target.querySelector('[data-testid="cadence-period-waiting"]')).not.toBeNull();
		expect(target.querySelectorAll('.cadence .day').length).toBe(0);
	});
});
