// src/exec/dataset-resolver.ts — serves injected dataset rows by slug inside the runner.
//
// A SEPARATE MODULE ON PURPOSE. This logic belongs to runner-entry.ts, but that file strips the
// network globals (`delete globalThis.fetch`, WebSocket, XMLHttpRequest, EventSource) at module
// load — that stripping IS its sandbox, and it has to happen before anything else is imported.
// Importing runner-entry from a test therefore disarms `fetch` for the whole `bun test` process,
// and every later test file that touches it dies with `ReferenceError: fetch is not defined`. That
// is not hypothetical: doing exactly that turned CI red across 42 delivery/egress tests while the
// same suite passed locally, because file order decides who gets poisoned. Keep testable logic out
// of runner-entry.

import type { BlockErrorRule, BlockErrorDetail } from '../db/trace-types';

/** A dataset the host resolved, capped and PII-redacted before injecting it into the run. */
export interface InjectedRows {
  rows: Record<string, unknown>[];
}

/**
 * "That slug is not a dataset here" — as a rule + its English + its tokens.
 *
 * ⛔ THE SENTENCE BELOW IS A PRODUCT SENTENCE AND IT REACHES A BROWSER, through `ctx.dataset()` →
 * `node_error.error`. It shipped raw in all eight locales because `BlockErrorRule` had no group for
 * this file. TWO rules, not one with an optional parameter: "…is not available here" and "…is not
 * available here; these are: a, b or c" are two different sentences, and the union's own rule is
 * ONE MEMBER PER SENTENCE. A single member would have to fall back to English for the
 * empty-workspace case, which is a real runtime state and not an archive artefact.
 *
 * ⛔ A DATA CARRIER, NOT A DISCRIMINATOR — same contract as `BlockModuleError`. `flow-executor.ts`
 * converts it into a refusal sentinel inside `ctx.dataset`, before the throw reaches author code;
 * `classify` trusts only that sentinel's identity. Forging this class from a block buys nothing.
 */
export class DatasetUnavailableError extends Error {
  constructor(
    readonly rule: BlockErrorRule,
    message: string,
    readonly detail: BlockErrorDetail,
  ) {
    super(message);
    this.name = 'DatasetUnavailableError';
  }
}

/**
 * Serve injected dataset rows by slug.
 *
 * A slug the host did not inject is an ERROR, not an empty result. This used to be
 * `datasets[slug]?.rows ?? []`, which collapsed "this workspace has no dataset called X" into
 * "X has no rows" — so a derived data block dragged onto the canvas by a tenant that lacks the
 * sample it defaults to (every global ontology block defaults to a DEMO-tenant dataset) just
 * emitted `count: 0` and the flow carried on over empty input. No failure, no warning, nothing to
 * debug: the block looked like it worked.
 *
 * A genuinely EMPTY dataset still returns `[]` — the host injected it and its rows really are
 * empty. Only an ABSENT slug throws, and the message names what this workspace does have, because
 * the fix is almost always "point the block's source at one of your own datasets".
 */
export function makeDatasetResolver(
  datasets: Record<string, InjectedRows>,
): (slug: string) => Record<string, unknown>[] {
  return (slug: string) => {
    const injected = datasets[slug];
    if (!injected) {
      // ⛔ THE AVAILABLE SLUGS SHIP AS AN ARRAY, never as a joined string. `a, b and c` is an
      // ENGLISH list — separator and final conjunction are both language-specific — and the seam is
      // gone the instant it is joined. Same reason `field_must_be_one_of` carries `options`, and
      // the browser rebuilds both with `Intl.ListFormat`.
      const known = Object.keys(datasets);
      throw known.length
        ? new DatasetUnavailableError(
            'dataset_not_available_alternatives',
            `dataset '${slug}' is not available in this workspace (available here: ` +
              `${known.join(', ')}). Point the block's source at one of your own datasets, or ` +
              `upload this one.`,
            { dataset: slug, options: known },
          )
        : new DatasetUnavailableError(
            'dataset_not_available',
            `dataset '${slug}' is not available in this workspace. Point the block's source at ` +
              `one of your own datasets, or upload this one.`,
            { dataset: slug },
          );
    }
    return injected.rows;
  };
}
