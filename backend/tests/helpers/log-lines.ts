// tests/helpers/log-lines.ts — reading the structured log the way an operator's grep would.
//
// ⛔ WHY THIS EXISTS, AND WHY IT THROWS RATHER THAN SKIPS.
// Several tests in this suite exist to prove that a particular event is EMITTED — silence is the
// failure mode they were written to remove (see tick-claim-contract.test.ts and
// run-finalize-lost-race.test.ts). They used to assert on free-form `console.*` text; `host/logger.ts`
// now emits ONE JSON object per event, so those assertions have to read fields instead of
// substrings. That is strictly stronger — `msg` + `label` is an exact identity where
// `toContain('… SKIPPED')` was a substring that any longer sentence could satisfy by accident.
//
// ⛔ A `try { JSON.parse } catch { /* skip */ }` HERE WOULD DESTROY THE POINT OF THOSE TESTS.
// A regression that reverted one call site to a bare `console.warn('… SKIPPED')` would emit a
// non-JSON line; a parser that silently dropped it would report "no matching line found" — and the
// test author would read that as "the event was not emitted" only if the assertion happened to be
// looking for it. Worse, an unparseable line is itself a defect (an unattributable line with no
// level and no request id is exactly what the logger was introduced to remove), so it must red the
// build where it appears rather than be quietly filtered out of the evidence.

/** One emitted log event. `lvl` and `msg` are guaranteed by `host/logger.ts`'s `emit`. */
export type LogLine = { lvl: string; msg: string } & Record<string, unknown>;

/**
 * Parse one captured `console.*` argument as a structured log line.
 *
 * @throws if the line is not a JSON object carrying string `lvl` and `msg` — i.e. if something in
 *         `src/` is still writing free-form text to that channel.
 */
export function parseLogLine(raw: string): LogLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `captured a NON-JSON log line — host/logger.ts emits one JSON object per event, so this is ` +
        `a raw console.* call that escaped the structured logger: ${JSON.stringify(raw)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`captured a JSON log line that is not an object: ${JSON.stringify(raw)}`);
  }
  const line = parsed as Record<string, unknown>;
  if (typeof line.lvl !== 'string' || typeof line.msg !== 'string') {
    throw new Error(
      `captured a JSON log line with no string \`lvl\`/\`msg\` — the two fields every emitted ` +
        `event must carry: ${JSON.stringify(raw)}`,
    );
  }
  return line as LogLine;
}

/** Parse every captured line. Any unparseable line throws (see above) — none are dropped. */
export function parseLogLines(raw: readonly string[]): LogLine[] {
  return raw.map(parseLogLine);
}

/** Every parsed line whose `msg` is exactly `msg`. Filtering on the field, never on array position:
 *  the same channel carries unrelated events, and their order is not part of any contract. */
export function linesWithMsg(raw: readonly string[], msg: string): LogLine[] {
  return parseLogLines(raw).filter((l) => l.msg === msg);
}

/** The `message` of a serialized `Error` field (`safeValue` in host/logger.ts keeps name/message/
 *  stack), or `undefined` when the field is absent or not an error shape. */
export function errMessage(line: LogLine | undefined, field = 'err'): string | undefined {
  const err = line?.[field];
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return undefined;
}
