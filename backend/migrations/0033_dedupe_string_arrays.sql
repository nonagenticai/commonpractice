-- 0033_dedupe_string_arrays.sql — clean existing duplicate-keyed string arrays.
--
-- Bug: the frontend renders some string[] columns in value-keyed Svelte blocks
-- ({#each arr as x (x)}). Svelte 5 throws each_key_duplicate and hard-crashes the page
-- when two items share a key, so a single stored row with a duplicate tag took down the
-- challenges leaderboard / homepage in production. Layer 1 (zod transforms in
-- routes/challenges.ts + routes/governance.ts) stops new duplicates; this one-shot,
-- forward-only migration cleans the rows already in the database.
--
-- Both UPDATEs are order-preserving (first occurrence wins, via WITH ORDINALITY) and
-- only touch rows that actually contain a duplicate, so they are a no-op on clean data
-- and idempotent on re-run.

-- challenges.tags (jsonb string[])
UPDATE challenges c
SET tags = d.deduped
FROM (
  SELECT id,
         (
           SELECT jsonb_agg(elem ORDER BY min_ord)
           FROM (
             SELECT elem, MIN(ord) AS min_ord
             FROM jsonb_array_elements_text(tags) WITH ORDINALITY AS t(elem, ord)
             GROUP BY elem
           ) u
         ) AS deduped
  FROM challenges
  WHERE jsonb_array_length(tags) >
        (SELECT count(DISTINCT e) FROM jsonb_array_elements_text(tags) AS e)
) d
WHERE c.id = d.id;

-- policies.value for list-type controls (jsonb string[])
UPDATE policies p
SET value = d.deduped
FROM (
  SELECT key,
         (
           SELECT jsonb_agg(elem ORDER BY min_ord)
           FROM (
             SELECT elem, MIN(ord) AS min_ord
             FROM jsonb_array_elements_text(value) WITH ORDINALITY AS t(elem, ord)
             GROUP BY elem
           ) u
         ) AS deduped
  FROM policies
  WHERE control = 'list'
    AND jsonb_typeof(value) = 'array'
    AND jsonb_array_length(value) >
        (SELECT count(DISTINCT e) FROM jsonb_array_elements_text(value) AS e)
) d
WHERE p.key = d.key;
