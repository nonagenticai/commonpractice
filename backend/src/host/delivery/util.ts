// src/host/delivery/util.ts — Phase 5C. Shared helpers for the delivery adapters (Jira / Azure
// DevOps / fr), kept here so no adapter has to import a sibling adapter. The target APIs all
// return a JSON (or, on a 5xx, an HTML) body we persist into `solution_deliveries.response`
// jsonb — these helpers make that storage safe and bounded.

/** Cap a stored response/error body so a verbose target error (or an HTML 5xx page) can't bloat
 *  the `solution_deliveries.response` jsonb column. */
export const RESPONSE_CAP = 4000;

/** Parse a target response body into a jsonb-safe object; a non-object JSON value is wrapped as
 *  {raw}, and non-JSON (e.g. an HTML 5xx page) is wrapped as {raw} and capped. */
export function safeJsonBody(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    return { raw: v };
  } catch {
    return { raw: text.slice(0, RESPONSE_CAP) };
  }
}
