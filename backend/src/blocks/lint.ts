// src/blocks/lint.ts — Phase 2-B: the single block-source quality check the editor
// and the publish gate both consume. It unifies the two static layers:
//   * scanBlockSource  — safety + syntax (import allowlist, banned globals, parse).
//   * typeCheckBlockSource — real `tsc` type errors against the SDK types.
// (The third layer, descriptor output-conformance, is BEHAVIOURAL and lives in the
//  test runner — it needs the block's actual output, not just its source.)
import { scanBlockSource } from '../exec/static-scan';
import { typeCheckBlockSource } from './type-check';

export interface LintFinding {
  /**
   * 'scan' = static safety/syntax, 'type' = tsc type-check.
   *
   * ⛔ THIS IS THE DISCRIMINANT THE BROWSER BRANCHES ON FIRST. The `scan` vocabulary is CLOSED —
   * thirteen rules, all declared in `static-scan.ts` — so it can be translated. The `type` half is
   * not: `rule` is a `TS####` code and `message` is tsc's own English diagnostic, an unbounded set
   * no catalog can ever cover. `scanFindingLabel` returns a `type` finding's message verbatim.
   */
  source: 'scan' | 'type';
  rule: string;
  message: string;
  line?: number;
  col?: number;
  /** Scan-only: the module specifier, for the three import rules. See `ScanFinding.spec`. */
  spec?: string;
  /** Scan-only: the transpiler's own error text, for `syntax`. See `ScanFinding.detail`. */
  detail?: string;
}

export interface LintResult {
  ok: boolean;
  findings: LintFinding[];
}

export function lintBlock(source: string): LintResult {
  const findings: LintFinding[] = [];

  const scan = scanBlockSource(source);
  for (const f of scan.findings) {
    // `spec`/`detail` are forwarded, not re-derived: they are the only way the browser can
    // interpolate a module specifier or a parser error into a localized sentence.
    findings.push({
      source: 'scan',
      rule: f.rule,
      message: f.message,
      line: f.line,
      spec: f.spec,
      detail: f.detail,
    });
  }

  const types = typeCheckBlockSource(source);
  for (const d of types.diagnostics) {
    findings.push({
      source: 'type',
      rule: `TS${d.code}`,
      message: d.message,
      line: d.line,
      col: d.col,
    });
  }

  return { ok: findings.length === 0, findings };
}
