# Common Practice — Build Spec

> Status: **shipped — live at commonpractice-app.nonagentic.ai (2026-06-07)** · Authored 2026-06-05 · Source of truth for the multi-session build.
> Design reference (frozen, do not edit): `../nonagentic_homepage/demo.html` (4592-line static mockup).
> Repo convention reference: `../fr/` (SvelteKit + Bun + Drizzle house style).

---

## 1. Context — why this exists

`nonagentic_homepage/demo.html` is a polished but **static** mockup of "Common Practice — Leaderboards": an internal platform where employees post *challenges* (frustrations from their work), colleagues build *solutions* by composing reusable *building blocks* on a visual canvas, the org votes, and a weekly winner gets promoted through a production pipeline — all governed by a platform team. It links out to `commonpractice.nonagentic.ai`.

We are turning that mockup into a **real, running application**: a SvelteKit frontend + a Bun/TypeScript backend API on a **Postgres 18** database, with building blocks and user-authored flows stored as **JSONB**, and a visual builder powered by **SvelteFlow** (`@xyflow/svelte`).

### Locked scope decisions (confirmed with the user 2026-06-05)
| Decision | Choice for v1 | Implication |
|---|---|---|
| **Block execution** | **Real TS-only sandbox** | Blocks are authored in TypeScript; "Test run" really executes them in an isolated runner. No Python in v1. No containers in v1 (deferred hardening). |
| **Auth** | **Keycloak from the start** | Mirror `fr/`: Keycloak JS on the frontend, JWT-validation middleware on the backend, license-authz at the edge. |
| **Build order** | **Builder core first** | Blocks library → block editor/designer → SvelteFlow Build canvas → flow persistence + execution. Marketplace and Ops come after. |
| **AI assistant** | **Stub provider in scaffold → real, provider-agnostic agent that operates the builder as a frontend co-pilot (Session 7)** | Chat is the *primary* authoring surface. A **TS-native, provider-agnostic** agent (own `LlmProvider` interface + Anthropic/OpenAI-compatible adapters, per-tenant BYO key — **not** worker_management/inference-router/a single SDK) drives the builder **in the browser, the way a user would** (full puppeteering). No `@ag-ui/*` SDK / no state-push — the canvas is reactive. See §5A. |
| **MCP surface** | **Full enterprise MCP: tools + resources + prompts, DB-backed, authed, audited** | One governed AI contract (official `@modelcontextprotocol/sdk`): platform **tools** — including the **block-authoring suite**, which is how a customer extends the platform over MCP — blocks/data/book **resources**, per-locale **prompts**; all tenant-scoped with auth + audit at the MCP layer (the enterprise story: security, separation of concerns, auditability). Reusable by external MCP clients. See §5A Layer 2. |
| **i18n** | **8 book editions incl. 2 RTL, native from scaffold** | English, Dutch, Polish, French, Spanish, German, **Arabic (RTL)**, **Hebrew (RTL)**. RTL is first-class (logical properties). UI strings via Paraglide; book/docs + agent prompts localized per edition. See §5B. |

### Project location decision
New sibling project at **`/Users/georgedekker/Movies/commonpractice/`** with `frontend/` + `backend/` (the `fr/` shape). It is **not** nested inside the `nonagentic_homepage` marketing repo — that repo only holds the design reference. This will be its own git repo, mirrored to GitHub under `nonagenticai/commonpractice` when the user approves. *If the user prefers a different name/location, change this before Session 1.*

---

## 2. Demo inventory — the 17 screens (what we are reproducing)

Two personas, toggled in the sidebar (`switchPersona` in demo.html:4520). Footer identity switches with persona.

**Employee persona — "Discover" (marketplace):**
1. `home` — employee dashboard (stats: active challenges, solutions in voting, active builders, live in production).
2. `challenges` — Challenge leaderboard: votable challenges with work-area + impact metrics.
3. `challenge-detail` — one challenge (metrics: time saved/wk, affected staff, backlog reduction).
4. `submit` — submit a challenge form.
5. `solutions` — Solution leaderboard: votable solutions per challenge.
6. `solution-detail` — one solution ("GPT flow with policy context in 7 steps").
7. `build` — **the visual flow builder** (blocks palette · SvelteFlow canvas · AI chat · test console). **Core.**
8. `winner` — weekly winner announcement.
9. `docs` — getting-started.

**Platform persona — "Operate" (admin/ops):**
10. `it-dash` — runtime overview (active sandboxes, daily LLM calls, spend today, P95 latency).
11. `sandboxes` — per-user sandbox list (running/idle/suspended, cost, pause/inspect).
12. `blocks` — **building blocks library** (grid of versioned block cards, filters by category). **Core.**
13. `block-edit` — **block editor/designer** (docs markdown + implementation code + I/O + examples + permissions + usage + version history). **Core.**
14. `pipeline` — production pipeline kanban (Review → Hardening → Staging/canary → Production).
15. `governance` — policy rails (toggles + numeric ceilings, enforced "at the sandbox boundary").
16. `audit` — audit log feed (every sandbox/block/policy/deploy action).

### Block taxonomy (from `build` + `blocks` screens)
Categories: **Data** (teal), **AI** (violet), **Logic** (amber), **Output** (coral), **UI**. Sample seed blocks: `read-claim-form`, `lookup-policy`, `read-customer-record`, `ai-summarize`, `extract-fields`, `classify`, `compare-docs`, `if-else`, `loop`, `flag-anomalies`, `filter-list`, `format-output`, `display-to-user`, `review-panel`, `ocr-scan`. Each carries: version (semver), status (`stable`/`beta`/`draft`/`deprecated`), maintainer, usage count, description, docs, typed inputs/outputs, permissions (network/PII/auto-promote), region, cost class.

### Governance policies (from `governance` screen) — seed list
Block real prod data · PII scrubbing · cross-sandbox isolation · EU-only execution · per-user daily LLM-call cap · per-user weekly spend ceiling · auto-suspend idle sandboxes after N · allowlisted models · external HTTP from sandboxes · code-exec outside building blocks · mandatory code review for winners · required reviewers · staging canary percent.

---

## 3. Architecture

```
commonpractice/
  frontend/                 # SvelteKit 2 + Svelte 5 (runes) + Tailwind 4, on Bun
    messages/               # i18n catalogs per locale: en,nl,pl,fr,es,de,ar,he (§5B; Paraglide)
    src/
      routes/               # file-based; two persona route groups
      lib/
        api/                # auth-fetch.ts (mirror fr), typed clients per resource
        components/         # design-system primitives ported from demo.html
        flow/               # SvelteFlow node/edge components, palette, run-console
        services/           # keycloak.ts, sse.ts, agent-session.ts (agent token)
        stores/             # *.svelte.ts runes stores (auth, builder, run-trace, agent-chat, locale)
        i18n/               # locale store + dir(rtl) handling + Accept-Language negotiation (§5B)
        agent/              # driver.ts (co-pilot puppeteer) + synthetic-cursor overlay
        styles/             # tokens.css ported verbatim from demo.html :root
  backend/                  # Bun.serve() + Drizzle ORM + postgres-js, on Bun
    src/
      server.ts             # route mounting, middleware stack
      config.ts             # env parsing (mirror fr/backend/src/config.ts)
      db/                   # client.ts, schema.ts, migrations/, seed.ts
      middleware/           # auth.ts (Keycloak JWT), cors.ts, request-context.ts
      routes/               # /api/<resource> handlers (unversioned — house rule)
      host/                 # TRUSTED exec orchestration (holds secrets)
        run-controller.ts   # POST /api/runs, Bun.spawn, AbortController, idle watchdog
        sse-stream.ts       # GET /api/runs/:id/stream (NDJSON→SSE, Last-Event-ID resume)
        llm-broker.ts       # host-side metered LLM calls; cap/ceiling enforcement; holds key
        static-scan.ts      # save-time import-allowlist + descriptor validation
      exec/                 # UNTRUSTED runner code (runs in spawned subprocess)
        runner-entry.ts     # bootstrap: strip network globals, execute flow, emit NDJSON
        flow-executor.ts    # Kahn topo sort + node loop + trace emit
        block-loader.ts     # Transpiler.transformSync → scratch .mjs → import(); cache by hash
        descriptor.ts       # BlockDescriptor types + validateInputs/Outputs (no Zod in runner)
        sdk.ts              # Block / BlockContext public types (published to block authors)
      ai/                   # AI substrate (§5A) — provider-agnostic agent + MCP knowledge
        llm/
          provider.ts       # normalized LlmProvider interface (the decoupling boundary)
          adapters/         # anthropic.ts, openai.ts (+ baseURL → DeepSeek/compatible); future: responses.ts
        mcp-server.ts       # @modelcontextprotocol/sdk streamable-http; tools+resources+prompts; auth+audit
        mcp/
          tools.ts          # platform tools + DB-tool dispatch (tools/list, tools/call)
          resources.ts      # blocks/data/book-per-locale (resources/list, resources/read)
          prompts.ts        # DB prompt registry, per-locale (prompts/list, prompts/get)
        block-catalog-service.ts # DB-backed block/data lookups (feed resources + tools)
        flow-edit-service.ts     # owner-scoped+audited flow.graph mutations — headless edit fallback (+ flow_snapshots)
        agent.ts            # TS-native agent loop: provider + MCP tools → SSE chat events (stub→real)
      services/             # keycloak service-account, metering counters, agent-session
    Dockerfile              # oven/bun base (mirror fr/backend/Dockerfile)
```

**Stack (mirror `fr/` exactly unless noted):**
- Frontend: SvelteKit 2.x, **Svelte 5 runes**, `@sveltejs/adapter-node`, TailwindCSS 4, Vitest, `svelte-check`. Add **`@xyflow/svelte`** (SvelteFlow) + **Paraglide/inlang** i18n (8 locales incl. RTL — §5B). Chat + co-pilot are custom-lightweight (SSE + a frontend agent-driver) — **no `@ag-ui/*` SDK**.
- Backend: **Bun** (`oven/bun:1.3.x`), `Bun.serve()` + custom Router util, **Drizzle ORM** + **`postgres`** (postgres-js) driver, `drizzle-kit` migrations, `bun test`. AI substrate (§5A): own **provider-agnostic `LlmProvider`** (TS-native — NOT `worker_management`/`inference-router`) with adapters that may wrap **`@anthropic-ai/sdk`** + **`openai`** (latter also covers DeepSeek/OpenAI-compatible via `baseURL`); **`@modelcontextprotocol/sdk`** for the full MCP surface (tools+resources+prompts, streamable-http, auth) + an MCP client; **`zod`** (already present) for tool/structured-output typing; `jose` (agent-session JWT, already present).
- DB: **Postgres 18** — CI `:5433`, prod `:5432` (optionally behind a connection pooler such as PgBouncer). One service = one DB = one DB user (`commonpractice` DB + `commonpractice` user). **No SQLite.**
- Auth: Keycloak JS (frontend) + JWT middleware (backend), like `fr/src/lib/services/keycloak.ts` and `fr/backend/src/middleware/auth.ts`. Dev: `VITE_AUTH_BYPASS` seam (as fr does).
- API routes: **unversioned `/api/<resource>`** (hard house rule).
- Testing: `bun test`, **no `mock.module()`** — use the injectable-deps `__setXDepsForTests()` seam (fr/backend CLAUDE.md rule).
- Ports: backend candidate **8790**, frontend dev **5174** (both free locally as of 2026-06-05). **Verify free locally AND in docker before committing** — never port 8000.

---

## 4. Data model (Postgres, Drizzle schema)

JSONB used for: block code descriptor, flow graphs, run traces, governance values, audit metadata.

**Builder-core tables (Sessions 1–4):**
- `users` — `id uuid pk`, `keycloak_sub`, `email`, `name`, `avatar_initials`, `role` (`employee`|`platform`), timestamps. Profile mirror of Keycloak.
- `building_blocks` — `id uuid`, `slug` (e.g. `read-claim-form`, unique), `category` enum(`data`|`ai`|`logic`|`output`|`ui`), `current_version_id fk`, `maintainer_id fk users`, `region`, `cost_class`, `license`, `archived bool`, timestamps.
- `block_versions` — `id uuid`, `block_id fk`, `version` (semver text), `status` enum(`draft`|`beta`|`stable`|`deprecated`), `language` enum(`typescript`) (python reserved for later), `docs_md text`, `source_ts text`, `descriptor jsonb` (typed I/O + capabilities + limits — see §5), `examples jsonb`, `changelog text`, `tests_passing bool`, `published_by fk`, `published_at`, `created_at`. Unique `(block_id, version)`.
- `flows` — `id uuid`, `name`, `owner_id fk`, `sandbox_id fk null`, `solution_id fk null`, `version`, `graph jsonb` (`{nodes, edges}` SvelteFlow shape — node = `{id, blockId, blockVersionId, config, position}`; edge = `{id, source, sourceHandle, target, targetHandle}`), `status`, `last_saved_at`, timestamps.
- `flow_runs` — `id uuid`, `flow_id fk`, `triggered_by fk`, `status` enum(`running`|`ok`|`partial`|`failed`), `trace jsonb` (final array of TraceEvents — §5), `total_ms int`, `total_cost_usd numeric`, `tokens_in`, `tokens_out`, `llm_calls`, `started_at`, `finished_at`.
- `sandboxes` — `id uuid`, `owner_id fk`, `status` enum(`running`|`idle`|`suspended`|`error`), `region`, `cost_today_usd numeric`, `last_active_at`, `created_at`. (Minimal in builder core; deepened in Ops session.)
- `usage_counters` — `user_id fk`, `day date`, `llm_calls int`, `spend_usd numeric` — for daily-cap / weekly-ceiling enforcement (or back with Redis).

**AI substrate tables (scaffolded Session 0; agent matures through Session 7 — see §5A):**
- `tenant_llm_settings` — `tenant_id pk`, `provider` (`anthropic`|`openai`|`openai_compatible`), `model`, `base_url`, `params jsonb`, `api_key_encrypted`, `updated_at`. Per-customer provider choice + BYO key; env defaults for dev/self-host.
- `agent_sessions` — `id uuid`, `user_id fk`, `refresh_token_hash`, `expires_at`, `revoked_at`, `created_at`. Backs the Keycloak→agent-token exchange for `/api/agent/chat` (mirrors fr's two-token model).
- `mcp_prompts` (+ `mcp_prompt_versions`) — `id uuid`, `name`, `locale` (`en`…`he`), `tenant_id`, `template text`, `arguments jsonb`, `current_version`, timestamps. DB-backed MCP **prompts** primitive — per-locale, versioned, tenant-scoped, audited (§5A/§5B). The agent's system prompt lives here.
- ~~`mcp_tools` (+ `mcp_tool_versions`)~~ — **specified, scaffolded in 0008, never built out, DROPPED in 0052.** The tables were created but no route, UI, seed or test ever wrote a row, and `impl` never got an executor, so their only reachable behaviour was to advertise a tool to the model that `tools/call` would then refuse. Customer-authored extensions are `building_blocks` + `block_versions` instead — same goal, but with a sandbox, linter, test runner, versioning and RBAC behind it. See §5A Layer 2.
- `content_translations` — `entity_type`, `entity_id`, `locale`, `field`, `value text`, `updated_at` (PK `entity_type,entity_id,locale,field`). Localized strings for book/docs + (best-effort) user-generated content (§5B). UI strings live in `frontend/messages/<locale>.json`.
- `chat_sessions` — `id uuid`, `flow_id fk`, `user_id fk`, `title`, `created_at`, `updated_at`. One conversation thread bound to a flow.
- `chat_messages` — `id uuid`, `session_id fk`, `role` enum(`user`|`assistant`|`tool`), `content jsonb` (text + tool_use / tool_result blocks, Anthropic message shape), `created_at`. Full transcript for replay + audit.
- `flow_snapshots` — `id uuid`, `flow_id fk`, `graph jsonb`, `source` enum(`manual`|`ai`), `summary` (e.g. "inserted ai-summarize after extract-fields"), `created_by fk`, `created_at`. Every AI (and manual) mutation snapshots the graph → undo/redo + an auditable diff trail (mirrors the mcp_server's version-history idea, applied to flows). Keep last N per flow.

**Marketplace tables (later session):**
- `challenges` — `id`, `title`, `description`, `work_area`, `submitter_id fk`, `status`, `week`, `metrics jsonb` (time_saved_per_week, affected_staff, backlog_reduction), `votes_count int`, timestamps.
- `solutions` — `id`, `challenge_id fk`, `title`, `author_id fk`, `flow_id fk`, `status`, `week`, `votes_count int`, timestamps.
- `votes` — `id`, `user_id fk`, `target_type` enum(`challenge`|`solution`), `target_id uuid`, `created_at`. Unique `(user_id, target_type, target_id)`.
- `weekly_winners` — `week`, `solution_id fk`, `announced_at`.

**Ops/governance tables (later session):**
- `pipeline_items` — `id`, `solution_id fk`, `stage` enum(`review`|`hardening`|`staging`|`production`), `assignee_id fk`, `rollout_pct int`, `progress jsonb`, `updated_at`.
- `policies` — `key` pk, `category`, `value jsonb` (bool toggle or number), `enabled bool`, `updated_by fk`, `updated_at`. Seeded from §2 governance list.
- `policy_changes` — audit of edits to `policies`.
- `audit_log` — `id`, `actor_id fk`, `action`, `target_type`, `target_id`, `metadata jsonb`, `created_at`.

Reuse Drizzle patterns from `fr/backend/src/db/schema.ts` (pgEnum, pgTable). Migrations via `drizzle-kit generate` + a `migrate` step run as an initContainer-equivalent (mirror fr).

---

## 5. Execution layer (the hard part — design vetted)

**Trust boundary:** everything in `backend/src/host/` is trusted and holds secrets; everything in `backend/src/exec/` runs inside an **untrusted spawned subprocess**.

### Isolation mechanism
One **`Bun.spawn` subprocess per flow run** (not per node). Rejected alternatives and why: `node:vm`/`new Function` are **not** security boundaries; Bun `Worker` shares the address space and **ignores `resourceLimits`** (no memory cap). A separate OS process is the only thing in Bun ~1.3.x that gives an enforceable resource boundary.

```ts
const ac = new AbortController();
const proc = Bun.spawn({
  cmd: ["prlimit", "--as=<bytes>", "bun", "run", runnerEntry], // RLIMIT_AS mem cap (Linux)
  stdin: "pipe",   // flow graph + resolved block sources (JSON)
  stdout: "pipe",  // NDJSON trace out
  stderr: "pipe",
  signal: ac.signal,            // cancel button
  timeout: policy.maxRunMs,     // hard wall-clock kill
  killSignal: "SIGKILL",        // SIGTERM is catchable by user code
  maxBuffer: 8 * 1024 * 1024,
  env: SCRUBBED_ENV,            // NO db url, NO provider keys
  cwd: perRunScratchDir,
});
```

### Block contract (`exec/sdk.ts`, published to authors)
```ts
type FieldType = "string"|"number"|"boolean"|"json"|"string[]"|"enum";
interface FieldSpec { type: FieldType; required?: boolean; enum?: string[]; pii?: boolean; description?: string; }
interface BlockDescriptor {
  id: string; version: string;
  inputs: Record<string, FieldSpec>;   // → input ports in SvelteFlow
  outputs: Record<string, FieldSpec>;  // → output ports
  // `mockData` = may fabricate output (USER-VISIBLE: renders the "Simulated" badge).
  // `dataset`  = may read the tenant's REAL datasets via ctx.dataset. NOT a fabrication bit.
  capabilities: { network?: boolean; llm?: boolean; mockData?: boolean; dataset?: boolean }; // network default false
  limits?: { timeoutMs?: number; memMb?: number };                        // clamped to org policy
}
interface BlockContext {
  llm(req: {model:string; prompt:string; maxTokens?:number}): Promise<{text:string; usage:TokenUsage; costUsd:number}>;
  mockData(kind: string, opts?: Record<string,unknown>): Promise<unknown>;
  log(level: "debug"|"info"|"warn"|"error", msg: string, data?: unknown): void;
  signal: AbortSignal;
}
interface Block<I=Record<string,unknown>, O=Record<string,unknown>> {
  descriptor: BlockDescriptor;
  run(inputs: I, ctx: BlockContext): Promise<O>;
}
export default block; // runner reads mod.default
```
`ctx` is the **only** capability surface — never ambient globals. Store `source_ts` (text) + `descriptor` (jsonb) in `block_versions`. Validate with a tiny hand-rolled `validateField` (no Zod in the runner).

### DB source → executable
Runner transpiles each block with `new Bun.Transpiler({loader:"ts"}).transformSync(src)`, writes to `${scratch}/blocks/<id>.mjs`, then `await import(pathToFileURL(file))`. Cache transpiled output keyed by `hash(source)`. Real file paths give usable stack traces. Disallow non-SDK imports at save time.

### Flow executor (`exec/flow-executor.ts`)
Kahn topological sort over `{nodes, edges}`; **cycle detection mandatory** (SvelteFlow allows cycles → fail run with `flow_error`). For each node in topo order: gather inputs from incoming edges (`nodeOutputs[edge.source][edge.sourceHandle]` → `inputs[edge.targetHandle]`) merged with node `config`; validate inputs; emit `node_start`; `await run(inputs, ctx)` under per-node `AbortSignal.timeout`; validate outputs; emit `node_success` (timing + cost) or `node_error` and **skip transitive descendants**. v1 = sequential; parallel fan-out is a noted later optimization.

### Trace events (NDJSON on stdout, one per line)
`run_start | node_start | log | node_success | node_error | node_skipped | run_complete`. Each carries `runId`, `ts`. `node_success` carries `durationMs`, `cost{usd,tokensIn,tokensOut,llmCalls}`, truncated `outputPreview`. `run_complete` carries `totalMs`, `totals`, `status`. Truncate previews to a byte budget so a huge output can't flood the stream. Persist the final trace array to `flow_runs.trace`.

### Governance enforcement points
- **LLM cap / spend ceiling:** `ctx.llm()` in the runner is a **thin shim that round-trips to `host/llm-broker.ts`** over stdio. The **host holds the provider key and checks `usage_counters` before each call.** The runner literally cannot bypass — it has no key. This is the single most important governance decision.
- **No network (per-block toggle):** runner bootstrap deletes `globalThis.fetch`/`WebSocket`/`XMLHttpRequest` and `Bun.connect`/`listen`; save-time `static-scan.ts` bans `node:net|dgram|tls|http(s)`, `bun:*` sockets, and dynamic `import`/`require` outside the SDK allowlist. When `capabilities.network===true`, provide an allowlisted, metered proxied fetch via `ctx`.
- **PII = mock only:** descriptor `pii:true` fields may only be fed by an upstream `mockData` block / `mock:true` literal (taint-by-source convention).
- **CPU/mem/time:** process `timeout`+SIGKILL (real backstop) + per-node cooperative `AbortSignal` + `RLIMIT_AS`.
- **Auto-suspend idle:** host watchdog aborts runs with no trace progress for `idleMs`.

### Streaming to frontend — **SSE**
`POST /api/runs` → `{runId}`; `GET /api/runs/:runId/stream` returns `text/event-stream`. Host consumes `proc.stdout` NDJSON into a capped per-run ring buffer + SSE writer (decoupled so a slow browser can't stall the runner). SSE `id:` = event seq → `Last-Event-ID` reconnect resume. 15s heartbeat comment. Frontend uses `EventSource`, appends to a `run-trace.svelte.ts` store, renders per-node status on the canvas + a console panel (matches demo's bottom console).

### ⚠️ Honest non-guarantees (state these to stakeholders)
1. v1 sandbox is an **OS process, not a container/jail** — no syscall filtering, no FS/network namespace. **True isolation = the deferred container milestone.**
2. "No network" = global-strip + import-ban: robust in practice via the allowlist, **bypassable in theory**.
3. CPU timeouts are **cooperative**; only the outer SIGKILL stops a busy loop.
4. Memory caps rely on **Linux `RLIMIT_AS`** — unreliable on macOS; **prod must be Linux**.
5. PII-mock-only is **policy-by-convention**, not cryptographic taint tracking.

Net posture: crash isolation + resource backstops + brokered secrets/spend + best-effort network/PII — reasonable for an internal tool, explicitly upgradeable.

> **Isolation posture — ACCEPTED v1 decision (2026-06-06).** The strato cluster has
> **no gVisor/Kata runtime** (RuntimeClasses are `crun` + WASM only), so true
> container/Job-per-run isolation is **not available** and the SPEC §8 "container-isolated
> execution" goal shipped as **pod-level hardening** instead, layered on the subprocess
> sandbox above: a default-deny egress **NetworkPolicy** (allows only the service CIDR +
> DNS + the in-cluster inference-router; the internet is unreachable — proven by a blocked
> `curl 1.1.1.1` from the pod), `seccompProfile: RuntimeDefault`, `runAsNonRoot`,
> `readOnlyRootFilesystem` + an `emptyDir` scratch mount, `capabilities.drop: [ALL]`, and a
> cgroup memory limit (the real RSS cap; `RLIMIT_AS` is `memMb + 4096` to clear bun's ~4 GB
> virtual floor on Linux). This **strengthens** the "no network" guarantee to the kernel
> boundary but does **not** give per-run syscall/FS namespacing. **Container/Job-per-run is
> a documented, accepted deferral**, not a v1 deliverable — it would require either a
> sandboxed RuntimeClass added to the cluster or a Job-per-run rework of
> `host/run-controller.ts` (stdio protocol).

---

## 5A. AI substrate — type-safe provider-agnostic agent + MCP knowledge + frontend co-pilot

**Vision:** the chat is the primary way to build a flow. A user types *"summarise incoming claim PDFs and flag anything over the auto-approval threshold"* and the assistant — which knows the block catalogue **and the available data** — **operates the builder visibly, the way a user would**: opens the palette, drops blocks, selects a node and opens its real properties panel, types the config, drags one port handle to another. The SvelteFlow canvas stays fully usable; the agent just drives the same controls. **One source of truth: `flows.graph`; one edit path: the builder store** (user clicks and agent both go through it).

The substrate is **three decoupled layers**, each independently replaceable. (Scaffolded from Session 0 as a stub; real providers wired in Session 7. ⚠️ the current S0–S6 build predates this — chat is a scripted `ChatPanel` stub — see the **§7 retrofit task**.)

### Layer 1 — Inference: provider-agnostic & type-safe (TS-native on Bun)
We do **not** reuse `worker_management` (Python/pydantic-ai) or `inference-router` (Python), and we do **not** couple to any one vendor SDK or framework. The agent core depends only on **our own normalized `LlmProvider` interface**; thin **adapters** translate to each vendor. Customer companies pick any provider, now or future — the interface is the stable contract; vendors aren't (even OpenAI moved past Chat Completions to the Responses API).

```ts
// backend/src/ai/llm/provider.ts — the decoupling boundary (Zod-typed)
interface LlmMessage  { role: 'system'|'user'|'assistant'|'tool'; content: string; toolCallId?: string }
interface LlmToolDef  { name: string; description: string; input: JsonSchema }   // derived from Zod
interface LlmToolCall { id: string; name: string; input: unknown }
interface LlmRequest  { model: string; messages: LlmMessage[]; tools?: LlmToolDef[]; temperature?: number; responseSchema?: JsonSchema }
interface LlmResult   { text?: string; toolCalls?: LlmToolCall[]; usage: TokenUsage }
interface LlmProvider {
  chat(req: LlmRequest, opts: { signal: AbortSignal }): Promise<LlmResult>;
  stream?(req: LlmRequest, opts: { signal: AbortSignal }): AsyncIterable<LlmStreamChunk>; // text/tool-call deltas
}
```
Adapters in `backend/src/ai/llm/adapters/`: **`anthropic.ts`** (→ Messages API + tool-use) and **`openai.ts`** (→ Chat Completions + function-calling). **DeepSeek and most providers are OpenAI-compatible** → the same `openai` adapter with a `baseURL` override. Future: an **OpenAI Responses API** adapter, Gemini, etc. — additive, no core change. An adapter may wrap the official `@anthropic-ai/sdk` / `openai` npm client internally; that's an implementation detail behind the interface, swappable.

**Per-customer choice (BYO key):** a `tenant_llm_settings` row (`provider`, `model`, `base_url`, `params`, **encrypted `api_key`**) selects the adapter at runtime; env defaults cover dev/self-host. Structured outputs are enforced with **Zod** (+ the provider's JSON/schema mode where available), so the loop stays type-safe regardless of vendor. Spend/usage is metered centrally in `host/llm-broker.ts` (daily cap + weekly ceiling) wrapping whichever adapter runs; **keys never reach the frontend or the block runner.**

### Layer 2 — MCP: the full enterprise surface (tools + resources + prompts), DB-backed, authed, audited
`backend/src/ai/mcp-server.ts` is a **real MCP server exposing all three protocol primitives** — not just knowledge. It is the platform's governed AI contract: enterprise customers get **security, separation of concerns, and auditability** on this one layer. Use the **official `@modelcontextprotocol/sdk`** (TS): it supports tools + resources + prompts, **dynamic `setRequestHandler` lists computed at request time** (so everything can be DB-backed — no static-registration limit, `list_changed` available), streamable-HTTP transport, and auth helpers. (Chosen over `@prefecthq/fastmcp-ts`, which is tool-centric and lacks dynamic lists / the other primitives.) Ideas (not code) from `nonagenticai_mcp_server`: store tools **and prompts** in the DB with version history + tenant isolation; audit every call; token auth at the server. The three primitives:

- **Tools** (`tools/list` + `tools/call`) — actions the agent (and external clients) can invoke:
  - *Platform tools* (code): `validate_flow` (reuse `exec/flow-validate.ts`), `run_flow` (reuse `host/run-controller.ts`), `publish_block`/`version_block`, and the **flow-edit tools** (`add_node`/`insert_node`/`remove_node`/`connect_nodes`/`disconnect_nodes`/`configure_node`/`move_node`) — in a browser session these are fulfilled by the Layer-3 co-pilot; `backend/src/ai/flow-edit-service.ts` (owner-scoped + audited + snapshotting, shared validation) is the **headless fallback** for browserless clients.
  - *Customer-authored extension — via BLOCKS, not a second tool table.* This was originally specified as *DB-defined tools* (the `nonagenticai_mcp_server` pattern): rows in `mcp_tools` merged into a dynamic `tools/list`, dispatched by name, new tools with no redeploy. **That is not what shipped, and deliberately so** — the tables were dropped in 0052. What shipped is the same capability through `building_blocks` + `block_versions` (tenant-scoped RLS, versioned, RBAC'd), authored end-to-end over MCP with `create_block`, `save_block_version`, `lint_block`, `simulate_block`, `run_block_test`, `publish_block` and `propose_block_patch`. A customer still adds executable behaviour to their tenant with no redeploy — it just arrives as a published block that runs in the **sandbox**, with a linter and a test runner in front of it, rather than as a bare `impl` blob with neither. A second, unsandboxed extension mechanism competing with that one was the wrong trade.
    *If MCP-native custom tools are genuinely wanted later* (an external client wanting a customer's block to appear as a first-class entry in `tools/list`), the right build is a **thin projection of an already-PUBLISHED block** into `tools/list` — descriptor I/O becomes `inputSchema`, `tools/call` dispatches into the existing sandbox runner. That needs no `mcp_tools` table and inherits the governance for free.
- **Resources** (`resources/list` + `resources/read`, URI-addressable) — the knowledge surface: blocks (`block://<slug>@<version>` → descriptor I/O + docs), datasets/data (`data://<dataset>` → schema/sample), and **the book/getting-started content per locale** (`doc://book/<chapter>?lang=…`). Read-only; dynamic from the DB.
- **Prompts** (`prompts/list` + `prompts/get`) — reusable, **DB-stored, versioned, tenant-scoped, per-locale** prompt templates in `mcp_prompts` (+ versions): the agent's system prompt + flow-authoring instructions + named prompts. The agent (Layer 1) genuinely fetches its system prompt from here at request time — this is not a `mcp_tools`-style trap; every seeded row is read end-to-end and rendered (`ai/mcp/prompts.ts` → `routes/mcp.ts` `prompts/list`/`prompts/get`, verified against the 24 live prod rows). **What is not built: authoring.** `db/seed-ai.ts`, run at backend startup, is the only writer anywhere in the codebase — no route, MCP tool, or UI ever inserts/updates a row, so despite the schema's tenant-override support (a `tenant_id`-scoped row wins over the global one, RLS-enforced) zero tenant-scoped rows have ever existed. Changing a prompt today means editing the seed constant and shipping a deploy — the opposite of what this section originally promised ("enterprise can review/customise them ... without a redeploy"). Corrected: prompts are a **governable-by-construction, but not yet customisable, asset** — enterprise can *see* them via `prompts/list`/`prompts/get` (auditable, DB-backed) but cannot review/edit them without a code change. Building real authoring (RBAC-gated update route(s) + version bump, mirroring `blocks/authoring-service.ts`'s write-core-shared-by-routes-and-MCP pattern) is straightforward if ever prioritized — it just hasn't been asked for or built.

**Auth + audit at the MCP layer (the enterprise point):** every request is Keycloak-JWT / license-token authed and tenant-scoped; every `tools/call`, `resources/read`, and `prompts/get` writes an `audit_log` row (actor, tenant, primitive, name, input hash, status, correlation id). One throat to choke for AI governance. External MCP clients (Claude Desktop, other platform agents) hit the same streamable-HTTP endpoint and get exactly this surface.

### Layer 3 — Execution: frontend co-pilot (primary UX, full puppeteering)
The desired experience: the agent **operates the builder in the browser**. Edit tool-calls are fulfilled by a frontend **agent-driver** (`frontend/src/lib/agent/driver.ts` + a synthetic-cursor overlay component) that performs the *real* interaction — move the cursor to the palette, drag a block onto the canvas, select a node, open its **real** properties panel, focus the field and **type** the value, drag from one port handle to another — then commits through the **same builder-store actions the user's own clicks use**, so validation, autosave (`PATCH /api/flows`), undo, and `flow_snapshots` are identical for human and agent.
- **No `@ag-ui/*` SDK, no `STATE_DELTA`.** The canvas is reactive to the builder store, so when the store mutates (by user *or* agent-driven action) the canvas redraws — that is "agent edits, canvas follows" without a state-push channel. We keep only the lightweight *frontend-tool round-trip* idea (the genuinely useful half of AG-UI / fr's custom stream), implemented ourselves.
- **Robustness rule:** the **mutation is authoritative; the puppetry is a cosmetic overlay.** If the driver can't locate an element (layout change, hidden panel), it **degrades to instant-apply** of the same store action. Correctness never depends on the animation.

### Agent loop (TS-native, type-safe, provider-agnostic)
`POST /api/agent/chat` opens an SSE stream and runs the loop in `backend/src/ai/agent.ts`: assemble the tool catalogue (MCP knowledge tools + the frontend edit tools) → `provider.chat({ messages, tools, responseSchema, … })` on the tenant's selected adapter → on `final_answer` stream the assistant message and finish; on `tool_calls`, for each call:
- **backend tool** (knowledge/validate/run) → execute via MCP `tools/call`, append the result, continue;
- **frontend tool** (edit) → emit a `frontend-tool-call` SSE event; the browser puppeteers + commits + POSTs the result to `/api/agent/chat/:turnId/tool-result`; the loop awaits it, appends, continues.
Bounded by max-iterations + wall-clock (mirror fr's `loop.ts`). Persist the transcript to `chat_messages`. **The system prompt is fetched from the MCP prompt registry** (Layer 2) for the user's locale (§5B) — it teaches the flow model, type rules, "prefer minimal diffs", and "validate before run" — so it is governable + localizable, not hardcoded. Swapping Anthropic ↔ OpenAI ↔ DeepSeek changes only the adapter — the loop is untouched.

**Auth (mirror fr's two-token model):** Keycloak user JWT → `POST /api/agent/session/issue` → short-lived agent token (HS256 via `jose`, already a dep) as Bearer on the chat + tool-result endpoints. Table `agent_sessions`.

### Stub-first (scaffold)
Session 0 ships the substrate with a **deterministic stub provider** (no real LLM): on a message it returns one canned `tool_calls` (`search_blocks`) then a `final_answer`, exercising the whole path end-to-end — MCP knowledge tool + a frontend edit tool that puppeteers one `add_node` + the SSE chat stream — before any real provider is wired. Session 7 plugs in the real adapters + system prompt; nothing else moves.

### Honest notes
- **Provider abstraction is the point.** The interface is stable; vendors aren't. Chat-Completions-compatible (OpenAI / DeepSeek / most) share one adapter; Anthropic gets its own; OpenAI Responses API and others are future adapters. Per-tenant selection + BYO key.
- **Full puppeteering is the most frontend work and the most fragile** (your call) — mitigated by the *mutation-authoritative, puppetry-cosmetic, instant-apply-fallback* rule. Build it as a thin layer over real components; never let animation gate correctness.
- MCP is the **full enterprise surface** (tools + resources + prompts), DB-backed + authed + audited; the **interactive editing UX is frontend-driven** (Layer 3), with backend edit tools as the headless fallback.
- Using the **official `@modelcontextprotocol/sdk`** (not fastmcp-ts) buys dynamic `setRequestHandler` lists → tools/resources/prompts are all computed from the DB at request time, so a row *already in the DB* appears in `list`/`get` output immediately, no redeploy. That's true for prompts today. It is not the same as saying prompts can be *authored* without a redeploy — see the Layer 2 note above: the only writer is the startup seed, so getting a new/changed row into the DB currently still requires a code change + deploy.
- A reactive canvas replaces a state-push channel; DB `flows.graph` is the source of truth.
- Contract test: the agent's resolved tool catalogue (MCP platform + DB tools + edit tools) matches what the MCP server advertises + the frontend driver implements.

---

## 5B. Internationalization — 8 book editions (incl. 2 RTL)

The Common Practice book ships in **eight language editions** and the app must match them: **English, Dutch, Polish, French, Spanish, German, Arabic, Hebrew**. Arabic + Hebrew are **right-to-left (RTL)** — a first-class concern, not a coat of paint. i18n is scaffolded from Session 0 so it is never retrofitted; `fr/` has no i18n framework to mirror, so we set the house pattern here.

- **Locales:** `en, nl, pl, fr, es, de, ar (RTL), he (RTL)`. A `locale` store drives `<html lang dir>`; `dir="rtl"` for ar/he.
- **Frontend i18n:** type-safe, tree-shakeable message catalogs — **Paraglide (inlang)** recommended (compile-time, typed message keys; falls back to `svelte-i18n` if a runtime catalog is preferred). One catalog per locale under `frontend/messages/<locale>.json`. A locale switcher in the topbar; locale persisted per user + negotiated from `Accept-Language`.
- **RTL:** lay out with **CSS logical properties** (`margin-inline-start`, `inset-inline`, `text-align: start`) and Tailwind logical utilities, not left/right, so the design tokens (§6) flip cleanly. Mirror directional icons; keep the SvelteFlow canvas LTR (graphs are direction-neutral) while chrome flips. Verify ar/he in the webapp-testing pass.
- **Content (the book / getting-started):** the `docs`/book screens render localized chapters; book content is served per locale as MCP **resources** (`doc://book/<chapter>?lang=…`, §5A Layer 2) and/or a `content_translations` table. Covers already exist per edition (`nonagentic_homepage/book/cover_<LANG>.png`).
- **User-generated content** (challenges, solutions, block docs): store a `locale` per record; translation is optional/best-effort in v1 (a `content_translations` side table keyed by `(entity_type, entity_id, locale)` when needed).
- **Agent localization:** the agent replies in the user's locale; its system + authoring prompts come from the MCP **prompt registry per locale** (`mcp_prompts` rows keyed by `locale`), so localizing the assistant is a data change, not code.
- **Honest note:** 8 locales + 2 RTL + localized book content is real, ongoing effort. v1 lands the *framework* + UI strings + the book in all 8; deep translation of user-generated content is incremental.

---

## 6. Design system

Port `demo.html`'s `:root` tokens (demo.html:21–70) verbatim into `frontend/src/lib/styles/tokens.css`: color palette (midnight/teal/coral/amber/emerald/violet), fonts (Fraunces display, IBM Plex Sans, JetBrains Mono), radii, shadows. Rebuild the recurring primitives as Svelte components: sidebar + persona switch, topbar/search, `nav-item`, `stat`, `card`, `badge`, `chip`, `toggle`, `tabs`, `block-card`, `block-tile`, `flow-node`, `kanban` col/card, `feed`/audit item, `code-area` (syntax-highlighted), `console`. Tailwind 4 for layout; tokens via CSS vars (don't fight the demo's exact look).

---

## 7. Session plan (multi-session delivery)

Each session ends with: green `bun test` + `svelte-check` + lint locally, a short status note, and a working demoable slice.

**Session 0 — Scaffold & rails + AI substrate + i18n**
- Create `commonpractice/` (frontend+backend), `git init`, mirror fr tooling (`.tool-versions` bun 1.3.x, package.json scripts, Dockerfiles, `bunfig.toml`, drizzle config). Port design tokens + base layout (sidebar/topbar/persona switch, routing shell) **with RTL-safe logical properties**. Wire Keycloak (frontend service + backend JWT middleware) with `VITE_AUTH_BYPASS` dev seam. Provision Postgres DB+user (CI `:5433`). `/health` endpoint. Confirm ports free locally + in docker.
- **i18n (native from scaffold — §5B):** Paraglide + the 8 locale catalogs (`en,nl,pl,fr,es,de,ar,he`), locale store + `<html lang dir>` (RTL for ar/he), topbar switcher, `Accept-Language` negotiation. Base layout strings localized.
- **AI substrate (native from scaffold — §5A):** `agent_sessions` + `tenant_llm_settings` + `mcp_prompts` tables + `POST /api/agent/session/issue` (Keycloak→agent token). `ai/llm/provider.ts` interface + a **stub provider** (no real LLM). `ai/mcp-server.ts` on **`@modelcontextprotocol/sdk`** (streamable-http, auth+audit) exposing all three primitives thinly: **tools** (`search_blocks`/`get_block`), **resources** (block/doc URIs), **prompts** (DB, per-locale; the agent's system prompt). `POST /api/agent/chat` SSE loop driven by the stub provider (canned `search_blocks` `tool_calls` then `final_answer`). Frontend `agent-chat.svelte.ts` store + a minimal chat panel rendering the SSE events.
- **Done = app boots, persona switch + locale switch (incl. an RTL locale) work, `/health` green, auth bypass logs you in; a chat message round-trips the SSE loop through the stub provider + the MCP tools/resources/prompts surface (authed + audited).**

**Session 1 — Building blocks library + editor (read/write CRUD)**
- `building_blocks` + `block_versions` schema + migrations + seed (~15 demo blocks). Backend `/api/blocks` (list/filter/get) + `/api/blocks/:slug/versions` (create draft, publish, version history). Frontend `blocks` grid (filters/sort) + `block-edit` screen (tabs: Documentation/Implementation/Examples/Permissions/Usage; markdown editor+preview; code editor; I/O descriptor editor; version history; permissions toggles). Save-time `static-scan.ts` validation. **Done = publish/version a real TS block end-to-end, persisted as JSONB.**

**Session 2 — Build canvas (SvelteFlow) + flow persistence**
- `@xyflow/svelte` canvas: blocks palette (drag-to-add), typed input/output ports/handles, edges, node config panel. `flows` schema + `/api/flows` CRUD (graph as JSONB, autosave "last saved 12s ago"). Port the build topbar (Test run / Share / Submit). **Establish the single edit path:** a reactive builder store whose mutation actions (`addNode`/`connectNodes`/`configureNode`/…) back both the user's clicks and the agent's frontend tools; `flow_snapshots` table; the frontend `agent/driver.ts` co-pilot harness (stub: instant-apply, puppeteer animation lands in Session 7). **Done = compose a flow manually *and* see the stub agent drive one `add_node` through the same store, canvas reactively redraws.**

**Session 3 — Execution engine + live test run**
- Implement `exec/` runner (`runner-entry`, `flow-executor`, `block-loader`, `descriptor`, `sdk`) + `host/` (`run-controller`, `sse-stream`, `llm-broker`, `usage_counters`). `POST /api/runs` + SSE `/api/runs/:id/stream`. Frontend run-trace store + console panel + per-node live status (matches demo console). Enforce network-strip, RLIMIT_AS, timeouts, LLM broker cap. `flow_runs` persistence. **Done = "Test run" really executes a TS flow and streams a real trace; governance caps enforced; verified on Linux.**

**Session 4 — Sandboxes + platform dashboard (Ops, thin)**
- `sandboxes` deepened; `it-dash` + `sandboxes` screens (status, cost, pause/inspect, idle auto-suspend watchdog). **Done = sandbox lifecycle visible + governable.**

**Session 5 — Marketplace (Challenge + Solution leaderboards)**
- `challenges`/`solutions`/`votes`/`weekly_winners` schema + `/api/challenges`, `/api/solutions`, `/api/votes`. Screens: home, challenges + detail, submit, solutions + detail, winner, docs. Solution links to a `flow`. **The `docs`/getting-started screen serves the book in all 8 editions** (MCP `doc://book/...?lang=` resources / `content_translations`), with per-locale covers (`book/cover_<LANG>.png`). **Done = full challenge→solution→vote→winner loop; book readable in all 8 languages incl. RTL.**

**Session 6 — Production pipeline + governance + audit**
- `pipeline_items`, `policies`(+`policy_changes`), `audit_log`. Screens: pipeline kanban (drag between stages), governance (live-editable policies that actually gate execution from Session 3), audit feed. Write audit entries from all mutating actions. **Done = policies edited here change runtime behavior; every action audited.**

> **Retrofit task (do before Session 7 — the current S0–S6 build predates the AI-substrate + i18n directives).** The shipped scaffold has only a scripted `ChatPanel` stub, no agent/MCP, and no i18n. Backfill the Session-0 + Session-2 substrate into the existing code: add `tenant_llm_settings`/`agent_sessions`/`mcp_prompts`/`mcp_tools`/`chat_sessions`/`chat_messages`/`flow_snapshots`/`content_translations`; `ai/` (`llm/provider.ts` + stub provider, `mcp-server.ts` on `@modelcontextprotocol/sdk` with tools+resources+prompts + auth+audit, `mcp/`, `block-catalog-service.ts`, `flow-edit-service.ts`, `agent.ts`); `POST /api/agent/chat` (SSE) + session endpoints; the reactive builder store + `agent/driver.ts`; replace `ChatPanel` with the SSE-driven chat; **add Paraglide i18n + the 8 locales + RTL** and convert existing screens to logical properties. Land as one (or two: substrate / i18n) focused PR(s) before real providers.

**Session 7 — Real reasoning (swap stub provider → real adapters + co-pilot) — see §5A**
- Implement the **provider adapters** (`ai/llm/adapters/anthropic.ts`, `openai.ts` incl. `baseURL` for DeepSeek/compatible) behind `LlmProvider`; wire `tenant_llm_settings` selection + BYO key; meter via `host/llm-broker.ts`; keys host-side only.
- Full agent loop: tool catalogue = MCP tools (platform + DB) + frontend edit tools; frontend-tool round-trip (`/api/agent/chat/:turnId/tool-result`); **system prompt pulled from the MCP `mcp_prompts` registry for the user's locale**; persist transcript to `chat_messages`. Seed the per-locale flow-authoring prompts across the 8 editions.
- **Full puppeteering** in `agent/driver.ts`: synthetic cursor, open real properties panel, type into fields, drag-to-connect; **instant-apply fallback** if an element can't be located.
- Add remaining edit + validate/run tools; contract test (agent tool catalogue ⟷ MCP `tools/list` + driver-implemented edits); external MCP client can read/validate/run + author headless.
- **Done = a user types a request and watches the agent build/edit a valid, runnable flow in the builder; manual + AI edits share `flows.graph`; provider swap (Anthropic↔OpenAI↔DeepSeek) changes only config; caps enforced.**

**Session 8 — Hardening + deploy**
- Containerize the runner for true isolation (the deferred §5 milestone). gitops manifests, flux, cloudflared host, CI. **Done = deployed at `commonpractice.nonagentic.ai`, container-isolated execution.**
- **Shipped (2026-06-06):** live at **`commonpractice-app.nonagentic.ai`** (the bare
  `commonpractice.nonagentic.ai` is the marketing homepage; 2-level `app.*` hosts have no
  edge cert here). Runner isolation shipped as **pod-level hardening**, NOT container-per-run
  — the cluster has no gVisor/Kata; see the §5 "Isolation posture" note. This is an
  **accepted, documented deferral**, so the "container-isolated execution" Done-criterion is
  amended to "**kernel-boundary-hardened, network-isolated execution**".

**Completion pass (2026-06-06) — closing the post-deploy SPEC gaps**
- **Real block-level reasoning:** `LLM_MODE=openai_compatible` routes the runner's
  `ctx.llm()` through the OpenAI-compatible adapter to the in-cluster inference-router, so a
  flow "Test run" does **real** inference (not the mock); the broker still meters + caps.
- **i18n:** the 7 non-en UI catalogs (`nl,pl,fr,es,de,ar,he`) are **really translated**
  (machine pass, correct CLDR plural categories incl. ar/he RTL), replacing the EN
  placeholders. A native/vendor QA pass remains reasonable.
- **Book:** the getting-started chapter is authored in EN and translated into all 8 editions,
  served per-locale via the `doc://book/getting-started?lang=` MCP resource
  (`content_translations`, migration 0010) and the i18n-driven `/docs` screen. (v1 book = the
  getting-started chapter; multi-chapter editions + localized cover art remain out of scope.)

**Final SPEC closeout (2026-06-07) — the last remaining items (no container isolation)**
- **Provider streaming (§5A Layer 1):** `LlmProvider.stream()` is now implemented (Anthropic +
  OpenAI-compatible + stub adapters); chat streams token-by-token via the inference-router. The
  broker reserves the daily-call slot up front (`brokerChatStream`) then settles `spend_usd`
  post-stream, so the daily-call cap stays strict while the weekly-spend ceiling is enforced to
  the last-completed call (stated tradeoff; non-streaming `brokerChatCall` keeps single-txn
  atomicity).
- **BYO-key settings UI:** the `/llm-settings` platform-gated screen (provider/model/baseUrl/
  params + masked API key) over the already-shipped `GET/PUT /api/llm-settings` (encrypted at
  rest). The key is never returned to the client (`hasKey` indicator only).
- **Deep i18n of user content (§5B):** `/api/challenges` + `/api/solutions` overlay
  title/description/business_impact via `content_translations` negotiated from `Accept-Language`
  (frontend attaches `locale.current`), EN fallback intact; demo challenge/solution translations
  seeded **in code** (`db/seed-marketplace-i18n.ts`, resolved by title since the rows carry
  random UUIDs — so it also rides the auto-seed boot path), not a static SQL migration. Block
  docs stay English (canonical library).
- **Auto-seed on boot:** `seedAll()` runs idempotently after migrations when `SEED_DEMO_DATA=true`
  (set in prod gitops), so a cold prod DB self-heals its showcase catalogue + marketplace.
- **i18n leak cleanup:** the block-category labels + the agent-chat store strings are now catalog
  keys (`category_*`, `chat_*`) across all 8 locales.

---

## 8. Verification (per session, end-to-end)
- **Backend:** `bun test` (unit + integration against ephemeral Postgres `:5433`), `bunx tsc --noEmit`. Health: `curl :8790/health`.
- **Frontend:** `vitest run`, `svelte-check`, `bun run build`.
- **Builder smoke (Session 3+):** seed a block → compose a 3-node flow → `POST /api/runs` → watch SSE trace reach `run_complete status=ok`; confirm a flow that calls network with `network:false` is blocked; confirm exceeding the daily LLM cap is rejected by the broker.
- **Docker (when asked to test in docker):** fresh containers, postgres CI DB up, hit `/health`, run a flow.
- **No CI green-washing:** report actual failures with output; never claim done on a red run.

---

## 9. Open items — RESOLVED (confirmed live as of 2026-06-07)
- **Project name/location + repo:** `commonpractice/`, GitHub `nonagenticai/commonpractice`. ✓
- **Keycloak realm/client:** confirmed live against the cluster (portal-realm; backend client
  `commonpractice-backend`). ✓
- **Ports:** backend **8790**, frontend **3000** (the dev `5174` candidate moved to 3000 in
  gitops; docker-availability confirmed). ✓
- **Seed-data fidelity:** reproduce the demo's exact sample blocks/challenges (the 12 demo blocks
  + marketplace), now auto-seeded idempotently on boot (`SEED_DEMO_DATA`). ✓
- **Known limitation (documented, not open):** the 2-level `app.commonpractice.*` host has no edge
  cert (Cloudflare Total TLS / a Zone token), so the app is served at
  `commonpractice-app.nonagentic.ai`. Container/Job-per-run isolation stays deferred (no
  gVisor/Kata on the cluster) — pod-level hardening is the v1 posture.
