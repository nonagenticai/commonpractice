-- 0087_llm_price_source_abort_estimate.sql
--
-- WHY: `brokerChatStream` (host/llm-broker.ts) reserves the call slot BEFORE any provider work,
-- then streams text deltas as they arrive. Real `tokensIn`/`tokensOut` only ever show up on the
-- provider's terminal `done` frame — which a caller abort (client disconnect, `AbortSignal`, an
-- early `for await … break`) or a mid-stream provider death never reaches. Until now, EVERY exit
-- that did not reach that terminal frame fell into the same `finally { if (!settled) releaseCall
-- }` as a call that streamed nothing at all. That is correct when nothing streamed — there is
-- nothing to bill — but wrong the moment real tokens were generated and DELIVERED to the caller:
-- the vendor already billed us for them, and refunding the reservation instead of settling it
-- makes that spend vanish from `usage_events` with no ledger row to show for it. This is the ONLY
-- path in the file where real spend disappears; every other early exit in the broker precedes
-- provider work.
--
-- The fix settles those calls too, pricing the PARTIAL text with the same `estimateTokens`
-- (chars/4) helper the reservation itself uses. That number is an estimate by construction — the
-- authoritative token count never arrives on an aborted stream — and it must never be confused
-- with a `price_source='flat'` row: `'flat'` means "this model has no pricing-table entry", which
-- is a statement about the MODEL. `'abort_estimate'` is a statement about the CALL — a row that
-- would otherwise have priced as `'provider'` or `'table'` had it completed, but didn't, so the
-- token count under it is approximate. Conflating the two would destroy exactly the provenance
-- `price_source` exists to record (see 0053): a `'flat'` row tells an operator "reprice this model
-- in the governance table"; a `'abort_estimate'` row tells them "this number is honest, but it
-- will never be more precise than an estimate, no matter how good the price table gets."
--
-- ADDITIVE / FORWARD-ONLY / PROD-SAFE. CP runs migrations at backend STARTUP against the live
-- database, so nothing here may block:
--   * Following the 0053 precedent exactly: DROP the existing CHECK, re-ADD it NOT VALID with the
--     fourth value. NOT VALID constrains every future row without scanning the existing table at
--     boot. No existing row needs revalidating — every pre-existing value is still legal under the
--     widened set, so there is nothing to VALIDATE CONSTRAINT for, deliberately left undone here
--     as 0053 left its own NOT VALID unvalidated.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usage_events_price_source_chk'
  ) THEN
    ALTER TABLE usage_events DROP CONSTRAINT usage_events_price_source_chk;
  END IF;

  ALTER TABLE usage_events
    ADD CONSTRAINT usage_events_price_source_chk
    CHECK (price_source IS NULL OR price_source IN ('provider', 'table', 'flat', 'abort_estimate'))
    NOT VALID;

  RAISE NOTICE '[0087] usage_events.price_source: CHECK widened to admit ''abort_estimate''';
END $$;
