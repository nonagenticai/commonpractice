// src/host/secret-box.ts — symmetric encryption for secrets at rest (Session 7).
// Per-tenant BYO provider keys are stored in tenant_llm_settings.api_key_encrypted
// and NEVER leave the host: the broker decrypts only at call time (select.ts), the
// write path encrypts (routes/llm-settings.ts), and the plaintext key is never
// returned to a client. AES-256-GCM (authenticated) via node:crypto — Bun ships the
// full node:crypto surface.
//
// Wire format (base64): iv(12) | tag(16) | ciphertext. A versionless v1 box; if we
// ever rotate the scheme, prefix a byte. The master key comes from config.secrets
// (CP_SECRET_KEY); a 32-byte base64/hex value is used directly, anything else is
// scrypt-derived to 32 bytes so a human passphrase also works in dev.
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { config } from '../config';
import { log } from './logger';

const IV_LEN = 12; // GCM standard nonce
const TAG_LEN = 16;
// Static derivation salt: the master key already carries the entropy; the salt only
// needs to be stable + app-specific so the same passphrase always yields the same key.
const KDF_SALT = Buffer.from('commonpractice/secret-box/v1');

let cachedKey: Buffer | null = null;
let cachedFrom: string | null = null;
let warnedScrypt = false;

/** Resolve the 32-byte AES key from config.secrets.masterKey. A value that decodes
 *  to exactly 32 bytes (base64 or hex) is used verbatim; otherwise it is treated as
 *  a passphrase and scrypt-derived. Cached per master-key string. */
function masterKey(): Buffer {
  const raw = config.secrets.masterKey;
  if (cachedKey && cachedFrom === raw) return cachedKey;

  let key: Buffer | null = null;
  // hex (64 chars) → 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    // base64 / base64url → exactly 32 bytes?
    const b64 = Buffer.from(raw, 'base64');
    if (b64.length === 32) key = b64;
  }
  if (!key) {
    // Passphrase path: stretch via scrypt. Deterministic + lower-entropy than a real
    // 32-byte key — fine for dev, warned once so operators notice it in any env. Prod
    // rejects a too-short master key up front (config.validateProductionConfig).
    if (!warnedScrypt) {
      warnedScrypt = true;
      log.warn('secret_box_key_not_32_bytes_scrypt_fallback', { component: 'secret-box' });
    }
    key = scryptSync(raw, KDF_SALT, 32);
  }

  cachedKey = key;
  cachedFrom = raw;
  return key;
}

/** Encrypt a UTF-8 secret → base64(iv|tag|ciphertext). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Decrypt a base64(iv|tag|ciphertext) blob produced by encryptSecret. Throws on a
 *  tampered/garbage blob or a wrong master key (GCM tag verification fails). */
export function decryptSecret(blob: string): string {
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error('secret-box: ciphertext too short');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Best-effort decrypt: returns null instead of throwing (used by the broker so a
 *  corrupt/legacy row degrades to the stub rather than failing the chat turn). */
export function tryDecryptSecret(blob: string | null | undefined): string | null {
  if (!blob) return null;
  try {
    return decryptSecret(blob);
  } catch {
    return null;
  }
}
