import { describe, it, expect } from 'vitest';
import { idpHintFromQuery, tenantSignInUrl } from './keycloak';

describe('idpHintFromQuery', () => {
	it('passes through a valid ?idp=<alias>', () => {
		expect(idpHintFromQuery('?idp=entra-acme')).toBe('entra-acme');
	});

	it('derives entra-<slug> from ?tenant=<slug>', () => {
		expect(idpHintFromQuery('?tenant=acme')).toBe('entra-acme');
	});

	it('does NOT treat ?slug= as a tenant hint (it is an in-app route param, e.g. block-edit)', () => {
		// Regression: a block deep-link /block-edit?slug=<block> must not derive a bogus
		// entra-<block> IdP hint (which broke login) nor get the slug stripped from the URL.
		expect(idpHintFromQuery('?slug=acme')).toBeNull();
		expect(idpHintFromQuery('?slug=tezt')).toBeNull();
	});

	it('lets ?idp win over ?tenant', () => {
		expect(idpHintFromQuery('?tenant=acme&idp=entra-other')).toBe('entra-other');
	});

	it('returns null for no param', () => {
		expect(idpHintFromQuery('')).toBeNull();
		expect(idpHintFromQuery('?foo=bar')).toBeNull();
	});

	it('rejects an idp alias outside the [a-z0-9-] charset', () => {
		expect(idpHintFromQuery('?idp=../evil')).toBeNull();
		expect(idpHintFromQuery('?idp=Entra ACME')).toBeNull();
		expect(idpHintFromQuery('?idp=entra_acme')).toBeNull();
		expect(idpHintFromQuery('?idp=')).toBeNull();
	});

	it('rejects a tenant slug outside the charset (no fabricated alias)', () => {
		expect(idpHintFromQuery('?tenant=../evil')).toBeNull();
		expect(idpHintFromQuery('?tenant=ACME%20Inc')).toBeNull();
	});
});

describe('tenantSignInUrl', () => {
	it('builds origin/?idp=<alias>', () => {
		expect(tenantSignInUrl('https://cp.example', 'entra-acme')).toBe(
			'https://cp.example/?idp=entra-acme'
		);
	});
});
