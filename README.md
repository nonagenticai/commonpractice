# Common Practice

Internal "Leaderboards" platform — employees post challenges, colleagues compose
solutions from reusable building blocks on a visual canvas, the org votes, and a
weekly winner ships through a governed production pipeline.

Turning `../nonagentic_homepage/demo.html` (static mockup) into a real app.
Build spec: [`SPEC.md`](./SPEC.md). Mirrors the `../fr/` house stack
(SvelteKit 5 + Bun + Drizzle + Postgres 18).

## Status — shipped & live ✅

All of the build spec is delivered and running in production at
**`commonpractice-app.nonagentic.ai`**: Sessions 0–8 (scaffold → blocks → canvas →
execution → sandboxes → marketplace → governance/pipeline → real LLM adapters →
hardening/deploy) plus the Phase 2 roadmap (2.0–2-H: test-data subsystem, live DB
connectors, per-block tests, container isolation, enterprise admin, weekly cadence,
compliance export, deep i18n, flow history). What runs:

- Backend on **:8790** (`/health`, `/api/me`); 24 live route modules across both
  personas; Drizzle migrations + idempotent demo seed on boot.
- Frontend on **:5174** (dev) / **:3000** (prod), `/api/*` proxied; SvelteFlow build
  canvas, full design system, 8-locale i18n (incl. RTL `ar`/`he`).
- Postgres 18 (bare-metal in prod; local docker on `:5433` for dev/CI).
- **Real Keycloak SSO** against the `portal` realm — no `AUTH_BYPASS` in production
  (the prod config gate rejects it). Public host is Keycloak-gated end-to-end.
- AI substrate: real Anthropic/OpenAI(-compatible) adapters behind a provider seam
  with per-tenant BYO keys (AES-256-GCM at rest), official MCP SDK transport, and an
  in-browser co-pilot. Keyless dev defaults to a deterministic stub.
- Flow execution runs untrusted block TS in a Bun subprocess (dev/CI/self-host) or a
  **Kata pod-per-run** (`RUN_BACKEND=k8s`) for hard per-session isolation in-cluster.

Build spec: [`SPEC.md`](./SPEC.md) (+ [`SPEC-PHASE2.md`](./SPEC-PHASE2.md)). Deployment:
[`deploy/ONPREM.md`](./deploy/ONPREM.md).

## Run it locally

```bash
# 1. Postgres (local docker, host :5433)
docker compose up -d db

# 2. Backend (:8790)
cd backend
cp -n .env.example .env
bun install
bun run migrate          # apply migrations/0001_init.sql
bun run dev              # http://localhost:8790/health

# 3. Frontend (:5174) — in another shell
cd frontend
cp -n .env.example .env
bun install
bun run dev              # http://localhost:5174
```

Open http://localhost:5174 — `VITE_AUTH_BYPASS=true` logs you in as a dev user
with both personas. Toggle **Employee / Platform** in the sidebar to switch the
nav group + identity.

## Verify

```bash
# backend
cd backend && bunx tsc --noEmit && bun test
curl localhost:8790/health        # {"ok":true,"db":"up"}
# frontend
cd frontend && bun run check && bun run test && bun run build
```

## Layout

- `backend/` — Bun.serve + Router + Drizzle/postgres-js. `src/host/` + `src/exec/`
  (execution engine) arrive in Session 3.
- `frontend/` — SvelteKit 5 (runes). `src/lib/flow/` (SvelteFlow canvas) arrives
  in Session 2.
- `docker-compose.yml` — dev Postgres only.

## Ports

| Service  | Port | Notes |
|----------|------|-------|
| backend  | 8790 | never 8000 |
| frontend | 5174 | dev |
| postgres | 5433 | host → container 5432 (local docker) |

## Licensing

The code in this repository is Apache-2.0 and needs no licence key to build, test or run locally.

In production the application enforces two gates. Gate 1 is identity: a Keycloak session resolves
who the caller is and which tenant they belong to. Gate 2 is entitlement and is **opt-in** —
`LICENSE_GATE_2_ENABLED` defaults to `false`, and while it is off the service never contacts a
licences server. Turning it on requires `LICENSE_GATE_2_ENABLED=true` plus `LICENSE_INTROSPECT_URL`
and `LICENSE_APP_KEY`; a deployment that sets the flag without those fails at startup rather than
serving unlicensed traffic.

With Gate 2 enabled, enforcement is fail-closed: no stored token returns `402 license_required`, an
unreadable token `402 license_unreadable`, and an unreachable licences service `402
license_unavailable` — an outage denies, never admits.

The licensing stack is open source too — [`licenses`](https://github.com/nonagenticai/licenses)
(entitlements, plans and tokens) and [`license-authz`](https://github.com/nonagenticai/license-authz)
(the Envoy `ext_authz` enforcement point). Neither is required to run this code.

## License

Apache-2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
