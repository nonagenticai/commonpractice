// src/utils/search.ts — the one place that turns a user's typed query into an ILIKE pattern.
//
// ⛔ WHY THIS IS SHARED RATHER THAN COPIED. `%` and `_` are ILIKE metacharacters, and a search box
// interpolating its input straight into `` `%${q}%` `` hands the user's own punctuation to the
// pattern matcher: someone searching for a connector named `Discount 100% off` matches every row
// containing `100`, and someone searching `a_b` matches `axb`. The escape is three characters of
// code, which is exactly why it kept being re-typed slightly differently or not at all — an
// independent sweep found six search boxes interpolating raw. It lived as a private function in
// `routes/search.ts` (the topbar search) where nothing else could reach it; it lives here now so
// the seventh caller imports it instead of growing a seventh copy.
//
// ⚠️ `\` is escaped FIRST and in the same pass, not in a second `.replace` — escaping `%` and `_`
// first and backslashes afterwards would double-escape the backslashes this function just added,
// turning `\%` back into a literal backslash followed by a wildcard. The single character class
// below cannot make that mistake.
//
// The backslash is Postgres's default LIKE/ILIKE escape character, and the pattern is passed as a
// BIND PARAMETER (never string-concatenated into SQL), so `standard_conforming_strings` does not
// enter into it.

/** Wrap a user's query as a contains-pattern, with ILIKE wildcards escaped so they match literally. */
export function likeTerm(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
