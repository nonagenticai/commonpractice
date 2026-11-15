// src/utils/router.ts
// Minimal regex router (copied from fr/backend/src/utils/router.ts). Converts
// "/api/blocks/:slug" patterns into capture-group regexes; params are passed to
// the handler positionally in declaration order.
export interface Route {
  method: string;
  pattern: RegExp;
  /** The original ":param" template (e.g. /api/blocks/:slug) — used for low-cardinality metrics labels. */
  template: string;
  handler: (req: Request, ...params: string[]) => Promise<Response>;
}

/** Escape every regex metacharacter so `text` matches exactly itself. */
function escapeRegExpLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The WHOLE pattern grammar: literal text and whole-segment `:name` placeholders.
// Only these two tokens are substituted; every other character is literal and
// escaped, so no registered path can inject regex syntax (a `.` in
// `/api/audit/export.csv` used to match any character).
const PATTERN_TOKEN = /(:\w+)/;
const PARAM_TOKEN = /^:\w+$/;

export class Router {
  private routes: Route[] = [];

  add(
    method: string,
    pattern: string,
    handler: (req: Request, ...params: string[]) => Promise<Response>,
  ): void {
    const source = pattern
      .split(PATTERN_TOKEN)
      .map((part) => (PARAM_TOKEN.test(part) ? '([^/]+)' : escapeRegExpLiteral(part)))
      .join('');

    this.routes.push({
      method,
      pattern: new RegExp(`^${source}$`),
      template: pattern,
      handler,
    });
  }

  /**
   * Every registered route, in declaration order.
   *
   * Added for `tests/block-source-gate.test.ts`, which must not HAND-LIST the gated write
   * endpoints — a hand-list is exactly how the ungated `POST /api/blocks` and
   * `PATCH …/versions/:version` shipped in the first place. The test derives the block-write
   * surface from this table and probes each entry, so a NEW route registered without the source
   * gate fails the suite instead of waiting to be noticed.
   */
  list(): readonly Route[] {
    return this.routes;
  }

  match(
    method: string,
    pathname: string,
  ): { handler: Route['handler']; params: string[]; template: string } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = pathname.match(route.pattern);
      if (match) {
        return { handler: route.handler, params: match.slice(1), template: route.template };
      }
    }
    return null;
  }
}
