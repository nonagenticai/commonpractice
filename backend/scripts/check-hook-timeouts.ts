// scripts/check-hook-timeouts.ts — CI guard for the "bun 1.3.14 ignores bunfig's [test] timeout
//
// ⛔ SCOPE LIMIT, measured 2026-08-02: the CI GATE below (`main()` / `bun run check:hooks`) checks
// HOOKS only. bun ignores bunfig's `[test] timeout` for `test()` bodies as well — verified
// directly: with `timeout = 30000` in bunfig, a plain test that sleeps 7 s still dies at exactly
// 5000 ms (see license-provisioning.test.ts for the full writeup). So a slow DB-touching TEST BODY
// needs its own explicit `}, 30_000)` and the CI gate will NOT tell you if one is missing.
//
// `findTestBodyDbTouches` (below `findHookTimeoutViolations`) was added as a ONE-OFF AUDIT aid and
// is deliberately NOT wired into `main()`/CI. Investigating why surfaced a much bigger reason than
// "not built yet": most test bodies in this suite do their real DB work through a dispatched ROUTE
// HANDLER (`router.match(...).handler(req, ...)`, e.g. `call('POST', '/api/invites', …)`) or a
// `src/host/*`/`src/services/*` function (`checkTenantBudgets()`, `closeCycle()`, …) — both are
// exactly the cross-module case this file's own "Known limitation" below declines to resolve, so a
// same-file AST count is BLIND to the majority of real round trips in exactly the tests that matter
// most (confirmed by hand: `budget-service.test.ts`'s `checkTenantBudgets()` scans+writes across a
// join and was called up to 9× in one test body, `cycle.test.ts`'s multi-tenant `closeCycle()` does
// per-tenant writes — neither counted as a single "touch"). Wiring this into CI as a hard gate would
// therefore repeat the exact mistake #164 made with hooks, but worse: "0 violations" would read as
// safety for precisely the tests most likely to time out. Risk here is managed by hand — see the 13
// tests carrying an explicit `}, 30_000)` in cycle.test.ts / budget-service.test.ts /
// marketplace-summary.test.ts / seed-marketplace-winner.test.ts / ontology-mcp.test.ts /
// rls-runtime.test.ts, added 2026-08-02 after a manual audit combining this counter's output with
// reading what each candidate actually calls. The other ~300 DB-touching test bodies in the suite
// were measured at 1–6 direct round trips (via this same counter) — nowhere near the 5 s budget —
// and were deliberately left alone; blanket-timing every DB-touching test would be noise, not safety.
//
// for HOOKS" class (#164/#167/#169). Hooks get a FIXED 5s budget bun cannot be configured out of;
// the only fix is an explicit per-hook timeout argument (`}, 30_000);`). Over budget, the failure
// reports as `(fail) (unnamed) [5003ms]` — naming NEITHER the file NOR the cause — which has been
// misdiagnosed twice in this repo (#158, and again inside #164 itself before a second pass fixed
// it in #167).
//
// This walks a REAL TypeScript AST (the `typescript` package, already a devDependency) rather than
// pattern-matching text — #164's own hand-rolled sweep misplaced 3 of 69 insertions onto an
// unrelated `test(...)` statement below the intended hook, and the diff still looked right. Brace
// matching by parser, not by eyeballing braces, is the entire point of this tool.
//
// Scope (matches exactly what #164/#167/#169 needed to enumerate — not a general dataflow analyzer):
//   1. Inline hook bodies that call `db.<method>(...)` directly (any depth of chaining/nesting).
//      `db` may be bound via a static named import, a destructured dynamic `import('../db/client')`
//      (`const { db } = await import(...)`), or destructured off a namespace import of that module
//      (`import * as client from '../db/client'; const { db: d } = client;`) — a static-import-only
//      check missed both of the latter two and reported 0 violations on them.
//   2. Bare-reference hooks (`afterAll(cleanup)`) resolved through a LOCALLY-DEFINED helper in the
//      same file (function declaration or `const x = (...) => {...}` / `function` expression),
//      followed transitively through further local helpers it calls.
//   3. Hooks that call an imported `seed*` helper from a `db/seed*` module (`seed`, `seedOntology`,
//      `seedAi`, …) — these always do real round trips.
// A hook is NOT flagged if it has an explicit 2nd (timeout) argument already, or if none of the
// above DB entry points appear anywhere in its resolved body (e.g. `afterEach(() =>
// __setAuthOverridesForTests(undefined))` is pure in-memory and correctly ignored).
//
// Known limitation (deliberate, not an oversight): helper resolution does not cross into OTHER
// source files. If a hook called some non-seed helper imported from `src/...` that itself touches
// the DB indirectly, this tool will not see it — that shape has not occurred in this suite (checked
// by hand against the current tree; see the handoff note where this script's output is reported).
// Extending resolution across module boundaries is real scope-creep with its own false-positive
// risk; not built speculatively.
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOOK_NAMES = new Set(['beforeAll', 'beforeEach', 'afterAll', 'afterEach']);

export interface Violation {
  file: string;
  line: number; // 1-based
  hook: string;
  reason: string; // human-readable: how DB-touching was established
}

type FnLike = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

interface ImportBinding {
  importedName: string; // name as exported by the module ('default' for default imports)
  moduleSpecifier: string;
}

function isFnLike(node: ts.Node): node is FnLike {
  return (
    ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)
  );
}

// Unwrap a (possibly chained) call/property-access expression down to its root identifier, e.g.
// `db.insert(x).values(y)` -> the CallExpression `db.insert(x).values(y)`'s callee is
// `db.insert(x).values`, whose expression is `db.insert(x)`, whose expression is `db.insert`,
// whose expression is `db` (the Identifier we want).
function rootIdentifier(node: ts.Expression): ts.Identifier | undefined {
  let cur: ts.Expression = node;
  for (;;) {
    if (ts.isIdentifier(cur)) return cur;
    if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isCallExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isNonNullExpression(cur) || ts.isAsExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    return undefined;
  }
}

const DB_CLIENT_MODULE_RE = /\/db\/client(\.ts)?$/;

// Unwrap `await x` down to `x`; a dynamic `import(...)` is almost always awaited, but handle the
// bare-Promise case too (`const p = import('../db/client')`) by unwrapping only `await`, not `.then`.
function unwrapAwait(expr: ts.Expression): ts.Expression {
  return ts.isAwaitExpression(expr) ? expr.expression : expr;
}

// `const { db } = await import('../db/client')` — returns the imported module specifier if `expr`
// (after unwrapping `await`) is a dynamic `import(...)` call with a string-literal argument.
// `ts.isImportCall` exists at runtime but isn't part of the public .d.ts for this typescript
// version, so this checks the same thing `isImportCall` does internally: a CallExpression whose
// callee is the bare `import` keyword token (not a `require`/property-access call).
function dynamicImportSpecifier(expr: ts.Expression): string | undefined {
  const e = unwrapAwait(expr);
  if (ts.isCallExpression(e) && e.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const arg = e.arguments[0];
    if (arg && ts.isStringLiteral(arg)) return arg.text;
  }
  return undefined;
}

function analyzeFile(fileName: string, sourceText: string): Violation[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const imports = new Map<string, ImportBinding>(); // local name -> binding
  const namespaceImports = new Map<string, string>(); // local name -> moduleSpecifier, for `import * as x`
  const localFns = new Map<string, FnLike>(); // local name -> function node (module-wide, not scope-precise)
  const localDbNames = new Set<string>(); // local identifier names bound to the drizzle `db` client

  // `{ db }` (or a renamed `{ db: alias }`) destructured out of something that resolves to the
  // db/client module — either a dynamic `import(...)` call or a reference to a namespace-imported
  // binding of that module. Registers each such local alias into `localDbNames`.
  function registerDbDestructure(pattern: ts.ObjectBindingPattern, sourceModule: string | undefined) {
    if (!sourceModule || !DB_CLIENT_MODULE_RE.test(sourceModule)) return;
    for (const el of pattern.elements) {
      if (el.dotDotDotToken || !ts.isIdentifier(el.name)) continue;
      const propName = el.propertyName
        ? ts.isIdentifier(el.propertyName)
          ? el.propertyName.text
          : undefined
        : el.name.text;
      if (propName === 'db') localDbNames.add(el.name.text);
    }
  }

  function collectDeclarations(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleSpecifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause) {
        if (clause.name) {
          // default import
          imports.set(clause.name.text, { importedName: 'default', moduleSpecifier });
        }
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const spec of clause.namedBindings.elements) {
            const importedName = (spec.propertyName ?? spec.name).text;
            const localName = spec.name.text;
            imports.set(localName, { importedName, moduleSpecifier });
            if (importedName === 'db' && DB_CLIENT_MODULE_RE.test(moduleSpecifier)) {
              localDbNames.add(localName);
            }
          }
        }
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          // `import * as client from '../db/client'` — `client` itself isn't `db`, but a later
          // `const { db } = client` (or `client.db.insert(...)`, not currently tracked) resolves
          // through this binding.
          namespaceImports.set(clause.namedBindings.name.text, moduleSpecifier);
        }
      }
    }

    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      localFns.set(node.name.text, node);
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer;
      if (ts.isIdentifier(node.name)) {
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          localFns.set(node.name.text, init);
        }
      } else if (ts.isObjectBindingPattern(node.name)) {
        // Case A: `const { db } = await import('../db/client')` — dynamic import destructured
        // directly. Resolved independent of import order (no forward-reference concern).
        const dynSpec = dynamicImportSpecifier(init);
        if (dynSpec) {
          registerDbDestructure(node.name, dynSpec);
        } else if (ts.isIdentifier(init) && namespaceImports.has(init.text)) {
          // Case B: `import * as client from '../db/client'; const { db: d } = client;` — resolved
          // through the namespace-import map, which (module imports always precede use in
          // practice, and this is a single top-down pass) is already populated by the time a
          // later destructure references it.
          registerDbDestructure(node.name, namespaceImports.get(init.text));
        }
      }
    }

    ts.forEachChild(node, collectDeclarations);
  }
  collectDeclarations(sourceFile);

  // Determine whether a function body (resolved transitively) contains a DB entry point.
  const dbTouchCache = new Map<FnLike, { touches: boolean; via: string | null }>();

  function fnTouchesDb(fn: FnLike, visiting: Set<FnLike>): { touches: boolean; via: string | null } {
    const cached = dbTouchCache.get(fn);
    if (cached) return cached;
    if (visiting.has(fn)) return { touches: false, via: null }; // cycle guard
    visiting.add(fn);

    let found: { touches: boolean; via: string | null } = { touches: false, via: null };

    function walk(node: ts.Node) {
      if (found.touches) return;
      if (ts.isCallExpression(node)) {
        const root = rootIdentifier(node.expression);
        if (root) {
          const name = root.text;
          if (localDbNames.has(name)) {
            found = { touches: true, via: `db call (\`${name}.*\`)` };
            return;
          }
          const imp = imports.get(name);
          if (imp && /\/db\/seed[^/]*$/.test(imp.moduleSpecifier) && /^seed([A-Z]|$)/.test(imp.importedName)) {
            found = { touches: true, via: `imported seed helper \`${imp.importedName}\` (${imp.moduleSpecifier})` };
            return;
          }
          const helper = localFns.get(name);
          if (helper && helper !== fn) {
            const sub = fnTouchesDb(helper, visiting);
            if (sub.touches) {
              found = { touches: true, via: `local helper \`${name}()\` -> ${sub.via}` };
              return;
            }
          }
        }
      }
      ts.forEachChild(node, walk);
    }

    if (fn.body) walk(fn.body);
    visiting.delete(fn);
    dbTouchCache.set(fn, found);
    return found;
  }

  // A bare identifier reference passed directly as the hook's first argument (`afterAll(cleanup)`):
  // resolve it as either a local helper or an imported seed helper, without requiring a call site.
  function identifierTouchesDb(id: ts.Identifier): { touches: boolean; via: string | null } {
    const name = id.text;
    const helper = localFns.get(name);
    if (helper) {
      const sub = fnTouchesDb(helper, new Set());
      if (sub.touches) return { touches: true, via: `local helper \`${name}()\` -> ${sub.via}` };
      return sub;
    }
    const imp = imports.get(name);
    if (imp && /\/db\/seed[^/]*$/.test(imp.moduleSpecifier) && /^seed([A-Z]|$)/.test(imp.importedName)) {
      return { touches: true, via: `imported seed helper \`${imp.importedName}\` (${imp.moduleSpecifier})` };
    }
    if (imp && localDbNames.has(name)) {
      return { touches: true, via: `db reference \`${name}\`` };
    }
    return { touches: false, via: null };
  }

  const violations: Violation[] = [];

  function visitForHooks(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && HOOK_NAMES.has(node.expression.text)) {
      const hookName = node.expression.text;
      const binding = imports.get(hookName);
      const isRealHook = binding && binding.moduleSpecifier === 'bun:test' && binding.importedName === hookName;
      if (isRealHook) {
        const [firstArg, secondArg] = node.arguments;
        const hasExplicitTimeout = node.arguments.length >= 2 && secondArg !== undefined;

        if (!hasExplicitTimeout && firstArg) {
          let result: { touches: boolean; via: string | null } = { touches: false, via: null };
          if (isFnLike(firstArg)) {
            result = fnTouchesDb(firstArg, new Set());
          } else if (ts.isIdentifier(firstArg)) {
            result = identifierTouchesDb(firstArg);
          }
          if (result.touches) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            violations.push({
              file: fileName,
              line: line + 1,
              hook: hookName,
              reason: result.via ?? 'DB entry point found',
            });
          }
        }
      }
    }
    ts.forEachChild(node, visitForHooks);
  }
  visitForHooks(sourceFile);

  return violations;
}

export function findHookTimeoutViolations(sourceText: string, fileName = 'test.ts'): Violation[] {
  return analyzeFile(fileName, sourceText);
}

// ---- test-BODY audit (informational only — see AUDIT-2026-08-02, not wired into CI) ----
//
// Reuses the exact same DB-touch resolver as the hook check (imports/local-helper/seed-helper
// resolution) but walks `test(name, fn, timeout?)` call sites instead of hook call sites, and
// additionally counts every DB entry point reached (not just the first), so callers can rank
// results by how much DB work a body actually does rather than a bare yes/no.
export interface TestBodyInfo {
  file: string;
  line: number;
  name: string; // the test's string title, '<dynamic>' if not a literal
  hasExplicitTimeout: boolean;
  dbTouchCount: number; // number of distinct DB/seed entry-point call sites found in the body
  reasons: string[];
}

function analyzeFileTestBodies(fileName: string, sourceText: string): TestBodyInfo[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const imports = new Map<string, ImportBinding>();
  const namespaceImports = new Map<string, string>();
  const localFns = new Map<string, FnLike>();
  const localDbNames = new Set<string>();

  function registerDbDestructure(pattern: ts.ObjectBindingPattern, sourceModule: string | undefined) {
    if (!sourceModule || !DB_CLIENT_MODULE_RE.test(sourceModule)) return;
    for (const el of pattern.elements) {
      if (el.dotDotDotToken || !ts.isIdentifier(el.name)) continue;
      const propName = el.propertyName
        ? ts.isIdentifier(el.propertyName)
          ? el.propertyName.text
          : undefined
        : el.name.text;
      if (propName === 'db') localDbNames.add(el.name.text);
    }
  }

  function collectDeclarations(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleSpecifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause) {
        if (clause.name) {
          imports.set(clause.name.text, { importedName: 'default', moduleSpecifier });
        }
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const spec of clause.namedBindings.elements) {
            const importedName = (spec.propertyName ?? spec.name).text;
            const localName = spec.name.text;
            imports.set(localName, { importedName, moduleSpecifier });
            if (importedName === 'db' && DB_CLIENT_MODULE_RE.test(moduleSpecifier)) {
              localDbNames.add(localName);
            }
          }
        }
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          namespaceImports.set(clause.namedBindings.name.text, moduleSpecifier);
        }
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      localFns.set(node.name.text, node);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer;
      if (ts.isIdentifier(node.name)) {
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          localFns.set(node.name.text, init);
        }
      } else if (ts.isObjectBindingPattern(node.name)) {
        const dynSpec = dynamicImportSpecifier(init);
        if (dynSpec) {
          registerDbDestructure(node.name, dynSpec);
        } else if (ts.isIdentifier(init) && namespaceImports.has(init.text)) {
          registerDbDestructure(node.name, namespaceImports.get(init.text));
        }
      }
    }
    ts.forEachChild(node, collectDeclarations);
  }
  collectDeclarations(sourceFile);

  const dbTouchCache = new Map<FnLike, { touches: boolean; via: string | null }>();
  function fnTouchesDb(fn: FnLike, visiting: Set<FnLike>): { touches: boolean; via: string | null } {
    const cached = dbTouchCache.get(fn);
    if (cached) return cached;
    if (visiting.has(fn)) return { touches: false, via: null };
    visiting.add(fn);
    let found: { touches: boolean; via: string | null } = { touches: false, via: null };
    function walk(node: ts.Node) {
      if (found.touches) return;
      if (ts.isCallExpression(node)) {
        const root = rootIdentifier(node.expression);
        if (root) {
          const name = root.text;
          if (localDbNames.has(name)) {
            found = { touches: true, via: `db call (\`${name}.*\`)` };
            return;
          }
          const imp = imports.get(name);
          if (imp && /\/db\/seed[^/]*$/.test(imp.moduleSpecifier) && /^seed([A-Z]|$)/.test(imp.importedName)) {
            found = { touches: true, via: `imported seed helper \`${imp.importedName}\` (${imp.moduleSpecifier})` };
            return;
          }
          const helper = localFns.get(name);
          if (helper && helper !== fn) {
            const sub = fnTouchesDb(helper, visiting);
            if (sub.touches) {
              found = { touches: true, via: `local helper \`${name}()\` -> ${sub.via}` };
              return;
            }
          }
        }
      }
      ts.forEachChild(node, walk);
    }
    if (fn.body) walk(fn.body);
    visiting.delete(fn);
    dbTouchCache.set(fn, found);
    return found;
  }

  // Count DISTINCT round-trip call-sites reached directly in the body (depth-1 resolution through
  // locals), not just whether one exists — this is what lets the audit rank "2 round trips" against
  // "20 round trips" instead of a flat yes/no. IMPORTANT: a fluent drizzle chain
  // (`db.select(...).from(...).where(...)`) is ONE round trip, not three — each `.method()` link is
  // its own CallExpression node, so once a chain's outer node is attributed, this does NOT descend
  // into `node.expression` (the rest of the same chain); it still walks `node.arguments` (so a
  // `Promise.all([db.a(), db.b()])` or a `.where(and(inArray(...)))` subquery is still found).
  function countDbTouches(fn: FnLike): { count: number; reasons: string[] } {
    const reasons: string[] = [];
    let count = 0;
    function walk(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const root = rootIdentifier(node.expression);
        if (root) {
          const name = root.text;
          let matched = false;
          if (localDbNames.has(name)) {
            count++;
            reasons.push(`db call (\`${name}.*\`)`);
            matched = true;
          } else {
            const imp = imports.get(name);
            if (imp && /\/db\/seed[^/]*$/.test(imp.moduleSpecifier) && /^seed([A-Z]|$)/.test(imp.importedName)) {
              count++;
              reasons.push(`imported seed helper \`${imp.importedName}\``);
              matched = true;
            } else {
              const helper = localFns.get(name);
              if (helper) {
                const sub = fnTouchesDb(helper, new Set());
                if (sub.touches) {
                  count++;
                  reasons.push(`local helper \`${name}()\` -> ${sub.via}`);
                  matched = true;
                }
              }
            }
          }
          if (matched) {
            // Same chain's own callee (`node.expression`) is not walked again — only args, which
            // may contain independent nested calls.
            for (const arg of node.arguments) walk(arg);
            return;
          }
        }
      }
      ts.forEachChild(node, walk);
    }
    if (fn.body) walk(fn.body);
    return { count, reasons };
  }

  const results: TestBodyInfo[] = [];

  function visitForTests(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'test') {
      const binding = imports.get('test');
      const isRealTest = binding && binding.moduleSpecifier === 'bun:test' && binding.importedName === 'test';
      if (isRealTest) {
        const [nameArg, fnArg, timeoutArg] = node.arguments;
        const hasExplicitTimeout = node.arguments.length >= 3 && timeoutArg !== undefined;
        if (fnArg && isFnLike(fnArg)) {
          const { count, reasons } = countDbTouches(fnArg);
          if (count > 0) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            results.push({
              file: fileName,
              line: line + 1,
              name: nameArg && ts.isStringLiteralLike(nameArg) ? nameArg.text : '<dynamic>',
              hasExplicitTimeout,
              dbTouchCount: count,
              reasons,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visitForTests);
  }
  visitForTests(sourceFile);

  return results;
}

/** Informational audit (not a CI gate): every `test()` body that touches the DB, with a round-trip
 *  count, regardless of whether it already carries an explicit timeout. See AUDIT-2026-08-02. */
export function findTestBodyDbTouches(sourceText: string, fileName = 'test.ts'): TestBodyInfo[] {
  return analyzeFileTestBodies(fileName, sourceText);
}

function main() {
  const testsDir = join(import.meta.dir, '..', 'tests');
  const files = readdirSync(testsDir).filter((f) => f.endsWith('.test.ts'));

  // ⛔ A CI gate that sweeps zero files reports "0 violations" and exits 0 — it passes
  // VACUOUSLY, and looks identical to a clean run. Move or rename `tests/`, or break the
  // `.test.ts` filter, and this guard silently stops guarding. The frontend's sibling guard
  // (frontend/src/lib/test/mock-specifiers.test.ts) asserts a non-empty sweep for the same
  // reason; this one never got it. The floor is deliberately loose — it only has to be
  // impossible to satisfy with an empty or near-empty directory.
  const MIN_EXPECTED_TEST_FILES = 50;
  if (files.length < MIN_EXPECTED_TEST_FILES) {
    console.error(
      `[check-hook-timeouts] REFUSING TO PASS: found only ${files.length} test file(s) in ${testsDir}, ` +
        `expected at least ${MIN_EXPECTED_TEST_FILES}. The sweep is broken (moved/renamed dir, or a bad filter) — ` +
        `a green result here would be meaningless.`
    );
    process.exit(1);
  }

  const allViolations: Violation[] = [];
  for (const f of files) {
    const full = join(testsDir, f);
    const text = readFileSync(full, 'utf8');
    allViolations.push(...analyzeFile(join('tests', f), text));
  }

  if (allViolations.length === 0) {
    console.log(`[check-hook-timeouts] OK — 0 violations across ${files.length} test files.`);
    process.exit(0);
  }

  console.error(
    `[check-hook-timeouts] ${allViolations.length} hook(s) do DB work without an explicit timeout argument:\n`
  );
  for (const v of allViolations) {
    console.error(`  ${v.file}:${v.line} — ${v.hook}(...) — ${v.reason}`);
  }
  console.error(
    '\nAdd an explicit timeout: `}, 30_000);` on the hook (bun 1.3.14 ignores bunfig\'s [test] timeout for hooks — see backend/tests/license-provisioning.test.ts for the full explanation).'
  );
  process.exit(1);
}

if (import.meta.main) {
  main();
}
