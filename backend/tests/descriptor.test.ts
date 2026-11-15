// tests/descriptor.test.ts — runtime field validation (pure, no DB/spawn).
import { test, expect } from 'bun:test';
import {
  validateField,
  validateInputs,
  validateOutputs,
} from '../src/exec/descriptor';
import type { BlockDescriptor } from '../src/db/block-types';

test('validateField covers each FieldType', () => {
  expect(validateField('a', { type: 'string' }, 'x')).toBeNull();
  expect(validateField('a', { type: 'string' }, 1)).toContain('string');
  expect(validateField('a', { type: 'number' }, 3)).toBeNull();
  expect(validateField('a', { type: 'number' }, NaN)).toContain('finite');
  expect(validateField('a', { type: 'boolean' }, true)).toBeNull();
  expect(validateField('a', { type: 'boolean' }, 'no')).toContain('boolean');
  expect(validateField('a', { type: 'string[]' }, ['x', 'y'])).toBeNull();
  expect(validateField('a', { type: 'string[]' }, ['x', 1])).toContain('string[]');
  expect(validateField('a', { type: 'enum', enum: ['x', 'y'] }, 'y')).toBeNull();
  expect(validateField('a', { type: 'enum', enum: ['x', 'y'] }, 'z')).toContain('one of');
  expect(validateField('a', { type: 'json' }, { any: 1 })).toBeNull();
  expect(validateField('a', { type: 'json' }, undefined)).toContain('required');
});

const desc: BlockDescriptor = {
  inputs: {
    text: { type: 'string', required: true },
    max: { type: 'number' },
  },
  outputs: {
    summary: { type: 'string', required: true },
    extra: { type: 'json' },
  },
  capabilities: {},
};

test('validateInputs flags a missing required input and a wrong type', () => {
  expect(validateInputs({ text: 'hi' }, desc).ok).toBe(true);
  expect(validateInputs({ text: 'hi', max: 5 }, desc).ok).toBe(true);
  const missing = validateInputs({ max: 5 }, desc);
  expect(missing.ok).toBe(false);
  expect(missing.errors[0]).toContain("required input 'text'");
  const badType = validateInputs({ text: 'hi', max: 'five' }, desc);
  expect(badType.ok).toBe(false);
});

test('validateOutputs requires present required outputs; tolerates absent optional', () => {
  expect(validateOutputs({ summary: 'done' }, desc).ok).toBe(true);
  expect(validateOutputs({ summary: 'done', extra: { a: 1 } }, desc).ok).toBe(true);
  const missing = validateOutputs({ extra: { a: 1 } }, desc);
  expect(missing.ok).toBe(false);
  expect(missing.errors[0]).toContain("required output 'summary'");
  expect(validateOutputs(null as unknown as Record<string, unknown>, desc).ok).toBe(false);
});
