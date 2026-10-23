-- Reserved (2026-10-23): version 71 is planned by PR #768
-- (perf/integer-session-ids), and the loader needs every version in turn, so
-- 0072 (github_prs) cannot ship without one. This one does nothing.
--
-- If #768 lands before this file does, delete this file and keep #768's
-- 0071. If this file has already shipped in a release, it is applied and
-- frozen (a database at 72 never runs another 71): #768 then takes the next
-- free number instead.
SELECT 1;
