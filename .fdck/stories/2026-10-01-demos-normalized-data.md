# 2026-10-01 — Threads: "they all share the same inefficiency: heavy JSON"

A short public exchange under Dima's Threads post about Caprock, forwarded as a
screenshot. The commenter (demos.ra) is a stranger, not a user; nothing says he
has installed it.

## In their words

> **demos.ra:** V cool.
>
> Probably parsing json, and sweating to build a coherent image out of huge and
> heavy json files.

> **dmitriy_solodukha:** Right. Plus session memory you are not losing every 30
> days, multi models and harness. Aaand solution for Teams that lives in your
> VPC

> **demos.ra:** Yep and they all share the same inefficiency: heavy and dense
> json.
>
> That's the exact reason to migrate to normalized tabular data (tsv mtsv).
>
> When u have the exact same 3d grid (multi sheet tab separated data) for the
> entire infrastructure, the problem collapses completely.

## What it tells us

- **He guessed the mechanism correctly, and it is the part nobody sees.** The
  work is reading five agents' formats — Claude Code JSONL, Codex rollouts,
  OpenCode's SQLite, Gemini's telemetry file, DeepSeek — none documented, all
  changing, and turning them into one thing. A stranger's first read of the
  product was "parsing JSON, sweating"; that is the cost a competitor has to
  pay too, every time any of the five vendors changes a field.
- **What he proposes is what Caprock already is.** "The same grid for the
  entire infrastructure" is the `events` table: one row per tool call, turn or
  lifecycle event, with `agent`, `model`, tokens, cost, `touch_dir` — the same
  columns whichever agent wrote the source. TSV is a file format for it; the
  normalization is the substance, and it exists. Nothing on the site says so in
  those words.
- **His "migrate" is the vendors' job, not ours.** No agent is going to change
  its transcript format for us. The layer that absorbs five formats into one is
  the product, and it gets more valuable each time a format drifts —
  [Codex transcripts, measured](../../.ai/19-codex.md) found two sources for
  the model name and an ordinal present in 1 file of 100.

## The 30-day point, measured

Dima's reply leaned on "session memory you are not losing every 30 days". Read
on the owner's machine on 2026-10-01 (read-only query against the live DB):

- Caprock has **117 Claude Code sessions** recorded, from 2026-07-18.
- **67 of the 114** with a transcript path no longer have that file on disk;
  **57** of those were not in a worktree, so were removed by Claude Code's own
  cleanup rather than by a deleted checkout.
- Caprock still holds those sessions' **171,537 events**, **51,093 of them
  assistant turns** — the prose Memory searches.
- They carry **$7,807.93 of the $14,050.83** API-list cost recorded for Claude
  Code (56%).

So more than half of what this machine spent on Claude Code is, as far as
Claude Code itself is concerned, gone — and is still searchable in Caprock. One
machine, one reading; not a rate.

## Ideas it raises

- **Say the normalization out loud.** One line on the site: five agents, five
  undocumented formats, one table. It is the moat a stranger spotted in two
  sentences, and the page currently sells the screens built on it.
- **The record outlives the source.** Every day installed adds history the
  agents delete; switching away loses it, and installing late cannot recover
  it. That is a retention moat that grows with time, and "install before the
  next 30 days are gone" is a true reason to install now. The figures above
  would make a post (`blog-post` skill), dated.
- **An export of the grid** (`caprock export --tsv/--csv`, per table) would
  answer him directly and is the shape a team's data person asks for. The
  database is already plain SQLite, so this is a convenience, not a capability
  — recorded as FB-041, not decided.
- **Publish the event schema** as a short spec. If anyone else writes agent
  events in it, Caprock reads them for free; if nobody does, it costs a page.

Nothing here was built. Each idea waits for Dima.
