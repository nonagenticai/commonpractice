// tests/config-no-provider-keys.test.ts — CP reads NO commercial-provider credential from env.
//
// ⛔ OWNER RULE (2026-10-13): "commonpractice SIMPLY does NOT CONTAIN any api tokens in its gitops
// files." A commercial model is reached only with the TENANT's own key (stored encrypted per tenant);
// the platform's own inference is the in-cluster router with a router token. OPENAI_API_KEY,
// ANTHROPIC_API_KEY and OPENROUTER_MANAGEMENT_KEY were deleted from config for that reason. This
// scrape makes re-adding one (or a sibling vendor's) a red test instead of a quiet diff.
//
// It reads SOURCE TEXT on purpose: an env var nobody sets is invisible at runtime, which is exactly
// how a fallback key creeps back in unnoticed until someone fills it in gitops.
import { test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');
export const PROVIDER_CREDENTIAL_ENV =
  /(OPENAI|ANTHROPIC|OPENROUTER|DEEPSEEK|COHERE|XAI|GROK|GEMINI|MISTRAL)_.*(KEY|TOKEN)/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Every env var name read in `text`: `process.env.X`, `process.env['X']`, `Bun.env.X`, `env.X` destructures aside. */
export function envReads(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/\b(?:process|Bun)\.env\.([A-Z0-9_]+)/g)) names.push(m[1]!);
  for (const m of text.matchAll(/\b(?:process|Bun)\.env\[\s*['"`]([A-Z0-9_]+)['"`]\s*\]/g)) names.push(m[1]!);
  return names;
}

test('the scrape is not vacuous: it sees env reads, and the pattern catches the deleted keys', () => {
  const all = tsFiles(SRC).flatMap((f) => envReads(readFileSync(f, 'utf-8')));
  expect(all.length).toBeGreaterThan(50);
  expect(all).toContain('OPENAI_BASE_URL'); // the router url stays, and is not a credential
  for (const deleted of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_MANAGEMENT_KEY', 'GEMINI_API_TOKEN']) {
    expect(PROVIDER_CREDENTIAL_ENV.test(deleted)).toBe(true);
  }
  expect(PROVIDER_CREDENTIAL_ENV.test('OPENAI_BASE_URL')).toBe(false);
  expect(envReads("process.env.OPENAI_API_KEY || process.env['ANTHROPIC_API_KEY']")).toEqual([
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
  ]);
});

test('no backend source reads a commercial-provider KEY/TOKEN env var', () => {
  const offenders: string[] = [];
  for (const f of tsFiles(SRC)) {
    for (const name of envReads(readFileSync(f, 'utf-8'))) {
      if (PROVIDER_CREDENTIAL_ENV.test(name)) offenders.push(`${relative(SRC, f)}: ${name}`);
    }
  }
  expect(
    offenders,
    'CP must hold no commercial provider credential (owner rule 2026-10-13). A commercial model is ' +
      'called with the TENANT’s own key; platform inference is the router with a router token.',
  ).toEqual([]);
});
