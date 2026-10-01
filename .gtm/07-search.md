# Search: what people type, and which page answers it

Written 2026-10-01, when the owner decided to develop search for caprock.dev.
The rules for writing the pages are in caprock-web
`.claude/skills/landing-page/SKILL.md` and `.claude/skills/blog-post/SKILL.md`;
this file is the evidence and the map.

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

## What people type

Google's autocomplete for seed phrases, read 2026-10-01. These are real
queries but carry **no volume**: they decide wording and which page owns what,
not how much traffic to expect.

- **History lost** — `claude code history disappeared`, `… history gone`,
  `… sessions disappeared`, `… history viewer`, `… history search`,
  `… sessions history`.
- **Where the files are** — `claude code transcripts location`,
  `… transcript path`, `… transcripts viewer`, `… transcript extraction tool`.
- **Usage and cost, solo** — `claude code usage monitor`, `… usage tracker`,
  `… usage dashboard`, `… token usage report`, `… cost per month`,
  `… cost calculator`, `… monitor token usage`.
- **The incumbent** — `ccusage`, `ccusage alternative`, `ccusage codex`,
  `ccusage statusline`.
- **Sessions** — `claude code sessions list`, `… sessions manager`,
  `… monitor agents`, `… sessions talk to each other`.
- **Teams** — `claude code analytics dashboard`, `… analytics admin api`,
  `… analytics api`.

## Which page owns which query

| Query cluster                  | Page                           | Status 2026-10-01                       |
| ------------------------------ | ------------------------------ | --------------------------------------- |
| usage dashboard / monitor      | `/`                            | title and h1 carry it                   |
| history disappeared / location | `/blog/claude-code-forgets/`   | sections added for both                 |
| one table across agents        | `/blog/five-agents-one-table/` | published                               |
| cost per month / token report  | `/numbers/`, money post        | titles carry "Claude Code usage"        |
| analytics dashboard (team)     | `/teams/`                      | h1 category "usage analytics for teams" |
| ccusage alternative            | new page                       | **open** — the biggest gap              |
| sessions list / manager        | `/` strip "live sessions"      | heading carries it                      |
| transcript viewer / search     | `/docs/` Memory section        | **open** — needs a task heading         |

## Next, in order

1. **"ccusage alternative"** — a comparison page or post. ccusage is the tool
   people already know; the query exists in autocomplete. Every cell about
   ccusage read from its own README with a date, the fit statement saying who
   should stay on ccusage. No claim about it inferred from silence.
2. **Transcript viewer / search** — a /docs section or a post on reading and
   searching old sessions, with Memory as the answer.
3. **Watch the effect.** Re-read Search Console four weeks after each page goes
   live: impressions per page and the queries each one actually gets. Those
   queries — not autocomplete — choose the next headings.
4. **Bing Webmaster Tools** — connect it; Copilot citations are reported there.

What this file does not do: predict traffic. Autocomplete has no volumes, and
201 impressions is not a baseline anyone can extrapolate from (rule 6).
