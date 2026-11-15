// src/templates/i18n-docs.ts — the ONE renderer for a template's `docs_md`, in any locale.
//
// ⛔ THIS IS THE SINGLE IMPLEMENTATION, DELIBERATELY. Three callers need the identical markdown
// shape and would otherwise drift apart:
//   1. db/seed-templates.ts `renderDocs()` — the English base column, on every fresh database;
//   2. scripts/gen-template-i18n.ts — the 7 localized `docs_md` cells baked into 0079;
//   3. (2) again on a fresh developer DB, via seed-templates.ts' i18n seed path.
// If (1) and (2) rendered separately, a change to the heading level or the step numbering would
// silently make every non-`en` reader's document a different SHAPE from the English one — the kind
// of divergence nothing fails on and nobody reviews. `renderDocs` in seed-templates.ts is now a
// thin wrapper over `renderDocsWithHeadings` with the English headings, so the two cannot diverge.
//
// The BODY (description / preconditions / steps / postconditions) is supplied by the caller — it
// comes from `src/templates/seed/*.json` for `en` and from `src/templates/seed/i18n/<locale>.json`
// for the rest. Only the three structural HEADINGS live here.
import type { TemplateStep } from '../db/schema';
import { DEFAULT_LOCALE, type Locale } from '../utils/locale';

export interface DocsHeadings {
  preconditions: string;
  steps: string;
  postconditions: string;
}

/**
 * The `##` headings, per locale.
 *
 * ⛔ NOT INVENTED HERE. Each value is carried verbatim from the reviewed frontend message catalog
 * (`frontend/messages/<locale>.json`), keys `blockedit_savetpl_pre_label`,
 * `blockedit_savetpl_steps_label` and `blockedit_savetpl_post_label` — the labels the "Save as
 * template" form already shows over these very three lists. Reusing them means a reader sees the
 * SAME word on the form that authored the section and in the document that renders it, and it
 * keeps three more strings out of the machine-translated set.
 *
 * A backend module cannot import from `frontend/` at runtime (the backend image does not ship it),
 * so the values are copied rather than read. `tests/template-i18n.test.ts` pins them against the
 * frontend catalogs so a change there is not silently lost here.
 */
export const DOCS_HEADINGS: Record<Locale, DocsHeadings> = {
  en: { preconditions: 'Preconditions', steps: 'Steps', postconditions: 'Postconditions' },
  nl: { preconditions: 'Voorwaarden vooraf', steps: 'Stappen', postconditions: 'Voorwaarden achteraf' },
  de: { preconditions: 'Vorbedingungen', steps: 'Schritte', postconditions: 'Nachbedingungen' },
  fr: { preconditions: 'Préconditions', steps: 'Étapes', postconditions: 'Postconditions' },
  es: { preconditions: 'Precondiciones', steps: 'Pasos', postconditions: 'Poscondiciones' },
  pl: { preconditions: 'Warunki wstępne', steps: 'Kroki', postconditions: 'Warunki końcowe' },
  ar: { preconditions: 'الشروط المسبقة', steps: 'الخطوات', postconditions: 'الشروط اللاحقة' },
  he: { preconditions: 'תנאים מקדימים', steps: 'צעדים', postconditions: 'תנאים אחריים' },
};

/** The prose a template document is rendered from — the same fields in every locale. */
export interface DocsParts {
  label: string;
  description?: string;
  preconditions?: string[];
  postconditions?: string[];
  steps?: TemplateStep[];
}

/** Render `docs_md` from the declarative fields, with the supplied headings. */
export function renderDocsWithHeadings(t: DocsParts, h: DocsHeadings): string {
  const L: string[] = [`# ${t.label}`, '', t.description ?? '', ''];
  if (t.preconditions?.length) {
    L.push(`## ${h.preconditions}`, '');
    t.preconditions.forEach((p) => L.push(`- ${p}`));
    L.push('');
  }
  if (t.steps?.length) {
    L.push(`## ${h.steps}`, '');
    t.steps.forEach((s, i) => L.push(`${i + 1}. **${s.label}** — ${s.detail}`));
    L.push('');
  }
  if (t.postconditions?.length) {
    L.push(`## ${h.postconditions}`, '');
    t.postconditions.forEach((p) => L.push(`- ${p}`));
    L.push('');
  }
  return L.join('\n');
}

/** Render `docs_md` for one locale (headings localized, body supplied already localized). */
export function renderLocalizedDocs(t: DocsParts, locale: Locale): string {
  return renderDocsWithHeadings(t, DOCS_HEADINGS[locale] ?? DOCS_HEADINGS[DEFAULT_LOCALE]);
}
