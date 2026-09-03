-- Give the /clear and Escape events already in the database their real kinds.
--
-- Until v0.52.1 every `SessionEnd` whose reason left the session running was
-- stored as `context.compact`. That is a different event: a compact summarizes
-- the context and keeps its substance, `/clear` discards it, and Escape at the
-- prompt does not touch the context at all. So the dashboard narrated
-- "compacting context" at sessions where no compaction had happened.
--
-- This is not cosmetic on old rows. On the owner's database all 18 of them are
-- the *last* event of their session, which is exactly the phrase the session
-- card shows — 17 sessions claiming a compaction, plus the /clear that started
-- the investigation, still captioned "was compacting context" beside a $1,062
-- cost and a 95%-full context.
--
-- The rewrite invents nothing. `events.payload` is stored verbatim, so each row
-- already carries the hook that produced it; this reads the answer out of the
-- same row rather than guessing it. `hook_event_name` is what separates the two
-- populations, and it separates them exactly:
--
--   SessionEnd + reason=clear    → context.clear     (1 row here)
--   SessionEnd + any other reason → session.continue (17 rows here)
--   PreCompact                   → left alone        (10 rows here)
--
-- Only rows whose payload names `SessionEnd` are touched, so a genuine
-- PreCompact keeps its kind. Verified before writing this: there are no
-- `context.compact` rows without a `hook_event_name`, so nothing unexpected
-- falls under the condition.
--
-- No figure moves. These rows carry `cost_usd = 0` and no tokens — money and
-- token counts come from `turn.assistant` — so this cannot change what any
-- screen says was spent (rule 6). It is the sentence that changes, not a number.
--
-- Deliberately NOT included: closing the sessions left `active` by an old
-- `/clear`. Only one such session exists here, it has already aged to `idle` so
-- it is no longer claiming to be working, and its process is still alive.
-- Retiring a session whose process is running is the failure ADR-028 exists to
-- prevent — a session wrongly closed vanishes from the dashboard while its
-- owner is still typing into it. It will close itself when its process exits.
--
-- Not reversible: the previous `kind` is not kept. It is recoverable from
-- `payload`, which this migration does not touch.
UPDATE events
SET kind = CASE
    WHEN json_extract(payload, '$.reason') = 'clear' THEN 'context.clear'
    ELSE 'session.continue'
  END
WHERE kind = 'context.compact'
  AND json_extract(payload, '$.hook_event_name') = 'SessionEnd';
