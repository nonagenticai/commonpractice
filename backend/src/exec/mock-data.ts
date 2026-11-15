// src/exec/mock-data.ts — deterministic sandboxed sample data for ctx.mockData().
// Kept INSIDE the runner (no secret, no network → no reason to round-trip to the
// host). Fixtures cover the kinds the seed blocks request (db/seed.ts):
//   claim_pdf · policy · scan · review_decision · customer
// Determinism: derived from a tiny string hash of the kind+opts so the same call
// always yields the same data (reproducible runs/tests). Real PII never appears;
// the `pii: true` descriptor fields are fed only from here, by convention.

/** Cheap deterministic 32-bit hash (FNV-1a) over a string. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mockData(kind: string, opts: Record<string, unknown> = {}): unknown {
  const seed = hash(`${kind}:${JSON.stringify(opts ?? {})}`);
  switch (kind) {
    case 'claim_pdf': {
      const scanned = seed % 2 === 0;
      const pageCount = 1 + (seed % 3);
      const pages = Array.from({ length: pageCount }, (_, i) => ({
        page: i + 1,
        text: `Claim form page ${i + 1}: policy ${1000 + (seed % 9000)}, amount €${(seed % 5000) + 100}.`,
      }));
      return { scanned, pages };
    }
    case 'policy': {
      const id = String(opts.id ?? 'POL-0000');
      return {
        coverage: {
          id,
          type: ['comprehensive', 'third-party', 'fire-theft'][seed % 3],
          limit: (seed % 9 + 1) * 10000,
        },
        deductible: (seed % 5 + 1) * 100,
      };
    }
    case 'scan': {
      return {
        text: `Scanned document text (sample ${seed % 1000}). Lorem ipsum dolor sit amet.`,
      };
    }
    case 'review_decision': {
      const kind = ['accept', 'edit', 'reject'][seed % 3] as
        | 'accept'
        | 'edit'
        | 'reject';
      return kind === 'edit'
        ? { kind, edited: { ...(opts.item as object), reviewed: true } }
        : { kind };
    }
    case 'customer': {
      const id = String(opts.id ?? 'CUST-0000');
      return {
        id,
        name: `Sample Customer ${seed % 1000}`,
        email: `customer${seed % 1000}@example.invalid`,
        tier: ['bronze', 'silver', 'gold'][seed % 3],
        // Synthetic only — never real PII.
        dob: '1990-01-01',
      };
    }
    default:
      return { kind, note: 'no fixture for this kind', seed };
  }
}
