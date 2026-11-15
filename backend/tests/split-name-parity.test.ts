// tests/split-name-parity.test.ts — the realm name split every early-access app shares (fr's
// identity.ts splitName). The shared portal realm REQUIRES firstName + lastName (VERIFY_PROFILE):
// an empty half sends the person to "Update account information" right after the password.
import { test, expect } from 'bun:test';
import { splitName } from '../src/services/provisioning';

const EMAIL = 'gregorius.dekker@example.test';

test('splitName: two words → first / last', () => {
  expect(splitName('Gregorius Dekker', EMAIL)).toEqual({ firstName: 'Gregorius', lastName: 'Dekker' });
});

test('splitName: a spaced surname keeps every word after the first', () => {
  expect(splitName('Anna van der Berg', EMAIL)).toEqual({ firstName: 'Anna', lastName: 'van der Berg' });
});

test('splitName: whitespace runs collapse and the ends are trimmed', () => {
  expect(splitName('  Anna \t van   der\nBerg  ', EMAIL)).toEqual({ firstName: 'Anna', lastName: 'van der Berg' });
});

test('splitName: ONE word → the same word for both (never an empty lastName)', () => {
  expect(splitName('Cher', EMAIL)).toEqual({ firstName: 'Cher', lastName: 'Cher' });
  expect(splitName('  Cher  ', EMAIL)).toEqual({ firstName: 'Cher', lastName: 'Cher' });
});

test('splitName: empty, whitespace-only or absent → the email local part for both', () => {
  const local = { firstName: 'gregorius.dekker', lastName: 'gregorius.dekker' };
  expect(splitName('', EMAIL)).toEqual(local);
  expect(splitName('   \t\n', EMAIL)).toEqual(local);
  expect(splitName(undefined, EMAIL)).toEqual(local);
  expect(splitName(null, EMAIL)).toEqual(local);
});
