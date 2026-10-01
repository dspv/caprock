# Brief #2 — `/guides/check-claude-code-usage/`

Written 2026-10-01 from the search plan ([07-search.md](../07-search.md)).
Volumes: August 2026, [`../data/2026-10-01-keywords.tsv`](../data/2026-10-01-keywords.tsv);
built-in answer checked against code.claude.com/docs (costs, commands) and
support.claude.com 12157520 the same day.

## Question and phrases

"How much Claude Code have I used, and how much of my plan is left?" Owns
`claude code usage` (4,400).

- **H1:** How to check Claude Code usage — `how to check claude code usage` 210.
- **## Check usage inside Claude Code** — `claude code check usage` 90,
  `check claude code usage` 90.
- **## Token usage per session and per model** — `claude code token usage` 140.
- **## Plan limits: how close you are** — `claude code usage limit` 480
  (adjacent; keep short, link to the statusline guide).
- **## A usage dashboard across every session** — `claude code usage
  dashboard` 110, `claude code dashboard` 260.
- **## Usage monitors and trackers compared** — `claude code usage monitor`
  480, `usage tracker` 90, `claude code monitor` 260.

## Built-in answer

- `/usage` shows session cost, plan usage limits and activity stats; `/cost`
  is an alias, `/stats` opens it on the Stats tab.
- The session dollar figure is a local estimate at list price "intended for
  API users"; on Pro/Max it is not billing. Resets on `/clear`.
- Pro, Max, Team, Enterprise: plan usage bars and a breakdown by skills,
  subagents, MCP servers and loops (24h/7d), "computed from local session
  history on this machine" — other devices and claude.ai not included.
- `/status` is version, model, account — not usage. `/insights` is a report on
  how you work, not tokens.
- API: the Console usage page. Team/Enterprise: Analytics → Claude Code for
  owners and admins (lines accepted, accept rate, top commands).

## What Caprock adds, with proof

- Every session, any range, across five agents — `.ai/04-ui.md` § Cost & Burn.
- Cost per repository and per directory — `.ai/04-ui.md`, `feat-breakdown.png`.
- 5h / 7d windows next to cost (Pro/Max, via the status line) —
  `internal/statusline/statusline.go`, `feat-limits.png`.
- Limit hits counted from the `StopFailure` hook.
- What the money went on — `ui/src/components/WorkMix.tsx`.
- Every figure states its basis ("at API list price · not a bill") —
  `ui/src/components/CostBasis.tsx`.
- `caprock report` (`--markdown`, `--json`) — `cmd/caprock/report.go`.
- Screenshots `shot-now.png`, `shot-cost.png` are a copy of a real database
  with names anonymised (`scripts/shots.py`); the caption says so.

## Limits

- No absolute plan threshold — Claude Code does not emit it.
- On Pro/Max, cost is an API-price equivalent, not a bill.
- This machine only, like `/usage`.
- Plan windows need `caprock statusline install`.
- Some hook-plane tool calls cannot be priced; re-measure the share before
  stating it.

## Comparison (READMEs read 2026-10-01)

- **ccusage** — github.com/ccusage/ccusage: token usage and costs from local data.
- **Claude-Code-Usage-Monitor** — github.com/Maciek-roboblog/Claude-Code-Usage-Monitor:
  live terminal monitor with statusline `rate_limits`, forecasting.
- **phuryn/claude-usage** — github.com/phuryn/claude-usage: local dashboard
  for token usage, costs, session history.

## Claims still to verify

- Screenshots still match the current UI.
- How Codex usage shows on this page (or leave it to guide #5).
- The unpriced hook-plane share.

## Links

- In: home strip, `/docs/` Cost section, `where-the-money-goes`.
- Out: `/install/`, `where-the-money-goes`, guide #1 (status line), guide #5.
