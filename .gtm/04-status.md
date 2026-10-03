# Go-to-market status

## Where things stand

**Last updated: 2026-10-04.** The first Reddit launch posts are published. The
2026-08-28 Show HN was killed on arrival and nobody saw it; the account is under
review with HN. The repeatable owned channel is not running yet: the product can
publish under `caprock`, while the separate personal channel still waits for a
name ([01-channel.md](01-channel.md)).

| Surface        | State                                                                  |
| -------------- | ---------------------------------------------------------------------- |
| caprock.dev    | Live. Analytics on (Umami), `copy-command` event instrumented          |
| GitHub repo    | Live, public, screenshots and description current                      |
| Reddit         | Launch posts published 2026-08-28                                      |
| Hacker News    | Show HN dead on arrival 2026-08-28; asked HN to review the account     |
| Telegram       | The owner's own, in Russian. Not a product channel                     |
| X              | Not registered; register as `caprock`                                  |
| LinkedIn       | Not registered; register as `caprock`                                  |
| YouTube        | Not started; the first video is no longer blocked on a published post  |
| Paid promotion | Deliberately held until 15–20 posts exist ([GTM-004](03-decisions.md)) |

## Completed launches

- **Reddit:** posted 2026-08-28 to r/claudecode and r/claudeskills. The result
  still needs to be read from Umami against the 17% install-intent rate from
  the Telegram repost.
- **Show HN:** posted 2026-08-28 with a repository link and short body. It was
  dead on arrival — 1 point, no comments, not in HN search — and so were the
  account's submissions of 2026-06-15 and 2026-09-17 (read from the HN API on
  2026-10-03; the account has `showdead` off, so the owner never saw it). The
  owner emailed hn@ycombinator.com on 2026-10-03 asking for a review. Do not
  post again from that account until HN answers.
- **Awesome lists (2026-10-03):** listed in Piebald-AI/awesome-gemini-cli.
  Under review: hesreallyhim/awesome-claude-code (issue #3058, filed by the
  owner through the web form, which the list requires), awesome-opencode #804,
  ai-for-developers/awesome-ai-coding-tools #845, awesome-codex-cli #360,
  bradAGI/awesome-cli-coding-agents #429. Older and quiet: jqueryscript #618,
  rohitg00 #751.

## Next actions

0. **This week (from 2026-10-04):** Reddit posts by the owner — r/ClaudeAI
   first, r/ChatGPTCoding a day later; drafts in `~/Downloads/reddit-caprock/`.
   Directory submissions, 5–10 a day, from `.gtm/directories.yml`: the owner
   signs up and logs in, the agent fills the forms. A Habr article in Russian.

1. **Register `caprock` on X, LinkedIn and YouTube.** No name to pick — the
   product already has one, and it carries no surname ([GTM-008](03-decisions.md)).
2. **Record the first video**: 60–90 seconds, the dashboard and one finding,
   screen only. Scrub project names before recording — a video cannot be
   replaced after posting the way a screenshot can.
3. Publish weekly for six weeks against [06-content-plan.md](06-content-plan.md),
   then evaluate. A personal channel is still wanted and still waits for a name;
   it no longer blocks anything.

## The one measured fact so far

17% of a cold audience copied the install command (2026-08-24, below). That is
a high enough conversion that the page is not the problem — the problem is that
nobody is arriving at it. Everything on this list is about arrival.

## Measured results

### 2026-08-24 — First organic exposure

The owner showed Caprock in a small Telegram chat and its owner reposted it to a
larger one. Neither post was written as promotion.

- **82 visitors, 86 visits, 103 page views** over the following hours
- **14 visitors copied the install command** — a **17% install-intent rate**
- 86% of visits landed on `/`; `/install` drew 5, `/numbers` 4
- Bounce 77%, average visit 42s — expected for a one-page site whose call to
  action is a command to copy, not a page to browse
- Geography far wider than the source chat: US 8, Netherlands 8, Germany 7,
  Cyprus 7, Spain 5, Georgia 4, Poland 4, **Russia 4**, Sweden 3, France 3
- **28% of visits came from iOS**, where the product cannot be installed at all
- Referrers nearly empty: Telegram strips them, so the traffic reads as direct

The number that matters is the 17%. For cold traffic from a chat, that is a
strong signal the landing page explains the product well enough for a stranger to
act on it.

The iOS share is worth remembering when interpreting short visits: a quarter of
readers were on a phone and physically could not install.
