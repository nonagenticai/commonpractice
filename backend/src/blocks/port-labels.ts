// src/blocks/port-labels.ts — the localized label for each input/output (port) of a block.
//
// SAME MECHANISM AS THE BLOCK'S OWN PROSE: `content_translations`, keyed by block OWNERSHIP
// (blocks/i18n-key.ts — global blocks by bare slug, tenant blocks by `tenantId:slug`), so one
// tenant's labels can never surface on another tenant's block of the same slug.
//
// ⛔ A SEPARATE entity_type (`block_port` / `block_port_tenant`), NOT extra fields on `block`.
// Port labels carry an `en` row (the seeded catalogue's English labels live nowhere else — prod's
// descriptors are published block_versions and are not rewritten to add them), while the `block`
// entity is documented and guarded to have NO `en` rows (i18n-key.ts, block-i18n-coverage.test.ts).
// A separate type keeps both invariants true and keeps the block translation queue/editor, which
// work on `block`, from seeing ports.
//
// Field name: `in.<key>` / `out.<key>` — an input and an output may share a key (`rows`) and mean
// different things.
//
// Resolution per port: reader's locale row → the descriptor's own `label` (what the block author
// wrote) → the `en` row → nothing (the frontend humanizes the key, port-label.ts).
import { and, eq, inArray } from 'drizzle-orm';
import { db as defaultDb, contentTranslations } from '../db/client';
import type { BlockDescriptor } from '../db/block-types';
import { DEFAULT_LOCALE } from '../utils/locale';
import { tenantBlockI18nId } from './i18n-key';

export const BLOCK_PORT_I18N = 'block_port';
export const BLOCK_PORT_TENANT_I18N = 'block_port_tenant';

export type PortDirection = 'in' | 'out';

export function portField(dir: PortDirection, key: string): string {
  return `${dir}.${key}`;
}

/** (entity_type, entity_id) for a block's port labels — derived from the BLOCK ROW's ownership. */
export function blockPortI18nKey(block: { tenant_id: string | null; slug: string }): {
  entityType: string;
  entityId: string;
} {
  return block.tenant_id === null
    ? { entityType: BLOCK_PORT_I18N, entityId: block.slug }
    : { entityType: BLOCK_PORT_TENANT_I18N, entityId: tenantBlockI18nId(block.tenant_id, block.slug) };
}

export interface PortLabels {
  inputs: Record<string, string>;
  outputs: Record<string, string>;
}

type Db = typeof defaultDb;

/**
 * Resolve the label of every port of a block for `locale`.
 *
 * `current` is the descriptor of the version the reader is served (the block's current/published
 * version — the one the route and /build treat as current). ONLY its `label`s count as the author's
 * label: scanning all versions let a DRAFT's label override the published one for every reader, and
 * let a label the author removed in a newer version come back from an older one.
 *
 * `others` are the remaining versions' descriptors. They contribute port KEYS only (a flow may pin an
 * older version whose ports differ), so those ports can still get a translated label — never an
 * author label. Ports with no label anywhere are omitted: the client humanizes the key.
 */
export async function resolvePortLabels(
  block: { tenant_id: string | null; slug: string },
  current: BlockDescriptor | null | undefined,
  others: (BlockDescriptor | null | undefined)[],
  locale: string,
  db: Db = defaultDb,
): Promise<PortLabels> {
  const out: PortLabels = { inputs: {}, outputs: {} };
  const authored: Record<PortDirection, Map<string, string | undefined>> = { in: new Map(), out: new Map() };
  const addKeys = (d: BlockDescriptor | null | undefined, withLabels: boolean) => {
    if (!d) return;
    for (const [dir, specs] of [['in', d.inputs], ['out', d.outputs]] as const) {
      for (const [key, spec] of Object.entries(specs ?? {})) {
        const label =
          withLabels && typeof spec?.label === 'string' && spec.label.trim() !== '' ? spec.label.trim() : undefined;
        if (withLabels || !authored[dir].has(key)) authored[dir].set(key, label);
      }
    }
  };
  addKeys(current, true);
  for (const d of others) if (d !== current) addKeys(d, false);
  const fields = [
    ...[...authored.in.keys()].map((k) => portField('in', k)),
    ...[...authored.out.keys()].map((k) => portField('out', k)),
  ];
  if (fields.length === 0) return out;

  const { entityType, entityId } = blockPortI18nKey(block);
  const locales = locale === DEFAULT_LOCALE ? [DEFAULT_LOCALE] : [locale, DEFAULT_LOCALE];
  const rows = await db
    .select({ locale: contentTranslations.locale, field: contentTranslations.field, value: contentTranslations.value })
    .from(contentTranslations)
    .where(
      and(
        eq(contentTranslations.entity_type, entityType),
        eq(contentTranslations.entity_id, entityId),
        inArray(contentTranslations.locale, locales),
        inArray(contentTranslations.field, fields),
      ),
    );
  const byLocale = new Map<string, Map<string, string>>();
  for (const r of rows) {
    if (r.value.trim() === '') continue;
    const m = byLocale.get(r.locale) ?? new Map<string, string>();
    m.set(r.field, r.value);
    byLocale.set(r.locale, m);
  }

  for (const dir of ['in', 'out'] as const) {
    const target = dir === 'in' ? out.inputs : out.outputs;
    for (const [key, authoredLabel] of authored[dir]) {
      const f = portField(dir, key);
      const label = byLocale.get(locale)?.get(f) ?? authoredLabel ?? byLocale.get(DEFAULT_LOCALE)?.get(f);
      if (label !== undefined) target[key] = label;
    }
  }
  return out;
}
