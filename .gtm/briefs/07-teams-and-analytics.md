# Brief #7 — /teams update and a post on Anthropic's Claude Code analytics

Written 2026-10-01 from the search plan ([07-search.md](../07-search.md)).
Volumes: August 2026, [`../data/2026-10-01-keywords.tsv`](../data/2026-10-01-keywords.tsv).
Anthropic's documentation read the same day.

## Question and phrases

"What does Anthropic already show my team about Claude Code, and what is
missing?" Phrases: `claude code enterprise` 390, `otel` 210, `analytics` 140,
`telemetry` 110, `for teams` 90, `team pricing` 90, `opentelemetry` 70,
`analytics api` 50. (`claude code team` 590 is mixed with agent-teams intent —
not targeted.)

Post outline:

- **H1:** Claude Code analytics: what Anthropic shows a team, and what it doesn't.
- **## The Team and Enterprise dashboard** — for teams, enterprise.
- **## The spend report** — team pricing.
- **## The Claude Code Analytics API** — analytics api.
- **## OpenTelemetry: your own stack** — otel, telemetry, opentelemetry.
- **## What none of them answer** — then `/teams/`.

## Official answer (2026-10-01)

- **Dashboard** (code.claude.com/docs/en/analytics): lines accepted, accept
  rate, daily active users and sessions, leaderboard, CSV. PRs and lines
  shipped need the GitHub app (public beta, off under ZDR). No cost.
- **Spend report** (support 12883420): per user and model, up to 90 days,
  net and gross USD; seat-based Enterprise shows only spend above allotment.
- **Analytics API** (platform.claude.com): Admin API key, one UTC day per
  call, per user: sessions, lines, commits, PRs, tool accept/reject, tokens
  and estimated cost per model. Up to an hour late. Excludes Bedrock, Vertex,
  Foundry. No repository field.
- **Enterprise Analytics API**: separate key, data from 2026-01-01. Team plans
  get no API.
- **OTel** (monitoring-usage): `claude_code.cost.usage` and token, session,
  lines, commit, PR, active-time metrics; `user.email`, `session.id`;
  `vcs.repository.name` opt-in via `OTEL_METRICS_INCLUDE_REPOSITORY`. Prompts
  redacted by default. You run the backend. Plan restrictions not documented —
  write "not documented".

## What Caprock adds (built, per machine)

- Cost per directory from the files each turn touched —
  `internal/store/touch.go`, `repo.go`.
- Cost by kind of work — `internal/store/workkind.go`.
- Live loop alerts — `internal/loop/loop.go`.
- Codex, OpenCode, Gemini, DeepSeek in the same tables.
- Weekly report against the four-week median — `internal/weekly/weekly.go`.
- Works with API, Bedrock or Vertex auth: it reads local transcripts.

Limits: list-price estimates; no PR or commit attribution (Anthropic does
that better — say so).

## /teams changes

- "Spend per repository" compare row: Anthropic's column is no longer a bare
  dash — OTel can tag repositories when you opt in. Name the opt-in and that
  it lives in your stack.
- Add rows for the Analytics API and OTel.
- Keep the FAQ "Doesn't Anthropic already show this?" and link the post.

## Internal note (never public)

`.ai/17-teams.md` marks the team server as specified, not built; the code has
no collector or per-person view. The post's claims about Caprock stay with
what one machine does today. The live /teams copy ("across every laptop", "a
collector", "per person is a switch") is the owner's decision under rule 11 —
raised with him 2026-10-01, not changed here.

## Comparison

code.claude.com analytics (official), faros.ai and worklytics.co (vendors),
GreptimeTeam's OTel dashboard (top for `otel`).

## Links

Post ↔ `/teams/#plans`, `where-the-money-goes`, `five-agents-one-table`,
`/numbers/`, `/install/`.
