// src/utils/pg-errors.ts — SQLSTATE probes shared by the routes that race a unique index.
// postgres-js surfaces the driver error with `.code`, but drizzle WRAPS it (DrizzleQueryError),
// so a top-level `err.code === '23505'` check silently misses every real collision — which reads
// as "the retry never fires" and lets a genuine duplicate escape as a 500.

/**
 * True when `err` (or anything in its cause chain) is a Postgres unique violation — of `constraint`
 * (index name, postgres-js `constraint_name`) when one is given, so a caller can tell WHICH index
 * collided instead of mapping every 23505 to one meaning.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  let e: unknown = err;
  for (let depth = 0; e != null && depth < 5; depth++) {
    if (typeof e === 'object' && (e as { code?: string }).code === '23505') {
      return constraint === undefined || (e as { constraint_name?: string }).constraint_name === constraint;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
