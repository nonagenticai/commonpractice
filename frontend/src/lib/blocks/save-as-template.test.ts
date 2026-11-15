import { describe, it, expect } from 'vitest';
import { toTemplateBody, slugifyName, type TemplateFormState, type TemplateSource } from './save-as-template';

const source: TemplateSource = {
	category: 'logic',
	description: 'a finished block',
	descriptor: { inputs: {}, outputs: {}, capabilities: { network: false } } as never,
	source_ts: 'export default {};',
	docs_md: '# docs'
};

function form(over: Partial<TemplateFormState> = {}): TemplateFormState {
	return {
		label: 'Dedupe Rows',
		name: 'dedupe-rows',
		domain: '',
		tags: '',
		preconditions: [],
		postconditions: [],
		steps: [],
		...over
	};
}

describe('toTemplateBody', () => {
	it('carries non-empty PKO/PDDL rows and drops blanks/whitespace', () => {
		const body = toTemplateBody(
			form({
				preconditions: ['  has rows  ', '', '   '],
				postconditions: ['deduped'],
				steps: [
					{ label: 'Scan', detail: '  collect ids ' },
					{ label: '', detail: '' }, // dropped
					{ label: 'Emit', detail: '' } // kept (label only)
				]
			}),
			source
		);
		expect(body.preconditions).toEqual(['has rows']);
		expect(body.postconditions).toEqual(['deduped']);
		expect(body.steps).toEqual([
			{ label: 'Scan', detail: 'collect ids' },
			{ label: 'Emit', detail: '' }
		]);
	});

	it('untouched formal sections save as empty arrays', () => {
		const body = toTemplateBody(form(), source);
		expect(body.preconditions).toEqual([]);
		expect(body.postconditions).toEqual([]);
		expect(body.steps).toEqual([]);
	});

	it('splits tags, drops blanks, and nulls an empty domain', () => {
		const body = toTemplateBody(form({ tags: 'a,  b , ,c', domain: '  ' }), source);
		expect(body.tags).toEqual(['a', 'b', 'c']);
		expect(body.domain).toBeNull();
	});

	it('falls back to a slugified label when name is blank', () => {
		const body = toTemplateBody(form({ name: '   ', label: 'My Cool Block!' }), source);
		expect(body.name).toBe('my-cool-block');
	});

	it('passes through the block design fields', () => {
		const body = toTemplateBody(form({ domain: 'insurance' }), source);
		expect(body).toMatchObject({
			category: 'logic',
			description: 'a finished block',
			source_ts: 'export default {};',
			docs_md: '# docs',
			domain: 'insurance'
		});
	});
});

describe('slugifyName', () => {
	it('lowercases, hyphenates, and trims edges', () => {
		expect(slugifyName('  Validate Record 2 ')).toBe('validate-record-2');
		expect(slugifyName('A//B')).toBe('a-b');
	});
});
