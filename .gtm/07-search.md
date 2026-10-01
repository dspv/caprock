# Search: what people type, and which page answers it

Written 2026-10-01, when the owner decided to develop search for caprock.dev.
How to research and write the pages is in caprock-web's
`.claude/skills/search-plan`, `landing-page` and `blog-post`; this file is the
evidence and the plan.

## Where we start

Google Search Console, last 90 days, read 2026-10-01:

| Site        | Clicks | Impressions | CTR  | Avg. position |
| ----------- | ------ | ----------- | ---- | ------------- |
| caprock.dev | 19     | 201         | 9.5% | 6             |
| fortem.dev  | 347    | 123K        | 0.3% | 14.6          |

- **caprock.dev ranks for nothing but its own name.** Every query in the report
  is the brand, a `site:` search or a localhost URL. There is no category
  traffic to lose, so any task page is upside.
- **fortem.dev has volume on the wrong intent.** Its top queries are AWS Fargate
  and ECS pricing — the archived ECS product — while the product is now
  Kubernetes. The owner reports very high bounce there and good engagement on
  caprock. The lesson for caprock: rank for what the product *does*, or the
  traffic leaves.

## What people search for, measured

DataForSEO, read 2026-10-01: Google Ads search volume for 85 phrases picked
from 1,369 Labs keyword suggestions, plus Google's top results for 22 of them.
US, English. Raw data, with method lines, in
[`data/2026-10-01-keywords.tsv`](data/2026-10-01-keywords.tsv) and
[`data/2026-10-01-serps.tsv`](data/2026-10-01-serps.tsv). Cost: under $0.50.

How to read the numbers:

- **Volume is Google's rounded monthly average.** Close phrasings share a
  bucket (`claude code cost` and `claude code costs` both read 4,400), so
  volumes of near-synonyms are never added up.
- **The months below are 2026.** Almost every Claude Code phrase fell from
  March to August, often by half. Plan on August, not on the twelve-month
  average.
- **A blank is "not measured", not "no demand".** `ccusage alternative` reads
  10 — the autocomplete list made it look like the biggest gap; it is not.
- **CPC is an ad signal.** High CPC on `claude code usage monitor` ($13) and
  `usage tracker` ($15) says advertisers pay for that intent; it says nothing
  about organic traffic.
- **None of this is a traffic forecast** (rule 6). It ranks topics.

## Clusters

Each cluster: the phrases with their August volume, the intent, what Google
shows now, and whether Caprock answers it.

- **Status line** — `claude code statusline` 1,000, `status line` 1,000
  (was 2,400 in May). Navigational / how-to. Top results are GitHub repos, a
  Medium setup post, claudelog; `ccusage.com/guide/statusline` ranks 8–9.
  Caprock ships `caprock statusline install`. **Fits.**
- **Check usage, solo** — `claude code usage` 4,400, `usage monitor` 480,
  `how to check claude code usage` 210, `token usage` 140, `check usage` 90,
  `usage tracker` 90, `usage dashboard` 110, `dashboard` 260, `monitor` 260.
  How-to plus tool. Anthropic's docs and help centre lead; the rest is GitHub
  tools (Claude-Code-Usage-Monitor, phuryn/claude-usage), HN and ccusage.com
  (rank 8–11). **Fits — the core.**
- **History** — `claude code history` 260, `history viewer` 390 (590 in most
  months since March), `transcripts` 210, `chat history` 70, `export conversation` 70,
  `conversation history` 30, `session history` 50, `where does claude code
  store conversation history` 50. Tool and how-to. Top results are GitHub
  viewers, a VS Code extension, mcpmarket skills, Reddit, HN — no strong page.
  **Fits — Memory, search, kept past 30 days.**
- **Sessions** — `claude code resume` 210, `resume session` 170, `how to
  resume claude code session` 260, `list sessions` 320, `sessions` 260,
  `save session` 110, `session manager` 210. How-to; the answer starts with
  `claude --resume`. Top results: GitHub issues, Reddit, small tools.
  **Fits — pick up a session Caprock did not start.**
- **Codex usage** — `codex usage` 9,900, `codex usage limit` 1,000,
  `codex cost` 1,600, `ccusage codex` 70, `codex cli usage` 90. Mostly people
  hitting limits; top results are OpenAI forum threads, GitHub issues, Reddit;
  `ccusage.com/guide/codex` ranks 8. Caprock imports Codex sessions and cost
  ([19-codex.md](../.ai/19-codex.md)); it does not show Codex's plan limits.
  **Fits the cost half only.**
- **Cost, buying** — `claude code cost` 2,900, `cost per month` 110, `how
  expensive is claude code` 170, `token cost` 590. Intent is "what will I pay";
  results are pricing guides (finout, superblocks) and claude.com/pricing.
  **Fits only as measured data:** what a real machine's months cost.
- **Teams and analytics** — `claude code analytics` 140, `for teams` 90,
  `team pricing` 90, `enterprise` 390, `otel` 210, `telemetry` 110,
  `analytics api` 50. Anthropic's docs own the head; faros, worklytics,
  minware write around it. **Fits /teams**, small volume.
- **ccusage** — `ccusage` 2,400, `npx ccusage` 260. Navigational: people want
  ccusage itself. Not a target; ccusage is named where we compare.
- **Parked — Anthropic's own features.** `claude code remote control` 3,600,
  `mobile` 480, `agent teams` 1,300, `multiple agents` 210, `orchestrator` 210.
  Anthropic's docs own them; Caprock's answer (web terminal, orchestrator)
  needs its own verification before any page claims it.

**What Google rewards here:** GitHub READMEs, Reddit, HN and single-purpose
task pages. ccusage.com ranks for 149 phrases with one page per task
(`/guide/codex`, `/guide/statusline`, `/guide/cost-modes`). caprock.dev ranks
for none in DataForSEO's index. The GitHub README of `dspv/caprock` is a
search surface too.

## Plan

One page owns one cluster. Guides are task pages: the question in the H1,
the direct answer first (including the free built-in way, when there is one),
then what Caprock adds, with a real screenshot or real output.

| # | Page                                   | Owns              | Aug volume, head |
| - | -------------------------------------- | ----------------- | ---------------- |
| 1 | `/guides/claude-code-statusline/`      | status line       | 1,000            |
| 2 | `/guides/check-claude-code-usage/`     | check usage, solo | 4,400            |
| 3 | `/guides/claude-code-history/`         | history, viewer   | 390              |
| 4 | `/guides/resume-claude-code-sessions/` | sessions          | 320              |
| 5 | `/guides/codex-usage-and-cost/`        | Codex usage       | 9,900            |
| 6 | post: a measured month of cost         | cost, buying      | 2,900            |
| 7 | `/teams/` + post on the Analytics API  | teams, otel       | 390              |

- **Done:** #1 published 2026-10-01 at
  `caprock.dev/guides/claude-code-statusline/`, linked from /docs and
  /install; re-read Search Console for it from 2026-10-29.
- **Order** is fit first, then volume against how weak the current results
  are. #5 is lower than its volume because Caprock answers only the cost half.
- **Home** keeps `Claude Code usage dashboard`; guide #2 answers the how-to
  and links to it.
- **`/blog/claude-code-forgets/`** stays the story of the 30-day cleanup;
  guide #3 is the task page and links to it.

### Briefs

Each page has a brief in [`briefs/`](briefs/) — the phrases per heading with
volumes, the built-in answer checked against official docs, what Caprock adds
with the file that proves it, limits, competitors and the claims still to
verify. Findings from writing them (2026-10-01):

- **#3 history** — "kept past 30 days" is not unique (a popular viewer has a
  one-click backup); our difference is that it is automatic. Needs a Memory
  screenshot before writing.
- **#4 sessions** — the H1 owns `how to resume claude code session` (260);
  needs a continue / can't-continue screenshot.
- **#5 Codex** — Caprock does not show Codex plan limits and misses
  `CODEX_HOME` and `archived_sessions/`; fix in the product first or state it.
  The Cost screen subtitle says "Anthropic list prices" beside GPT rows.
- **#6 cost post** — first monthly reading taken; the Max 20x price must be
  read from the plan picker.
- **#7 teams** — the compare row "spend per repository" is stale: Anthropic's
  OpenTelemetry export can tag repositories when opted in.
- **Remote / mobile (parked)** — Caprock lets a paired phone or tablet watch
  every session over the LAN or Tailscale, and pause or kill the ones it
  started; it does not type into sessions or answer permission prompts. It
  can own "watch Claude Code from your phone", never "remote control".

### Internal links

- Home → guides #1–#3 from the strip items that already name those tasks.
- Every guide → `/install/` as its one action, and → the post that measures
  the same thing (history → `claude-code-forgets`, usage and cost →
  `where-the-money-goes`, Codex → `five-agents-one-table`).
- Guides #1, #2 and #5 link each other (one tool, three surfaces).
- Posts → the guide that does the task they describe.
- `/docs/` sections link to the guide for each task; the guide does not repeat
  the reference.

### Before each page

The rules are in caprock-web's `search-plan`, `guide`, `landing-page` and
`blog-post` skills. In short: re-read the cluster's results on the day, check every
competitor statement against its current source, every product claim against
the code, and pass the independent fact-check.

## Watch the effect

- Re-read Search Console four weeks after each page goes live: impressions,
  position and the queries it actually gets. Those choose the next headings.
- Re-pull these volumes monthly; the trend is falling and the plan follows
  August, not March.
- Connect Bing Webmaster Tools; Copilot citations are reported there.
