// src/exec/block-loader.ts — turn a block's stored TS source into an executable
// module, INSIDE the runner subprocess. Per SPEC §5: transpile with Bun.Transpiler
// (strips types, no type-checking), write to a real file under the per-run scratch
// dir (real paths → usable stack traces), then dynamic-import it. Transpiled output
// is cached by a hash of the source so the same block reused across nodes loads once.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BlockDescriptor } from '../db/block-types';
import type { BlockErrorRule, BlockErrorDetail } from '../db/trace-types';
import type { BlockContext } from './sdk';

export interface LoadedBlock {
  descriptor: BlockDescriptor;
  run: (inputs: Record<string, unknown>, ctx: BlockContext) => Promise<Record<string, unknown>>;
}

/**
 * The three ways a saved module can fail to BE a block — as a rule + its English + its tokens.
 *
 * ⛔ THESE ARE PRODUCT SENTENCES AND THEY REACH A BROWSER. `loadBlock` runs inside the runner
 * subprocess; a module that transpiles but exports the wrong shape errors the node, and the string
 * lands in `node_error.error` (/build's run console) and in `block_test_results.error`
 * (/block-edit's result panel). They shipped as untranslatable English because
 * `BlockErrorRule` had no group for this file at all — the contract test hand-listed three files
 * and CLAIMED they composed every product sentence. They did not.
 *
 * ⛔ THIS CLASS IS A DATA CARRIER, NOT THE DISCRIMINATOR, AND IT IS DELIBERATELY EXPORTED. Nothing
 * downstream trusts it: `flow-executor.ts` converts it into a refusal sentinel at the ONE call site
 * that can produce it (`deps.loadBlock`, which runs BEFORE any author code has a context), and
 * `classify` trusts only that sentinel's identity. A block author who imports this module at
 * runtime and throws a hand-made `BlockModuleError` from `run()` therefore gets exactly what any
 * other author throw gets: their own words, raw, with no rule.
 */
export class BlockModuleError extends Error {
  constructor(
    readonly rule: BlockErrorRule,
    message: string,
    readonly detail: BlockErrorDetail,
  ) {
    super(message);
    this.name = 'BlockModuleError';
  }
}

const cache = new Map<string, LoadedBlock>();
const transpiler = new Bun.Transpiler({ loader: 'ts' });

function hashSource(source: string): string {
  return Bun.hash(source).toString(16);
}

/** Transpile + import a block. `source` is block_versions.source_ts; the module
 *  must `export default { descriptor, run }`. Throws on a malformed module. */
export async function loadBlock(
  blockVersionId: string,
  source: string,
  scratchDir: string,
): Promise<LoadedBlock> {
  const key = hashSource(source);
  const cached = cache.get(key);
  if (cached) return cached;

  const js = transpiler.transformSync(source);
  const dir = path.join(scratchDir, 'blocks');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${blockVersionId}.${key}.mjs`);
  await writeFile(file, js, 'utf8');

  const mod = await import(pathToFileURL(file).href);
  const def = mod.default;
  const at: BlockErrorDetail = { blockVersion: blockVersionId };
  if (!def || typeof def !== 'object') {
    throw new BlockModuleError(
      'block_no_default_export',
      `block ${blockVersionId}: module has no default export object`,
      at,
    );
  }
  if (typeof def.run !== 'function') {
    throw new BlockModuleError(
      'block_no_run_function',
      `block ${blockVersionId}: default export has no run() function`,
      at,
    );
  }
  if (!def.descriptor || typeof def.descriptor !== 'object') {
    throw new BlockModuleError(
      'block_no_descriptor',
      `block ${blockVersionId}: default export has no descriptor`,
      at,
    );
  }
  const loaded: LoadedBlock = {
    descriptor: def.descriptor as BlockDescriptor,
    run: def.run.bind(def),
  };
  cache.set(key, loaded);
  return loaded;
}

/** Test seam — clears the module cache between cases. */
export function __clearBlockCache(): void {
  cache.clear();
}
