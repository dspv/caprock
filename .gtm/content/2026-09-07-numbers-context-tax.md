# /numbers — the context tax

**Where:** r/claudecode first, then X and LinkedIn in the product's voice
**Who posts:** Dima, personal account, on Reddit; the product account elsewhere
**Status:** DRAFT. Figures final, from `.ai/notes/context-tax.md` (Stage 0,
2026-09-07, 53 sessions after excluding the ones that developed the spike).
**Do not publish before** the meter ships — the post ends on "you can check
this", and that has to be true on the day it goes out.

---

## Why this post

Everyone has read that Spotify cut 90% by moving a payload out of the frontier
context. Nobody has checked whether the same move is available in Claude Code.
We did, on a real archive, and the answer is interesting in a way a marketing
post cannot fake: **the mechanism works, and the model refuses to use it.**

That refusal is the post. A finding people expect gets a scroll; a finding that
contradicts what the author was hoping for gets a comment. We spent the work
expecting to ship loop isolation and ended up shipping something else, and
saying so is the most credible thing in the piece.

The rule from the content plan holds: lead with the finding, the tool appears
at the end as the answer to "how do you know that".

## What is being claimed, precisely

Three claims, each measured, none extrapolated:

- **Reads are not the problem.** File reads are 1.6% of context token-turns.
  Routing them somewhere cheaper — the obvious Spotify analogue — is dead.
- **The money is context times calls.** Every tool call re-sends the whole
  conversation as a cache read. At 382k of context that is about $0.19 before
  the call does anything; the session that produced these numbers ran at 968k,
  where it is $0.48.
- **Isolation works and is not taken.** Moving a loop into a subagent is worth
  roughly 12x on that series. Nudged live, Claude did it once in 8 tries.

And the thing we shipped instead: **compaction saves more and needs nobody's
consent** — $578 against isolation's $466 on the same archive — because the
threshold is a setting, not a suggestion.

## The post

**Title:** Spotify cut 90% by moving the payload. I checked whether that works in Claude Code — it doesn't, and the reason is not what I expected.

**Body:**

The Spotify number has been going around: 90% saved by keeping a heavy payload
out of the frontier model's context. Claude Code reads a lot of files, so the
obvious move is to route those reads somewhere cheap.

I measured it on my own archive — 439 sessions, every turn priced at list.
File reads are **1.6%** of context token-turns. There is nothing there.

The cost is somewhere else, and it is structural. Every tool call re-sends the
entire conversation as a cache read. So a call costs whatever your context
costs, before it does any work:

- 382k of context — about **$0.19** per call
- 968k — about **$0.48** per call

That is per call, and a debugging loop is thirty of them. Half of my context
tax was paid above 500k of context — not by any single expensive thing, but by
the habit of running loops in a conversation that was never compacted.

Which points at an obvious fix: run the loop in a subagent. Fresh context, only
the result comes back. I measured it — about **12x** on the series.

So I wired up a hook to suggest exactly that, at the moment a loop got
expensive, and ran it on myself.

**8 nudges. It took the suggestion once.**

The message definitely arrived — I can see it in the transcript. Claude read
"this loop is costing you $1.14, move it to a subagent" and kept running Bash
in the main context. The one time it did delegate, it saved $1.41 of the $1.45
that loop would have cost. The lever is real. The model just doesn't pull it.

The thing that actually worked is duller. `autoCompactWindow` sets when Claude
Code compacts, and it is a number in settings.json. Left alone it sits near the
top of the model's window, which is why my session was at 968k. Set it lower
and every subsequent call is cheaper — **$578 on the same archive, more than
isolation was worth, and it doesn't require the model to agree to anything.**

One caveat I can't get rid of: I was both the experimenter and the subject. The
model being nudged was the one that wrote the nudge. If anyone wants to run the
same measurement on their own archive, it is one command:

```
go run github.com/dspv/caprock/cmd/routing-spike@latest -tax -json > my-context-tax.json
```

I would genuinely like to know if the 1-in-8 holds up on someone whose session
isn't about the experiment.

## Answering comments

The three that will come, and the honest answer to each:

- **"Your sample is one person."** Correct, and it is in the post. That is what
  the command at the end is for. The workload the whole thing was written about
  is the session that had to be excluded from it.
- **"Just use /compact yourself."** You can, and the post says the threshold is
  a settings key anyone can set. The part worth paying for is knowing which
  number, per project, from your own history.
- **"Did you tune the prompt?"** No. One trial, untuned. 1-in-8 is not the
  ceiling of what a nudge could do — it is what an untuned nudge did, which is
  why the lever is parked and not deleted.

**Do not claim compaction is free in the comments.** It is not measured yet:
after a boundary the model re-reads some of what the summary dropped, and that
cost is not in the $578. If asked, say exactly that — it is the next thing we
are measuring, and the intervention does not ship if re-reads eat half the
saving.
