# Common Practice — on-prem / own-cluster deployment

Common Practice is built to run on **its own cluster or on-prem at a customer**, with minimal,
*documented* dependencies. Nothing in the app code assumes the `strato` cluster — every cluster
dependency below is vanilla Kubernetes plus, for hard per-session isolation, a **Kata RuntimeClass**.

## Minimal dependencies

| Dependency | How the app uses it | Env |
|---|---|---|
| **PostgreSQL 18** (bundled or external) | the one datastore; self-migrates on boot | `DATABASE_URL` |
| **Keycloak or any OIDC** | request auth (JWKS-verified `Bearer` tokens) | `KEYCLOAK_URL` / `KEYCLOAK_ISSUER` |
| **An AI provider over API** | per-tenant BYO key (encrypted) or an env fallback | tenant settings; `OPENAI_*` / `ANTHROPIC_*` |
| **Isolation runtime** (recommended) | one Kata-isolated Pod per flow run | `RUN_BACKEND` / `RUN_RUNTIME_CLASS` (below) |

No in-cluster inference-router, pgbouncer, Istio, or private registry is required — those are
strato conveniences, not app requirements. Point the env at whatever the target cluster provides.

## Run isolation (Phase 2-C)

A flow run executes **untrusted block/AI code**. The host delivers work over a stdio protocol; the
runner never gets DB or network access. Two backends, selected by `RUN_BACKEND`:

- **`subprocess`** (default) — a `Bun.spawn` child inside the backend pod. Fine for dev, CI, and
  single-node/self-host. Isolation = process + the pod's NetworkPolicy (best-effort).
- **`k8s`** — **one Kata-isolated Pod per run**. The host drives the run pod with the **`kubectl`
  binary** (bundled in the image; `create` → `wait` → `attach` → `delete`) and attaches to its
  stdin/stdout **over the API server** (control plane), so the run pod keeps **zero network egress
  and no secrets/ServiceAccount token**. A user session's AI/block code cannot reach the network
  out-of-the-box, and the Kata VM boundary contains a kernel escape. This is the multi-tenant default.
  *(kubectl rather than an in-process client because Bun's HTTPS stack cannot reach a k3s apiserver.)*

### Cluster prerequisites for `RUN_BACKEND=k8s`

1. **A Kata RuntimeClass** named per `RUN_RUNTIME_CLASS` (recommended `kata`). Install `kata-runtime`
   on the nodes + register the handler in containerd, then create the `RuntimeClass`. *(Leaving
   `RUN_RUNTIME_CLASS` empty falls back to the cluster default runtime — weaker, documented degrade.)*
2. **A runs namespace** (`RUN_NAMESPACE`, default `commonpractice-runs`) with a **default-deny-egress
   NetworkPolicy** and PSS `restricted`.
3. **RBAC** so the backend can manage run pods: a `ServiceAccount` bound to a `Role` in the runs
   namespace granting `pods: create/get/list/delete/watch`, `pods/attach: create`, `pods/log: get`.
   Set the backend Deployment `serviceAccountName` + `automountServiceAccountToken: true`.
4. **Env**: `RUN_BACKEND=k8s`, `RUN_NAMESPACE=…`, `RUN_RUNTIME_CLASS=kata`, `RUN_IMAGE=<this backend image>`
   (the run pod runs `bun run /app/src/exec/runner-entry.ts` from the same image).

> Cold-start: a Kata run pod adds ~1–3 s (schedule + VM boot) over the in-pod subprocess. Acceptable;
> warm-pooling is a future optimization.

## Run-backend env reference

| Env | Default | Meaning |
|---|---|---|
| `RUN_BACKEND` | `subprocess` | `subprocess` \| `k8s` |
| `RUN_NAMESPACE` | `commonpractice-runs` | namespace the run pods are created in |
| `RUN_RUNTIME_CLASS` | `` (empty) | `kata` for VM isolation; empty = cluster default runtime |
| `RUN_IMAGE` | `` | runner image ref (required for `k8s`) — same as the backend image |
| `RUN_CPU_LIMIT` | `1` | per-run CPU limit |
| `RUN_MEM_MB` | `512` | per-run memory limit (cgroup `memory.max`) |
| `RUN_MEMORY_REQUEST_MB` | `256` | per-run Kubernetes memory request, capped at `RUN_MEM_MB`; independent of the execution limit. Strato uses `64`, based on measurements of small tool executions. RuntimeClass overhead is added separately. |
| `RUN_MAX_MS` / `RUN_MAX_NODE_MS` / `RUN_IDLE_MS` | `30000` / `15000` / `20000` | Run / per-node / host-silence backstops. **Derived, not independent**: the ladder `maxNodeMs < idleMs < maxRunMs` is enforced by flooring each against the one below, so setting one may raise another (a warning naming both values is logged at boot). `RUN_IDLE_MS` defaults to `RUN_MAX_NODE_MS + 5000`, not a flat 10000 — a silence watchdog that fires before the per-node budget it supervises kills healthy runs and cannot report what it killed. |

## Compliance export (Phase 2-F)

The append-only `audit_log` is the system-of-record for every mutating action. A **boot-only,
in-process scheduler** archives each UTC day's audit rows (plus that day's `policy_changes` count) as
a **tamper-evident NDJSON bundle** — `audit_log.ndjson` + a `manifest.json` carrying its **sha256** —
to an object store, giving a compliance reviewer (ISO 27001 / GDPR / DORA) a durable, verifiable
archive instead of audit history living only in Postgres. Each run is recorded in `audit_exports`,
whose `UNIQUE(export_date)` makes a missed / double / restart fire harmless.

- **No cron framework, no k8s CronJob** — the scheduler is in-process and re-arms itself, so it
  replays on any cluster. **Default OFF** is the graceful degrade (audit stays queryable in Postgres).
- **Target = any S3-compatible store or storage proxy.** On strato this is the platform
  `storage_service` (MinIO proxy) over `POST /api/files/upload`; in-cluster **trusted-network
  pass-through** means a plain `X-Tenant-Id` (no token). Off-cluster / on-prem, supply
  `AUDIT_EXPORT_TOKEN` (sent as `X-Tenant-Id: Bearer <token>`).
- A platform user can also pull on demand: `POST /api/audit/export { date? }`. The governance screen
  surfaces the real last-export status (date · status · rows · object key · sha256).
- Egress is SSRF-guarded (loopback/link-local/metadata refused) independently of the user-connector
  egress policy; in-cluster the NetworkPolicy already pins egress to the Service CIDR.

### Compliance-export env reference

| Env | Default | Meaning |
|---|---|---|
| `AUDIT_EXPORT_ENABLED` | `false` | master switch for the nightly scheduler |
| `AUDIT_EXPORT_HOUR_UTC` | `2` | hour (UTC) the nightly run fires |
| `AUDIT_EXPORT_STORAGE_URL` | `` | storage base URL, e.g. `http://storage-api.example.com:8391` |
| `AUDIT_EXPORT_BUCKET` | `artifacts` | target bucket (`compliance` once provisioned on the store) |
| `AUDIT_EXPORT_KEY_PREFIX` | `audit` | object-key prefix → `<prefix>/YYYY/MM/DD/{audit_log.ndjson,manifest.json}` |
| `AUDIT_EXPORT_TOKEN` | `` | license token for non-trusted / on-prem stores (sent as `Bearer`) |
