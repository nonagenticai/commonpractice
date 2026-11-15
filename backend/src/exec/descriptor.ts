// src/exec/descriptor.ts — runtime field validation for a block's typed I/O.
// Deliberately hand-rolled (NO zod): this runs inside the untrusted subprocess,
// where we keep the dependency surface minimal. Mirrors the FieldType set in
// db/block-types.ts. Inputs enforce `required`; outputs validate the shape of
// whatever the block actually returned (an absent non-required output is fine —
// a present one of the wrong type is a bug worth surfacing as node_error).
//
// ⛔ EVERY MESSAGE HERE IS PRODUCT ENGLISH THAT A BROWSER RENDERS. It reaches the reader twice:
// through `node_error.error` in /build's run console, and through `block_test_results.error` in
// /block-edit's test + simulate panels. Both used to print it raw in all eight locales. So each
// check now returns a `FieldIssue` — the ENGLISH byte for byte, PLUS the `rule` and the machine
// tokens the browser needs to write its own sentence (`frontend/src/lib/i18n/
// block-test-error-label.ts`). The English is not dead weight: `ai/mcp/tools.ts` ships it verbatim
// to an LLM, "Fix with AI" seeds a prompt with it, and `tests/descriptor.test.ts` pins eight of
// these strings character for character.
//
// ⛔ `detail` MUST BE PLAIN JSON. This module runs in the untrusted subprocess and everything it
// returns crosses the NDJSON boundary to the host. An `Error` object in the bag serialises to `{}`.
import type { BlockDescriptor, FieldSpec } from '../db/block-types';
import type { BlockErrorRule, BlockErrorDetail, FieldIssue } from '../db/trace-types';

export interface FieldCheck {
  ok: boolean;
  /**
   * ⛔ KEPT, NOT REPLACED. Three live callers read this array and none of them wants the objects:
   * `flow-executor.ts:151,158` join it into an Error message, `test-runner.ts` joins it into a test
   * verdict, and `tests/descriptor.test.ts` asserts `errors[0]`. `issues[i].message` is the SAME
   * string, so the two arrays are always the same length and the same order.
   */
  errors: string[];
  /** The machine half of each entry in `errors`. Added; nothing was taken away. */
  issues: FieldIssue[];
}

/**
 * The ONE place a field refusal is born — the rule, its English, and its tokens together.
 *
 * ⛔ NOTHING IN THIS FILE MAY RETURN A BARE MESSAGE STRING. That is what
 * `block-test-error-label.backend-contract.test.ts` enforces (`return '…'` count must be zero), so
 * a twelfth check added here cannot ship as untranslatable English by accident: writing it the
 * obvious way reds CI and names the literal.
 */
function issue(rule: BlockErrorRule, message: string, detail?: BlockErrorDetail): FieldIssue {
  return detail ? { rule, message, detail } : { rule, message };
}

/**
 * Validate one value against its FieldSpec. Returns an error string or null.
 *
 * ⛔ THE `string | null` CONTRACT IS LOAD-BEARING AND IS DELIBERATELY UNCHANGED.
 * `datasets/ontology-validation.ts:94` does `if (validateField(column, spec, v) !== null)` and
 * DISCARDS the string — it only wants the boolean. Widening the return type there would be churn
 * for a caller that reads nothing. `validateFieldIssue` below is the sibling that carries the
 * machine fields; this is a thin projection of it.
 */
export function validateField(
  name: string,
  spec: FieldSpec,
  value: unknown,
): string | null {
  return validateFieldIssue(name, spec, value)?.message ?? null;
}

/** Validate one value against its FieldSpec. Returns the full `FieldIssue` or null. */
export function validateFieldIssue(
  name: string,
  spec: FieldSpec,
  value: unknown,
): FieldIssue | null {
  const f: BlockErrorDetail = { field: name };
  switch (spec.type) {
    case 'string':
      return typeof value === 'string'
        ? null
        : issue('field_must_be_string', `'${name}' must be a string`, f);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : issue('field_must_be_number', `'${name}' must be a finite number`, f);
    case 'boolean':
      return typeof value === 'boolean'
        ? null
        : issue('field_must_be_boolean', `'${name}' must be a boolean`, f);
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? null
        : issue('field_must_be_string_array', `'${name}' must be a string[]`, f);
    case 'enum':
      // ⛔ THE OPTIONS SHIP AS AN ARRAY, and the English keeps its `[a, b, c]` join. A joined list
      // is an ENGLISH list — the separator and the final conjunction are language-specific — so the
      // browser rebuilds it with `Intl.ListFormat`. Joining here and localising later is impossible;
      // the seam is gone the moment the string is built.
      return spec.enum && spec.enum.includes(value as string)
        ? null
        : issue('field_must_be_one_of', `'${name}' must be one of [${(spec.enum ?? []).join(', ')}]`, {
            ...f,
            options: [...(spec.enum ?? [])],
          });
    case 'json':
      // Any defined value is acceptable JSON (objects, arrays, primitives).
      return value === undefined ? issue('field_required', `'${name}' is required`, f) : null;
    case 'dataset':
      // The config value is a dataset slug (string). The host resolves the rows.
      return typeof value === 'string' && value.length > 0
        ? null
        : issue('field_must_be_dataset', `'${name}' must be a dataset slug`, f);
    default:
      return issue('field_unknown_type', `'${name}' has unknown field type`, f);
  }
}

/** Assemble the two parallel arrays from a list of issues. */
function check(issues: FieldIssue[]): FieldCheck {
  return { ok: issues.length === 0, errors: issues.map((i) => i.message), issues };
}

/** Validate a block's inputs. Missing required fields are errors; absent
 *  optional fields are skipped; present fields are type-checked. */
export function validateInputs(
  inputs: Record<string, unknown>,
  descriptor: BlockDescriptor,
): FieldCheck {
  const issues: FieldIssue[] = [];
  for (const [name, spec] of Object.entries(descriptor.inputs)) {
    const present = inputs[name] !== undefined && inputs[name] !== null;
    if (!present) {
      if (spec.required)
        issues.push(
          issue('input_missing_required', `missing required input '${name}'`, { field: name }),
        );
      continue;
    }
    const bad = validateFieldIssue(name, spec, inputs[name]);
    if (bad) issues.push(bad);
  }
  return check(issues);
}

/** Validate a block's returned outputs. Only declared outputs that are present
 *  are type-checked; a declared-but-absent output is tolerated (a block may not
 *  emit every output on every path). Required outputs must be present. */
export function validateOutputs(
  outputs: Record<string, unknown>,
  descriptor: BlockDescriptor,
): FieldCheck {
  if (outputs === null || typeof outputs !== 'object') {
    return check([issue('output_not_object', 'block did not return an output object')]);
  }
  const issues: FieldIssue[] = [];
  for (const [name, spec] of Object.entries(descriptor.outputs)) {
    const present = outputs[name] !== undefined && outputs[name] !== null;
    if (!present) {
      if (spec.required)
        issues.push(
          issue('output_missing_required', `missing required output '${name}'`, { field: name }),
        );
      continue;
    }
    const bad = validateFieldIssue(name, spec, outputs[name]);
    if (bad) issues.push(bad);
  }
  return check(issues);
}
