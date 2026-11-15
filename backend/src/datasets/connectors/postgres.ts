// src/datasets/connectors/postgres.ts — read-only Postgres connector (Phase 2-A).
// Opens a FRESH postgres.js client (never the app pool) to the source, in a READ ONLY
// transaction with a statement timeout, runs the single configured SELECT wrapped in a
// row LIMIT, and hands the rows to the shared finalize() so the typed schema is
// inferred exactly like an uploaded dataset. Host-side only — the runner never sees a
// connection string. The egress guard authorizes the source host before any socket.
import postgres from 'postgres';
import { badRequest } from '../../utils/http';
import { assertEgressAllowed } from '../../host/egress-guard';
import type { GovernanceSnapshot } from '../../host/policy-store';
import { finalize, orderedKeys } from '../parse/infer';
import { CONNECTOR_FETCH_ROW_CAP } from '../../db/dataset-types';
import type { ParseResult } from '../parse';

/** Validate that `query` is a single read-only SELECT/CTE. Defense in depth on top of
 *  the READ ONLY transaction: reject multi-statement input and non-SELECT leading
 *  keywords. Returns the trimmed, semicolon-stripped statement. */
export function assertReadOnlySelect(query: string): string {
  const s = query.trim().replace(/;\s*$/, '');
  if (!s) throw badRequest('empty_query', 'connector query is empty');
  if (s.includes(';')) {
    throw badRequest('multi_statement', 'only a single SELECT statement is allowed');
  }
  if (!/^(select|with)\b/i.test(s)) {
    throw badRequest('not_select', 'connector query must be a SELECT (or WITH … SELECT)');
  }
  return s;
}

export async function fetchPostgres(
  cfg: { url: string; query: string },
  snapshot: GovernanceSnapshot,
): Promise<ParseResult> {
  await assertEgressAllowed(cfg.url, snapshot);
  const select = assertReadOnlySelect(cfg.query);

  const sql = postgres(cfg.url, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    onnotice: () => {},
  });
  try {
    const rawRows = await sql.begin(async (tx) => {
      // READ ONLY + a statement timeout make a malicious/expensive query safe.
      await tx.unsafe('SET TRANSACTION READ ONLY');
      await tx.unsafe("SET LOCAL statement_timeout = '15s'");
      // Wrap in a LIMIT (cap+1 so finalize can flag truncation). The subquery form
      // requires the input be a SELECT producing a relation — enforced above.
      const wrapped = `SELECT * FROM (${select}) AS _cp_src LIMIT ${CONNECTOR_FETCH_ROW_CAP + 1}`;
      return (await tx.unsafe(wrapped)) as unknown as Record<string, unknown>[];
    });
    const rows = rawRows.map((r) => ({ ...r }));
    const names = rows.length ? orderedKeys(rows) : [];
    return finalize(names, rows);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
