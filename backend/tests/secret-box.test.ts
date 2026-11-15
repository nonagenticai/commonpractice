// tests/secret-box.test.ts — AES-256-GCM secret box round-trip + tamper detection.
// Pure (no DB / no network).
import { test, expect } from 'bun:test';
import {
  encryptSecret,
  decryptSecret,
  tryDecryptSecret,
} from '../src/host/secret-box';

test('encrypt → decrypt round-trips an api key', () => {
  const secret = 'sk-ant-abc123-DEF_456.ghi';
  const blob = encryptSecret(secret);
  expect(blob).not.toContain(secret); // ciphertext, not plaintext
  expect(decryptSecret(blob)).toBe(secret);
});

test('each encryption uses a fresh IV (ciphertexts differ, both decrypt)', () => {
  const a = encryptSecret('same');
  const b = encryptSecret('same');
  expect(a).not.toBe(b);
  expect(decryptSecret(a)).toBe('same');
  expect(decryptSecret(b)).toBe('same');
});

test('round-trips unicode + empty string', () => {
  for (const s of ['', '日本語キー', 'مفتاح', '🔑emoji']) {
    expect(decryptSecret(encryptSecret(s))).toBe(s);
  }
});

test('a tampered ciphertext fails the GCM tag (throws)', () => {
  const blob = encryptSecret('topsecret');
  const buf = Buffer.from(blob, 'base64');
  buf[buf.length - 1] = (buf[buf.length - 1] ?? 0) ^ 0xff; // flip a ciphertext byte
  const tampered = buf.toString('base64');
  expect(() => decryptSecret(tampered)).toThrow();
});

test('tryDecryptSecret returns null on garbage/null instead of throwing', () => {
  expect(tryDecryptSecret(null)).toBeNull();
  expect(tryDecryptSecret(undefined)).toBeNull();
  expect(tryDecryptSecret('not-a-real-blob')).toBeNull();
  // a valid blob still decrypts
  expect(tryDecryptSecret(encryptSecret('ok'))).toBe('ok');
});
