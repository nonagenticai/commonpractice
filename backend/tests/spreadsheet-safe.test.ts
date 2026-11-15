// tests/spreadsheet-safe.test.ts — the formula-injection neutraliser (utils/spreadsheet-safe.ts).
import { test, expect } from 'bun:test';
import { neutralizeFormula, neutralizeCell, neutralizeRow } from '../src/utils/spreadsheet-safe';

test('every formula-starting character is neutralised with a leading quote', () => {
  for (const s of ['=1+1', '+1', '-1', '@SUM(A1)', '\t=1', '\r=1']) {
    expect(neutralizeFormula(s)).toBe(`'${s}`);
  }
});

test('ordinary text, an embedded = and an empty string pass unchanged', () => {
  for (const s of ['Claim', 'a=b', ' =1', '', "'already"]) expect(neutralizeFormula(s)).toBe(s);
});

test('only strings are touched; a row with nothing to change is returned as is', () => {
  expect(neutralizeCell(-5)).toBe(-5);
  expect(neutralizeCell(null)).toBe(null);
  const row = { a: 'x', n: -1 };
  expect(neutralizeRow(row)).toBe(row);
  expect(neutralizeRow({ a: '=1', n: -1 })).toEqual({ a: "'=1", n: -1 });
});
