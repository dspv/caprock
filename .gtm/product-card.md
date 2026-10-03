# Caprock — product card for directory forms

The one source for every listing form in [directories.yml](directories.yml).
Copy from here; do not rewrite per site. Every claim below traces to
[`README.md`](../README.md) or caprock.dev as read on **2026-10-04**. If the
product changes, change this file first and the listings after.

Rules that bind every field: no invented numbers; nothing is described as a
pilot, coming soon or unbuilt; Caprock **shows** where tokens go — it does not
lower a bill, and no copy may say or imply that it does.

## Identity

- **Name:** Caprock
- **Website:** https://caprock.dev
- **GitHub:** https://github.com/dspv/caprock
- **Docs:** https://caprock.dev/docs/
- **Install page:** https://caprock.dev/install/
- **Pricing:** https://caprock.dev/pricing/ (Premium detail: https://caprock.dev/premium/)
- **Changelog:** https://caprock.dev/changelog/
- **Press kit:** https://caprock.dev/press/
- **Submission / contact email:** who@caprock.dev
- **Founder / maker:** Dmitriy
- **First release:** 19 August 2026 (per caprock.dev/press)
- **Licence:** Apache-2.0 (open source; the free edition is the whole product)
- **Platforms:** macOS, Linux, Windows
- **Language / stack:** Go (single static binary), React dashboard embedded in it, SQLite

## Tagline (≤60 characters)

Primary (55 chars):

> Local dashboard for Claude Code, Codex and other agents

Alternates:

- `See what your Claude Code is actually doing` (43) — the README headline
- `Live activity and cost for your coding-agent sessions` (53)

## Short description (≤160 characters)

> Open-source local dashboard for Claude Code, Codex, OpenCode and Gemini CLI: live activity, cost per repo, loop alerts, searchable history. No telemetry.

(153 characters.)

## Medium description (~300 characters)

> Caprock is an open-source dashboard for AI coding agents that runs entirely on your machine. One Go binary watches Claude Code, Codex, OpenCode and Gemini CLI sessions and shows what each is doing, what it costs per repository at list prices, how close you are to plan limits, and everything the agent wrote, searchable.

(~320 characters; trim the last clause for a hard 300 limit.)

## Long description (~1000 characters)

> Caprock is a local, open-source dashboard for AI coding agents. A single Go binary runs a daemon that listens on loopback only and records every Claude Code session on the machine — through Claude Code's hooks and the transcripts it already writes — into a local SQLite database. Codex, OpenCode and DeepSeek Harness sessions are read from their own transcripts and databases; Gemini CLI sessions are recorded when Caprock starts them.
>
> The dashboard shows live activity per session, token cost per repository priced at API list prices, the 5-hour and weekly plan-limit windows, and alerts when a session repeats the same tool call in a loop. Everything the agent wrote is searchable across sessions, and the record is kept after Claude Code's default 30-day transcript cleanup. You can start sessions from the browser and type into the ones Caprock started.
>
> No account, no hosted service, no telemetry. Free under Apache-2.0; an optional Premium licence adds a daily spend cap and a weekly report.

(~1,000 characters.)

## What it is not (for forms that ask, and for keeping copy honest)

- Not a proxy and not a billing tool: costs are **modelled from captured tokens at list prices** — not a bill and not money saved.
- It does not reduce spend; it shows where tokens go.
- It never types into or signals a session it did not start.
- Codex, OpenCode and DeepSeek Harness are observation only.

## Pricing line

> Free and open source (Apache-2.0) for solo use. Premium: $30/year or $100 once, unlocked by an offline licence key. Teams plan available.

Notes for forms:

- Pricing model to pick: **Freemium** (or "Free + paid plan"); where only "Free / Paid / Open source" exist, pick **Open source** or **Free**.
- The README also lists **$5/month** for Premium; caprock.dev/premium shows $30/year and $100 once (read 2026-10-04). Use the two on the site unless a form asks for a monthly price.
- Teams (from caprock.dev/pricing, read 2026-10-04): $6,000/year for the whole team, never per person. Only mention where a form asks for every tier.

## Categories (pick the closest the site offers)

1. Developer Tools
2. AI Coding / AI Code Assistants (as a companion tool)
3. Observability / Monitoring
4. Analytics / Cost tracking
5. Open Source
6. Productivity
7. Command-line tools (for CLI-focused directories)

## Tags (15)

`claude-code`, `codex`, `opencode`, `gemini-cli`, `ai-coding-agents`,
`developer-tools`, `llm-observability`, `token-usage`, `cost-tracking`,
`dashboard`, `local-first`, `open-source`, `self-hosted`, `golang`, `sqlite`

(Matches the GitHub topics where they overlap.)

## Install

```bash
# macOS / Linux
brew install dspv/tap/caprock

# Windows
scoop bucket add dspv https://github.com/dspv/scoop-bucket
scoop install caprock

# Any OS with Go
go install github.com/dspv/caprock/cmd/caprock@latest

caprock up   # opens http://localhost:22776
```

For a single-line field use `brew install dspv/tap/caprock`. There is **no**
curl/shell install script — do not list one. Binaries:
https://github.com/dspv/caprock/releases

## Feature bullets (for "key features" fields)

- Live activity per session, as it happens
- Token cost per repository and per model, at API list prices
- 5-hour and weekly plan-limit windows
- Loop alerts when a session repeats the same tool call
- Everything the agent wrote, searchable across sessions
- History kept after Claude Code's 30-day transcript cleanup
- Start sessions from the browser and type into the ones Caprock started
- Claude Code, Codex, OpenCode, Gemini CLI and DeepSeek Harness on one screen
- Loopback only, no account, no telemetry
- CSV/TSV/JSONL export of the record (`caprock export`)

## Assets

Logos and screenshots live in `/Users/ds/dev/caprock-web/public` (served at
`https://caprock.dev/<path>`). Sizes measured 2026-10-04.

**Icon / logo** (`press/`):

| File                               | Pixels    | Size   | Use                                   |
| ---------------------------------- | --------- | ------ | ------------------------------------- |
| `press/caprock-icon-1024.png`      | 1024×1024 | 35 KB  | Square logo fields (most directories) |
| `press/caprock-icon-512.png`       | 512×512   | 16 KB  | Square logo, size-capped forms        |
| `press/caprock-icon-256.png`       | 256×256   | 5 KB   | Favicon-sized logo fields             |
| `press/caprock-icon.svg`           | vector    | 1 KB   | Where SVG is accepted                 |
| `press/caprock-mark-512.png`       | 512×512   | 5 KB   | Mark only, no tile                    |
| `press/caprock-mark.svg`           | vector    | 1 KB   | Mark only                             |
| `press/caprock-mark-light.svg`     | vector    | 1 KB   | Mark only, light variant              |
| `press/caprock-logo-dark.png`      | 1200×314  | 28 KB  | Wordmark, dark                        |
| `press/caprock-logo-light.png`     | 1200×314  | 28 KB  | Wordmark, light                       |
| `press/caprock-logo-for-dark.png`  | 1200×314  | 24 KB  | Wordmark for dark backgrounds         |
| `press/caprock-logo-for-light.png` | 1200×314  | 24 KB  | Wordmark for light backgrounds        |
| `press/caprock-logo-*.svg`         | vector    | 8 KB   | SVG versions of the four wordmarks    |
| `press/caprock-press-kit.zip`      | —         | 3.5 MB | Brand files + 8 screenshots, bundled  |

**Cover / social image:**

| File           | Pixels   | Size   | Use                                      |
| -------------- | -------- | ------ | ---------------------------------------- |
| `og.png`       | 1200×630 | 154 KB | Cover / thumbnail / Product Hunt gallery |
| `og-press.png` | 1200×630 | 149 KB | Alternate cover                          |

**Screenshots** (`shots/`, dark; each also has a `-light` twin of the same size):

| File                       | Pixels    | Size   | Shows                               |
| -------------------------- | --------- | ------ | ----------------------------------- |
| `shots/shot-now.png`       | 3200×2800 | 655 KB | Live pulse, activity, cost per repo |
| `shots/shot-cost.png`      | 3200×2800 | 637 KB | Plan value and cost breakdown       |
| `shots/shot-history.png`   | 3200×2800 | 505 KB | Lifetime history                    |
| `shots/shot-memory.png`    | 3200×2800 | 531 KB | Search across what the agents wrote |
| `shots/shot-tasks.png`     | 3200×600  | 113 KB | Task runner (off state)             |
| `shots/feat-projects.png`  | 3600×1020 | 145 KB | Projects list                       |
| `shots/feat-breakdown.png` | 3592×868  | 207 KB | What the money went on              |
| `shots/feat-limits.png`    | 3600×552  | 75 KB  | Plan-limit windows                  |
| `shots/feat-cap.png`       | 3600×920  | 117 KB | Daily cap (Premium)                 |

`shots/crop-today*.png` and `shots/crop-tasks*.png` are small crops (incl.
`-m` mobile variants) used on the site; not suited to forms.

**Animated** (in this repo, `docs/`): `docs/pulse.gif` 1700×242, 72 KB (live
pulse, also `pulse-light.gif`); `docs/context-tax.gif` 900×563, 720 KB.

Many forms cap screenshots at 1–5 MB and some want 16:9 — the `shot-*` files
are 8:7, so for a 16:9 slot use `og.png` or crop. Check the `shot-*` images for
project names before uploading anywhere new.

## Open points

- **Contact email.** This card uses `who@caprock.dev` as instructed
  (2026-10-04); caprock.dev/press lists `hi@caprock.dev`. Confirm the mailbox
  exists and receives mail before the first form uses it — directories send
  verification links there.
- **Founder surname.** [GTM-002](03-decisions.md) says the surname appears
  nowhere public, so forms use "Dmitriy" only. caprock.dev/press still shows
  the full name; that page or GTM-002 needs the owner's call.
