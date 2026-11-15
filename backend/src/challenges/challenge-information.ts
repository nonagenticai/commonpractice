// src/challenges/challenge-information.ts — "Information involved" on a challenge (W8/P1): the
// types of information (ontology entities) a challenge is about, as plain cards a member can read —
// localized name + description, never a key or a slug.
//
// READ-ONLY over the ontology. Nothing here writes an ontology row; admin ontology control
// (requireOntologyManager, routes/ontology.ts) is untouched.
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  db as defaultDb,
  challenges,
  challengeDatasets,
  challengeEntities,
  tenants,
  datasets,
  datasetMappings,
  ontologyEntities,
} from '../db/client';
import {
  compileEffective,
  entityKey,
  localizeEntityLabels,
  resolveCell,
} from '../ontology/ontology-service';
import { hasTenantAdmin } from '../middleware/admin-guards';
import { badRequest, notFound } from '../utils/http';
import { brokerChatCall } from '../host/llm-broker';
import { config } from '../config';
import { log } from '../host/logger';
import type { User } from '../types';

type Db = typeof defaultDb;

/** One "type of information" card. `id` is the entity id the picker sends back; it is never shown. */
export interface InformationCard {
  id: string;
  label: string;
  description: string | null;
}

/** A card plus where it came from: `linked` = the creator linked it directly (P2, editable);
 *  otherwise it was reached through the challenge's sample data (read-only here). */
export interface ChallengeInformationCard extends InformationCard {
  linked: boolean;
}

/** One choice in the picker: a card plus the synonyms the search also matches. */
export interface InformationOption extends InformationCard {
  synonyms: string[];
}

/** Most links one challenge may carry. */
export const MAX_CHALLENGE_ENTITIES = 30;

export interface ChallengeRef {
  id: string;
  tenant_id: string;
  submitter_id: string;
  work_area: string;
  title: string;
  description: string;
}

/** The challenge, only when it belongs to `tenantId` — else 404. The tenant predicate is explicit
 *  on top of RLS: tests and system paths run as the owner, which bypasses RLS. */
export async function challengeInTenant(
  challengeId: string,
  tenantId: string,
  database: Db = defaultDb,
): Promise<ChallengeRef> {
  const [c] = await database
    .select({
      id: challenges.id,
      tenant_id: challenges.tenant_id,
      submitter_id: challenges.submitter_id,
      work_area: challenges.work_area,
      title: challenges.title,
      description: challenges.description,
    })
    .from(challenges)
    .where(and(eq(challenges.id, challengeId), eq(challenges.tenant_id, tenantId)));
  if (!c || !c.tenant_id) throw notFound('challenge_not_found', `No challenge '${challengeId}'`);
  return c as ChallengeRef;
}

/** Who may change what a challenge links to (its sample data, its information): the creator, a
 *  tenant_admin or a super_admin (owner decision W8.4, 2026-10-14: "the creator + admins").
 *  ONE rule for both link kinds — the dataset-link PATCH uses it too, so widening it widened both.
 *  A `developer` is NOT an admin here: developers author blocks/ontology, they do not curate other
 *  people's challenges. The tenant is checked by the caller (`challengeInTenant` / RLS), so a
 *  tenant_admin of another tenant never reaches this predicate with this challenge. */
export function canEditChallengeLinks(user: User, submitterId: string): boolean {
  return user.id === submitterId || hasTenantAdmin(user);
}

/** Entity rows (visible to the tenant) → localized cards, in the order of `ids`. */
export async function cardsForEntityIds(
  ids: string[],
  tenantId: string,
  locale: string,
  database: Db = defaultDb,
): Promise<InformationCard[]> {
  if (!ids.length) return [];
  const rows = await database
    .select()
    .from(ontologyEntities)
    .where(
      and(
        inArray(ontologyEntities.id, ids),
        or(isNull(ontologyEntities.tenant_id), eq(ontologyEntities.tenant_id, tenantId)),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  // One card per natural key: a global entity and this tenant's override of it are one concept.
  const seenKeys = new Set<string>();
  const items = ids
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => {
      if (!r) return false;
      const k = entityKey(r);
      if (seenKeys.has(k)) return false;
      seenKeys.add(k);
      return true;
    })
    .map((r) => ({
      id: r.id,
      key: entityKey(r),
      tenantOwned: r.tenant_id !== null,
      label: r.label,
      description: r.description,
    }));
  await localizeEntityLabels(items, { locale, tenantId, database });
  return items.map(({ id, label, description }) => ({ id, label, description: description ?? null }));
}

/** Entity ids reached through the challenge's sample data: its linked datasets' CONFIRMED
 *  mappings (the same source as the "Involves" chips). First-seen order. */
export async function entityIdsFromChallengeData(
  challengeId: string,
  tenantId: string,
  database: Db = defaultDb,
): Promise<string[]> {
  const rows = await database
    .select({ entityId: datasetMappings.entity_id, linkedAt: challengeDatasets.created_at })
    .from(challengeDatasets)
    .innerJoin(
      datasets,
      and(eq(datasets.slug, challengeDatasets.dataset_slug), eq(datasets.tenant_id, tenantId)),
    )
    .innerJoin(datasetMappings, eq(datasetMappings.dataset_id, datasets.id))
    .where(
      and(
        eq(challengeDatasets.challenge_id, challengeId),
        eq(datasetMappings.confirmed, true),
        or(isNull(datasetMappings.tenant_id), eq(datasetMappings.tenant_id, tenantId)),
      ),
    )
    .orderBy(challengeDatasets.created_at);
  return [...new Set(rows.map((r) => r.entityId))];
}

/** Entity ids the creator linked directly (W8/P2), in link order. */
export async function linkedEntityIds(
  challengeId: string,
  tenantId: string,
  database: Db = defaultDb,
): Promise<string[]> {
  const rows = await database
    .select({ id: challengeEntities.entity_id })
    .from(challengeEntities)
    .where(and(eq(challengeEntities.challenge_id, challengeId), eq(challengeEntities.tenant_id, tenantId)))
    .orderBy(challengeEntities.created_at, challengeEntities.entity_id);
  return rows.map((r) => r.id);
}

/** The challenge's "Information involved" cards: direct links first, then what its sample data's
 *  confirmed mappings add. One card per concept. */
export async function resolveChallengeInformation(
  challengeId: string,
  tenantId: string,
  locale: string,
  database: Db = defaultDb,
): Promise<ChallengeInformationCard[]> {
  const linked = await linkedEntityIds(challengeId, tenantId, database);
  const fromData = await entityIdsFromChallengeData(challengeId, tenantId, database);
  const linkedSet = new Set(linked);
  const ids = [...linked, ...fromData.filter((id) => !linkedSet.has(id))];
  const cards = await cardsForEntityIds(ids, tenantId, locale, database);
  return cards.map((c) => ({ ...c, linked: linkedSet.has(c.id) }));
}

/**
 * The ids from `ids` a challenge in `tenantId` may link: entities this tenant can see (global or
 * its own), not hidden by a tenant tombstone. Throws 400 naming none of them otherwise — the picker
 * only offers valid ids, so this is a stale page or a crafted request.
 */
export async function assertLinkableEntities(
  tenantId: string,
  ids: string[],
  database: Db = defaultDb,
): Promise<void> {
  if (!ids.length) return;
  const rows = await database
    .select({ id: ontologyEntities.id })
    .from(ontologyEntities)
    .where(
      and(
        inArray(ontologyEntities.id, ids),
        eq(ontologyEntities.hidden, false),
        or(isNull(ontologyEntities.tenant_id), eq(ontologyEntities.tenant_id, tenantId)),
      ),
    );
  const ok = new Set(rows.map((r) => r.id));
  if (ids.some((id) => !ok.has(id))) {
    throw badRequest('information_not_found', 'One of the chosen types of information no longer exists');
  }
}

/** Replace a challenge's direct links (whole set). Writes `challenge_entities` only — never the
 *  ontology. The caller has checked the tenant, the edit right and the ids. */
export async function replaceChallengeEntities(
  challenge: Pick<ChallengeRef, 'id' | 'tenant_id'>,
  ids: string[],
  userId: string,
  database: Db = defaultDb,
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx
      .delete(challengeEntities)
      .where(
        and(eq(challengeEntities.challenge_id, challenge.id), eq(challengeEntities.tenant_id, challenge.tenant_id)),
      );
    if (ids.length) {
      // One clock per statement would tie every created_at; stagger by position so the order the
      // creator chose is the order the card shows.
      const base = Date.now();
      await tx.insert(challengeEntities).values(
        ids.map((entity_id, i) => ({
          challenge_id: challenge.id,
          entity_id,
          tenant_id: challenge.tenant_id,
          created_by: userId,
          created_at: new Date(base + i),
        })),
      );
    }
  });
}

/** Dedupe, keeping first-seen order. */
export function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * The picker's choices for a challenge in `workArea`: the tenant's ontology for its industry and
 * the work area's department (the same cell the build agent reasons over), localized. Empty when
 * the tenant has no ontology for that cell.
 */
export async function informationOptions(
  tenantId: string,
  workArea: string | null,
  locale: string,
  database: Db = defaultDb,
): Promise<InformationOption[]> {
  const [t] = await database
    .select({ industry: tenants.industry })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  const cell = resolveCell(t?.industry ?? null, workArea);
  if (!cell.industry && !cell.department) return [];
  const compiled = await compileEffective(cell.industry ?? '', cell.department ?? '', {
    tenantId,
    locale,
    ...(database === defaultDb ? {} : { database }),
  });
  return compiled.entities
    .map((e) => ({ id: e.id, label: e.label, description: e.description, synonyms: e.synonyms }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));
}


// ---- W8/P3: AI suggestions ------------------------------------------------------------------------

/** How long a suggestion may take before the member just gets none. */
export const SUGGEST_TIMEOUT_MS = 20_000;
/** Most suggestions returned. */
const MAX_SUGGESTIONS = 5;

/**
 * Ask the tenant's AI which of `options` a challenge is about. The prompt carries ONLY the
 * challenge's title and description and the option NAMES — never sample data, never a value from
 * a dataset, never PII from the workspace's records. Goes through the metered broker
 * (`brokerChatCall`): the tenant's own AI settings, the allowlist, the daily call cap and the weekly
 * spend ceiling all apply exactly as for any other assistant call.
 *
 * Every failure — a broker refusal (budget, model), a timeout, prose instead of numbers — returns
 * `[]`: "no suggestions" is the whole degraded state, and the member can still pick by hand. It is
 * logged so a tenant whose budget ran out is visible to operators.
 */
export async function suggestInformation(args: {
  userId: string;
  tenantId: string;
  title: string;
  description: string;
  options: InformationOption[];
  signal?: AbortSignal;
}): Promise<string[]> {
  if (!args.options.length) return [];
  const list = args.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
  const system =
    'You decide which types of business information a workplace challenge is about. ' +
    'Reply with ONLY a JSON array of the numbers of the matching types, most relevant first, ' +
    `at most ${MAX_SUGGESTIONS}. Use only numbers from the list. Reply [] if none fit.`;
  const user =
    `Challenge title: ${args.title}\n` +
    `Challenge description: ${args.description}\n\n` +
    `Types of information:\n${list}\n\nReturn the JSON array.`;
  const signal = args.signal
    ? AbortSignal.any([args.signal, AbortSignal.timeout(SUGGEST_TIMEOUT_MS)])
    : AbortSignal.timeout(SUGGEST_TIMEOUT_MS);
  try {
    const outcome = await brokerChatCall(
      args.userId,
      args.tenantId,
      {
        model: config.agent.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
        maxTokens: 64,
      },
      { signal },
      { stage: 'challenge-information' },
    );
    if (!outcome.ok) {
      log.warn('information_suggest_failed', { kind: outcome.kind, error: outcome.error });
      return [];
    }
    const text = outcome.result.text ?? '';
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end < start) {
      log.warn('information_suggest_failed', { reason: 'unparseable_response', textPreview: text.slice(0, 200) });
      return [];
    }
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    const ids: string[] = [];
    for (const n of parsed) {
      const opt = typeof n === 'number' && Number.isInteger(n) ? args.options[n - 1] : undefined;
      if (opt && !ids.includes(opt.id)) ids.push(opt.id);
      if (ids.length >= MAX_SUGGESTIONS) break;
    }
    return ids;
  } catch (err) {
    log.warn('information_suggest_failed', { reason: 'error', err });
    return [];
  }
}
