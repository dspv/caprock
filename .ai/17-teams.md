# Caprock for Teams

**Status: specified, not built.** This is the design, the boundary and the open
questions — written before any code so the shape is argued once rather than
discovered halfway through. Nothing here has shipped.

## What it is

One Caprock, run by the team, that every machine reports into. The single-machine
product answers "what is my Claude doing"; this answers the same question for
eight laptops at once, which is the version a lead pays for.

**Self-hosted, not a service we run.** The team installs one server on a box
they control. This is the only shape that keeps the promise the free product is
built on — all data stays on machines you own — and that promise is not a
marketing line but the reason a company installs a tool that reads every
transcript on every developer's disk. A hosted version would mean shipping
prompts, replies and tool output to us, and no engineering leader signs that
off for a cost dashboard.

## What a team cannot see today, and what this shows

The three problems the site already names, and the answer to each:

- **The bill arrives as one number.** Cost per person, per repository, per day,
  across every machine — from the same transcripts the free product already
  reads, so the figures are the ones each developer sees locally, added up.
- **A looping session drains a plan in minutes.** The loop detector runs
  per-machine today; the team view surfaces it centrally, so someone other than
  the person at that laptop can see it.
- **Agents run on eight laptops.** One live screen showing every session in the
  team: what it is doing, what it has spent, which repository it is in.

## The boundary

**Free stays whole.** Everything the single-machine product does today remains
Apache-2.0 and unchanged: capture, cost, history, prose search, loop alerts, the
task runner, the OpenCode reader. A team feature is never carved out of the free
product to create a reason to pay.

Paid is the *aggregation across machines*, which does not exist today and cannot
be had by running the free binary harder:

| Free (Apache-2.0)             | Teams (paid)                           |
| ----------------------------- | -------------------------------------- |
| One machine, all its sessions | Every machine, one screen              |
| Your cost, your repositories  | Cost per person and per repository     |
| Your loop alerts              | Loop alerts anyone on the team can see |
| Your history and prose search | Team history, searchable across people |
| Task runner on your machine   | (unchanged — no team task runner yet)  |

## How it works

Three pieces, each already half-built by the free product.

**The agent.** The existing daemon, with an outbound reporter added. It sends
what it already computes — session identity, totals, activity phrase — to the
team server on the same cadence the dashboard polls. It never sends prompts,
replies or tool output. That is not a setting: the payload has no field for
them, so a misconfiguration cannot leak one.

**The server.** A second binary, or the same binary in a second mode. Receives
reports, stores them in one SQLite database, and serves a dashboard that is the
existing UI with a person column added. Runs on one box the team controls; no
inbound access to any developer's machine is required, which is what makes it
installable inside a corporate network.

**Enrolment.** A token per team, put in each developer's config. Deliberately
the dullest possible mechanism for a first version: no accounts, no SSO, no
invitations. A team that needs SSO is a team that will say so, and building it
before then is guessing.

## What is deliberately not in the first version

Each of these is a real request that will come, and each is cheaper to add later
than to guess at now:

- **SSO and roles.** Everyone who has the token sees everything. A ten-person
  team does not need permissions; a hundred-person one does, and by then the
  shape of what they want is knowable rather than imagined.
- **Budget enforcement.** Alerts, yes; automatically stopping someone else's
  session, no. Killing a colleague's work from a dashboard is a decision with
  consequences we cannot see, and it is the kind of feature that gets a tool
  banned rather than adopted.
- **A team task runner.** The orchestrator is per-machine and stays that way.
  Coordinating unattended agents across machines is a different product.
- **Hosted anything.** See above.

## Two tiers, not one

A team licence is a conversation with a lead; a solo developer who likes the
tool has nobody to have that conversation with and no way to pay. So there are
two things to sell, and they are sold to different people:

- **Premium** — a solo developer, a few dollars a month, bought in a minute
  from the dashboard. Extra features on one machine, no server, no enrolment.
- **Teams** — a lead, hundreds a month, self-hosted, bought after a call.

The free product is the floor under both and is never reduced to make room for
either. What premium adds has to be something a single machine genuinely cannot
do today rather than something switched off — the same rule the team tier
follows, applied at a smaller scale.

**The first candidate is API-key hygiene**, and it is deliberately *hygiene*
rather than *storage*:

- Which keys and profiles a session used — the variable names, never the
  values.
- A warning when a key appears in command output, which happens constantly and
  which nothing currently catches.

**Not a secret store.** Holding keys would trade the product's foundation for a
feature: today a bug in Caprock shows a wrong number, and with a vault a bug in
Caprock leaks credentials. It would also mean competing with 1Password, Vault
and the OS keychain — tools that do nothing else — and it would put every
buyer's security review in front of a two-person product. Helping someone not
leak a key is worth paying for; taking custody of it is a different company.

*This held when a feature needed a key.* The Gemini feature ([ADR-023](08-decisions.md))
reads the user's Google AI Studio key from `GEMINI_API_KEY` in the daemon's
environment at the moment of the call — never stored, never in `config.json`,
never returned by any endpoint. The paragraph above is the reason: a key Caprock
does not hold is a key Caprock cannot leak. The cost is a worse first run, and
that was the right side of the trade.

This is a candidate, not a decision. What premium contains should be settled by
what the first paying users ask for.

**The instrument for finding that out is `/premium`.** An email field, one
question — which of five things you would want first — and a free-text box. It
posts to the same waitlist endpoint the team form uses, separated by
`source: "site/premium"`, because a second endpoint would be a second thing to
maintain for no gain.

It is deliberately not a preorder. No money changes hands and no date is
promised, and a form implying either would be selling something that does not
exist. The page says "not built yet" above the fold and the button says "keep me
posted"; what it collects is a demand signal and a specification, not a sale.

The dashboard footer links to it as a question — `what should paid add?` —
styled like the utility links beside it rather than like the team offer. Two
offers at equal weight in one footer read as a sales strip, which is the thing
that footer is written not to become.

## Open questions

These are decisions, not details, and each changes the work:

- **What does a person's identity look like?** A machine name is what the agent
  knows; a person is what the buyer wants to see. Git author email is the
  obvious mapping and it is wrong on shared machines and CI.
- **What happens to a developer who is offline?** Reports queue and catch up, or
  the gap shows as a gap. The second is more honest and looks broken.
- **How is it priced?** Per seat is conventional and penalises the team that
  installs it everywhere, which is exactly what makes the product work. Per
  team, banded by size, may be better.
- **Does the free binary carry the reporter?** One binary is simpler to ship and
  means the free product contains code for a paid feature. A separate build
  avoids that and doubles the release matrix.

## Why write this before building it

The single-machine product was built by measuring first — the OpenCode work
started by reading a real database rather than by designing an importer. There
is no equivalent measurement available here: nobody is running a team version to
observe. What replaces it is stating the shape plainly enough that its costs are
visible, so the argument happens now rather than in the middle of an
implementation.

The commercial decision — whether to build this at all — is still gated on
demand, per [01-product.md](01-product.md). The form on `/teams` is what
collects it.
