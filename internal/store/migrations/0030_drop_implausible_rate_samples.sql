-- Rate-limit samples that cannot describe a real window, removed.
--
-- `caprock statusline`'s own unit test posted a fixture — 23.5% with a reset
-- at 1900000000, the year 2030 — to whatever daemon was running, because the
-- test did not isolate the data directory. On the owner's machine that left 8
-- such rows in rate_limit_history (20 August 2026), and a guide nearly
-- published 23.5% as his highest five-hour reading. The endpoint has since
-- rejected a reset more than eight days ahead (api.plausibleRateWindow) and
-- the test package now runs against a temporary data directory; this removes
-- what got in before, by the same rule.
DELETE FROM rate_limit_history WHERE resets_at * 1000 > ts + 8 * 86400 * 1000;
DELETE FROM rate_limit_latest  WHERE resets_at * 1000 > ts + 8 * 86400 * 1000;
