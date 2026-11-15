-- 0112 — a tenant can go BACK to the platform default (PLAN-2026-10-14-ux-cleanup.md § W7 task C).
--
-- 0110 gave a tenant its own cadence override (`tenant_cycle_cadence`, no row = inherit the platform
-- `cycle.cadence` policy). PATCH /api/tenant/cycle-cadence {value: null} reverts to inheriting. That
-- switch obeys the same rule as every other one: it takes effect at the NEXT period boundary, never
-- by opening a partly-elapsed period. When the platform's cadence cannot take over at once (the
-- tenant was off, or its running period still has to reach a boundary of the platform's kind) the
-- row has to carry the pending switch until then — but a row means "pinned", so it needs a marker:
--
--   tenant_cycle_cadence.follows_platform          the row only CARRIES a pending return to the
--                                                  platform default. Once `effective_from` has passed
--                                                  (or with none) the tenant inherits exactly as with
--                                                  no row, and a platform switch moves it.
--   tenant_cycle_cadence_changes.follows_platform  the history entry IS a return to the platform
--                                                  default: from it on the catch-up replays the
--                                                  platform trail again (host/cycle-cadence.ts
--                                                  `mergeTenantChanges`).
--
-- FORWARD-ONLY, idempotent (startup on every replica). Adding a NOT NULL column with a constant
-- default is metadata-only on pg ≥ 11. Same fail-fast lock ceiling as 0107/0110.
SET LOCAL lock_timeout = '5s';

ALTER TABLE tenant_cycle_cadence
  ADD COLUMN IF NOT EXISTS follows_platform boolean NOT NULL DEFAULT false;
ALTER TABLE tenant_cycle_cadence_changes
  ADD COLUMN IF NOT EXISTS follows_platform boolean NOT NULL DEFAULT false;
