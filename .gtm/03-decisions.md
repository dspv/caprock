# Go-to-market decisions

One entry per decision: what was decided, why, and what would reverse it. A
decision without a reversal condition is a preference, not a decision.

---

## GTM-001 — The channel is personal, not a product account

**Decided 2026-08-24.**

The channel belongs to the owner as an engineer, not to Caprock. Caprock is one
subject in it, alongside experiments, a closed product, and the reality of a
full-time job plus night work.

**Why.** Products change; an audience built around a product dies with it. An
audience built around a person carries to whatever comes next. The owner was
explicit that he wants a personal blog, not a marketing channel.

**Reverses if** the personal format proves impossible to sustain under the
constraint that his surname cannot appear anywhere.

**Superseded 2026-08-27 by GTM-008.** Not because the reasoning was wrong — it
still holds — but because it made "pick a name" the thing blocking every
account, and nothing had been published for three days as a result.

---

## GTM-008 — Product accounts first, the personal channel when it has a name

**Decided 2026-08-27.** Supersedes GTM-001 on sequencing, not on substance.

X, LinkedIn and YouTube are registered as **caprock** — the product's own
accounts. The personal channel is still wanted and still the more durable
asset; it waits for a name, and it does not hold up anything else while it
waits. Telegram stays the owner's own, in Russian, in his voice.

**Why.** GTM-001 made a naming decision the gate on every channel, and the
consequence was that nothing shipped: `04-status.md` read "pick a name — blocks
everything else" for three days. The product's name exists, is registered, and
carries no surname. Publishing under it costs nothing that the personal channel
can't recover later — an audience that arrived for measured numbers follows the
person who measured them.

**What each account is for**

- **caprock on X** — the findings, in English. One number per post.
- **caprock on LinkedIn** — the same findings, written for people who buy
  tools rather than build them.
- **caprock on YouTube** — screen recordings. No face, no surname.
- **The owner's Telegram** — his own voice, in Russian, personal and
  unpackaged. Not a product channel and not scheduled.
- **Reddit and Hacker News** — his personal account, never the product's. A
  brand account posting to r/ClaudeAI is an advertisement; a person posting a
  measurement is a post.

**Reverses if** the product accounts read as marketing and get no engagement
while the same material does well from a person — which is the thing to watch
in the first six weeks.

---

## GTM-009 — No cold DMs, and no scraping chat members

**Decided 2026-08-27.** Considered and rejected: harvesting the member lists of
Telegram groups the owner belongs to, and writing to those people individually.

**Why not.** Telegram bans accounts for exactly this, and quickly — the first
few reports are enough. What gets lost is not a throwaway: it is the owner's
own number and the personal channel the whole strategy in
[01-channel.md](01-channel.md) is built on. Trading the asset for a week of
outreach is a bad trade at any conversion rate.

The second reason stands on its own. People in those groups joined a group;
they did not agree to be collected into a list. However well a message is
personalised, being in someone's scraped database is the thing spam is, and it
reads that way.

**What replaces it.** Answering in the group, in public, with his own figures,
when someone asks a question the numbers answer. Whoever is interested writes
first. Slower, and it costs nothing that cannot be replaced.

**Reverses if** never, for the automated form. A human conversation with
someone who has just asked about Claude Code is a different thing and always
was.

---

## GTM-010 — A Telegram bot that stores nothing

**Decided 2026-08-27.** A bot is worth building as an entry point, and the
thing that decides whether it can exist is what it does with data.

It takes what a person chooses to paste — the output of `caprock report`, which
is already the shape they would post publicly — draws the share card, and keeps
nothing. No transcripts, no prompts, no code, no history. The card comes back
and the input is gone.

**Why this shape and not a better one.** A bot that ingested transcripts would
be more useful and would need no install at all — and it would take the user's
prompts and their code onto a server we run, which contradicts rule 4 and the
three places the site says nothing leaves your machine. The version that stores
nothing is weaker and is the only one that can be built without rewriting what
the product claims to be.

**What it buys.** Advertising in Telegram can point at "message a bot" rather
than "install a binary", which is a far lower step, and it is advertising
rather than outreach — see [GTM-009](#gtm-009--no-cold-dms-and-no-scraping-chat-members).

**Not started.** No user has asked for it; it is a channel idea, and it queues
behind the six weeks of posts in [06-content-plan.md](06-content-plan.md) that
cost nothing to run.

---

## GTM-002 — First name, no surname

**Decided 2026-08-24.**

His face appears in video and his first name is used. His surname appears
nowhere: not in a channel name, a description, an about page, a video caption, or
a commit trailer.

**Why.** He works full-time in fintech and has stated repeatedly that being
publicly attached to this project could cost him the job. First name plus face is
his own judgement of acceptable risk; a surname makes the link to his employer
findable in a single search.

**Reverses only** if his employment situation changes. Not a marketing decision.

---

## GTM-003 — Russian in Telegram, English on X, repackaged not translated

**Decided 2026-08-24.**

He writes in Telegram in Russian, the way he thinks. The same finding is then
rebuilt for X in English: number first, image, link.

**Why.** He writes fastest in Russian, and speed is what makes a weekly rhythm
survive one to two hours a week. The Russian audience is not expected to install
directly — it produces recommendations, stars, and word of mouth. The English
repackaging is what reaches people who run `brew install`.

Straight translation was rejected: the two platforms reward different openings —
a story in Telegram, a figure on X.

**Reverses if** six weeks of data show the X repackaging producing no clicks,
which would mean the two audiences need separately-written material rather than
one source.

---

## GTM-004 — Advertising waits for 15–20 posts

**Decided 2026-08-24.**

No paid promotion until the channel has 15–20 posts of substance.

**Why.** Advertising into a near-empty channel converts poorly: the visitor
arrives, finds nothing to read, and leaves. The purchased click is spent either
way. The course the owner bought does not expire, so the only cost of waiting is
time.

**Reverses if** organic growth stalls completely for six weeks — at that point a
paid test becomes the cheaper way to learn whether the content works at all.

---

## GTM-005 — Measurement is the core rubric, not one of four

**Decided 2026-08-24.**

"Here is what I measured" leads. Building, opinions and personal material
support it rather than share equal billing.

**Why.** Measured findings are the only thing the owner has that nobody else
does, because nobody else instruments their agent sessions. Comparable posts show
findings-led material outperforming announcement-led material by roughly two
orders of magnitude in the relevant communities (see
[02-research.md](02-research.md)).

**Reverses if** the measurement well runs dry — but with the product generating
new data continuously, that is unlikely.

---

## GTM-006 — Premium pricing is left open until there is someone to ask

**Raised 2026-08-25. Deliberately not decided.**

Two numbers are on the table for a solo premium tier, and the argument for each
is worth keeping rather than resolving now.

**$2.50/month billed annually ($30/year).** The case: it is small enough that
nobody deliberates, and a large number of small payments is enough for a
one-person product. It also prices well below anything a team tool would
charge, which keeps the two tiers clearly separate.

**$9/month or $79/year.** The case against the cheaper number, in three parts:

- **A $30 decision costs the same thought as a $100 one.** The buyer still asks
  "do I need this"; only the revenue differs. Cheapness does not remove the
  deliberation, it just removes the upside.
- **$30 a year does not cover support.** One email exchange consumes an annual
  subscription, and for a solo product that email lands on the founder.
- **A low price reads as low value.** Someone already paying $200/month for
  Claude does not see $2.50 as cheap; they see it as probably not serious.

**Why this stays open.** There are 26 Homebrew installs and no paying users, so
either number is a guess — and the cheaper one is the harder guess to reverse,
because raising a price on existing subscribers is a conversation nobody wants.
The decision belongs after the first few people say what they would pay for,
which is what the in-product footer and the `/teams` form exist to surface.

**What would settle it:** three conversations with people who installed it and
asked for something more. Not a survey — the question "would you pay $X" is
answered generously and honestly only by an invoice.

---

## GTM-007 — Ask before charging: a signup, not a preorder

**Decided 2026-08-25.**

`/premium` collects an email address and one answer about what a paid tier
should contain. No payment, no price, no date. The dashboard footer links to it
as a question rather than an offer.

**Why a signup rather than a preorder.** Taking money now would mean charging
for something that does not exist, against a price
[GTM-006](#gtm-006--premium-pricing-is-left-open-until-there-is-someone-to-ask)
deliberately left open. Both problems are solved by asking first: the answers
name the feature and the people who answer are the ones to ask about price.

**Why not Stripe yet.** Nothing is built, so there is nothing to sell. Stripe is
a few hours of work — a payment link, two prices, a webhook — and none of it is
the hard part. The hard part is knowing what the money buys, which is what this
form is for.

**Why it reuses the team endpoint.** One Cloudflare Function, one KV namespace,
one Telegram notification path, already working and already tested. The two
lists are separated by `source`. A second endpoint would double the surface that
can silently fail — which is exactly the failure both forms have already had
once.

**Reverses if** the answers arrive without a pattern. Fifty replies spread evenly
across five options would mean the question is wrong, and the next instrument is
conversations rather than a form.

**What it feeds:** GTM-006's open price, and the premium section of
[`.ai/17-teams.md`](../.ai/17-teams.md).
