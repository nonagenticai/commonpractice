// src/routes/health.ts — GET /health/live. The LIVENESS probe: a literal 200, no await, no
// dependency, no database.
//
// ⛔ WHY THIS EXISTS (commonpractice#308). The container's livenessProbe WAS wired at `/health`
// (gitops-production clusters/strato/services/commonpractice/deployment.yaml), and `/health` calls
// validateConnection() and answers 503 when Postgres is down. At `failureThreshold: 3` ×
// `periodSeconds: 20` that SIGTERMed the container 40-60s into a Postgres blip — and with
// `replicas: 2` sharing ONE Postgres, both replicas died together. A database blip became an outage
// of a service that was answering every request, and restarting a pod cannot make an unreachable
// database reachable.
//
// ✅ RESOLVED: gitops #3372 (2026-09-04) moved BOTH livenessProbe and startupProbe onto this
// endpoint, after it was proven to answer 200 in the RUNNING pod. readinessProbe deliberately stays
// on `/health`. This handler is now load-bearing in production — which is exactly why the
// "NOTHING MAY BE ADDED" block below is not decoration.
//
// Liveness means "this process is wedged and only a restart can help". Readiness means "this pod
// cannot serve right now". A dependency being down is the SECOND one. Conflating them turns every
// blip in a dependency into an outage of this service plus a restart that cannot possibly repair it.
// `/health` therefore stays readiness-shaped (deep, DB-gated) and `/ready` deeper still: depooling a
// pod whose database is gone is correct; killing it is not.
//
// ⛔ NOTHING MAY BE ADDED TO THIS HANDLER. Not a DB read, not a cache lookup, not a config probe,
// not a "cheap" await of anything. Every dependency added here is a new way for a pod that is
// serving perfectly to be killed, which is the exact defect this file exists to retire. If you want
// to report a subsystem's health, it belongs on /metrics as an alert — see the connector-LISTEN note
// above the `/health` route in server.ts.
//
// ⛔ WHY THIS IS A FILE AND NOT FOUR LINES INLINE IN server.ts NEXT TO `/health` AND `/ready`.
// server.ts is the entrypoint: importing it calls `Bun.serve`, runs migrations and arms every
// scheduler, so NO TEST CAN REACH A ROUTE DEFINED THERE (routes/metrics.ts carries the same note,
// for the same reason, and moved out for the same reason). The load-bearing claim about this
// endpoint is not "it returns 200" — it is "it returns 200 WITHOUT TOUCHING THE DATABASE", which is
// a claim about the HANDLER. Inline in server.ts it would have been untestable and therefore
// unproven, and an unproven shallow probe is how a kill probe ends up aimed at something that is
// not shallow after all. tests/health-live.test.ts dispatches this router entry.
//
// ⛔ THIS MODULE DELIBERATELY IMPORTS NOTHING FROM `../db`, AND THAT IS THE GUARANTEE, NOT A
// COINCIDENCE. tests/health-live.test.ts asserts it twice over: once by walking the transitive
// import graph from this file and requiring `db/client.ts` to be unreachable, and once at runtime by
// requiring the handler to settle before the event loop can turn (no I/O). `jsonResponse` is
// imported instead of a hand-rolled `new Response` to match every other route file here; its whole
// transitive graph is zod + node:async_hooks, and the import-graph test is what keeps it that way.
import { jsonResponse } from '../utils/http';
import type { Router } from '../utils/router';

/** The path the manifest's `httpGet.path` must carry. Kept as a constant so the test asserts the
 *  registered route against the literal the gitops probe uses, not against a re-typed copy. */
export const LIVENESS_PATH = '/health/live';

/** The SAME handler, mounted a second time where an OUTSIDE prober can actually reach it.
 *
 * ⛔ WHY A SECOND MOUNT AND NOT AN ISTIO RULE. Measured 2026-09-04 against the real public host
 * `commonpractice-app.nonagentic.ai`:
 *
 *     /health, /health/live, /ready  -> 404, and the body is the SPA's HTML
 *     /api/health, /api/health/live  -> 404 {"error":"Not Found"}   (JSON: the BACKEND answered)
 *
 * `commonpractice-public-vs` (gitops clusters/strato/istio/app-hosts/virtualservices.yaml) routes
 * `prefix: /api/` to commonpractice-backend:8790 with NO rewrite, and everything else to the
 * frontend. So the bare health paths hit the SPA catch-all and NO backend health endpoint was
 * reachable from outside at all. The alternative fix — an exact-match istio rule for /health/live —
 * was rejected on the estate rule "cluster is downstream of code, never upstream": do not
 * special-case a shared gateway to absorb an application's own routing gap. `/api/` is already this
 * service's public backend surface and already carries the X-App-Key header contract.
 *
 * ⛔ This exists so an EXTERNAL prober can tell "the backend is alive" from "the SPA still loads".
 * `/` returning 200 proves only that the frontend and the ingress chain are up — the SPA renders
 * fine with a completely dead backend, which is precisely the failure this must catch. */
export const PUBLIC_LIVENESS_PATH = '/api/health/live';

export function registerLivenessRoutes(router: Router): void {
  // No `await` in either handler, by contract. `async` only because Router's handler type is
  // `=> Promise<Response>`; the promise is already resolved when it is returned.
  //
  // ⛔ BOTH mounts must stay literal-200 and dependency-free. The in-cluster probe uses the first
  // and the external prober uses the second, so a dependency added here would simultaneously make
  // kubelet kill healthy pods AND page a human at 03:00. See the "NOTHING MAY BE ADDED" block above.
  router.add('GET', LIVENESS_PATH, async () => jsonResponse({ status: 'live' }, 200));
  router.add('GET', PUBLIC_LIVENESS_PATH, async () => jsonResponse({ status: 'live' }, 200));
}
