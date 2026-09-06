# Postmortem — token compression on real Claude Code traffic

The record of the measurement that closed the token-compression direction. Two
feedback files point here — [the request ledger](../.fdck/01-ledger.md) and [the
one-week story](../.fdck/stories/2026-09-03-vova-one-week-in.md) — so the finding
gets one home instead of living only inside them.

## What was measured

Compression on real Claude Code traffic, the direction the previous product
came from. Caprock-python — the free Python measurer this repo replaced — was
built on Headroom, an upstream compression-analysis tool
([ADR-007](08-decisions.md#adr-007--the-harness-is-caprock-new-go-codebase-in-dspvcaprock-python-measurer-frozen),
[01-product.md § Relationship to Caprock-python](01-product.md#relationship-to-caprock-python-heritage)).

## The result

~0%. Claude Code's prefix is frozen by design, so there is essentially nothing
for a compressor to save; "headroom compressed essentially nothing" is how the
owner recorded it. This is the finding that closed the previous direction.

## What it rules out

A "tokens saved" figure shipped without a fresh measurement. FB-031 — token
optimisation, with the saving shown in the stats — is **declined** for exactly
this reason: a number with nothing measured behind it is what rule 6 exists to
prevent. The honest shape of any future attempt is to measure first on a real
session, publish the number whatever it is, and only then decide whether there
is a feature. The tools that claim it mostly compress inputs, and RTK is
reported to drop needed chunks.

## What it does not rule out

Terse ("caveman") prompting styles and input-compression tools are a separate
question from compressing a frozen prefix; they are unscoped (B5 in
[09-execution-plan.md](09-execution-plan.md)).
