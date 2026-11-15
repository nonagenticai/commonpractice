// tests/pii-values.test.ts — VALUE-based personal-data detection (datasets/pii-values.ts), with
// realistic Dutch and English samples. Each positive case is paired with a near-miss that must
// SURVIVE, so the detector cannot pass by redacting everything.
import { test, expect } from 'bun:test';
import { scrubPiiText, scrubPiiCell, scrubPiiRow, isValidBsn, isValidIban } from '../src/datasets/pii-values';
import { PII_REDACTION as R } from '../src/db/dataset-types';

test('e-mail addresses are replaced inside free text', () => {
  expect(scrubPiiText('Graag reactie naar anna.de-vries+claims@verzekeraar.nl vóór vrijdag')).toBe(`Graag reactie naar ${R} vóór vrijdag`);
  expect(scrubPiiText('Contact: j.smith@example.co.uk')).toBe(`Contact: ${R}`);
  expect(scrubPiiText('Twitter @handle is not an address')).toBe('Twitter @handle is not an address');
});

test('Dutch and international phone numbers are replaced; amounts, dates and short numbers are not', () => {
  expect(scrubPiiText('Bel mevrouw op 06-12345678 na 17u')).toBe(`Bel mevrouw op ${R} na 17u`);
  expect(scrubPiiText('Kantoor 020 123 4567')).toBe(`Kantoor ${R}`);
  expect(scrubPiiText('Rotterdam (010) 123 4567')).toBe(`Rotterdam ${R}`);
  expect(scrubPiiText('mobiel 0612345678')).toBe(`mobiel ${R}`);
  expect(scrubPiiText('Call +31 6 1234 5678 or +44 20 7946 0958')).toBe(`Call ${R} or ${R}`);
  expect(scrubPiiText('Belgium 0032 2 123 45 67')).toBe(`Belgium ${R}`);
  expect(scrubPiiText('Claim 2024-10-15, amount 1250.50, policy 4471')).toBe('Claim 2024-10-15, amount 1250.50, policy 4471');
  expect(scrubPiiText('06-1234 (too short)')).toBe('06-1234 (too short)');
});

test('IBANs are replaced only when the mod-97 check passes', () => {
  expect(isValidIban('NL91ABNA0417164300')).toBe(true);
  expect(isValidIban('NL91ABNA0417164301')).toBe(false);
  expect(scrubPiiText('Uitbetalen op NL91 ABNA 0417 1643 00 graag')).toBe(`Uitbetalen op ${R} graag`);
  expect(scrubPiiText('GB82WEST12345698765432')).toBe(R);
  expect(scrubPiiText('code NL91ABNA0417164301')).toBe('code NL91ABNA0417164301');
});

test('a BSN is replaced only when it passes the 11-proef — 9 digits, or 1234.56.782 / 123 456 782', () => {
  expect(isValidBsn('111222333')).toBe(true);
  expect(isValidBsn('123456782')).toBe(true);
  expect(isValidBsn('123456789')).toBe(false);
  expect(isValidBsn('000000000')).toBe(false);
  expect(scrubPiiText('BSN 111222333 bekend')).toBe(`BSN ${R} bekend`);
  expect(scrubPiiText('1234.56.782')).toBe(R);
  expect(scrubPiiText('123 456 782')).toBe(R);
  expect(scrubPiiText('order 123456789')).toBe('order 123456789');
  expect(scrubPiiText('1234567820')).toBe('1234567820'); // 10 digits: not a BSN (and no leading 0)
});

test('a BSN typed as a NUMBER (a CSV column "klant") is replaced whole; other numbers pass', () => {
  expect(scrubPiiCell('klant', 111222333)).toBe(R);
  expect(scrubPiiCell('klant', 123456789)).toBe(123456789);
  expect(scrubPiiCell('bedrag', 450)).toBe(450);
  expect(scrubPiiCell('ratio', 0.25)).toBe(0.25);
  expect(scrubPiiCell('actief', true)).toBe(true);
  expect(scrubPiiCell('leeg', null)).toBe(null);
});

test('Dutch postcodes (1012 AB) are replaced; SA/SD/SS and lower case are not postcodes', () => {
  expect(scrubPiiText('Dorpsstraat 4, 1012 AB Amsterdam')).toBe(`Dorpsstraat 4, ${R} Amsterdam`);
  expect(scrubPiiText('3511LX')).toBe(R);
  expect(scrubPiiText('in 2024 SS ging het mis')).toBe('in 2024 SS ging het mis');
  expect(scrubPiiText('in 2024 ok')).toBe('in 2024 ok');
});

test('a date is replaced only in a column whose NAME suggests a date of birth', () => {
  expect(scrubPiiCell('geboortedatum', '1985-03-12')).toBe(R);
  expect(scrubPiiCell('date_of_birth', '12/07/1990')).toBe(R);
  expect(scrubPiiCell('DOB', '12-07-1990')).toBe(R);
  expect(scrubPiiCell('born_on', '1990-07-12T00:00:00Z')).toBe(R);
  expect(scrubPiiCell('claim_date', '1985-03-12')).toBe('1985-03-12');
  expect(scrubPiiCell('geboortedatum', 'onbekend')).toBe('onbekend');
});

test('scrubPiiRow scrubs every cell and returns the SAME object when nothing matched', () => {
  const clean = { claim_id: 'CLM-1', amount: 450, notes: 'Schade aan voorruit' };
  expect(scrubPiiRow(clean)).toBe(clean);
  const dirty = { claim_id: 'CLM-2', notes: 'Bel 06-12345678', klant: 111222333 };
  expect(scrubPiiRow(dirty)).toEqual({ claim_id: 'CLM-2', notes: `Bel ${R}`, klant: R });
  expect(dirty.notes).toBe('Bel 06-12345678'); // input not mutated
});
