// src/lib/components/build/build-topbar.title-visible.test.ts — a guard that the flow-title input
// LOOKS like a control you can edit.
//
// ⚠️ BE HONEST ABOUT WHAT THIS TEST IS. It reads the component's `<style>` block as TEXT. It is a
// grep, not a rendering assertion: vitest does not apply a Svelte component's scoped CSS, so no
// mounted test in this repo can observe a computed `border-color`. It cannot prove the input is
// legible; it can only stop the specific regression that produced the defect. The behavioural half
// lives next door in `build-topbar.submit-gate.render.test.ts`, which drives the gate itself.
//
// Reading source text from disk in a vitest test is an established pattern here — see
// `src/routes/build/build-page.submit.test.ts` and
// `src/routes/pipeline/pipeline-page.no-reviewer-count.test.ts`, which document why.
//
// The defect this guards, measured in the LIVE production DOM:
//   document.querySelector('input.title')
//     -> border      "1px solid rgba(0, 0, 0, 0)"
//        background  "rgba(0, 0, 0, 0)"
//        placeholder (none)
// The rename control EXISTED the whole time and revealed itself only on hover. Nobody renamed
// anything, so `/build`'s auto-generated name went straight into `solutions.title`, and the
// product's first user-submitted solution is called "Untitled flow".
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const COMPONENT = fileURLToPath(new URL('./BuildTopbar.svelte', import.meta.url));

/** The body of one top-level rule in the component's `<style>` block, comments stripped. */
function rule(selector: string): string {
	const src = readFileSync(COMPONENT, 'utf-8');
	const re = new RegExp(`^\\t${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)^\\t\\}`, 'm');
	const found = src.match(re);
	expect(found, `no \`${selector}\` rule in BuildTopbar.svelte — this file is grepping for nothing`).not.toBeNull();
	return found![1].replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('the flow-title input is visibly editable', () => {
	it('is the file we think it is (or every assertion below passes vacuously)', () => {
		const src = readFileSync(COMPONENT, 'utf-8');
		expect(src).toContain('class="title"');
		expect(src).toContain('<style>');
	});

	it('has a real, non-transparent border', () => {
		const css = rule('.title');
		expect(
			css,
			'`.title` is back to a transparent border. The rename control is then invisible until you ' +
				'happen to hover it — which is how every flow kept the name the product invented and ' +
				'"Untitled flow" ended up as a competition entry.'
		).not.toMatch(/border:[^;]*transparent/);
		expect(css).not.toMatch(/border:\s*none/);
		expect(css, '`.title` declares no border colour at all').toMatch(/border:\s*1px solid var\(--c-/);
	});

	it('has a real background rather than borrowing the topbar\'s', () => {
		const css = rule('.title');
		expect(
			css,
			'`.title` has `background: none`, so the field is indistinguishable from the bar behind it.'
		).not.toMatch(/background:\s*none/);
		expect(css).toMatch(/background:\s*var\(--c-/);
	});

	it('turns amber while the flow still carries an auto-generated name', () => {
		// The state the Submit gate refuses must be visible ON the field that resolves it, not only
		// in the hint 400px to its right.
		const css = rule('.title.unnamed');
		expect(css, 'the unnamed state is not amber, so nothing points at the field to fix').toMatch(/--c-amber/);
	});

	it('still shows a focus indicator in that same amber state', () => {
		// `.title:focus` sets `outline: none` and a teal border; `.title.unnamed` is later at EQUAL
		// specificity (0,3,0) and takes the border back, while nothing takes back the `outline: none`.
		// Tabbing into the title while unnamed — the one state this feature funnels users into —
		// produced no visible change at all (WCAG 2.4.7). Only the hint button's `.select()` masked it.
		const css = rule('.title.unnamed:focus');
		expect(css, 'the unnamed focus state suppresses the outline again').not.toMatch(/outline:\s*none/);
		expect(
			css,
			'`.title.unnamed:focus` declares no outline, so it cannot restore the ring `.title:focus` removed'
		).toMatch(/outline:\s*[^;]*var\(--c-/);
	});

	it('names itself with a placeholder, not only an aria-label', () => {
		expect(
			readFileSync(COMPONENT, 'utf-8'),
			'the title input has no placeholder. An empty, unlabelled box says nothing about what it is.'
		).toMatch(/placeholder=\{m\./);
	});
});
