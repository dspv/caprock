# Brief #6 — post: what Claude Code costs per month, measured

Written 2026-10-01 from the search plan ([07-search.md](../07-search.md)).
Volumes: August 2026, [`../data/2026-10-01-keywords.tsv`](../data/2026-10-01-keywords.tsv).
Plan prices read from claude.com/pricing the same day.

## Question and phrases

"How much will Claude Code cost me a month?" Buying intent; the results are
pricing guides and claude.com/pricing.

- **H1:** What Claude Code costs per month — N months on one machine —
  `claude code cost per month` 110, `claude code cost` 2,900.
- **## The plan prices** — the direct answer first (`claude code cost`).
- **## My months at list price** — `how expensive is claude code` 170.
- **## What a token costs** — `claude code token cost` 590: cache reads
  against fresh input per month, link to the dated price table.
- **## Plan or API** — list-price equivalent against the plan fee, per month.
- **## Run it on your machine** — the commands, then `/install/`.

## Official answer (claude.com/pricing, 2026-10-01)

- Pro $17/mo billed annually, $20 monthly; includes Claude Code.
- Max "From $100", 5x or 20x — **the 20x price is not printed; read it from the
  plan picker before quoting.**
- Team: standard seat $20 annual / $25 monthly; premium seat $100 / $125.
- Enterprise: $20/seat annual plus usage at API rates.
- API list prices: platform.claude.com/docs/en/about-claude/pricing.
- Built-in: `/usage` (`/cost`), code.claude.com/docs/en/costs.

## The measurement

First reading, 2026-10-01, Caprock v0.62.0, `caprock export events --agent
claude --format csv`, UTC months, list-price equivalent:

| Month   | Claude Code cost | Turns  | Sessions | Active days |
| ------- | ---------------- | ------ | -------- | ----------- |
| 2026-07 | $6,056.39        | 39,639 | 17       | 14          |
| 2026-08 | $5,898.03        | 28,001 | 63       | 29          |
| 2026-09 | $2,093.18        | 9,071  | 43       | 14          |

- July starts mid-month (the record begins there). August is the one full month.
- 10–28 September the work moved to Codex; transcripts on disk confirm almost
  no Claude Code turns those days. The post says so — it is the honest reason
  the month is small, and a finding (one machine, two agents).
- Before publishing: re-run on the day with the read-only SQL below, compare
  with `daily_stats`, state the unpriced turns, check `retention_days` is 0.

```sql
-- sqlite3 -readonly "~/Library/Application Support/caprock/caprock.db"
SELECT strftime('%Y-%m', ts/1000,'unixepoch','localtime') m,
       ROUND(SUM(cost_usd),2) usd, COUNT(*) turns, SUM(cost_usd IS NULL) unpriced,
       COUNT(DISTINCT date(ts/1000,'unixepoch','localtime')) active_days
FROM events WHERE kind='turn.assistant' AND internal=0
 AND session_id IN (SELECT session_id FROM sessions WHERE agent='claude')
GROUP BY m ORDER BY m;
```

Limits hit per month: `throttle_observations`. Plan and caveat wording:
`caprock report --json` (`cmd/caprock/report.go`).

## Must not claim

- The list-price figure is not a bill on a flat plan — use the report's
  "flat" caveat wording.
- One heavy user's machine is not typical; no forecast.
- Do not repeat where-the-money-goes ($181/day, Bash 49%); link to it for
  "what it went on".

## Comparison

claude.com/pricing (prices, no usage), finout and superblocks pricing guides,
one Reddit instrumentation thread. None shows a measured month.

## Links

Out: `where-the-money-goes`, `/numbers/`, guide #2, guide #1 (plan windows),
`/install/`.
