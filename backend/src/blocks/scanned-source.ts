// src/blocks/scanned-source.ts — the BRAND, and nothing else.
//
// ⛔ THIS MODULE HAS NO IMPORTS AND MUST KEEP NONE. It is imported by `db/schema.ts` (which types
// `block_versions.source_ts` with the brand) AND by `blocks/source-gate.ts` (which mints it, and
// which reaches `host/policy-store` → `db/client` → `db/schema`). Putting the type next to the
// minting function would close that cycle.
//
// WHY A BRAND AT ALL. The defect this exists to close is not "someone wrote a bad regex", it is
// "three write paths were added over three phases and none of their authors remembered the lint
// that a fourth path had". A runtime check inside the three known writers fixes those three; it
// does nothing about the fifth. Typing the COLUMN means the compiler refuses any `.values({
// source_ts })` / `.set({ source_ts })` whose value did not come out of the gate — `bun run
// typecheck` (CI, ci-cd.yaml) is the enforcement, and a new writer cannot be merged without it.
//
// The brand is one-way: `ScannedSource` is assignable to `string`, so every READER (the runner,
// the loader, the lint route, every `Pick<BlockVersion, 'source_ts'>`) is untouched. Only writes
// narrow.

/** A block source that has been through `blocks/source-gate.ts`. Mint it there; nowhere else. */
export type ScannedSource = string & { readonly __blockSourceScanned: unique symbol };

/**
 * The column default, and the ONE legitimate cast in the codebase.
 *
 * A block row is created before its source exists (`createBlockCore` writes `''` when the author
 * supplied none), and the empty string is trivially safe — `scanBlockSource('')` returns zero
 * findings, so routing it through the gate would be a no-op that only exists to satisfy the type.
 */
export const EMPTY_SCANNED_SOURCE = '' as ScannedSource;
