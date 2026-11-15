// src/routes/governance.ts — the platform "Governance" surface (Session 6).
// Platform-gated. GET returns the policy rails grouped for the screen + the static
// compliance panel + the recent policy_changes. PATCH edits a policy's value: it
// validates per control type, writes a policy_changes diff (old→new), records a
// policy.change audit row, and INVALIDATES the policy cache so the edit changes
// runtime behaviour immediately (the broker / idle-sweep / run-gate read the store).
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, policies, policyChanges, users, auditExports, runAsSystem } from '../db/client';
import { isLockTimeout, switchCadence } from '../host/cycle-service';
import { CADENCE_POLICY_KEY } from '../host/cycle-cadence';
import { isCadence } from '../host/period';
import type { Policy, PolicyValue, AuditExport } from '../db/schema';
import { config } from '../config';
import { requireSuperAdmin } from '../middleware/admin-guards';
import { jsonResponse, readJson, route, notFound, badRequest, conflict, unprocessable } from '../utils/http';
import { invalidatePolicyCache } from '../host/policy-store';
import { policyEnforcement, isRetiredPolicy } from '../host/policy-enforcement';
import { auditActorId, recordAudit } from '../host/audit-service';
import type { Router } from '../utils/router';

// The four rail groups. `category` is the machine key the screen renders from
// (frontend/src/lib/i18n/policy-label.ts `policyGroupTitle`); `title` is English prose kept on
// the wire for the same old-frontend reason as COMPLIANCE.label below, and read by nothing.
const GROUPS: { category: string; title: string }[] = [
  { category: 'data_isolation', title: 'Data & isolation' },
  { category: 'spend_quota', title: 'Spend & quotas' },
  { category: 'models_tools', title: 'Models & tools' },
  { category: 'promotion', title: 'Promotion to production' },
  // 0107: the marketplace voting cycle (`cycle.cadence`). Its row is written at boot, not seeded.
  { category: 'marketplace', title: 'Voting cycle' },
];

// Static compliance panel (display-only — not a real attestation engine; S6 honest).
//
// ⚠️ `key` / `statusKey` are the FIELDS THE SCREEN READS. `label` / `status` are English prose
// this process cannot localize — the server does not know, and must not know, who is reading —
// and they are kept on the wire ONLY so an OLD frontend deployed against a NEW backend keeps
// rendering something. They are deleted one deploy after the frontend stops reading them; see
// frontend/src/lib/i18n/compliance-label.ts, which owns the words, and
// routes/governance/governance-page.i18n.render.test.ts, which fails if the panel reads the prose again.
//
// `statusKey` is deliberately NOT unique per row: ISO 27001 and DORA are both `passing` and must
// resolve to the same word. `key` is the row identity (and the frontend {#each} key).
const COMPLIANCE = [
  { key: 'iso27001', label: 'ISO 27001 controls', statusKey: 'passing', status: 'Passing', tone: 'ok' },
  { key: 'gdpr', label: 'GDPR data flows', statusKey: 'documented', status: 'Documented', tone: 'ok' },
  { key: 'dora', label: 'DORA operational resilience', statusKey: 'passing', status: 'Passing', tone: 'ok' },
  {
    key: 'eu_ai_act',
    label: 'EU AI Act risk profile',
    statusKey: 'reassess',
    status: 'Re-assess in 21d',
    tone: 'warn',
  },
];

function initialsOf(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return (p.length === 1 ? p[0]!.slice(0, 2) : p[0]![0]! + p[p.length - 1]![0]!).toUpperCase();
}

function exportDto(e: AuditExport) {
  return {
    date: e.export_date,
    status: e.status,
    rowCount: e.row_count,
    objectKey: e.object_key,
    bucket: e.bucket,
    sha256: e.sha256,
    bytes: e.bytes,
    triggeredBy: e.triggered_by,
    error: e.error,
    finishedAt: e.finished_at,
    createdAt: e.created_at,
  };
}

export function policyDto(p: Policy, now: Date = new Date()) {
  return {
    key: p.key,
    category: p.category,
    label: p.label,
    description: p.description,
    control: p.control,
    value: p.value,
    options: p.options,
    unit: p.unit,
    enabled: p.enabled,
    /**
     * WHAT BACKS THIS RAIL — 'enforced' | 'applied' | 'architectural' | 'retired'.
     *
     * ⛔ ONLY 'retired' IS READ-ONLY. 'applied' rails (a canary percent, a tier→model map, a price
     * table) change what happens on the next run or call, so they MUST stay writable — the PATCH
     * guard below is keyed on `isRetiredPolicy`, deliberately not on "is not enforced". A rail that
     * refuses nothing is not thereby a rail nobody may edit.
     *
     * ⛔ ON THE WIRE, NOT INFERRED IN THE BROWSER. The screen's whole claim is that these rails are
     * enforced, and four of the eighteen are not. A frontend-side list of which is which would be a
     * second copy of a fact only the backend can know, drifting the moment an enforcement point
     * moves — the same mistake as the `?? policy.label` fallback this DTO's prose fields exist to
     * warn about. `policy-enforcement.ts` is the one source; the contract test proves it against
     * the actual consumers of each snapshot field.
     */
    enforcement: policyEnforcement(p.key),
    /**
     * When the PLATFORM's pending switch of this rail takes over (today only `cycle.cadence`, 0107),
     * else null. ⛔ Read from the policy row, never from GET /api/cycle/cadence: that endpoint answers
     * for the CALLER'S TENANT (0110), so an operator whose own workspace overrides the cadence was
     * shown their workspace's switch date under the platform rail.
     */
    effectiveFrom: p.effective_from && p.effective_from.getTime() > now.getTime() ? p.effective_from : null,
  };
}

// GET /api/governance — grouped policies + compliance + recent changes.
const getGovernance = route(async (req) => {
  await requireSuperAdmin(req);
  const rows = await db.select().from(policies).orderBy(policies.sort);

  const groups = GROUPS.map((g) => ({
    category: g.category,
    title: g.title,
    policies: rows.filter((r) => r.category === g.category).map((r) => policyDto(r)),
  })).filter((g) => g.policies.length > 0);

  const changeRows = await db
    .select({
      id: policyChanges.id,
      policyKey: policyChanges.policy_key,
      oldValue: policyChanges.old_value,
      newValue: policyChanges.new_value,
      createdAt: policyChanges.created_at,
      actorName: users.name,
    })
    .from(policyChanges)
    .leftJoin(users, eq(policyChanges.changed_by, users.id))
    .orderBy(desc(policyChanges.created_at))
    .limit(8);

  const labelByKey = new Map(rows.map((r) => [r.key, r.label]));
  const recentChanges = changeRows.map((c) => ({
    id: c.id,
    policyKey: c.policyKey,
    label: labelByKey.get(c.policyKey) ?? c.policyKey,
    oldValue: c.oldValue,
    newValue: c.newValue,
    actor: c.actorName ? { name: c.actorName, initials: initialsOf(c.actorName) } : null,
    createdAt: c.createdAt,
  }));

  // Real, data-backed compliance evidence (Phase 2-F): the nightly audit-log export
  // status. Unlike the declared `compliance` panel, this is sourced from audit_exports.
  const exportRows = await db
    .select()
    .from(auditExports)
    .orderBy(desc(auditExports.export_date))
    .limit(8);
  const exportStatus = {
    enabled: config.auditExport.enabled,
    bucket: config.auditExport.bucket,
    hourUtc: config.auditExport.hourUtc,
    lastRun: exportRows[0] ? exportDto(exportRows[0]) : null,
    recent: exportRows.map(exportDto),
  };

  return jsonResponse({ groups, compliance: COMPLIANCE, recentChanges, exportStatus });
});

const patchSchema = z.object({ value: z.unknown() }).strict();

/**
 * `list` rails an operator may not EMPTY from this route, because on those rails an empty list is
 * not a tighter setting — it is the absence of the control.
 *
 * ⛔ THE MECHANISM IS FAIL-**OPEN**, AND THE FIRST VERSION OF THIS COMMENT HAD IT EXACTLY BACKWARDS.
 * `llm-broker.ts` `reserveCall` gates on `allowlist && allowlist.length > 0 && !allowlist.includes(model)`
 * — that `length > 0` means an EMPTY list SKIPS the check and EVERY model is permitted. So clearing
 * the "Allowlisted models" box does not refuse every request (the claim this docblock, the refusal
 * message and two test comments all used to make); it switches the model gate OFF, silently, from a
 * text input, on the one screen whose entire claim is that governance is enforced.
 *
 * "Absent/empty = no restriction" is a DELIBERATE contract that four modules document and that this
 * floor does not change — it only stops the PATCH route from being how you reach it:
 *   - `routes/llm-settings.ts` (the save-time mirror, `length > 0` and all: "a check that disagrees
 *     with the enforcer is worse than no check"),
 *   - `ai/llm/pricing.ts` `findUnallowlistedCatalogModels` (nothing can be missing from "no list"),
 *   - `host/allowlist-reconcile.ts` `planAllowlistReconcile` → the `skipped_empty` branch, which is
 *     now UNREACHABLE FROM THIS ROUTE but still reachable from direct SQL and from a freshly seeded
 *     row nobody has edited. That is fine; see the matching note there, and keep the two in step.
 *
 * ⚠️ SCOPED BY KEY, NOT "NO LIST MAY BE EMPTY", and the distinction is load-bearing — the two rails'
 * enforcers are opposite shapes. `data.egress_allowlist` is checked by `egress-guard.ts`
 * `hostAllowlisted` → `allowlist.some(...)`, which over `[]` is `false` for EVERY host: empty there
 * really is deny-all, that rail's TIGHTEST setting and the one hardening move it exists for (its own
 * seeded description reads "Empty = no external host is reachable"). A blanket rule would forbid it
 * and be "fixed" by deleting this guard.
 */
const NON_EMPTY_LISTS = new Set(['models.allowlist']);

/** Validate the incoming value against the policy's control type. */
function validateValue(p: Policy, raw: unknown): PolicyValue {
  switch (p.control) {
    case 'toggle':
      if (typeof raw !== 'boolean') throw unprocessable('invalid_value', 'expected a boolean');
      return raw;
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
      if (!Number.isFinite(n) || n < 0) throw unprocessable('invalid_value', 'expected a number ≥ 0');
      return n;
    }
    case 'select': {
      const s = String(raw);
      if (!(p.options ?? []).includes(s)) throw unprocessable('invalid_value', `expected one of ${(p.options ?? []).join(', ')}`);
      return s;
    }
    case 'list': {
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
        throw unprocessable('invalid_value', 'expected a string[]');
      }
      // Dedupe: duplicate values would collide in the value-keyed {#each value as m (m)}
      // badge render (PolicyRow.svelte) and crash the page with each_key_duplicate.
      const list = [...new Set(raw as string[])];
      if (!list.length && NON_EMPTY_LISTS.has(p.key)) {
        throw badRequest(
          'empty_allowlist',
          `'${p.key}' cannot be emptied here — an empty list removes the model gate entirely and the ` +
            `broker then permits every model. Keep at least one model on the list.`,
        );
      }
      return list;
    }
    case 'map': {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw unprocessable('invalid_value', 'expected an object of string values');
      }
      const entries = Object.entries(raw as Record<string, unknown>);
      if (entries.some(([k, v]) => !k.trim() || typeof v !== 'string' || !v.trim())) {
        throw unprocessable('invalid_value', 'every key must map to a non-empty string');
      }
      // The key SET is fixed by the seeded row (e.g. work tiers are exactly small/medium/large):
      // an edit may change the values, never invent or drop a key, since consumers resolve by key.
      const allowed = new Set(Object.keys((p.value ?? {}) as Record<string, unknown>));
      if (allowed.size) {
        const keys = entries.map(([k]) => k);
        if (keys.length !== allowed.size || keys.some((k) => !allowed.has(k))) {
          throw unprocessable(
            'invalid_value',
            `expected exactly these keys: ${[...allowed].join(', ')}`,
          );
        }
      }
      return Object.fromEntries(entries.map(([k, v]) => [k, (v as string).trim()]));
    }
    default:
      throw unprocessable('invalid_control', `unknown control ${p.control}`);
  }
}

// PATCH /api/governance/:key — edit a policy; the headline of Session 6.
const patchGovernance = route(async (req, key) => {
  const actor = await requireSuperAdmin(req);
  const body = patchSchema.parse(await readJson(req));
  const [policy] = await db.select().from(policies).where(eq(policies.key, key!));
  if (!policy) throw notFound('policy_not_found', `No policy '${key}'`);

  /**
   * ⛔ A RETIRED RAIL ACCEPTS NO EDIT — AND THE REFUSAL BELONGS HERE, NOT ONLY IN THE BROWSER.
   *
   * `data.eu_only` claimed EU residency that nothing in this codebase ever checked. The claim is
   * withdrawn: the screen renders the rail read-only with honest copy. But /governance is a
   * compliance surface reachable by curl and by any admin script, and the ONE thing that must not
   * happen is a fresh `policy_changes` diff + `policy.change` audit row recording that somebody
   * "turned EU-only execution off" — a change to a control that has never controlled anything.
   * That trail would be indistinguishable from a real hardening decision.
   *
   * The ROW is deliberately left in place (`policy_changes.policy_key` is a foreign key onto
   * `policies.key` with ON DELETE CASCADE, so deleting it would destroy real recorded history), and
   * it is still returned by GET so an auditor reading an old change log can still see what the
   * withdrawn rail was called. It is simply no longer writable.
   */
  if (isRetiredPolicy(policy.key)) {
    throw unprocessable(
      'policy_retired',
      `'${policy.key}' is a retired rail: nothing in the platform enforces it, so it no longer ` +
        `accepts edits. It is kept read-only so recorded changes against it still resolve.`,
    );
  }

  const newValue = validateValue(policy, body.value);
  // `let`: the cadence path replaces it with the value `switchCadence` read UNDER the row lock.
  let oldValue = policy.value;

  // ⛔ AN IDENTICAL VALUE IS NOT A CHANGE, AND THE ROUTE IS THE ONLY PLACE THAT CAN SAY SO FOR EVERY
  // CLIENT. `PolicyRow.svelte`'s equality checks (commitList / commitNumber / commitMapEntry) close
  // the browser rail; curl, a script or any other admin client still reached the three writes below
  // and minted a `policy_changes` diff whose `old_value` was byte-identical to its `new_value`, plus
  // a `policy.change` row in `audit_log`. /governance is the compliance-credible surface — a trail
  // that records changes which did not occur devalues every real edit sitting next to them.
  //
  // Compared on the VALIDATED value, not on the request body, so `"15"` against a stored `15`, a
  // list with duplicates and a `map` with untrimmed values all normalize FIRST and are correctly
  // seen as no change.
  //
  // ⛔ AND BOTH SIDES ARE NORMALIZED, NOT JUST THE INCOMING ONE. Comparing the validated new value
  // against the RAW stored value silently did nothing for `select` rails: measured on a live
  // instance, `promotion.required_reviewers` reads back from the driver as the NUMBER `1` while
  // `validateValue`'s select branch yields the STRING `"1"` (its two siblings, `data.validation_mode`
  // and `spend.auto_suspend_idle`, read back as strings — so a test on either of those passes while
  // the third stays broken). `JSON.stringify(1) !== JSON.stringify("1")`, so the guard could never
  // fire there and every identical PATCH still minted a phantom diff. Round-tripping the stored
  // value through the same validator compares like with like.
  //
  // The stored value is re-validated defensively: a row written before a validator was tightened
  // can legitimately fail it, and that must not 500 an otherwise valid edit. Falling back to the raw
  // value merely means the comparison misses and we write — the safe direction.
  const sameAsStored = (stored: unknown): boolean => {
    let storedForCompare: unknown = stored;
    try {
      storedForCompare = validateValue(policy, stored as PolicyValue);
    } catch {
      /* stored value predates the current validator — compare raw, which errs towards writing */
    }
    //
    // ⚠️ THE COMPARISON ERRS TOWARDS WRITING, NEVER TOWARDS SWALLOWING. `JSON.stringify` is
    // key-ORDER sensitive and `validateValue`'s `map` branch rebuilds the object from the REQUEST's
    // key order, so `{b,a}` against a stored `{a,b}` still writes a no-op row. That is the safe
    // direction: two different values can never stringify the same, so a real edit cannot be dropped
    // here. Do not "fix" it by comparing loosely.
    return JSON.stringify(newValue) === JSON.stringify(storedForCompare);
  };
  // ⛔ THE COMPARISON RUNS UNDER THE ROW LOCK (`FOR UPDATE`, below), NEVER AGAINST THE PRE-READ ROW.
  // Compared before the lock, five parallel PATCHes answered 200 and recorded four changes: one
  // request saw a stored value that a concurrent PATCH then replaced, judged its own (different)
  // value "unchanged" and silently dropped it. A true no-op answers 200 with `changed: false` and
  // writes nothing (no diff, no audit row).

  // ⛔ `policies.updated_by` AND `policy_changes.changed_by` ARE BOTH FKs ONTO `users.id`, and this
  // route gates on `requireSuperAdmin` -> `authenticateWithoutLicense`, which never calls
  // `ensureUser`. A super_admin granted directly in Keycloak has NO local `users` row, so
  // `actor.id` raised 23503 and `route()` handed server.ts a non-HttpError it renders as a bare
  // 500: /governance was unusable for exactly the operators most likely to edit a policy, and the
  // error named nothing. Both columns are nullable, so `auditActorId` degrades the attribution to
  // System rather than losing the edit — the acting subject is preserved in the audit `metadata`
  // below. Same seam and same trade as routes/onboarding.ts and routes/translations.ts.
  const actorRowId = await auditActorId(actor.id);

  const recordChange = (database: typeof db) =>
    database.insert(policyChanges).values({
      policy_key: policy.key,
      old_value: oldValue,
      new_value: newValue,
      changed_by: actorRowId,
    });

  let changed = true;
  if (policy.key === CADENCE_POLICY_KEY && isCadence(newValue)) {
    // ⛔ THE CADENCE IS NOT A PLAIN VALUE WRITE. A change takes effect at the next period boundary:
    // `switchCadence` (host/cycle-service.ts) persists WHEN on the row (`effective_from` /
    // `previous_value`), stretches or restores the running period, records the `policy_changes` diff
    // (the history the catch-up replays — `old_value` read UNDER its `FOR UPDATE`, so two racing
    // PATCHes chain correctly) and sweeps stranded rows — in ONE transaction, so no replica (and no
    // boot catch-up) can observe a value without its switch. SYSTEM scope: the sweep spans every
    // tenant's challenges and solutions (RLS would silently narrow it to none).
    //
    // ⛔ BOUNDED WAIT. The daily tick holds the policy row `FOR SHARE` for its whole transaction;
    // `switchCadence` sets `lock_timeout` and a timeout answers 409 `cycle_busy` (retry in a moment)
    // instead of a request that hangs behind the tick.
    try {
      const r = await runAsSystem('platform-admin', () =>
        switchCadence(newValue, null, db, { updatedBy: actorRowId, unlessSame: sameAsStored }),
      );
      oldValue = r.oldValue as typeof oldValue;
      changed = r.changed;
    } catch (err) {
      if (isLockTimeout(err)) {
        throw conflict(
          'cycle_busy',
          'The voting cycle is being advanced right now. Try the change again in a moment.',
        );
      }
      throw err;
    }
  } else {
    changed = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as typeof db;
      const [locked] = await tx.select().from(policies).where(eq(policies.key, policy.key)).for('update');
      if (locked && sameAsStored(locked.value)) return false;
      if (locked) oldValue = locked.value;
      await tx
        .update(policies)
        .set({ value: newValue, updated_by: actorRowId, updated_at: new Date() })
        .where(eq(policies.key, policy.key));
      await recordChange(tx);
      return true;
    });
  }

  if (!changed) {
    const [fresh] = await db.select().from(policies).where(eq(policies.key, policy.key));
    return jsonResponse({ ...policyDto(fresh ?? policy), changed: false });
  }

  // The edit must change runtime behaviour at once — drop the cached snapshot.
  invalidatePolicyCache();

  await recordAudit({
    actorId: actor.id,
    action: 'policy.change',
    category: 'policy',
    targetType: 'policy',
    targetId: policy.key,
    result: 'Applied',
    resultTone: 'warn',
    // `actorSub` is the only carrier for WHO acted when `actorRowId` degraded to null above.
    metadata: { label: policy.label, oldValue, newValue, actorSub: actor.id },
  });

  const [updated] = await db.select().from(policies).where(eq(policies.key, policy.key));
  return jsonResponse({ ...policyDto(updated!), changed: true });
});

export function registerGovernanceRoutes(router: Router): void {
  router.add('GET', '/api/governance', getGovernance);
  router.add('PATCH', '/api/governance/:key', patchGovernance);
}
