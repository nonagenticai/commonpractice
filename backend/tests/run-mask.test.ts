// tests/run-mask.test.ts — the TYPE-PRESERVING run masker (datasets/run-mask.ts), rule by rule.
// The end-to-end claim (a member's typed run finishes ok) is in run-typed-masking.test.ts.
import { test, expect } from 'bun:test';
import { maskDatasetForRun, RUN_PLACEHOLDER, shiftDateString, synthNumber } from '../src/datasets/run-mask';
import { isValidBsn, isValidIban, scrubPiiText } from '../src/datasets/pii-values';
import type { DatasetColumn } from '../src/db/dataset-types';

const cols: DatasetColumn[] = [
  { name: 'amount', type: 'number' },
  { name: 'rate', type: 'number' },
  { name: 'filed', type: 'date' },
  { name: 'filed_nl', type: 'date' },
  { name: 'approved', type: 'boolean' },
  { name: 'holder', type: 'string' },
  { name: 'meta', type: 'json' },
  { name: 'note', type: 'string' },
];
const rows = [
  { amount: 2500, rate: -3.75, filed: '2026-01-15', filed_nl: '15-01-2026', approved: true, holder: 'Jan Jansen', meta: { score: 12, who: 'Jan' }, note: 'mail jan@x.nl' },
  { amount: 0, rate: 0.5, filed: '2026-03-01T09:30:00Z', filed_nl: '01-03-2026', approved: false, holder: 'Piet', meta: null, note: '' },
  { amount: null, rate: 12, filed: '', filed_nl: null, approved: null, holder: 'Jan Jansen', meta: [1, 'a'], note: null },
];
const MASKED = ['amount', 'rate', 'filed', 'filed_nl', 'approved', 'holder', 'meta'];

test('masked numbers keep type, sign, digit count and decimals — and are never the original', () => {
  const out = maskDatasetForRun('t:d', cols, rows, MASKED).rows;
  expect(typeof out[0]!.amount).toBe('number');
  expect(Number.isInteger(out[0]!.amount)).toBe(true);
  expect(String(out[0]!.amount)).toHaveLength(4);
  expect(out[0]!.amount).not.toBe(2500);
  expect(out[0]!.rate as number).toBeLessThan(0);
  expect(out[0]!.rate).not.toBe(-3.75);
  expect(String(out[0]!.rate).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
  expect(out[1]!.amount).not.toBe(0);
  expect(Number.isInteger(out[1]!.amount)).toBe(true);
  expect(out[2]!.rate).not.toBe(12);
  expect(Number.isInteger(out[2]!.rate)).toBe(true);
});

test('masking is deterministic per tenant+dataset and differs across datasets', () => {
  const a = maskDatasetForRun('t:d', cols, rows, MASKED).rows;
  const b = maskDatasetForRun('t:d', cols, rows, MASKED).rows;
  const c = maskDatasetForRun('t:other', cols, rows, MASKED).rows;
  expect(a).toEqual(b);
  expect(a[0]!.amount === c[0]!.amount && a[0]!.filed === c[0]!.filed).toBe(false);
});

test('masked dates shift by one offset per column, keep their format and ordering', () => {
  const out = maskDatasetForRun('t:d', cols, rows, MASKED).rows;
  expect(out[0]!.filed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(out[1]!.filed).toMatch(/^\d{4}-\d{2}-\d{2}T09:30:00Z$/);
  expect(out[0]!.filed).not.toBe('2026-01-15');
  expect((out[0]!.filed as string) < (out[1]!.filed as string)).toBe(true);
  expect(out[0]!.filed_nl).toMatch(/^\d{2}-\d{2}-\d{4}$/);
  expect(out[0]!.filed_nl).not.toBe('15-01-2026');
  const d = new Date('2026-01-15T00:00:00Z');
  const dateOut = maskDatasetForRun('t:d', [{ name: 'when', type: 'date' }], [{ when: d }], ['when']).rows[0]!.when;
  expect(dateOut).toBeInstanceOf(Date);
  expect((dateOut as Date).getTime()).not.toBe(d.getTime());
  expect(shiftDateString('2026-02-30', 10)).toBeNull();
  expect(shiftDateString('2026-01-31', 1)).toBe('2026-02-01');
});

test('booleans, null and empty are kept; strings become stable neutral pseudonyms; json leaves masked', () => {
  const out = maskDatasetForRun('t:d', cols, rows, MASKED).rows;
  expect(out[0]!.approved).toBe(true);
  expect(out[1]!.approved).toBe(false);
  expect(out[2]!.amount).toBeNull();
  expect(out[2]!.filed).toBe('');
  expect(out[0]!.holder).toBe('value-1');
  expect(out[1]!.holder).toBe('value-2');
  expect(out[2]!.holder).toBe('value-1'); // equal originals → equal pseudonyms
  expect(typeof (out[0]!.meta as { score: unknown }).score).toBe('number');
  expect((out[0]!.meta as { who: unknown }).who).not.toBe('Jan');
  expect(out[1]!.meta).toBeNull();
});

test('a visible column keeps its text; only the detected span is replaced, with a typed placeholder', () => {
  const data = [{ note: 'BSN 111222333, mail eva@claims.example, bel 06-12345678, IBAN NL91ABNA0417164300, 1012 AB' }];
  const out = maskDatasetForRun('t:d', [{ name: 'note', type: 'string' }], data, []).rows[0]!.note as string;
  expect(out).toBe(
    `BSN ${RUN_PLACEHOLDER.bsn}, mail ${RUN_PLACEHOLDER.email}, bel ${RUN_PLACEHOLDER.phone}, IBAN ${RUN_PLACEHOLDER.iban}, ${RUN_PLACEHOLDER.postcode}`,
  );
  // The placeholders are not personal data by the detector's own rules.
  expect(isValidBsn(RUN_PLACEHOLDER.bsn)).toBe(false);
  expect(isValidIban(RUN_PLACEHOLDER.iban)).toBe(false);
  expect(scrubPiiText(RUN_PLACEHOLDER.bsn)).toBe(RUN_PLACEHOLDER.bsn);
  expect(scrubPiiText(RUN_PLACEHOLDER.postcode)).toBe(RUN_PLACEHOLDER.postcode);
});

test('a BSN that parsed as a NUMBER in a visible column becomes a 9-digit number that fails the 11-proef', () => {
  const out = maskDatasetForRun('t:d', [{ name: 'klant', type: 'number' }], [{ klant: 111222333 }], []).rows[0]!.klant;
  expect(typeof out).toBe('number');
  expect(String(out)).toHaveLength(9);
  expect(out).not.toBe(111222333);
  expect(isValidBsn(String(out))).toBe(false);
});

test('a synthetic 9-digit integer never passes the 11-proef (over many seeds)', () => {
  for (let i = 0; i < 500; i++) {
    let s = i + 1;
    const rnd = () => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
    expect(isValidBsn(String(synthNumber(123456789, rnd)))).toBe(false);
  }
});

test('a date of birth in a visible birth column is shifted, not blanked', () => {
  const out = maskDatasetForRun('t:d', [{ name: 'geboortedatum', type: 'date' }], [{ geboortedatum: '1980-05-17' }], []).rows[0]!.geboortedatum;
  expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(out).not.toBe('1980-05-17');
});

test('the column sample is masked with the same rules; column types are unchanged', () => {
  const c: DatasetColumn[] = [{ name: 'amount', type: 'number', sample: 2500 }, { name: 'note', type: 'string', sample: 'x@y.nl' }];
  const out = maskDatasetForRun('t:d', c, [], ['amount']).columns;
  expect(out.map((x) => x.type)).toEqual(['number', 'string']);
  expect(typeof out[0]!.sample).toBe('number');
  expect(out[0]!.sample).not.toBe(2500);
  expect(out[1]!.sample).toBe(RUN_PLACEHOLDER.email);
});
