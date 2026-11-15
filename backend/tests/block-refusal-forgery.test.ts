// tests/block-refusal-forgery.test.ts — A BLOCK AUTHOR CANNOT MAKE THEIR OWN TEXT RENDER IN THE
// PRODUCT'S VOICE.
//
// ⛔ WHAT THIS PINS, AND WHY IT IS NOT A UNIT TEST. `frontend/src/lib/i18n/block-test-error-label.ts`
// decides "product sentence or author's words?" on ONE bit: does the refusal carry a `rule`. If a
// block author can get a `rule` attached to a string THEY wrote, the product renders their text in
// the reader's language, the product's quotes and the product's locale — a phishing primitive in
// our own voice, on /build's run console and on /block-edit's result panel.
//
// The old design made `rule` unforgeable by CLASS (`err instanceof ProductError`). The class check
// is sound; its REACHABILITY was not. `buildContext` reads `caps` off the block's OWN descriptor,
// so a block that declares no capabilities and calls `ctx.llm()` is HANDED a live ProductError —
// and from there `e.constructor` is the class. Three measured attacks:
//
//   ATTACK1  catch it, mutate `e.rule` / `e.message` / `e.detail`, rethrow.
//   ATTACK2  `const PE = e.constructor; throw new PE('node_inputs_invalid', …)` — forge a fresh one.
//   ATTACK3  a plain shape-alike `{rule, kind}` — the CONTROL: it must fail even on the old build,
//            so a green run here is not "the discriminator is gone".
//
// And a fourth, which needs no capability trick at all: `kind` is a SECOND injection channel.
// `classify`'s default arm copied any string `err.kind` onto the wire and `errorKindLabel` rendered
// an unknown kind RAW, so `{kind: 'WAARSCHUWING: uw account wordt geblokkeerd'}` became product
// chrome — and was PERSISTED into `error_detail.actualKind`.
//
// ⛔ REAL TRANSPILED BLOCKS THROUGH THE REAL LOADER. Every case below is a TypeScript SOURCE STRING
// put through `Bun.Transpiler` + a dynamic import by `exec/block-loader.ts` — the production path —
// and executed by the real `executeFlow`. A hand-built `{run(){}}` closure shares the harness's
// module scope and would prove nothing about what an author's module scope can reach.
import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeFlow, type ExecDeps } from '../src/exec/flow-executor';
import { loadBlock, __clearBlockCache } from '../src/exec/block-loader';
import type { FlowGraph, FlowNode } from '../src/db/flow-types';
import type { TraceEvent } from '../src/db/trace-types';

const POLICY = { maxNodeMs: 5000 };

function node(id: string, blockVersionId: string): FlowNode {
  return {
    id,
    blockId: `b-${id}`,
    blockVersionId,
    slug: id,
    label: id,
    category: 'logic',
    config: {},
    position: { x: 0, y: 0 },
  };
}

interface NodeError {
  error: string;
  kind: string;
  rule?: string;
  detail?: Record<string, unknown>;
}

/** Transpile + import + execute `source` as a REAL block, and return its node_error. */
async function runSource(source: string, id = 'atk'): Promise<NodeError | undefined> {
  __clearBlockCache();
  const scratch = await mkdtemp(path.join(tmpdir(), 'cp-forgery-'));
  const events: TraceEvent[] = [];
  let clock = 0;
  const versionId = `v-${id}-${Math.random().toString(16).slice(2)}`;
  const deps: ExecDeps = {
    loadBlock, // ⛔ THE REAL ONE — Bun.Transpiler + dynamic import.
    llm: async () => ({ text: 'x', usage: { tokensIn: 0, tokensOut: 0 }, costUsd: 0 }),
    mockData: (kind) => ({ kind }),
    dataset: () => [],
    emit: (ev) => events.push(ev),
    now: () => clock++,
  };
  const graph: FlowGraph = { nodes: [node('a', versionId)], edges: [] };
  try {
    await executeFlow(graph, new Map([[versionId, source]]), 'r1', scratch, deps, POLICY);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return events.find((e) => e.type === 'node_error') as NodeError | undefined;
}

/** A block that declares NO capabilities, so `ctx.llm()` refuses and hands the refusal to `run()`. */
const attacker = (body: string) => `export default {
  descriptor: { inputs: {}, outputs: {}, capabilities: {} },
  async run(inputs, ctx) {
${body}
  }
};`;

// ─────────────────────────────────────────────────────────────────────────────────────────────
const PHISH = 'Sessie verlopen — voer uw wachtwoord opnieuw in';

test('⛔ ATTACK1 — mutating the refusal handed to author code cannot forge a rule', async () => {
  // AS MEASURED BY THE VERIFIER: catch it, assign, rethrow. A transpiled block module is ESM and
  // therefore always strict, so the assignment to a FROZEN sentinel throws `TypeError` at the
  // author's own hand — and the TypeError is then an ordinary unruled author throw.
  const err = await runSource(
    attacker(`    try {
      await ctx.llm({ model: 'm', prompt: 'p' });
    } catch (e) {
      e.rule = 'field_must_be_string';
      e.message = ${JSON.stringify(PHISH)};
      e.detail = { field: ${JSON.stringify(PHISH)} };
      throw e;
    }
    return {};`),
    'a1',
  );
  expect(err, 'the attacking block did not error at all').toBeDefined();
  expect(
    err!.rule ?? undefined,
    'ATTACK1 forged a rule — the author owns the catalog sentence the reader gets',
  ).toBeUndefined();
  expect(JSON.stringify(err!.detail ?? {})).not.toContain('Sessie verlopen');
  expect(err!.error).not.toContain('Sessie verlopen');
});

test('⛔ ATTACK1b — swallowing the freeze TypeError relays OUR sentence, never theirs', async () => {
  // THE HARDER HALF, AND THE ONE A CAREFUL ATTACKER WRITES. Guard each assignment, then rethrow the
  // sentinel PRISTINE. Identity is identity: the refusal is still reported, and reporting it is
  // correct — every byte of it is ours. `rule`, `message` and `detail` all come from a module-
  // private WeakMap, so the object the author held could not have carried them in the first place.
  const err = await runSource(
    attacker(`    try {
      await ctx.llm({ model: 'm', prompt: 'p' });
    } catch (e) {
      try { e.rule = 'field_must_be_string'; } catch (frozen) {}
      try { e.message = ${JSON.stringify(PHISH)}; } catch (frozen) {}
      try { e.detail = { field: ${JSON.stringify(PHISH)} }; } catch (frozen) {}
      throw e;
    }
    return {};`),
    'a1b',
  );
  expect(err).toBeDefined();
  // ⛔ THE ASSERTION THAT MATTERS: not "no rule", but "no author text anywhere on the wire".
  expect(JSON.stringify(err)).not.toContain('Sessie verlopen');
  // …and what IS reported is the product's own refusal about the author's own block, unaltered.
  expect(err!.rule).toBe('capability_missing_llm');
  expect(err!.error).toBe("block 'a' lacks the llm capability");
  expect(err!.detail).toEqual({ slug: 'a' });
});

test('⛔ ATTACK1c — the sentinel is frozen, so nothing an author writes to it lands', async () => {
  // The mechanism, asserted directly rather than through its consequence: a block that reports what
  // it observed proves the object it was handed is sealed and carries no rule of its own.
  const err = await runSource(
    attacker(`    try {
      await ctx.llm({ model: 'm', prompt: 'p' });
    } catch (e) {
      const seen = {
        frozen: Object.isFrozen(e),
        ownRule: Object.prototype.hasOwnProperty.call(e, 'rule'),
        ctor: e.constructor === Error,
        // The engine hangs its own position fields (line/column/sourceURL) on every Error; what
        // matters is that NONE of the refusal's fields is an own property of the thrown object.
        secrets: ['rule', 'kind', 'detail'].filter((k) =>
          Object.prototype.hasOwnProperty.call(e, k)
        ).join(','),
      };
      throw new Error(JSON.stringify(seen));
    }
    return {};`),
    'a1c',
  );
  expect(err).toBeDefined();
  expect(err!.rule ?? undefined).toBeUndefined();
  expect(JSON.parse(err!.error)).toEqual({
    frozen: true,
    ownRule: false,
    // `e.constructor` is the GLOBAL Error — there is no product class to steal (see ATTACK2).
    ctor: true,
    secrets: '',
  });
});

test('⛔ ATTACK2 — `e.constructor` must not be a mintable product-refusal class', async () => {
  const err = await runSource(
    attacker(`    try {
      await ctx.llm({ model: 'm', prompt: 'p' });
    } catch (e) {
      const PE = e.constructor;
      throw new PE(
        'node_inputs_invalid',
        'Uw sessie is verlopen',
        'validation',
        { issues: [{ rule: 'field_must_be_string', message: 'x', detail: { field: 'wachtwoord' } }] }
      );
    }
    return {};`),
    'a2',
  );
  expect(err, 'the attacking block did not error at all').toBeDefined();
  expect(
    err!.rule ?? undefined,
    'ATTACK2 minted a product refusal from `e.constructor` — the class is stealable',
  ).toBeUndefined();
  expect(JSON.stringify(err!.detail ?? {})).not.toContain('wachtwoord');
});

test('ATTACK3 — a plain shape-alike gets no rule (the CONTROL: sound before and after)', async () => {
  const err = await runSource(
    attacker(`    throw Object.assign(new Error('Uw sessie is verlopen'), {
      rule: 'node_inputs_invalid',
      kind: 'validation',
      detail: { field: 'wachtwoord' }
    });`),
    'a3',
  );
  expect(err).toBeDefined();
  expect(err!.rule ?? undefined).toBeUndefined();
  expect(err!.error).toBe('Uw sessie is verlopen');
});

test('⛔ KIND INJECTION — an author-supplied `kind` must not reach the wire raw', async () => {
  const PHISH = 'WAARSCHUWING: uw account wordt geblokkeerd';
  const err = await runSource(
    attacker(`    throw Object.assign(new Error('x'), { kind: ${JSON.stringify(PHISH)} });`),
    'k1',
  );
  expect(err).toBeDefined();
  // The nine `ErrorKind` members are the whole vocabulary. Anything else is the author's prose
  // wearing an enum's clothes, and `errorKindLabel` renders an unknown kind as product chrome.
  const KINDS = [
    'timeout',
    'validation',
    'block_throw',
    'network_blocked',
    'llm_capped',
    'model_not_allowed',
    'budget_exhausted',
    'flow_error',
    'internal',
  ];
  expect(
    KINDS,
    `an unrecognised kind reached node_error.kind: ${JSON.stringify(err!.kind)}`,
  ).toContain(err!.kind);
  expect(err!.error).toBe('x'); // the author's own message still travels, raw and unruled.
});

test('a REAL product refusal still carries its rule (so the four above are not vacuous)', async () => {
  const err = await runSource(
    attacker(`    await ctx.llm({ model: 'm', prompt: 'p' });
    return {};`),
    'ok',
  );
  expect(err).toBeDefined();
  expect(err!.rule).toBe('capability_missing_llm');
  expect(err!.detail?.slug).toBe('a');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
test('⛔ ATTACK4 — importing the HOST MODULES at runtime mints nothing', async () => {
  // ⛔ THE VECTOR THE STATIC SCAN DOES NOT CLOSE. `blocks/static-scan.ts` allowlists `./sdk` AT SAVE
  // TIME; it is a scan, not a sandbox, and the block is dynamically imported into the runner's own
  // process, so `await import(<absolute path>)` really does resolve. This test hands the attacker
  // MORE than production does — the exact paths, spelled out — and the answer must still be no.
  //
  // What is exported is deliberately inert: two carrier classes that are converted into refusals
  // only at call sites author code cannot reach. `productError`, `REFUSALS` and `REFUSAL_FIELDS`
  // are module-private and appear in nobody's namespace.
  const EXEC = JSON.stringify(fileURLToPath(new URL('../src/exec/flow-executor.ts', import.meta.url)));
  const LOADER = JSON.stringify(fileURLToPath(new URL('../src/exec/block-loader.ts', import.meta.url)));
  const DS = JSON.stringify(fileURLToPath(new URL('../src/exec/dataset-resolver.ts', import.meta.url)));

  const err = await runSource(
    attacker(`    const exec = await import(${EXEC});
    const loader = await import(${LOADER});
    const ds = await import(${DS});
    if (typeof exec.productError === 'function') throw new Error('MINT REACHABLE: productError');
    if (exec.REFUSALS || exec.REFUSAL_FIELDS) throw new Error('MINT REACHABLE: the registries');
    // The carriers ARE reachable. Throw a hand-made one and see what the wire says.
    throw new loader.BlockModuleError('block_no_run_function', 'Uw sessie is verlopen', {
      blockVersion: 'wachtwoord'
    });`),
    'a4',
  );
  expect(err).toBeDefined();
  expect(err!.error, 'the private mint leaked into the module namespace').not.toContain(
    'MINT REACHABLE',
  );
  expect(
    err!.rule ?? undefined,
    'a hand-made carrier class acquired a rule — the carriers are not inert after all',
  ).toBeUndefined();
  expect(err!.error).toBe('Uw sessie is verlopen');
  expect(JSON.stringify(err!.detail ?? {})).not.toContain('wachtwoord');
});

test('⛔ ATTACK5 — a forged host-LLM carrier gets no rule either', async () => {
  // `ctx.llm`'s conversion reads `{kind, rule, detail}` off an object that only ever comes from
  // `runner-entry.ts`'s stdin reader. An author can write the same shape by hand; the conversion is
  // what mints, and it runs at a site the author's throw does not pass through.
  const err = await runSource(
    attacker(`    throw Object.assign(new Error('daily LLM call cap reached (1)'), {
      kind: 'llm_capped',
      rule: 'llm_daily_cap_reached',
      detail: { limit: '1' }
    });`),
    'a5',
  );
  expect(err).toBeDefined();
  expect(err!.rule ?? undefined).toBeUndefined();
  // `kind` IS allowlisted rather than rejected — `llm_capped` is a real member, and a block that
  // claims one is only mislabelling its own failure, not authoring product copy.
  expect(err!.kind).toBe('llm_capped');
});
