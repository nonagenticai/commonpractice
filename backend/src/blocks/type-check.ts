// src/blocks/type-check.ts — Phase 2-B: real TypeScript type-check of block source
// (TRUSTED host-side only; the `typescript` compiler is NEVER bundled into the
// runner — the runner keeps using Bun.Transpiler). Complements static-scan.ts
// (safety + syntax) and the runtime descriptor-conformance check in test-runner.ts.
//
// We compile the block source in an in-memory program against the REAL SDK types
// (src/exec/sdk.ts + src/db/block-types.ts served as virtual files — single source
// of truth, no hand-maintained .d.ts to drift). The block's SDK import — any of the
// allowlisted specifiers — is resolved to that virtual sdk module.
//
// `noImplicitAny` is OFF on purpose: blocks are conventionally written as
// `export default { run(inputs, ctx) {…} }` with un-annotated params (they rely on
// the SDK contract, transpiled type-free in prod). Rejecting those would flag every
// existing block. strictNullChecks and the rest of `strict` stay ON, so genuine
// type bugs (null misuse, bad assignments, wrong arithmetic, calling a non-function)
// are still caught. Authors who `import { Block } from './sdk'` get full ctx typing.
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface TypeDiagnostic {
  message: string;
  /** 1-based line, when locatable. */
  line?: number;
  /** 1-based column, when locatable. */
  col?: number;
  code: number;
}

export interface TypeCheckResult {
  ok: boolean;
  diagnostics: TypeDiagnostic[];
}

// Allowlisted SDK import specifiers (mirror static-scan.ts) → the virtual sdk module.
const SDK_SPECIFIERS = new Set(['./sdk', '../sdk', '@commonpractice/sdk', 'commonpractice']);

// Virtual file layout — keeps sdk.ts's own `import '../db/block-types'` resolving.
const V_ROOT = '/__cp_typecheck__';
const V_BLOCK = `${V_ROOT}/block.ts`;
const V_SDK = `${V_ROOT}/src/exec/sdk.ts`;
const V_BLOCK_TYPES = `${V_ROOT}/src/db/block-types.ts`;

// Read the real SDK sources once (cached). Strip the new Phase-2-B test types from
// block-types if present is unnecessary — they're harmless to the block surface.
let sdkSourceCache: { sdk: string; blockTypes: string } | null = null;
function sdkSources(): { sdk: string; blockTypes: string } {
  if (sdkSourceCache) return sdkSourceCache;
  const exec = path.resolve(import.meta.dir, '..', 'exec', 'sdk.ts');
  const types = path.resolve(import.meta.dir, '..', 'db', 'block-types.ts');
  sdkSourceCache = {
    sdk: readFileSync(exec, 'utf8'),
    blockTypes: readFileSync(types, 'utf8'),
  };
  return sdkSourceCache;
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  noEmit: true,
  strict: true,
  noImplicitAny: false,
  skipLibCheck: true,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  types: [],
  allowJs: false,
  noEmitOnError: false,
};

// Module-not-found (2307) is owned by static-scan's import allowlist — suppress it
// here so a banned/unknown import isn't double-reported.
const SUPPRESSED_CODES = new Set([2307]);

export function typeCheckBlockSource(source: string): TypeCheckResult {
  const { sdk, blockTypes } = sdkSources();
  const virtualFiles = new Map<string, string>([
    [V_BLOCK, source ?? ''],
    [V_SDK, sdk],
    [V_BLOCK_TYPES, blockTypes],
  ]);

  const defaultHost = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const sourceFileCache = new Map<string, ts.SourceFile | undefined>();

  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists: (fileName) => virtualFiles.has(fileName) || defaultHost.fileExists(fileName),
    readFile: (fileName) => virtualFiles.get(fileName) ?? defaultHost.readFile(fileName),
    getSourceFile: (fileName, languageVersion, onError, shouldCreate) => {
      const virtual = virtualFiles.get(fileName);
      if (virtual !== undefined) {
        if (!sourceFileCache.has(fileName)) {
          sourceFileCache.set(
            fileName,
            ts.createSourceFile(fileName, virtual, languageVersion, true),
          );
        }
        return sourceFileCache.get(fileName);
      }
      return defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreate);
    },
    // Resolve the block's SDK import (any allowlisted specifier) → the virtual sdk.
    resolveModuleNames: (moduleNames, containingFile) =>
      moduleNames.map((name): ts.ResolvedModule | undefined => {
        if (SDK_SPECIFIERS.has(name)) {
          return { resolvedFileName: V_SDK };
        }
        // sdk.ts's own relative import of '../db/block-types' from /src/exec/.
        if (name === '../db/block-types' || name === './block-types') {
          return { resolvedFileName: V_BLOCK_TYPES };
        }
        const resolved = ts.resolveModuleName(name, containingFile, COMPILER_OPTIONS, defaultHost);
        return resolved.resolvedModule
          ? { resolvedFileName: resolved.resolvedModule.resolvedFileName }
          : undefined;
      }),
  };

  const program = ts.createProgram([V_BLOCK], COMPILER_OPTIONS, host);
  const blockFile = program.getSourceFile(V_BLOCK);

  const raw = [
    ...program.getSyntacticDiagnostics(blockFile),
    ...program.getSemanticDiagnostics(blockFile),
  ];

  const diagnostics: TypeDiagnostic[] = [];
  for (const d of raw) {
    if (SUPPRESSED_CODES.has(d.code)) continue;
    // Only surface diagnostics that point at the block source itself.
    if (d.file && d.file.fileName !== V_BLOCK) continue;
    const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    let line: number | undefined;
    let col: number | undefined;
    if (d.file && typeof d.start === 'number') {
      const lc = d.file.getLineAndCharacterOfPosition(d.start);
      line = lc.line + 1;
      col = lc.character + 1;
    }
    diagnostics.push({ message, line, col, code: d.code });
  }

  return { ok: diagnostics.length === 0, diagnostics };
}
