import { describe, it, expect } from 'vitest';
import { matchInformation, foldText } from './information-search';
import type { InformationOption } from '$lib/types/challenges';

const OPTS: InformationOption[] = [
	{ id: '1', label: 'Schadeclaim', description: null, synonyms: ['claim', 'schademelding'] },
	{ id: '2', label: 'Reclamación', description: null, synonyms: [] },
	{ id: '3', label: 'Polis', description: 'Verzekeringscontract', synonyms: ['policy'] }
];

describe('matchInformation', () => {
	it('an empty query offers everything', () => {
		expect(matchInformation(OPTS, '  ').map((o) => o.id)).toEqual(['1', '2', '3']);
	});
	it('matches the localized name, case-insensitively', () => {
		expect(matchInformation(OPTS, 'SCHADE').map((o) => o.id)).toEqual(['1']);
	});
	it('matches a synonym', () => {
		expect(matchInformation(OPTS, 'policy').map((o) => o.id)).toEqual(['3']);
	});
	it('ignores accents both ways', () => {
		expect(matchInformation(OPTS, 'reclamacion').map((o) => o.id)).toEqual(['2']);
		expect(foldText('Reclamación')).toBe('reclamacion');
	});
	it('needs every word to match', () => {
		expect(matchInformation(OPTS, 'schade polis')).toEqual([]);
	});
	it('does not search the description', () => {
		expect(matchInformation(OPTS, 'verzekering')).toEqual([]);
	});
});
