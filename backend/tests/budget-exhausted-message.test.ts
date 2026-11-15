// tests/budget-exhausted-message.test.ts — DB-free. The English fallback a `budget_exhausted`
// refusal carries must name the menu path the shell actually shows.
//
// ⛔ THE DEFECT. The sentence said "Administer → LLM settings". The sidebar's Administer group was
// retired; LLM settings now lives behind the settings gear → Organisation. A reader following the
// sentence looked for a menu that does not exist. The frontend builds the same path from its own
// labels (`frontend/src/lib/i18n/llm-settings-path.ts`); this is the host's English copy of it.
import { test, expect } from 'bun:test';
import { BUDGET_EXHAUSTED_MESSAGE } from '../src/host/llm-broker';

test('names Settings → Organisation → LLM settings, not the retired Administer menu', () => {
  expect(BUDGET_EXHAUSTED_MESSAGE).toContain('Settings → Organisation → LLM settings');
  expect(BUDGET_EXHAUSTED_MESSAGE).not.toContain('Administer');
});
