-- 0067_chat_sessions_user_flow_unique.sql — the copilot joined a chat thread by FLOW alone,
-- so one employee's turn landed in a colleague's private transcript.
--
-- THE DEFECT. `ai/agent.ts` `ensureChatSession` is documented "Ensure a chat_session exists for
-- (user, flow)" and its INSERT does write `user_id` (NOT NULL since 0008). Its LOOKUP did not:
--
--     .from(chatSessions).where(eq(chatSessions.flow_id, flowId))     -- no user_id predicate
--
-- Its sibling `getOwnedChatSession` two functions above DOES check `user_id`. So the first person
-- ever to chat about flow F owned the only thread that flow would ever have, and every later
-- caller resolving F was handed THAT row — id, transcript and all.
--
-- The reachable path is not exotic. `routes/flows.ts` `getFlow` deliberately serves a flow that
-- backs a PUBLISHED solution read-only to anyone ("Open in Build" on the marketplace), and the
-- build page renders the copilot panel with no read-only branch. So: A builds F with the copilot
-- and publishes it; B opens it and types one sentence; `POST /api/agent/chat {flowId: F}` (which
-- checked nothing about F) resolved A's session; `loadHistory` replayed A's ENTIRE private
-- conversation into the provider request as B's context; and B's message was appended to A's
-- thread permanently. Two users, two directions, one missing predicate.
--
-- RLS DOES NOT COVER THIS AND WAS NEVER GOING TO. 0028 scopes `chat_sessions` by `tenant_id`, so
-- the cross-TENANT case is shut (tests/rls-runtime.test.ts pins it). The leak is between two
-- colleagues in the SAME tenant — precisely the boundary a tenant policy cannot see. Per-user RLS
-- is not the answer either: `chat_sessions` legitimately has non-user readers (the offboarding
-- cascade in services/provisioning.ts, the admin exports), and a row-level user policy would have
-- to be defeated by every one of them.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS FILE DOES, AND WHY THE CODE FIX ALONE WAS NOT ENOUGH
-- ---------------------------------------------------------------------------------------------
-- The code fix (adding `eq(chatSessions.user_id, userId)` to the lookup) is the whole behavioural
-- change. This index is the part of the contract the database can hold on its own:
--
--   1. It is a CONTRACT, written down. "One thread per (user, flow)" existed only in a docstring
--      that the function under it did not honour for four sessions. A unique index is the same
--      sentence in a place that cannot silently disagree with the code.
--   2. It closes the check-then-INSERT race the lookup has always had. Two turns from the same
--      user on the same flow arriving together both miss the SELECT and both INSERT, splitting
--      that user's transcript across two threads — a silent context-loss bug, not a leak, but a
--      real one. `ensureChatSession` now inserts `ON CONFLICT (user_id, flow_id) DO NOTHING` and
--      re-reads the winner, which is only well-defined because this index exists.
--   3. It makes a REGRESSION of the leak fail loudly. A future call site that resolves a session
--      by flow and inserts a second row for another user gets a 23505, not a shared transcript.
--
-- WHY A PLAIN UNIQUE INDEX AND NOT A PARTIAL ONE. `flow_id` is NULLABLE and legitimately so: the
-- block-authoring and fix-loop personas have no flow to key on and open one flow-LESS session per
-- sitting (the browser threads `sessionId` back instead — see `getOwnedChatSession`). Postgres
-- treats NULLs as DISTINCT in a unique index by default (`UNIQUE NULLS DISTINCT`, the standard
-- behaviour and the default in PG15+ where the spelling became explicit), so those rows never
-- collide with each other and no `WHERE flow_id IS NOT NULL` predicate is needed to protect them.
-- A partial index would express the intent more loudly but would also have to be spelled out again
-- as an `ON CONFLICT … WHERE …` arbiter predicate at every insert site; the plain index infers
-- unambiguously from the column list. The NULLS-DISTINCT reliance is the trade and it is stated in
-- the COMMENT below so nobody "tightens" this into `NULLS NOT DISTINCT` and collapses every
-- block-authoring session of a user into one.
--
-- ---------------------------------------------------------------------------------------------
-- EXISTING ROWS THAT WOULD VIOLATE THE NEW INDEX
-- ---------------------------------------------------------------------------------------------
-- Under the defect, duplicates on (user_id, flow_id) can only come from the check-then-INSERT race
-- above — the leak itself produced FEWER rows than it should have, not more. They are therefore
-- expected to be rare or absent (zero in dev and CI at the time of writing), but "expected" is not
-- "guaranteed", and a migration that 23505s on boot wedges every pod behind the runner's advisory
-- lock. So the duplicates are resolved BEFORE the index is built.
--
-- NOTHING IS DELETED THAT HOLDS A MESSAGE. Every duplicate group is one user's own threads on one
-- flow, so merging them is not a cross-user operation: the surviving row is the EARLIEST (the one
-- the old lookup would most likely have kept returning), its siblings' `chat_messages` are
-- re-parented onto it, and only the then-empty sibling rows are dropped. `chat_messages` is read
-- `ORDER BY created_at` (ai/agent.ts `loadHistory`), so a merged thread reads back in real
-- chronological order rather than as two interleaved-but-lost halves. Deleting the losers outright
-- would have destroyed transcripts to satisfy an index, which is the wrong way round.
--
-- ⛔ WHAT THIS MIGRATION CANNOT REPAIR, AND DOES NOT PRETEND TO. Sessions that ALREADY absorbed a
-- second person's turns stay mixed. `chat_messages` has no author column — the row records the
-- session and the role, never who typed it — so there is no expression that separates A's messages
-- from B's after the fact. Inventing one (splitting on a time gap, on a run of roles) would be a
-- guess dressed as a repair, and a wrong guess here deletes a real author's work. The residue is
-- instead MEASURED and reported: the NOTICE below counts flow-keyed sessions whose user is not the
-- flow's owner, which is the strongest available signal of a session opened through the hole. Those
-- rows are left in place for a human to adjudicate; an operator who wants them gone can delete them
-- deliberately, with the count in front of them.

SET LOCAL lock_timeout = '5s';
-- ⛔ RESET AT THE BOTTOM (and the runner resets it too — MIGRATION_RESET_GUCS). `SET LOCAL` is
-- scoped to the TRANSACTION and the runner applies every pending file inside ONE transaction with a
-- savepoint per file, so an unreset ceiling silently applies to 0068 and everything after it on a
-- fresh-cluster first boot. 0066 states the same; 0059/0060 are the trap it is not repeating.

DO $$
DECLARE
  merged_msgs bigint := 0;
  dropped     bigint := 0;
  orphaned    bigint := 0;
BEGIN
  -- Re-parent every duplicate's messages onto the earliest session of its (user_id, flow_id) group.
  -- `created_at, id` is a total order (id is uuidv7 since 0039, so it is itself time-ordered and
  -- breaks a same-timestamp tie deterministically rather than by whatever the heap returns).
  WITH ranked AS (
    SELECT id,
           first_value(id) OVER (
             PARTITION BY user_id, flow_id ORDER BY created_at, id
           ) AS keep_id
      FROM chat_sessions
     WHERE flow_id IS NOT NULL
  ),
  losers AS (
    SELECT id, keep_id FROM ranked WHERE id <> keep_id
  ),
  moved AS (
    UPDATE chat_messages m
       SET session_id = l.keep_id
      FROM losers l
     WHERE m.session_id = l.id
    RETURNING 1
  )
  SELECT count(*) INTO merged_msgs FROM moved;

  WITH ranked AS (
    SELECT id,
           first_value(id) OVER (
             PARTITION BY user_id, flow_id ORDER BY created_at, id
           ) AS keep_id
      FROM chat_sessions
     WHERE flow_id IS NOT NULL
  ),
  gone AS (
    DELETE FROM chat_sessions
     WHERE id IN (SELECT id FROM ranked WHERE id <> keep_id)
    RETURNING 1
  )
  SELECT count(*) INTO dropped FROM gone;

  IF dropped > 0 THEN
    RAISE NOTICE '0067: merged % chat_messages from % duplicate (user_id, flow_id) sessions',
      merged_msgs, dropped;
  END IF;

  -- The leak residue (reported, never repaired — see the header).
  SELECT count(*) INTO orphaned
    FROM chat_sessions cs
    JOIN flows f ON f.id = cs.flow_id
   WHERE cs.user_id <> f.owner_id;
  IF orphaned > 0 THEN
    RAISE NOTICE '0067: % flow-keyed chat_sessions belong to someone other than the flow owner; '
                 'these may contain another person''s turns and cannot be separated automatically',
      orphaned;
  END IF;
END $$;

-- Not CONCURRENTLY: structurally impossible here. The runner applies every file inside one
-- transaction (db/migration-runner.ts), and CREATE INDEX CONCURRENTLY cannot run in a transaction
-- block. This is a plain, blocking build over a table that holds one row per (person, flow) they
-- have chatted about — small by construction, and guarded by the 5s lock_timeout above.
CREATE UNIQUE INDEX IF NOT EXISTS chat_sessions_user_flow_key
  ON chat_sessions (user_id, flow_id);

COMMENT ON INDEX chat_sessions_user_flow_key IS
  'One copilot thread per (user, flow) — the contract ai/agent.ts ensureChatSession states in its '
  'docstring and, until 0067, did not enforce: its lookup filtered on flow_id alone, so a second '
  'user chatting about a published flow was handed the first user''s transcript. Rows with '
  'flow_id IS NULL (block-authoring / fix-loop sessions, which have no flow to key on) are exempt '
  'by NULLS DISTINCT, which is the default and MUST NOT be changed to NULLS NOT DISTINCT — that '
  'would collapse every flow-less session a person ever opens into a single thread.';

-- No GRANT and no RLS change. 0028 enabled RLS on chat_sessions with a tenant-scoped policy and
-- granted cp_app table-level DML; an index is neither granted nor policied.

-- Scope the lock ceiling to THIS file (see the note beside the SET LOCAL above).
RESET lock_timeout;
