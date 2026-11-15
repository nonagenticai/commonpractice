// src/lib/i18n/llm-settings-path.ts — the menu path to the LLM settings page, built from the SAME
// keys the shell renders, so a copy change to the menu cannot leave a sentence pointing at a label
// that no longer exists.
//
// ⛔ WHY THIS EXISTS. Five sentences (the budget notification, the run/chat budget refusal and the
// two BYO-key refusals) used to spell the path out inside each catalog — "Administer → LLM
// settings" — and the menu moved under it: the sidebar no longer has an Administer group, the page
// lives at Settings (gear) → Organisation → LLM settings. Each piece below is the label the reader
// actually sees: `nav_settings` on the gear (`SettingsNavLink.svelte`), `settings_group_organisation`
// on the settings page's group (`navConfig.ts` settings groups), `nav_llm_settings` on the item.
// The connector ("→", or "←" in ar/he) belongs to each catalog (`settings_path_llm`).
import * as m from '$lib/paraglide/messages';

export function llmSettingsPath(): string {
	return m.settings_path_llm({
		settings: m.nav_settings(),
		group: m.settings_group_organisation(),
		page: m.nav_llm_settings()
	});
}
