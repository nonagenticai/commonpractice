// src/lib/i18n/notification-label.ts — the ONE place an in-app notification becomes words a reader
// can read.
//
// ⛔ THE DEFECT. `NotificationBell.svelte` rendered `{n.title}` and `{n.body}` verbatim, and
// `backend/src/routes/notifications.ts` `toView` passed both straight through with no locale
// negotiation at all (contrast `routes/marketplace-summary.ts` and `routes/blocks.ts`, which both
// negotiate). Those sentences are composed in `backend/src/host/budget-service.ts` `alertCopy` as
// ENGLISH — "90% of the welcome budget used", "$4.10 of the $50.00 welcome budget for Acme is
// left." They sat inside a fully localized Dutch panel, under a Dutch heading, beside a Dutch
// "Alles als gelezen markeren".
//
// ⚠️ AND THE SHARPEST EDGE IS NOT THE PROSE — IT IS THE BREADCRUMB. Every one of the three bodies
// ends by telling the reader to "open Administer → LLM settings". The sidebar four inches to the
// left renders those exact two labels from `nav_group_administer` / `nav_llm_settings`, so a Dutch
// reader was pointed at "Administer → LLM settings" while the menu in front of them said
// "Beheren → LLM-instellingen". An English instruction naming menu items that are not on the
// screen is worse than English prose: it is a wrong instruction. `budgetHowTo` below therefore
// composes that sentence from the SAME two nav keys the sidebar renders, so the two cannot drift.
//
// The wire now carries the KIND plus machine fields (`threshold`, `tenantName`, `limitUsd`,
// `remainingUsd`, in `notifications.data` — migration 0066); the browser owns the words. Same split
// as `ops-alert-label.ts` (#244), `stage-label.ts` and `data-finding-label.ts`.
//
// EXHAUSTIVE SWITCH, NOT A LOOKUP TABLE. Paraglide compiles ONE function per message key and
// tree-shakes on the import graph, so `m[`notification_${kind}_title`]()` does not resolve — there
// is no runtime object to index. The explicit switch is the house idiom, not a workaround.
//
// ⛔ THE FALLBACK IS THREE-BRANCH, AND THE MIDDLE BRANCH IS LOAD-BEARING.
//   kind known + its machine fields present → the catalog message   (the normal path)
//   kind known, machine fields MISSING      → `n.title` / `n.body`  (see below — TWO causes)
//   kind absent or UNRECOGNISED             → `n.title` / `n.body`  (a backend-first alert kind)
//
// The middle branch has one cause `ops-alert-label.ts` also has and one it does not:
//   1. The browser reaches the API through the k8s SERVICE, which load-balances across old and new
//      pods for the length of a rolling deploy, so a NEW frontend really is answered by an OLD pod
//      whose rows carry prose and nothing else. That exact hazard blanked /governance and was
//      caught only at review in PR #233.
//   2. ⛔ AND UNLIKE /it-dash, IT NEVER GOES AWAY. /it-dash recomputes its payload on every
//      request, so one deploy later every alert has machine fields. A notification is a stored ROW:
//      every row inserted before 0066 has `data IS NULL` for as long as it exists, and there is
//      nothing to backfill it from (`remainingUsd` came from a live OpenRouter response at alert
//      time). The feed keeps 30 rows; a workspace alerted last month reads its history through this
//      branch forever. It is not transitional and must never be deleted as "one deploy of debt".
//
// ⚠️ THE FALLBACK IS PROSE, NOT THE RAW KIND — deliberately unlike `complianceLabel`, which returns
// the raw key. That panel is a fixed four-row display where an unknown key can only be a build
// defect. THIS IS AN ALERTING SURFACE: a row degrading to a bare `budget.threshold` token tells the
// reader nothing they can act on, while the English sentence tells them everything except in their
// own language. Same rule `ops-alert-label.ts` and `data-finding-label.ts` follow.
//
// ⛔ EVERY PRESENCE CHECK IS `== null` / `=== undefined`, NEVER TRUTHINESS. `remainingUsd` is `0`
// at the 100 % rung — that is not a missing value, it is the entire point of that alert — and
// `threshold` and `limitUsd` are numbers a `!x` guard would also mishandle. A truthiness check
// would drop precisely the most urgent notification CP sends into the English branch.
import * as m from '$lib/paraglide/messages';
import { llmSettingsPath } from './llm-settings-path';
import { usd } from '$lib/utils/format';
import type { AppNotification, AppNotificationProse } from '$lib/types/admin';

/**
 * "Open Beheren → LLM-instellingen and …" — the call to action every budget rung ends with.
 *
 * ⚠️ THE TWO NAV LABELS ARE PASSED IN AS PARAMETERS, not baked into eight translations. They are
 * the SAME message keys `Sidebar.svelte` renders, which is the only way a translator reworking the
 * menu cannot leave this sentence pointing at a label that no longer exists. The connector between
 * them ("→", "←", a comma) belongs to each catalog, because ar and he set it right-to-left.
 *
 * ⛔ THIS DELIBERATELY DIVERGES FROM `blockresult_errkind_budget_exhausted`, the one existing key
 * that names the same path, and it diverges because that key has ALREADY DRIFTED — measured, not
 * feared. It spells the path out inside each catalog, and in `ar.json` it reads
 * "إدارة ← إعدادات النماذج" while the sidebar renders `nav_group_administer` = "الإدارة" and
 * `nav_llm_settings` = "إعدادات LLM". An Arabic reader is sent to two menu items that do not exist
 * under those names. de and nl happen to still agree; nothing keeps them agreeing. That is the
 * failure mode this file is fixing, so copying its shape here would have shipped it again.
 */
function budgetHowTo(): string {
	return m.notification_budget_how_to({ path: llmSettingsPath() });
}

/**
 * ⚠️ COMPOSED IN CODE WITH A SPACE, not folded into each rung's message key.
 *
 * The backend does exactly this (`… ${howTo}` in all three arms of `alertCopy`), and the
 * alternative is worse: three catalog entries × eight locales would each carry their own copy of
 * the same call-to-action, twenty-four strings that must be kept identical by hand and will not be.
 * Two complete sentences joined by a space reorder correctly under bidi; nothing here is a
 * fragment. Same call `opsAlertDetail` makes for its owner list.
 */
function sentences(...parts: string[]): string {
	return parts.join(' ');
}

/** The notification's headline. */
export function notificationTitle(n: AppNotification): string {
	switch (n.kind) {
		case 'budget.threshold': {
			const t = n.data?.threshold;
			if (t == null) return n.title;
			// The SAME ladder `alertCopy` runs, on the same value, so the two sides cannot disagree
			// about which of the three things is being said. `>= 100` rather than `=== 100` because
			// the backend's top rung is tied to actual exhaustion, not to a rounded 100.
			if (t >= 100) return m.notification_budget_used_up_title();
			// ⚠️ ONE key with `{pct}` interpolated, not one key per rung. `ALERT_THRESHOLDS` is
			// `[75, 90, 100]` today and is a backend constant that can gain a rung; a hard-coded
			// `notification_budget_75_title` would render a new rung as the wrong number, which is a
			// worse failure than English. The number itself is not translated — it is the datum.
			return m.notification_budget_threshold_title({ pct: t });
		}
		default:
			// `n` narrows to `never`: the union is exhaustive by construction. A kind added
			// backend-first is nonetheless a REAL wire shape, so widen and read the prose.
			return (n as AppNotificationProse).title;
	}
}

/**
 * The notification's supporting line, or `null` when there is none.
 *
 * Returns `n.body` unchanged — including its `null` — on every fallback path, so the bell's
 * `{#if body}` keeps behaving exactly as it did.
 *
 * ⛔ `locale` IS A PARAMETER BECAUSE THIS IS A PLAIN `.ts` MODULE. It cannot import
 * `$lib/stores/locale.svelte` — reading a `$state` rune from a plain module binds every importer,
 * including this file's two pure-logic specs, to the Svelte runtime. `ops-alert-label.ts:66-74`
 * solved exactly this: the module takes the tag and the COMPONENT passes `locale.current` from its
 * template, where the rune is in scope and the read is reactive.
 *
 * ⚠️ `notificationTitle` deliberately does NOT take one — it interpolates a threshold percentage and
 * no money, so a locale parameter there would be a lie about what the function depends on.
 */
export function notificationBody(n: AppNotification, locale: string): string | null {
	switch (n.kind) {
		case 'budget.threshold': {
			const d = n.data;
			// ⛔ ALL THREE OF THESE ARE INTERPOLATED INTO EVERY RUNG'S SENTENCE, so a payload carrying
			// only some of them is a partial roll-out, not a usable message. Interpolating an absent
			// field would print "undefined of $50.00 is left" — a localized sentence that says LESS
			// than the English one it replaced.
			if (d?.threshold == null || d.limitUsd == null || d.tenantName == null) return n.body;
			if (d.threshold >= 100) {
				// The exhausted rung does not name the remainder: it is zero by definition, and
				// "$0.00 is left" reads as a rounding artefact rather than as a stop.
				return sentences(
					m.notification_budget_used_up_body({
						limit: usd(d.limitUsd, locale),
						tenant: d.tenantName
					}),
					budgetHowTo()
				);
			}
			// Below the top rung the remainder IS the message, so its absence is a fallback — checked
			// here and not above, because the 100 % arm genuinely does not need it.
			if (d.remainingUsd == null) return n.body;
			const money = {
				remaining: usd(d.remainingUsd, locale),
				limit: usd(d.limitUsd, locale),
				tenant: d.tenantName
			};
			// ⚠️ The 90 and 75 rungs differ by more than a number, which is why `{pct}` cannot collapse
			// them into one key: 90 says model calls STOP when it reaches zero, 75 says nothing is
			// blocked yet. Merging them would tell a tenant at 75 % that their flows are about to die.
			return sentences(
				d.threshold >= 90
					? m.notification_budget_low_body(money)
					: m.notification_budget_heads_up_body(money),
				budgetHowTo()
			);
		}
		default:
			return (n as AppNotificationProse).body;
	}
}
