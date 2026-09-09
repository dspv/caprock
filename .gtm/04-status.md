# Go-to-market status

## Where things stand

**Last updated: 2026-09-09.** The first Reddit and Show HN launch posts are
published. The repeatable owned channel is not running yet: the product can
publish under `caprock`, while the separate personal channel still waits for a
name ([01-channel.md](01-channel.md)).

| Surface        | State                                                                  |
| -------------- | ---------------------------------------------------------------------- |
| caprock.dev    | Live. Analytics on (Umami), `copy-command` event instrumented          |
| GitHub repo    | Live, public, screenshots and description current                      |
| Reddit         | Launch posts published 2026-08-28                                      |
| Hacker News    | Show HN published 2026-08-28                                           |
| Telegram       | The owner's own, in Russian. Not a product channel                     |
| X              | Not registered; register as `caprock`                                  |
| LinkedIn       | Not registered; register as `caprock`                                  |
| YouTube        | Not started; the first video is no longer blocked on a published post  |
| Paid promotion | Deliberately held until 15–20 posts exist ([GTM-004](03-decisions.md)) |

## Completed launches

- **Reddit:** posted 2026-08-28 to r/claudecode and r/claudeskills. The result
  still needs to be read from Umami against the 17% install-intent rate from
  the Telegram repost.
- **Show HN:** posted 2026-08-28 with a repository link and short body. It went
  out on the same day as Reddit, despite the launch notes recommending separate
  days, because the figures were fresh and the owner was available for both.

## Next actions

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
