# Common Practice — Phase 2 Build Spec

> Status: **proposed** · Authored 2026-06-07 (revised 2026-06-08) · Source of truth for post-v1 development.
> Builds on: `SPEC.md` (v1, shipped + verified live — 165 backend tests green, frontend check/build clean).
> Product truth: `../nonagentic_homepage/commonpractice.html` + `Common_Practice_Knowledge_Base.md` + `demo.html`.

---

## 1. Context — why Phase 2, and the principle it must respect

v1 is real and verified. But there is a **foundational gap that blocks real use**: blocks can only consume **5 hardcoded fixtures** baked into `backend/src/exec/mock-data.ts`. There is no way to get test data into the platform, so no realistic flow can be built or run.

**The fix must respect what Common Practice *is*.** Per the marketing site and Knowledge Base, this is a **safe, IT-governed sandbox — "IT-as-nursery"**: *"no production data, full audit, locally hosted,"* *"mock data only."* So Phase 2.0 is emphatically **NOT** about live/real data or external connectors. It is about giving the **platform team an easy way to load *cleaned test data*** into the sandbox, plus **internal rules documentation (PDFs)** for blocks/agent to reference.

> ⚠️ **Correction to the first draft of this spec:** an earlier version implied users would work with "real live data" and proposed "real data connectors." **That is wrong and is removed.** The platform stays a no-production-data sandbox. The only data that enters is (a) cleaned test datasets uploaded by IT, and (b) internal rules/policy PDFs uploaded by IT. Both are reference/mock material, never a live source.

Who does it: the **platform persona** (IT — the "nursery" role: *"Realistic mock data — JSON or in-memory DB; no production data needed"* and *"pre-stages mock data"*). Employees building flows then consume it; they never upload production data.

Ground truth that shapes the design (verified):
- The runner is a **DB-less, network-less subprocess**; the host delivers work as a **JSON init frame on the first stdin line** + an `llm` broker channel. → datasets ride that same init frame; no DB/network in the sandbox.
- `ctx.mockData` is **capability-gated** in `flow-executor.ts`. → dataset/rules access reuses that gate.
- No CSV/xlsx/PDF parse libraries present yet → Phase 2.0 adds light ones.

---

## 2. Phase 2.0 — Sandbox test-data + rules-docs ingestion (platform-team upload)

**Goal:** a platform-team member uploads **cleaned test data** (CSV, Excel `.xlsx`, a `.sql` file, plain text/JSON) and **internal rules PDFs**, sees it typed/previewed, marks any PII columns, and blocks + the agent can use it — all inside the sandbox boundary, tenant-scoped, audited. **No production data, ever.**

### 2.1 The two upload kinds (both platform-only, both sandbox-safe)
- **Test datasets** — tabular cleaned sample rows that stand in for real records (claims, policies, customers…). Replace the 5 baked fixtures with loadable data.
- **Rules documents** — internal policy/rules PDFs (e.g. claims-handling rules, deductible tables) that blocks/agent reference. Text only; copied *idea* from `ingestion_service/src/parsers/simple_parser.py` (text extraction + fallback) — explicitly **not** the 881-line `enhanced_pdf_parser.py` / embeddings / RAG / OCR pipeline.

### 2.2 Data model (new tables — Drizzle, mirror v1 `db/schema.ts`)
- `datasets` — `id uuid`, `owner_id fk`, `tenant_id`, `sandbox_id fk null`, `name`, `slug`, `source_type` enum(`csv`|`xlsx`|`sql`|`text`|`json`), `columns jsonb` (`[{name,type,pii?,sample?}]`), `row_count`, `size_bytes`, `status` enum(`ready`|`parsing`|`error`), `error`, timestamps.
- `dataset_rows` — `dataset_id fk`, `idx int`, `data jsonb`, PK `(dataset_id, idx)`.
- `rules_documents` — `id uuid`, `owner_id fk`, `tenant_id`, `sandbox_id fk null`, `name`, `slug`, `source` enum(`pdf`|`text`|`md`), `page_count`, `status`, timestamps.
- `rules_chunks` — `document_id fk`, `idx int`, `page int`, `text`, PK `(document_id, idx)` — light page/paragraph chunks for plain keyword lookup (no vectors).
- Migrations `0011_datasets.sql`, `0012_rules_docs.sql` (raw SQL like existing `migrations/`).

### 2.3 Ingestion — parsers (backend, Bun; keep light)
`backend/src/datasets/parse/`, one parser per source, each → `{columns, rows}` or `{pages|chunks}`:
- **CSV** — header→columns; per-column type inference (number/bool/date/string); delimiter sniff. Dependency-light parser (e.g. `papaparse`).
- **Excel (.xlsx)** — `exceljs` (pure-JS, streaming, Bun-friendly). Pick sheet + header row.
- **SQL** — **import a `.sql` file** of cleaned test data: parse `INSERT INTO … VALUES …` (and optional `CREATE TABLE` for column types). This is a *file import of a cleaned dump*, **not** a connection to any live database. (Reinforces §1: no live sources.)
- **Plain text / JSON** — text → line/blob rows; JSON array→rows, object→one row.
- **PDF (rules docs)** — text extraction via a small TS lib (`unpdf` or `pdf-parse`/`pdfjs-dist`) with a graceful fallback, mirroring `simple_parser.py`'s text-only philosophy. Split into page/paragraph `rules_chunks`. No embeddings, no OCR, no job queue.
- Shared: type inference, **PII heuristics** (column name matches `email|ssn|iban|phone|dob|name|address` → suggest `pii:true`, dev confirms), row/size caps, deterministic order.

### 2.4 API (unversioned `/api/...`, platform-role gated)
- `POST /api/datasets` (multipart CSV/xlsx, or JSON for sql/text/json) → parse → infer → store → preview. `GET` list/preview, `PATCH` schema/PII, `DELETE`. **Requires platform role** (employees don't upload data).
- `POST /api/rules-documents` (PDF/text/md upload) → extract → chunk → store; `GET` list/read; `DELETE`. Platform-role gated.
- CLI/seed: `bun run seed:dataset <file>` + extend `db/seed.ts` to ship **sample datasets + a sample rules PDF that match the seed blocks**, so the app works out-of-the-box with no hand-loading.

### 2.5 Runner wiring (host→runner via the existing init frame)
- A flow node/config references datasets/rules by slug. At run time the **host** (`run-controller.ts`) resolves them, enforces caps + PII redaction, and **adds `datasets` / `rules` to the init frame** already written to the runner's stdin. Sandbox stays DB-less/network-less.
- Extend the runner ctx (`runner-entry.ts` / `flow-executor.ts`), gated on the existing `caps.mockData`:
  - keep `ctx.mockData(kind)` (the 5 baked kinds become built-in datasets, back-compat),
  - add **`ctx.dataset(slug, opts?)`** → injected rows (optional filter/sample),
  - add **`ctx.rules(slug, query?)`** → matching chunks (plain keyword match) for rules-aware blocks (e.g. `flag-anomalies` checking against uploaded thresholds).
- PII columns flow only where governance permits; redacted at the host before injection.

### 2.6 Agent / MCP wiring (make data + rules discoverable)
- `mcp/resources.ts`: real `data://<slug>` (dataset schema + sample) and `doc://rules/<slug>` (rules-doc text) from the DB — tenant-scoped + audited (replaces today's "thin" placeholder).
- `mcp/tools.ts`: back `list_datasets` / `describe_data(slug)` (currently only referenced) + `search_rules(query)`, so the co-pilot *knows what test data and rules exist* and can wire a block to them during a build.

### 2.7 Frontend (platform persona — a Data screen)
- New **Data** screen (platform side, beside `sandboxes`): upload CSV/Excel + paste SQL-file/text/JSON; upload rules PDFs; typed table preview; edit column types + toggle PII; rules-doc preview; rescope/delete. Localized (8 locales) + RTL-safe. Reuse design-system primitives.
- A **dataset/rules picker** in the block-config panel on the Build canvas (and reachable by the agent via `configure_node`).

### 2.8 Governance (reinforces the sandbox principle)
- **No production data** — UI copy + validation make clear this is cleaned test data only; upload is **platform-role only**; audit every upload/edit/delete (`audit_log`).
- Per-sandbox scope by default, promotable to tenant-shared (confirm §4); row/size caps with **logged** truncation (never silent); PII redaction at the host before the runner sees anything.

### 2.9 Verification (end-to-end)
- Unit: each parser (csv/xlsx/sql-file/text/json/pdf) → typed output; inference; PII heuristics; caps/truncation.
- Integration (real PG `:5433`): upload CSV+xlsx+a `.sql` file + a rules PDF → persisted; preview; `describe_data`/`data://`/`search_rules`/`doc://rules` return them; platform-role gate rejects an employee.
- Runner: a flow whose block calls `ctx.dataset()` + `ctx.rules()` runs; trace shows real rows + rule hits; PII redaction verified.
- Frontend: upload→preview→use-in-a-flow→test-run, in an LTR and an RTL locale.
- Seed: fresh DB + `seed` → sample datasets + rules present → a seeded flow test-runs green with no hand-loading.

---

## 2T. Terminology cleanup — purge "strand" (do early; hard rule)

"strand" is **banned everywhere** (legacy from the old "helix dna" name). It has leaked into the shipped app — **80 occurrences** across **user-visible UI** (the `/docs` page renders "The two strands"), **all 8 message catalogs** (`docs_strands_*`, "Herausforderungsstrang", "filière Défi", "מסלולים", …), the MCP resource text the agent reads (`mcp/resources.ts`), and code comments/identifiers in `routes/challenges.ts`, `routes/solutions.ts`, `api/challenges.ts`, `api/solutions.ts`, `schema.ts`, `seed-marketplace.ts`.

Replace with the Knowledge-Base / marketing language (which never says "strand"):
- "Challenge strand" → **"Challenges" / "the Challenge leaderboard"**; "Solution strand" → **"Solutions" / "the Solution leaderboard"**; "the two strands" → **"the two linked leaderboards"**; "Strand 1/2" (comments) → "Challenges/Solutions".
- Scope: re-translate the `docs_strands_*` keys in all 8 catalogs (incl. RTL ar/he), rename the message keys, fix the `/docs` page, the MCP resource text, and the code comments/identifiers. Land as one focused PR. **This is the highest-priority item — it's user-visible and violates a hard rule.**

---

## 3. Phase 2 roadmap (recommended order; reprioritize freely)

Do **2T (terminology)** first (hygiene, user-visible), then **2.0** (the unblocker). Then, recommended:

- **A. Block-authoring DX + per-block tests** — in-app code editor with type-check, **per-block test fixtures using the new datasets**, "run tests" before publish. *Composes directly with 2.0; size M.*
- **B. Container isolation hardening** — the deferred v1 milestone: runner from `Bun.spawn` process → container/namespace (true FS/network isolation). *The honest security upgrade; size L.*
- **C. Enterprise admin** — tenant management UI, BYO-key (`tenant_llm_settings`), **MCP API-key issuance** for external clients, usage/spend dashboards (`usage_counters` + audit already exist). *The enterprise story; size M.*
- **D. Marketplace + weekly cadence** — real weekly winner automation, vote cycles, and wiring pipeline promotion (Review→…→Production); the Friday-winner rhythm from the KB. *The program's social loop; size M.*
- **E. Observability + compliance export** — real metrics + nightly audit-log export to the compliance bucket (named in the governance screen). *Size S–M.*
- **F. Deep i18n content pipeline** — translate user-generated content (challenges/solutions/block docs) beyond the shipped UI/book strings. *Size M.*
- **G. Collaboration + flow lifecycle** — multi-user flow editing; a version/rollback UI over the existing `flow_snapshots`. *Size M.*

> Removed from the earlier draft: **"real data connectors"** — it contradicts the no-production-data sandbox principle. If a *cleaned-data refresh* workflow is ever wanted, it's still an **upload of cleaned data**, not a live connection.

**Recommended next after 2T + 2.0:** A (block test DX) → C (enterprise admin) → B (container hardening).

---

## 4. Open decisions (genuine — your call)
- **Dataset/rules scope default:** per-sandbox (dev-isolated) vs tenant-shared (team-reusable). Recommend **per-sandbox, promotable to tenant**.
- **Excel library:** `exceljs` (pure-JS, Bun-safe — recommended) vs SheetJS `xlsx`.
- **PDF library:** `unpdf` (modern, serverless-friendly — recommended) vs `pdf-parse`/`pdfjs-dist`. Text-only either way.
- **Rules lookup depth:** plain keyword match in 2.0 (recommended, simple) vs add embeddings later (a roadmap item, not 2.0 — keeps it simple per your instruction).
