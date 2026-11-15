// src/blocks/source-gate.ts — the ONE place block source is admitted, for writing or for running.
//
// ⛔ THE CLAIM THIS MAKES TRUE. `policy_desc_models_code_exec_outside_blocks` tells a compliance
// reader that under `models.code_exec_outside_blocks` "arbitrary code/eval is banned at save time
// and refused at run time". Before this module NEITHER half was true: `saveVersionCore`,
// `createBlockCore` and `addVersionCore` wrote `source_ts` with no check at all, and
// `runOneBlockTest` / `simulateBlockVersion` handed a DRAFT's `source_ts` straight to
// `exec/block-loader.ts`, which transpiles and `import()`s it. The only call site of `lintBlock`
// was `publishVersionCore` — a gate on the one path that was already the most careful.
//
// ⛔ SCAN ONLY, NEVER `lintBlock`. `lintBlock` = `scanBlockSource` (regex + a Bun transpile, ~0.1ms)
// ⊕ `typeCheckBlockSource` (a real tsc Program, ~80–100ms). A TYPE error is a quality problem, not
// a safety rule: `inputs.rows.lenght` is a bug, not an escape from the sandbox, and paying 100ms of
// tsc on every keystroke-driven draft save — and on every test in a suite — to report it would be a
// latency regression bought with nothing. The tsc half stays exactly where it was: the publish gate
// and the advisory editor lint route.
//
// ⛔ POLARITY. `models.code_exec_outside_blocks` is seeded FALSE and false means NOT ALLOWED, so
// enforcement is ACTIVE when the snapshot reads `false`. An operator who flips it to true has
// declared that arbitrary code may run; the gate then mints without refusing, because refusing
// would be enforcing a policy the operator switched off. The scan still RUNS in that case — only
// the throw is suppressed — so the behaviour is one branch, not two code paths.
import { scanBlockSource } from '../exec/static-scan';
import { getSnapshot } from '../host/policy-store';
import { unprocessable } from '../utils/http';
import { log } from '../host/logger';
import { EMPTY_SCANNED_SOURCE, type ScannedSource } from './scanned-source';

export { EMPTY_SCANNED_SOURCE, type ScannedSource };

/**
 * A gate finding, shaped as a `LintFinding` with `source: 'scan'`.
 *
 * ⛔ THE SHAPE IS THE CONTRACT, NOT A CONVENIENCE. `publishVersionCore` has always thrown
 * `unprocessable('lint_failed', 'Block failed lint', { findings })` with `LintFinding[]`, and the
 * browser renders each one through `frontend/src/lib/i18n/scan-finding-label.ts`, which branches on
 * `source` FIRST and then on `rule`. Emitting a bare `ScanFinding` (no `source`) would fall into the
 * `'type'` branch's negation by accident and, worse, would be a second wire shape for one concept.
 * Nothing new is added to the scan vocabulary HERE — this module emits whatever `static-scan.ts`
 * declares, and the eight message files are kept in step by
 * `frontend/src/lib/i18n/scan-finding-label.backend-contract.test.ts`, which scrapes that table and
 * reds when a rule has no localized sentence.
 */
export interface SourceGateFinding {
  source: 'scan';
  rule: string;
  message: string;
  line?: number;
  spec?: string;
  detail?: string;
}

/** Run the fast layer and return the findings in `LintFinding` shape. Never throws. */
export function scanSourceFindings(source: string): SourceGateFinding[] {
  return scanBlockSource(source).findings.map((f) => ({
    source: 'scan' as const,
    rule: f.rule,
    message: f.message,
    line: f.line,
    spec: f.spec,
    detail: f.detail,
  }));
}

/**
 * ⛔ BYTE-IDENTICAL TO `publishVersionCore`'s THROW, INCLUDING THE MESSAGE.
 *
 * Prod runs both containers in ONE Deployment at 2 replicas, so a rollout serves a NEW frontend
 * from an OLD backend and vice versa for the length of the roll. The browser's 422 handling keys on
 * the code string `lint_failed` and reads `findings` off the body; the message is the last-resort
 * fallback. Inventing a second sentence for the same failure would give the same event two English
 * strings depending on which pod answered, which is exactly the drift the catalog split exists to
 * prevent — and it would need a ninth catalog key for nothing.
 */
const refuse = (findings: SourceGateFinding[]): never => {
  throw unprocessable('lint_failed', 'Block failed lint', { findings });
};

/**
 * UNCONDITIONAL gate — scan, throw on any finding, mint on success.
 *
 * For the paths that have no governance context and must never depend on one: the SEEDERS (which
 * run before/while the `policies` rows exist, and whose sources ship in the product image) and
 * `deriveDataBlock` (generated code — a finding there is a compiler bug, not an author's mistake).
 * A seed that trips this fails `bun run seed` loudly, which is the point: the four seeders wrote
 * `published`/`stable` versions that had never been scanned by anything.
 */
export function requireScannedSource(source: string): ScannedSource {
  if (!source) return EMPTY_SCANNED_SOURCE;
  const findings = scanSourceFindings(source);
  if (findings.length > 0) refuse(findings);
  return source as ScannedSource;
}

/**
 * POLICY-AWARE gate — the one every author-facing write and every draft RUN goes through.
 *
 * Throws `unprocessable('lint_failed', …, { findings })` — byte-identical in shape to what
 * `publishVersionCore` already throws, so `frontend/src/lib/api/blocks.ts` and the block editor's
 * existing 422 handling work with no frontend change.
 */
export async function assertBlockSourceSafe(source: string): Promise<ScannedSource> {
  if (!source) return EMPTY_SCANNED_SOURCE;
  // ⛔ SCAN FIRST, POLICY SECOND, AND THAT ORDER IS THE LATENCY ANSWER. `getSnapshot()` is a 5s-TTL
  // cache over a `policies` SELECT, so a cache miss is a DB round trip. Reading it unconditionally
  // would put that round trip on EVERY draft save — including the first save after any 5s idle,
  // which is most of them for a human typing in an editor. Ordering it behind `findings.length > 0`
  // means the CLEAN path (every save that is going to succeed) adds a sub-millisecond regex pass and
  // ZERO queries; the snapshot is only consulted to decide whether a source that ALREADY tripped the
  // scan should be refused, which is rare and already an error path.
  const findings = scanSourceFindings(source);
  if (findings.length === 0) return source as ScannedSource;

  // ⛔ FAIL CLOSED, DELIBERATELY. If the governance read fails we cannot know whether the operator
  // switched enforcement off, and the two ways to be wrong are not symmetric: failing OPEN silently
  // reinstates the exact lie this workstream exists to remove (a banned source written while the
  // policy screen still says it cannot be), while failing CLOSED refuses a save that trips the scan.
  // The second is also nearly free here: this gate sits IN FRONT of a write to the same database
  // `getSnapshot()` just failed to read, so "the DB is briefly unavailable" is not a state in which
  // the save could have succeeded anyway. It is not "no developer can save" — a clean source never
  // reaches this line.
  let allowed = false;
  try {
    allowed = (await getSnapshot()).codeExecOutsideBlocks === true;
  } catch (err) {
    log.warn('governance_read_failed', { component: 'source-gate', err });
  }
  if (allowed) return source as ScannedSource;
  return refuse(findings);
}
