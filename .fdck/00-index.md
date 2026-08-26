# Caprock — User Feedback

What real users said, when they said it, and what happened as a result.

This directory exists because the feedback that moved the product arrived in
chat logs and voice notes and lived nowhere else. The Windows hook bug that
broke every Windows install was found in a screenshot of someone's terminal;
the install prompt was rewritten because one user's agent refused it. Neither
was written down until after the fix, and the reasoning behind both was
reconstructed from memory. That is a corpus we were losing.

**A user's own words are the primary source.** Paraphrase in the ledger, but
keep the quote in the story — what someone actually typed carries information
that a summary of it does not.

| File                         | Contents                                          | Read when...                                |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------- |
| [01-ledger.md](01-ledger.md) | Every request: who, when, status, where it landed | Picking work, checking if something is done |
| [02-users.md](02-users.md)   | Who the users are and how they run Caprock        | Judging whether a report generalises        |
| [stories/](stories/)         | One file per conversation, dated, verbatim        | Understanding why a request exists          |

## How to use this

**Every user report gets a ledger row**, even if the answer is no. A rejected
request that keeps coming back is a signal; a rejected request nobody records
gets re-litigated from scratch every time.

**Requests are not tasks.** The ledger records what a user asked for and what
we decided. Work that follows lives in [`.ai/09-execution-plan.md`](../.ai/09-execution-plan.md)
and the ledger points at it. Two directories, two clocks: what people want
changes on their schedule, what we build changes on ours.

**Date everything absolutely.** "Last week" is worthless in six months.

**Prices, counts and willingness-to-pay are quotes, not measurements.** What
someone says they would pay is evidence about that person on that day. It is
recorded as a quote with its date and never becomes a forecast — that is
[rule 6](../CLAUDE.md), and it binds here too.

## Naming

Stories are `stories/YYYY-MM-DD-<who>-<topic>.md`. One conversation per file.
If a conversation spans days, use the date it started and say so inside.

Ledger ids are `FB-NNN`, assigned in order, never reused.
