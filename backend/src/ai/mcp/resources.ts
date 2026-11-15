// src/ai/mcp/resources.ts — the MCP "resources" knowledge surface (read-only,
// dynamic from the DB). Three URI schemes:
//   block://<slug>@<version>  → a block's descriptor (typed I/O) + docs
//   doc://book/<chapter>?lang= → getting-started / book content per locale. The 7
//                                non-en editions live in content_translations
//                                (migration 0010); en is the base text below.
//   data://<dataset>          → dataset schema/sample (thin: the mock-data kinds)
//   ontology://<industry>/<dept> → the compiled (industry × department) semantic graph
//                                  (entities + attributes + relations); 3.4. Global,
//                                  non-PII, read-only.
// resources/list + resources/read are computed at request time so new blocks appear
// with no redeploy.
import { and, desc, eq } from 'drizzle-orm';
import { db as defaultDb, datasets } from '../../db/client';
import { searchBlocks, getBlockDetail } from '../block-catalog-service';
import { schemaForAi } from '../../datasets/dataset-service';
import { compileEffective, listMatrix } from '../../ontology/ontology-service';
import { getTranslation } from '../../db/translations';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
} from '../../utils/locale';

type Db = typeof defaultDb;

export interface ResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
}

export interface ResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

// The getting-started chapter, served as a doc:// resource per locale. `en` is the
// base text below (also the fallback when a locale row is missing); the 7 other
// editions live in content_translations (book/getting-started/content), seeded by
// migration 0010_book_translations.sql.
const GETTING_STARTED_EN = `# Getting started with Common Practice

Common Practice turns the everyday frustrations in your work into real, shipped
tools — without anyone learning a new app or writing production code. It runs as
two leaderboards that feed each other.

## The two leaderboards

**Challenges** — anyone posts a frustration from their own work area; colleagues
vote on what is worth solving. The most-voted challenges open to the Solution
leaderboard each Thursday.

**Solutions** — builders pick up a top challenge and compose a *flow* from reusable
building blocks. The company votes on the best, and the weekly winner is promoted
through IT's normal production pipeline under platform governance.

## Build with the copilot

A flow is a directed graph of typed blocks (categories: data · ai · logic · output
· ui). You compose it on a visual canvas: drag a block from the palette and connect
one block's output port to the next block's input port of a matching type. The
graph must stay acyclic.

You don't have to wire it by hand. Ask the build copilot in plain language ("summarise
the incoming claim and flag anything over the auto-approval threshold") and it
operates the builder for you — finding the right blocks, dropping them on the canvas,
configuring them, and connecting the ports. These are the same actions you would take,
so you can watch and take over at any point.

## Run it in your sandbox

Press **Test run** and the flow really executes in your personal sandbox. Every step
streams a live trace — timing, cost, and an output preview per block. Sandboxes run
on mock data only and never touch production systems; AI calls are brokered and
metered, with per-user daily and weekly limits enforced before each call.

## The weekly cadence

- **Monday** — voting on new challenges opens.
- **Tuesday & Wednesday** — one hour a day of building.
- **Thursday 18:00** — challenge and solution voting closes.
- **Friday** — a short guest talk and the winner announcement.

## What you never have to do

Install anything locally · touch production data · wait for IT approval to start
building · justify a budget. Post a challenge in two sentences, or open your sandbox
and remix an existing solution — none of the work is ever wasted, because every
solution stays as building blocks anyone can reuse.`;

export async function listResources(
  db: Db = defaultDb,
  tenantId?: string | null,
): Promise<ResourceDef[]> {
  const { items } = await searchBlocks('', { limit: 100 }, db);
  const blockResources: ResourceDef[] = items.map((b) => ({
    uri: `block://${b.slug}@${b.version ?? 'latest'}`,
    name: b.name,
    description: b.description,
    mimeType: 'application/json',
  }));
  // The getting-started chapter is available in all 8 book editions (§5B).
  const bookResources: ResourceDef[] = SUPPORTED_LOCALES.map((locale) => ({
    uri: `doc://book/getting-started?lang=${locale}`,
    name: `Getting started (${locale})`,
    description: 'The Common Practice getting-started chapter.',
    mimeType: 'text/markdown',
  }));
  // The caller's datasets (Phase 2.0) — real test data the agent can wire to a node.
  // Scoped by tenant_id (Phase 3.6: test data is shared within an org), matching
  // list_datasets in mcp/tools.ts — NOT owner_id, which would only surface datasets the
  // caller personally uploaded (wrong for e.g. a super_admin-issued MCP key, where the
  // key's tenant and its issuer's own tenant differ).
  const datasetResources: ResourceDef[] = tenantId
    ? (
        await db
          .select({ slug: datasets.slug, name: datasets.name, row_count: datasets.row_count })
          .from(datasets)
          .where(eq(datasets.tenant_id, tenantId))
          .orderBy(desc(datasets.updated_at))
      ).map((d) => ({
        uri: `data://dataset/${d.slug}`,
        name: `Dataset: ${d.name}`,
        description: `${d.row_count} rows of test data (typed columns).`,
        mimeType: 'application/json',
      }))
    : [];
  // The compiled ontology cells (3.4) — one resource per (industry × department) cell,
  // including any the caller's tenant has extended (3.5). Uses the caller's actual tenant
  // (ctx.tenantId), never re-derived from the issuer's own home tenant.
  const { cells } = await listMatrix({ tenantId: tenantId ?? null, database: db });
  const ontologyResources: ResourceDef[] = cells.map((c) => ({
    uri: `ontology://${c.industry}/${c.department}`,
    name: `Ontology: ${c.industry} × ${c.department}`,
    description: 'Compiled semantic model (entities, attributes, relations) for this cell.',
    mimeType: 'application/json',
  }));
  return [
    ...bookResources,
    {
      uri: 'data://blocks/overview',
      name: 'Block catalogue overview',
      description: 'All available blocks with their typed ports.',
      mimeType: 'application/json',
    },
    ...ontologyResources,
    ...datasetResources,
    ...blockResources,
  ];
}

export async function readResource(
  uri: string,
  db: Db = defaultDb,
  tenantId?: string | null,
): Promise<ResourceContents | null> {
  if (uri.startsWith('block://')) {
    // block://<slug>@<version>
    const body = uri.slice('block://'.length);
    const slug = body.split('@')[0] ?? '';
    const block = await getBlockDetail(slug, db);
    if (!block) return null;
    return { uri, mimeType: 'application/json', text: JSON.stringify(block) };
  }
  if (uri.startsWith('doc://book/getting-started')) {
    // §5B: serve the chapter per locale. Read content_translations
    // (entity_type 'book', field 'content') with an `en` fallback. The 7 non-en
    // editions are seeded by migration 0010; `en` resolves to the base text below.
    const lang = new URLSearchParams(uri.split('?')[1] ?? '').get('lang');
    const locale = isSupportedLocale(lang) ? lang : DEFAULT_LOCALE;
    const localized = await getTranslation(
      'book',
      'getting-started',
      locale,
      'content',
      db,
    );
    return {
      uri,
      mimeType: 'text/markdown',
      text: localized ?? GETTING_STARTED_EN,
    };
  }
  if (uri.startsWith('data://dataset/')) {
    // data://dataset/<slug> — the caller's tenant's dataset schema + a sample of rows.
    // Scoped by tenant_id, matching list_datasets in mcp/tools.ts (see listResources above).
    if (!tenantId) return null;
    const slug = decodeURIComponent(uri.slice('data://dataset/'.length).split('?')[0] ?? '');
    const [d] = await db
      .select()
      .from(datasets)
      .where(and(eq(datasets.tenant_id, tenantId), eq(datasets.slug, slug)));
    if (!d) return null;
    // ⛔ NO EXAMPLE DATA (owner decision W8, 2026-10-14) — same rule and same shape as the
    // describe_data tool (mcp/tools.ts): this text is read straight into the LLM conversation.
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({
        slug: d.slug,
        name: d.name,
        columns: schemaForAi(d.columns),
        rowCount: d.row_count,
      }),
    };
  }
  if (uri.startsWith('data://blocks/overview')) {
    const { items } = await searchBlocks('', { limit: 100 }, db);
    return { uri, mimeType: 'application/json', text: JSON.stringify({ items }) };
  }
  if (uri.startsWith('ontology://')) {
    // ontology://<industry>/<department> — the compiled (industry × department) graph,
    // overlaid with the caller's tenant overrides/extensions (3.5). Non-PII, canonical
    // (en) labels. An empty department (ontology://insurance/) is valid: the overlay alone.
    const path = uri.slice('ontology://'.length).split('?')[0] ?? '';
    const [industryPart, departmentPart = ''] = path.split('/');
    const industry = decodeURIComponent(industryPart ?? '');
    if (!industry) return null;
    // The caller's actual tenant (ctx.tenantId) — never re-derived from the issuer's own
    // home tenant, which would resolve the WRONG tenant's overlay for a super_admin-issued
    // key (issuer's home tenant != the key's tenant).
    const compiled = await compileEffective(industry, decodeURIComponent(departmentPart), {
      tenantId: tenantId ?? null,
      database: db,
    });
    return { uri, mimeType: 'application/json', text: JSON.stringify(compiled) };
  }
  return null;
}
