# Reddit — first post

**Where:** r/ClaudeAI
**Who posts:** Dima, personal account, no surname
**When:** a weekday morning US time (that is evening in Israel)
**Status:** POSTED 2026-08-28 to r/claudecode and r/claudeskills, under Dima's
own account. Figures read that morning with `caprock report` on v0.33.0.

The text that went out is the short version below, not the long one this file
first carried. The long one read as slop — "Not 'roughly' — I mean", "A few
things I did not expect", "I am not claiming X, I am saying Y" — hedging that
belongs in a document and reads as marketing in a post. Cut to about a third.

The headline carries the finding rather than only the total: *half of it was
running commands, not writing code*. A number invites a scroll; a claim people
disagree with invites a comment, and comments are what move a post.

---

## Why this post and not a different one

Every figure in it is measured on Dima's own machine and can be checked by
anyone who installs the thing. That is the entire asset: a competitor can copy
the dashboard, and cannot copy having spent $11,711 through it.

It leads with the finding, not the product. People come for the number and
find the tool underneath it — the reverse does not work on Reddit, where a
post that opens with a product gets read as an ad and downvoted.

**The comments matter more than the post.** Reddit decides in the first hour,
and it decides on whether the author answers like a person. Dima should plan
to be around for a couple of hours after posting.

## The span question, answered

It was open because nobody had counted the calendar days behind the 60 active
ones. `caprock report` now prints both: the window runs 24 May to 27 August —
**97 calendar days**, 61 of them with activity — so the plan fee for it is
$200 × 97 ÷ 30 = **$647**, and the multiple is **18×**.

The post still leads with the total rather than the multiple. A multiple
invites the reader to argue about the denominator; a total invites them to
check their own.

---

## The post

**Title:** I measured what my Claude Code actually costs. $11,711 over three months — on a $200/month plan.

**Body:**

I have been on Max 20× since June and had no idea what any of it was going to.
Not "roughly" — I mean the plan is flat, so nothing itemises. You pay $200 and
the usage is invisible.

So I wrote something to read the transcripts Claude Code already writes to
disk, price every turn at Anthropic's list rates, and add it up. Three months
later — 97 calendar days, 61 of them with any activity on them:

    $11,711      priced at API list rates — not a bill
    $647         what I actually paid over the same window
    131          sessions
    75,397       turns
    84,247       tool calls
    99%          cache hit rate

A few things I did not expect.

**Bash is half of everything.** 43,163 calls, 51% of every tool call I have
made — running tests, running builds, running `git status` for the hundredth
time. Reading is 14% and editing 9%. I assumed writing code was the expensive
part. It is not; running it is.

**The cache is doing enormous work.** 99% hit rate, which is where most of the
gap between "what this would cost through the API" and "what I actually pay"
comes from. If you are on a flat plan you are not seeing this at all.

**A session can start repeating itself and nothing tells you.** One of mine
ran the same tool call five times in three minutes. The session it happened in
had thousands of dollars of list-price usage on it by then — I am not claiming
the loop spent all of that, I am saying I had no idea either was happening
until I went looking afterwards.

That last one is why the thing stopped being a script. It now sits open on a
second monitor and shows every session on the machine — including the ones I
start by hand in a terminal — what each is doing, what it has cost, and a
banner when one starts repeating itself.

It is a single Go binary, runs entirely on your machine, no account, no
telemetry, Apache-2.0. It reads the transcripts that are already there, so it
sees sessions you started before installing it.

https://github.com/dspv/caprock

Happy to answer anything about the numbers or how the pricing is computed —
it is all list rates from Anthropic's published table, dated, and the code that
does it is right there.

---

## What NOT to say in the comments

- Never claim it saves money. It does not; it shows where money went.
- Never quote a figure not on this page. If someone asks something we have not
  measured, say we have not measured it.
- A session's cost is not the loop's cost. Caprock cannot price a loop
  separately, and saying otherwise is the kind of small overclaim that loses
  the room on Reddit.
- No "we". One person made this.
