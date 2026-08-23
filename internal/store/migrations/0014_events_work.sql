-- Work-kind attribution — verbatim from .ai/03-contracts.md § Work attribution DDL.
--
-- THE QUESTION. The Cost screen answers how much (totals), which model (model
-- mix) and where (per project, per directory). It cannot answer what the money
-- was spent ON: a $200 day looks identical whether it went on running the test
-- suite, editing files, or reading the codebase. The kind of work a turn did is
-- in the tool calls that turn made, and nowhere else.
--
-- THE LINKAGE IS msg_id, the same one per-directory attribution uses: a
-- tool_use block and the usage billed for it are content blocks of the SAME
-- assistant message, so they share its id by construction. No second mechanism
-- is invented here.
--
-- WHY THIS WIDENS AN EXISTING INDEX INSTEAD OF ADDING ONE. The carry-forward
-- scan behind per-directory attribution already reads exactly the rows this
-- needs — both tool.pre and turn.assistant, in (session_id, ts, id) order — so
-- the work kind is folded into THAT scan rather than paid for a second time.
-- The only thing missing from idx_events_attr was `tool`, and a column absent
-- from a covering index costs a table lookup per row.
--
-- Measured through the Go driver on the owner's 191k-event database
-- (2026-08-23, 30d range, best of six):
--
--   * /v1/stats/summary before this feature:                     ~252 ms
--   * as a separate aggregate on idx_events_kind_ts:             ~708 ms
--   * as a separate aggregate on its own covering index:         ~544 ms
--   * folded into the existing scan, `tool` NOT in the index:    ~578 ms for
--     the scan alone (the table lookup per row destroys covering)
--   * folded into the existing scan with `tool` in the index:    see § timings
--
-- SQLite cannot add a column to an index in place, so the widened index is
-- created under a new name and the old one dropped. Both are IF EXISTS /
-- IF NOT EXISTS so a re-run is a no-op, and the drop comes last so a failure
-- part-way leaves the old index serving queries rather than none.
--
-- The column order is unchanged from 0013 and is the ORDER BY, then the
-- payload: session_id groups the carry, ts and id order within it, and
-- kind/msg_id/touch_dir/tool plus the token and cost columns are along for the
-- ride so SQLite never touches the table. `tool` sits with the other payload
-- columns rather than in the key, because nothing filters or orders on it.
--
-- Without ANALYZE (nothing in the daemon runs it) SQLite prefers
-- idx_events_kind_ts and reintroduces a temp B-tree sort, so the query pins
-- this index with INDEXED BY — unchanged from 0013.
CREATE INDEX IF NOT EXISTS idx_events_attr_work ON events(
  session_id, ts, id, kind, msg_id, touch_dir, tool,
  cost_usd, tokens_in, tokens_out, cache_read, cache_write
);

DROP INDEX IF EXISTS idx_events_attr;
