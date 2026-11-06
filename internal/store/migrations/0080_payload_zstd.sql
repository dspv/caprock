-- Compressed tool payloads (ADR-093): with "Compress tool output" on, the
-- daemon stores the payload of older tool.pre and tool.post rows as a BLOB —
-- a JSONB string around a zstd frame — in the same events.payload column.
-- No table changes shape; the other kinds stay plain JSON text.
--
-- This migration is the fence. A Caprock from before it reads such a BLOB as
-- a JSON string with no fields, and its in-place repairs (json_set over a
-- Codex or OpenCode call's payload) would overwrite one with that string. So
-- the schema version moves past every older release, and ADR-082's guard has
-- an older binary refuse the database untouched, with its one-line message,
-- whether or not anything was ever compressed.
--
-- payload_zstd_cursor: every compressed row has an id at or below it; 0 is
-- none. payload_zstd_saved: payload bytes saved so far (an upper bound once
-- rows are deleted). See 03-contracts.md § Compressed tool payloads.
INSERT OR IGNORE INTO meta(k, v) VALUES ('payload_zstd_cursor', '0');
INSERT OR IGNORE INTO meta(k, v) VALUES ('payload_zstd_saved', '0');
