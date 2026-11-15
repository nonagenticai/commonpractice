// src/lib/early-access/notice.ts — the public early-access notice at /early-access.
//
// Owner decision (2026-10-15): no full legal documents during early access, only this short notice.
// The drafts of the Terms, Privacy Notice and DPA are kept in docs/legal-drafts/ and are NOT served.
//
// The text lives here, not in messages/*.json: it is a statement the owner approved word for word,
// in exactly two languages. Dutch readers get Dutch, every other locale gets English.
export type NoticeLanguage = 'en' | 'nl';

export interface EarlyAccessNotice {
	title: string;
	paragraphs: string[];
	contactLabel: string;
	back: string;
}

export const CONTACT_EMAIL = 'george@nonagentic.ai';

export const EARLY_ACCESS_NOTICE: Record<NoticeLanguage, EarlyAccessNotice> = {
	en: {
		title: 'CommonPractice is in early access',
		paragraphs: [
			'CommonPractice is provided as-is and free of charge during early access. There is no service level: the service may be unavailable at times.',
			'Features may change or be removed while we develop the product.',
			"Your organisation's data is hosted in the EU, in Germany. The AI runs on nonagentic.ai's own hardware in the Netherlands, unless your organisation adds its own provider key. In that case, that provider processes the requests sent to it.",
			'Full terms of service will follow.'
		],
		contactLabel: 'Questions or requests:',
		back: 'Back to CommonPractice'
	},
	nl: {
		title: 'CommonPractice is in early access',
		paragraphs: [
			'Tijdens de early access wordt CommonPractice gratis en in de huidige staat aangeboden. Er geldt geen serviceniveau: de dienst kan soms niet beschikbaar zijn.',
			'Functies kunnen veranderen of verdwijnen terwijl we het product ontwikkelen.',
			'De gegevens van je organisatie worden in de EU opgeslagen, in Duitsland. De AI draait op eigen hardware van nonagentic.ai in Nederland, tenzij je organisatie een eigen sleutel van een AI-aanbieder toevoegt. Dan verwerkt die aanbieder de verzoeken die naar hem gaan.',
			'Volledige gebruiksvoorwaarden volgen.'
		],
		contactLabel: 'Vragen of verzoeken:',
		back: 'Terug naar CommonPractice'
	}
};

/** Dutch for a Dutch UI locale (`nl`, `nl-BE`, …); English for every other locale. */
export function noticeLanguageFor(locale: string | null | undefined): NoticeLanguage {
	return (locale ?? '').toLowerCase().split('-')[0] === 'nl' ? 'nl' : 'en';
}

export const EARLY_ACCESS_PATH = '/early-access';

/** Public paths render without signing in: no Keycloak redirect, no app shell. */
export function isPublicPath(pathname: string): boolean {
	return pathname === EARLY_ACCESS_PATH || pathname.startsWith(`${EARLY_ACCESS_PATH}/`);
}
