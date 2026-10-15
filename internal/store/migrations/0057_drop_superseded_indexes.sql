-- Indexes whose queries later indexes took over (03-contracts.md § Superseded
-- indexes DDL).
DROP INDEX IF EXISTS idx_events_touch;
DROP INDEX IF EXISTS idx_events_ts_model;
DROP INDEX IF EXISTS idx_events_cost_cover;
DROP INDEX IF EXISTS idx_events_msg;
