// src/routes/ops.ts — the platform Ops dashboard endpoint (Session 4, it-dash).
// Platform-gated. One call returns every widget's data (stat cards, 24h sparkline,
// most-used blocks, needs-attention, recent events) — all real aggregates from
// host/ops-metrics.ts.
import { requireSuperAdmin } from '../middleware/admin-guards';
import { jsonResponse, route } from '../utils/http';
import { getDashboard } from '../host/ops-metrics';
import { runAsSystem } from '../db/client';
import type { Router } from '../utils/router';

const dashboard = route(async (req) => {
  await requireSuperAdmin(req);
  return jsonResponse(await runAsSystem('platform-admin', () => getDashboard()));
});

export function registerOpsRoutes(router: Router): void {
  router.add('GET', '/api/ops/dashboard', dashboard);
}
