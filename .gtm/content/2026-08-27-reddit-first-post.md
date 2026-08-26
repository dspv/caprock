# Reddit — first post

**Where:** r/ClaudeAI
**Who posts:** Dima, personal account, no surname
**When:** a weekday morning US time (that is evening in Israel)
**Status:** draft — needs Dima's read and one number confirmed

---

## Why this post and not a different one

Every figure in it is measured on Dima's own machine and can be checked by
anyone who installs the thing. That is the entire asset: a competitor can copy
the dashboard, and cannot copy having spent $11,166 through it.

It leads with the finding, not the product. People come for the number and
find the tool underneath it — the reverse does not work on Reddit, where a
post that opens with a product gets read as an ad and downvoted.

**The comments matter more than the post.** Reddit decides in the first hour,
and it decides on whether the author answers like a person. Dima should plan
to be around for a couple of hours after posting.

## What needs confirming before this goes out

- The multiple. $11,166 over **two** calendar months of a $200 plan is 27.9×;
  over three it is 18.6×. The post below avoids the multiple entirely for that
  reason, but if Dima wants it in, we need the real span.

---

## The post

**Title:** I measured what my Claude Code actually costs. $11,166 in 60 days — on a $200/month plan.

**Body:**

I have been on Max 20× since June and had no idea what any of it was going to.
Not "roughly" — I mean the plan is flat, so nothing itemises. You pay $200 and
the usage is invisible.

So I wrote something to read the transcripts Claude Code already writes to
disk, price every turn at Anthropic's list rates, and add it up. Sixty active
days later:

    $11,166.06   priced at API list rates — not a bill
    130          sessions
    73,755       turns
    82,906       tool calls
    99%          cache hit rate

A few things I did not expect.

**Bash is half of everything.** 41,000 calls — running tests, running builds,
running `git status` for the hundredth time. Reading and editing files together
are about a quarter of it. I assumed writing code was the expensive part. It
is not; running it is.

**The cache is doing enormous work.** 99% hit rate, which is where most of the
gap between "what this would cost through the API" and "what I actually pay"
comes from. If you are on a flat plan you are not seeing this at all.

**A session can start repeating itself and nothing tells you.** One of mine
ran the same tool call five times in three minutes. The session it happened in
had $3,157 of list-price usage on it by then — I am not claiming the loop spent
all of that, I am saying I had no idea either was happening until I went
looking afterwards.

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
- The $3,157 is the SESSION's cost, not the loop's. Caprock cannot price a
  loop separately, and saying otherwise is the kind of small overclaim that
  loses the room on Reddit.
- No "we". One person made this.
