// The OpenRouter welcome budget is RETIRED (backend migration 0099). Copy that still promises it —
// the LLM-access posture help on the tenant forms said "including any welcome budget" — tells an
// operator about money the platform no longer grants. This pins its absence in every locale.
//
// ⚠️ The legacy `notification_budget_*` keys are deliberately NOT checked: they render alert rows
// written before the retirement, which really were about a welcome budget.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LOCALES = ['en', 'nl', 'de', 'fr', 'es', 'pl', 'ar', 'he'] as const;
/** How each catalog words "welcome budget" (measured from the catalogs before the retirement). */
const TERM: Record<(typeof LOCALES)[number], RegExp> = {
	en: /welcome budget/i,
	nl: /welkomstbudget/i,
	de: /willkommensbudget/i,
	fr: /budget de bienvenue/i,
	es: /presupuesto de bienvenida/i,
	pl: /powitaln\w* budżet/i,
	ar: /ميزانية ترحيبية|الميزانية الترحيبية/,
	he: /תקציב פתיחה/
};
const KEYS = [
	'admin_tenants_byo_help_byo_required',
	'admin_tenants_byo_help_local_allowed',
	'admin_tenants_byo_help_platform_only',
	'policy_desc_models_work_tiers'
];

describe('no live copy mentions the retired welcome budget', () => {
	for (const loc of LOCALES) {
		it(`${loc}: posture help and the work-tier description`, () => {
			const cat = JSON.parse(
				readFileSync(fileURLToPath(new URL(`../../../messages/${loc}.json`, import.meta.url)), 'utf8')
			) as Record<string, string>;
			for (const k of KEYS) {
				expect(typeof cat[k], `${loc}.${k} exists`).toBe('string');
				expect(cat[k], `${loc}.${k}`).not.toMatch(TERM[loc]);
			}
		});
	}
});

// The legacy budget alert rows above still RENDER (old bells), so their keys stay — but their call to
// action must not send a reader to a provider the platform no longer brokers a key for. CP holds no
// OpenRouter credential (owner rule 2026-10-13); the instruction is "add your own provider key".
describe('the legacy budget alert call to action names no specific provider', () => {
	for (const loc of LOCALES) {
		it(`${loc}: notification_budget_how_to`, () => {
			const cat = JSON.parse(
				readFileSync(fileURLToPath(new URL(`../../../messages/${loc}.json`, import.meta.url)), 'utf8')
			) as Record<string, string>;
			const v = cat.notification_budget_how_to;
			expect(typeof v, `${loc}.notification_budget_how_to exists`).toBe('string');
			expect(v, `${loc}.notification_budget_how_to`).not.toMatch(/openrouter/i);
			// The menu path survives the rewording as ONE placeholder (notification-label.ts passes the
			// Settings → Organisation → LLM settings path from llm-settings-path.ts).
			expect(v).toContain('{path}');
		});
	}
});
