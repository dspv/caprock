# Brief #5 — `/guides/codex-usage-and-cost/`

Written 2026-10-01 from the search plan ([07-search.md](../07-search.md)).
Volumes: August 2026, [`../data/2026-10-01-keywords.tsv`](../data/2026-10-01-keywords.tsv);
built-in answer checked against OpenAI's Codex docs (now at
learn.chatgpt.com) the same day.

## Question and phrases

"How much Codex have I used, when does my limit reset, and what is it
costing?" Owns `codex usage` (9,900).

- **H1:** Codex usage: check your limits, and see what each session costs.
- **## Check your Codex usage limit** — `codex usage limit` 1,000.
- **## Codex CLI usage from the terminal** — `codex cli usage` 90.
- **## What Codex costs, session by session** — `codex cost` 1,600.
- **## ccusage codex and other tools** — `ccusage codex` 70.

## Built-in answer

- Usage dashboard: `chatgpt.com/codex/settings/usage`. CLI: `/status` (session
  config and token usage), `/usage daily|weekly|cumulative`.
- Limits are per five-hour period, estimated per model and plan; "Pro plans
  currently have no five-hour limit". Weekly window: not stated on the
  pricing page — verify.
- "API token prices are separate from subscription usage."
- `codex resume` (`--last`, `--all`), `/resume`. The `~/.codex/sessions`
  path is not in the official pages read; it is measured on disk.

## What Caprock adds, with proof

- Imports Codex sessions from `~/.codex/sessions/…/rollout-*.jsonl`, no hook,
  no config (`.ai/19-codex.md`, `internal/codex/codex.go`).
- Prices them from its own table — Codex reports no cost
  (`pricing/pricing.json`).
- Same screens as Claude Code, agent filter on Now, GPT models in the model
  mix (`.ai/04-ui.md`). `caprock export --agent codex`.
- Screenshots `shot-cost.png`, `shot-history.png` show GPT models and Codex's
  background review usage.

## Limits — and product gaps found while briefing

- **Plan limits are not shown.** The parser reads the 5h/7d windows but
  nothing stores or shows them (`internal/codex/codex.go`). The page must not
  claim it; showing them would make this guide much stronger.
- **Some sessions are missed:** `CODEX_HOME` and `archived_sessions/` are not
  read (ccusage reads both). Fix before this guide, or state it.
- **Copy defect:** the Cost screen subtitle says "At Anthropic list prices"
  while GPT rows are shown.
- Cost is an API-list equivalent, not what a ChatGPT plan charges; turns that
  report only a total are priced as all input; fast mode is not priced.

## Comparison

- **ccusage.com/guide/codex** (Beta): `ccusage codex daily|monthly|session`,
  reads `CODEX_HOME` incl. archived sessions, prices from LiteLLM; nothing on
  plan limits.
- VS Code "Claude Code and Codex Assist" claims usage, cost and quota —
  verify.

## Claims

- Verified: `/status`, `/usage`, dashboard URL, 5h estimates, Pro has no 5h
  limit, sessions path on disk.
- Rejected: "Caprock shows Codex limits".
- Needs verification: weekly window; `.zst` compression of old rollouts.

## Links

- Out: `/install/`, `five-agents-one-table`, guides #1 and #2.
- In: guides #1 and #2, `five-agents-one-table`, `/docs/` Codex section.
