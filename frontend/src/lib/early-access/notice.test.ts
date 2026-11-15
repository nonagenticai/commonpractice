// src/lib/early-access/notice.test.ts — the public early-access notice (owner decision 2026-10-15).
import { describe, it, expect } from 'vitest';
import { CONTACT_EMAIL, EARLY_ACCESS_NOTICE, isPublicPath, noticeLanguageFor } from './notice';

const words = (lang: 'en' | 'nl') => {
	const n = EARLY_ACCESS_NOTICE[lang];
	return [n.title, ...n.paragraphs, n.contactLabel, CONTACT_EMAIL].join(' ').split(/\s+/).length;
};

describe('early-access notice', () => {
	it('states what the owner asked for, in EN', () => {
		const text = EARLY_ACCESS_NOTICE.en.paragraphs.join(' ');
		for (const must of ['early access', 'as-is', 'free of charge', 'no service level', 'Features may change', 'Germany', 'own hardware in the Netherlands', 'own provider key', 'Full terms']) {
			expect(text + EARLY_ACCESS_NOTICE.en.title).toContain(must);
		}
		expect(CONTACT_EMAIL).toBe('george@nonagentic.ai');
	});

	it('has the same structure in NL, and stays short (about 120 words)', () => {
		expect(EARLY_ACCESS_NOTICE.nl.paragraphs).toHaveLength(EARLY_ACCESS_NOTICE.en.paragraphs.length);
		expect(EARLY_ACCESS_NOTICE.nl.paragraphs.join(' ')).toContain('Duitsland');
		expect(words('en')).toBeLessThanOrEqual(130);
		expect(words('nl')).toBeLessThanOrEqual(140);
	});

	it('Dutch readers get Dutch; every other locale gets English', () => {
		expect(noticeLanguageFor('nl')).toBe('nl');
		expect(noticeLanguageFor('nl-BE')).toBe('nl');
		for (const l of ['en', 'de', 'fr', 'es', 'pl', 'ar', 'he', '', null, undefined]) expect(noticeLanguageFor(l)).toBe('en');
	});

	it('only /early-access is public', () => {
		expect(isPublicPath('/early-access')).toBe(true);
		expect(isPublicPath('/early-accessory')).toBe(false);
		expect(isPublicPath('/')).toBe(false);
		expect(isPublicPath('/settings')).toBe(false);
	});
});
