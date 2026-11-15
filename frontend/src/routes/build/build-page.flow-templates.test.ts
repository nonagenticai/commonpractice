// src/routes/build/build-page.flow-templates.test.ts — the flow-template ENTRY POINTS are wired.
//
// Source guards (the house answer for wiring in a `.svelte` page with no cheap render harness — see
// audit-categories.backend-contract.test.ts). Each slices to the region it means, asserts the file
// is non-empty first, and checks both directions: the new wiring is there AND the old one is gone.
//   • /build's empty-canvas "Pick a template" card opens the gallery — it used to be a link to
//     /solutions because no flow templates existed;
//   • "New flow" opens the Blank / From template choice instead of creating a blank flow at once;
//   • "Save as template" is offered only to authors (developer and up) on a flow they own;
//   • a used template navigates to the new flow, keeping ?challenge=, and frames it;
//   • /solutions/[id] offers "Use as starting point", which copies the flow and opens the copy.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('/build — flow template entry points', () => {
	const src = read('src/routes/build/+page.svelte');

	it('the page source is readable (anti-vacuity)', () => {
		expect(src.length).toBeGreaterThan(10_000);
	});

	it('the empty-canvas template card opens the gallery, not /solutions', () => {
		const start = src.slice(src.indexOf('data-testid="build-start"'), src.indexOf('{#if narrow}'));
		expect(start.length).toBeGreaterThan(200);
		const at = start.indexOf('m.build_start_template()');
		// The opening tag of the card that holds the template copy: whichever of <button / <a is nearer.
		const opener = Math.max(start.lastIndexOf('<button', at), start.lastIndexOf('<a ', at));
		const card = start.slice(opener, at);
		expect(card.startsWith('<button')).toBe(true);
		expect(card).toContain('onclick={() => (galleryOpen = true)}');
		expect(start).not.toContain('href="/solutions"');
		const gallery = src.slice(src.indexOf('<FlowTemplateGallery'), src.indexOf('/>', src.indexOf('<FlowTemplateGallery')));
		expect(gallery).toContain('open={galleryOpen}');
		expect(gallery).toContain('onUsed={openUsedTemplate}');
	});

	it('"New flow" opens the choice; Blank creates the blank flow; From template opens the gallery', () => {
		expect(src).toContain('onNew={() => (newChoiceOpen = true)}');
		expect(src).not.toContain('onNew={newFlow}');
		const choice = src.slice(src.indexOf('<NewFlowChoice'), src.indexOf('<SaveFlowTemplateDialog'));
		expect(choice).toContain('void newFlow();');
		expect(choice).toContain('galleryOpen = true;');
	});

	it('"Save as template" is offered to authors on their own flow only', () => {
		expect(src).toContain('onSaveTemplate={auth.isDeveloper && !builder.readOnly ? openSaveTemplate : undefined}');
		const fn = src.slice(src.indexOf('async function openSaveTemplate'), src.indexOf('function selectFlow'));
		// The autosave is flushed first, so the template is the graph on screen.
		expect(fn.indexOf('await doSave()')).toBeGreaterThan(-1);
		expect(fn.indexOf('await doSave()')).toBeLessThan(fn.indexOf('saveTemplateOpen = true'));
	});

	it('a used template opens the new flow through builderBootUrl and re-frames the canvas', () => {
		const fn = src.slice(src.indexOf('async function openUsedTemplate'), src.indexOf('async function openSaveTemplate'));
		expect(fn).toContain('goto(builderBootUrl(page.url, result.flowId))');
		expect(fn).toContain('fitAfterLoad = true');
		expect(src).toMatch(/\[paletteCol, sideCol, consoleRow, sidebar\.collapsed, fitNonce\]/);
		const load = src.slice(src.indexOf('builder.hydrated = true;'), src.indexOf('builder.hydrated = true;') + 200);
		expect(load).toContain('fitNonce++');
	});
});

describe('/solutions/[id] — Use as starting point', () => {
	const src = read('src/routes/solutions/[id]/+page.svelte');

	it('copies the flow through the API and opens the copy in /build', () => {
		expect(src.length).toBeGreaterThan(10_000);
		expect(src).toMatch(/data-testid="use-as-start"[^>]*onclick=\{useAsStart\}/);
		const fn = src.slice(src.indexOf('async function useAsStart'), src.indexOf('async function vote'));
		expect(fn).toContain('flowTemplatesApi.useSolution(data.id)');
		expect(fn).toContain('goto(`/build?id=${encodeURIComponent(flowId)}`)');
		// Rendered inside the flow card (only a solution with a flow can be a starting point).
		const flowCard = src.slice(src.indexOf('{#if data.flow}\n\t\t\t\t\t<div class="card">'), src.indexOf('{:else}', src.indexOf('{#if data.flow}\n\t\t\t\t\t<div class="card">')));
		expect(flowCard).toContain('data-testid="use-as-start"');
	});
});
