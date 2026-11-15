// W8/P5: approving a request opens the existing create screen PREFILLED — these are the prefills.
import { describe, it, expect } from 'vitest';
import { camelName, datasetPrefill, entityPrefill, fromRequestParam, pascalName } from './prefill';

describe('request prefill (W8/P5)', () => {
	it('names', () => {
		expect(pascalName('Policy holder')).toBe('PolicyHolder');
		expect(camelName('policy number')).toBe('policyNumber');
		expect(camelName('Start-date')).toBe('startDate');
	});
	it('a "missing information" request prefills the create-entity form', () => {
		expect(entityPrefill({ name: 'Policy holder', description: 'Who owns it', fieldNames: ['policy number', 'Policy Number', 'start date'] })).toEqual({
			name: 'PolicyHolder',
			label: 'Policy holder',
			description: 'Who owns it',
			attributes: [
				{ name: 'policyNumber', type: 'string', pii: false, synonyms: 'policy number' },
				{ name: 'startDate', type: 'string', pii: false, synonyms: 'start date' }
			]
		});
	});
	it('example records prefill the paste drawer as JSON rows', () => {
		expect(datasetPrefill({ name: 'Claims', rows: [{ a: 1 }] })).toEqual({ name: 'Claims', content: '[\n  {\n    "a": 1\n  }\n]' });
	});
	it('reads only a uuid-shaped ?fromRequest=', () => {
		expect(fromRequestParam('?fromRequest=00000000-0000-0000-0000-00000a8e0001')).toBe('00000000-0000-0000-0000-00000a8e0001');
		expect(fromRequestParam('?fromRequest=../x')).toBeNull();
		expect(fromRequestParam('')).toBeNull();
	});
});
