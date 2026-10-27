-- Events name their session by an integer, sessions.sid, instead of repeating
-- its 36-character id in every row and in 14 of the 18 indexes on events
-- (03-contracts.md § Session key DDL).
--
-- sessions is rebuilt to carry sid as its INTEGER PRIMARY KEY: VACUUM may
-- renumber an implicit rowid, never one declared. session_stats references
-- sessions, and dropping a parent fails on an immediate foreign key, so the
-- check waits for COMMIT; the rows are back by then.
PRAGMA defer_foreign_keys = ON;

-- An event never recorded its session's row in some older versions; the new
-- foreign key needs one.
INSERT INTO sessions(session_id, started_at, last_event_at, worked_at, status)
  SELECT session_id, MIN(ts), MAX(ts), MAX(ts), 'ended' FROM events
   WHERE session_id NOT IN (SELECT session_id FROM sessions)
   GROUP BY session_id;

CREATE TABLE sessions_old AS SELECT * FROM sessions;
DROP TABLE sessions;
CREATE TABLE sessions (
  sid             INTEGER PRIMARY KEY,
  session_id      TEXT    NOT NULL UNIQUE,
  cwd             TEXT,
  project         TEXT,
  model           TEXT,
  started_at      INTEGER,
  last_event_at   INTEGER,
  status          TEXT    NOT NULL DEFAULT 'active',  -- active|idle|ended
  transcript_path TEXT,
  has_hooks       INTEGER NOT NULL DEFAULT 0,
  has_transcript  INTEGER NOT NULL DEFAULT 0,
  git_branch      TEXT,
  version         TEXT,
  owned           INTEGER NOT NULL DEFAULT 0,
  worktree        TEXT,
  spawn_command   TEXT,
  pid             INTEGER,
  exit_code       INTEGER,
  repo_root       TEXT,
  repo_path       TEXT,
  agent           TEXT    NOT NULL DEFAULT 'claude',
  title           TEXT    NOT NULL DEFAULT '',
  prompt          TEXT    NOT NULL DEFAULT '',
  worked_at       INTEGER NOT NULL DEFAULT 0,
  parent_session  TEXT    NOT NULL DEFAULT '',
  handoff         INTEGER NOT NULL DEFAULT 0,
  native_id       TEXT    NOT NULL DEFAULT '',
  relay_from      TEXT    NOT NULL DEFAULT '',
  subscription    TEXT    NOT NULL DEFAULT '',
  name            TEXT    NOT NULL DEFAULT '',
  handoff_brain   INTEGER NOT NULL DEFAULT 0,
  chat            INTEGER NOT NULL DEFAULT 0,
  archived_at     INTEGER NOT NULL DEFAULT 0,
  subagent_model  TEXT    NOT NULL DEFAULT '',
  idle_ended_at   INTEGER NOT NULL DEFAULT 0,
  idle_ended_after INTEGER NOT NULL DEFAULT 0,
  handoff_runes   INTEGER NOT NULL DEFAULT 0
);
INSERT INTO sessions(session_id, cwd, project, model, started_at, last_event_at, status, transcript_path,
                     has_hooks, has_transcript, git_branch, version, owned, worktree, spawn_command, pid,
                     exit_code, repo_root, repo_path, agent, title, prompt, worked_at, parent_session,
                     handoff, native_id, relay_from, subscription, name, handoff_brain, chat, archived_at,
                     subagent_model, idle_ended_at, idle_ended_after, handoff_runes)
  SELECT session_id, cwd, project, model, started_at, last_event_at, status, transcript_path,
         has_hooks, has_transcript, git_branch, version, owned, worktree, spawn_command, pid,
         exit_code, repo_root, repo_path, agent, title, prompt, worked_at, parent_session,
         handoff, native_id, relay_from, subscription, name, handoff_brain, chat, archived_at,
         subagent_model, idle_ended_at, idle_ended_after, handoff_runes
    FROM sessions_old ORDER BY started_at, session_id;
DROP TABLE sessions_old;

CREATE INDEX idx_sessions_agent ON sessions(agent, last_event_at DESC);
CREATE INDEX idx_sessions_chat ON sessions(last_event_at) WHERE chat = 1;
CREATE INDEX idx_sessions_handoff_brain ON sessions(started_at) WHERE handoff_brain > 0;
CREATE INDEX idx_sessions_native ON sessions(agent, native_id) WHERE native_id <> '';
CREATE INDEX idx_sessions_relay_from ON sessions(relay_from) WHERE relay_from <> '';
CREATE INDEX idx_sessions_repo ON sessions(session_id, project, repo_path);
CREATE INDEX idx_sessions_repo_branch ON sessions(repo_root, git_branch);
CREATE INDEX idx_sessions_subscription ON sessions(subscription) WHERE subscription <> '';

-- events is not copied here: copying every row took 105-501 s on copies of
-- real databases (2026-10-21), and a migration runs before the daemon
-- answers. The old table stays as events_legacy, and Store.MoveEventsStep
-- moves its rows into the new one in the background, the newest first.
ALTER TABLE events RENAME TO events_legacy;
-- Its triggers went with it: moving a row out must neither count as a
-- change to its session nor take its tool_fields.
DROP TRIGGER events_gen_update;
DROP TRIGGER events_gen_delete;
DROP TRIGGER events_tool_fields_delete;
-- What the move's progress is counted against, read while an index can
-- answer it.
INSERT INTO meta(k, v) SELECT 'events_move_total', COUNT(*) FROM events_legacy WHERE true
  ON CONFLICT(k) DO UPDATE SET v = excluded.v;
INSERT INTO meta(k, v) VALUES('events_moved', 0)
  ON CONFLICT(k) DO UPDATE SET v = excluded.v;
-- Its indexes keep the names the new ones need, and each would be written
-- for every row moved out. (session_id, key) stays: a key still waiting to
-- move is a duplicate too (events_legacy_dedupe).
DROP INDEX IF EXISTS idx_events_ts;
DROP INDEX IF EXISTS idx_events_kind_ts;
DROP INDEX IF EXISTS idx_events_kind_id;
DROP INDEX IF EXISTS idx_events_tool_dist;
DROP INDEX IF EXISTS idx_events_session_ts;
DROP INDEX IF EXISTS idx_events_session_id;
DROP INDEX IF EXISTS idx_events_ts_cover;
DROP INDEX IF EXISTS idx_events_turn_msg;
DROP INDEX IF EXISTS idx_events_turn_agent;
DROP INDEX IF EXISTS idx_events_user_turn;
DROP INDEX IF EXISTS idx_events_attr_work;
DROP INDEX IF EXISTS idx_events_turn_bounds;
DROP INDEX IF EXISTS idx_events_agent;
DROP INDEX IF EXISTS idx_events_agent_task;
DROP INDEX IF EXISTS idx_events_subagent_turn;
DROP INDEX IF EXISTS idx_events_agent_ts;
DROP INDEX IF EXISTS idx_events_todo;

CREATE TABLE events (
  id             INTEGER PRIMARY KEY,          -- rowid, monotonic
  ts             INTEGER NOT NULL,             -- unix ms
  sid            INTEGER NOT NULL REFERENCES sessions(sid),
  source         TEXT    NOT NULL,             -- 'hook' | 'transcript'
  kind           TEXT    NOT NULL,             -- see 02-architecture.md § Event model
  tool           TEXT,
  payload        TEXT    NOT NULL,             -- raw JSON
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  cache_read     INTEGER,
  cache_write    INTEGER,
  cost_usd       REAL,
  key            TEXT,
  model          TEXT,
  cache_write_1h INTEGER,
  agent_id       TEXT,
  msg_id         TEXT,
  touch_dir      TEXT,
  tool_bytes     INTEGER NOT NULL DEFAULT 0,
  internal       INTEGER NOT NULL DEFAULT 0 CHECK (internal IN (0,1)),
  inner_tool     TEXT
);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_kind_ts ON events(kind, ts);
CREATE INDEX idx_events_kind_id ON events(kind, id);
CREATE INDEX idx_events_tool_dist ON events(kind, ts, tool, tool_bytes, internal);
CREATE INDEX idx_events_session_ts ON events(sid, ts);
CREATE INDEX idx_events_session_id ON events(sid, id);
-- Not idx_events_session_key: events_legacy holds that name until the
-- move is done.
CREATE UNIQUE INDEX idx_events_sid_key ON events(sid, key) WHERE key IS NOT NULL;
CREATE INDEX idx_events_ts_cover
  ON events(ts, internal, kind, sid, tokens_in, tokens_out, cache_read, cache_write, cost_usd);
CREATE INDEX idx_events_turn_msg
  ON events(msg_id, sid)
  WHERE kind = 'turn.assistant' AND msg_id IS NOT NULL;
CREATE INDEX idx_events_turn_agent
  ON events(kind, ts, sid, agent_id, model, cost_usd,
            tokens_in, tokens_out, cache_read, cache_write, cache_write_1h, internal)
  WHERE kind = 'turn.assistant';
CREATE INDEX idx_events_user_turn
  ON events(sid, ts)
  WHERE kind = 'turn.user';
CREATE INDEX idx_events_attr_work ON events(
  sid, ts, id, kind, msg_id, touch_dir, tool,
  cost_usd, tokens_in, tokens_out, cache_read, cache_write, internal, inner_tool
);
CREATE INDEX idx_events_turn_bounds
  ON events(sid, ts, kind, agent_id)
  WHERE source = 'hook' AND kind IN ('turn.user', 'agent.stop', 'throttle');
CREATE INDEX idx_events_agent
  ON events(sid, agent_id, ts)
  WHERE agent_id IS NOT NULL;
-- idx_events_agent_task (0054) is not rebuilt: tool_fields (0070) took over
-- its reads, and Open puts it back only while a fill is pending.
CREATE INDEX idx_events_todo
  ON events(sid, ts)
  WHERE kind = 'tool.pre' AND tool IN ('TodoWrite', 'TaskCreate', 'TaskUpdate', 'update_plan');
CREATE INDEX idx_events_subagent_turn
  ON events(sid, agent_id, ts, model, cost_usd, tokens_in, kind, internal)
  WHERE kind = 'turn.assistant' AND agent_id IS NOT NULL AND internal = 0;
CREATE INDEX idx_events_agent_ts
  ON events(sid, ts, agent_id, kind)
  WHERE agent_id IS NOT NULL;

-- session_gen stays keyed by the string id its readers ask by (0063).
CREATE TRIGGER events_gen_update AFTER UPDATE ON events BEGIN
  INSERT INTO session_gen(session_id, gen)
    SELECT session_id, 1 FROM sessions WHERE sid = NEW.sid
    ON CONFLICT(session_id) DO UPDATE SET gen = gen + 1;
  INSERT INTO session_gen(session_id, gen)
    SELECT session_id, 1 FROM sessions WHERE sid = OLD.sid AND OLD.sid IS NOT NEW.sid
    ON CONFLICT(session_id) DO UPDATE SET gen = gen + 1;
END;

CREATE TRIGGER events_gen_delete AFTER DELETE ON events BEGIN
  INSERT INTO session_gen(session_id, gen)
    SELECT session_id, 1 FROM sessions WHERE sid = OLD.sid
    ON CONFLICT(session_id) DO UPDATE SET gen = gen + 1;
END;

CREATE TRIGGER events_tool_fields_delete AFTER DELETE ON events BEGIN
  DELETE FROM tool_fields WHERE event_id = OLD.id;
END;

-- The newest rows move now: id has no AUTOINCREMENT, so a new event takes
-- the highest id in events plus one, and that must be above every old one.
INSERT INTO events(id, ts, sid, source, kind, tool, payload, tokens_in, tokens_out, cache_read,
                   cache_write, cost_usd, key, model, cache_write_1h, agent_id, msg_id, touch_dir,
                   tool_bytes, internal, inner_tool)
  SELECT e.id, e.ts, s.sid, e.source, e.kind, e.tool, e.payload, e.tokens_in, e.tokens_out, e.cache_read,
         e.cache_write, e.cost_usd, e.key, e.model, e.cache_write_1h, e.agent_id, e.msg_id, e.touch_dir,
         e.tool_bytes, e.internal, e.inner_tool
    FROM events_legacy e JOIN sessions s ON s.session_id = e.session_id
   WHERE e.id >= (SELECT MIN(id) FROM (SELECT id FROM events_legacy ORDER BY id DESC LIMIT 1000))
   ORDER BY e.id;
DELETE FROM events_legacy WHERE id >= (SELECT MIN(id) FROM events);
UPDATE meta SET v = (SELECT COUNT(*) FROM events) WHERE k = 'events_moved';

-- Until it is moved, a row in events_legacy keeps its key: an importer that
-- offers its history again on start finds the old row here, and InsertEvent
-- reads the ignored row as a duplicate. Store.MoveEventsStep takes a row out
-- of events_legacy before it puts it in, and drops this with the table.
CREATE TRIGGER events_legacy_dedupe BEFORE INSERT ON events
  WHEN NEW.key IS NOT NULL AND EXISTS (
    SELECT 1 FROM events_legacy
     WHERE session_id = (SELECT session_id FROM sessions WHERE sid = NEW.sid) AND key = NEW.key)
BEGIN
  SELECT RAISE(IGNORE);
END;
