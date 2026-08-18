# [Project] — Product

<!-- SKELETON. Replace every bracketed placeholder. Delete these comments as you go.
     This file answers "what is this and what does it promise". It is read on every
     task, so it must be short enough to actually be read every time. -->

<!-- One line placing this file: what it owns, and where the adjacent facts live. -->

[What this file covers.] The [mechanism] is in [02-...]; the money is in [05-...].

## One-liner

<!-- The sentence you would send to a stranger. Copy it from the spec verbatim if the
     spec has one — do not improve it here without saying so. -->

[One sentence.]

## The core loop

<!-- The whole product as a flow. If it does not fit in a code block, the product is
     not defined tightly enough yet. -->

```
[step → step → step]
```

**Everything else is out of scope.** [Link to where the cut order lives, if there is one.]

## [The central design choice]

<!-- Every product has one or two choices that everything else follows from. Name them
     here, with the reasoning and the cost. This is the section a new engineer reads to
     understand why the product is shaped this way rather than the obvious way. -->

[What was chosen, why, and what it costs.]

## What the user gets

<!-- The deliverable, concretely. What appears on screen or arrives in their hands. -->

[Concrete outputs.]

## Free tier / limits

<!-- If anything is free or capped: what, how much, and how the cap is enforced.
     State enforcement explicitly — a cap the client can edit is not a cap. -->

[What is free, what the limit is, where it is enforced.]

## Trust contract

<!-- The promises the product makes that must be enforced by code rather than intent.
     Each line is a testable behaviour. If you cannot name the test, it is marketing,
     not a contract. -->

- **[Promise]** — [what enforces it]

## Out of scope

<!-- Explicit non-goals. This section prevents scope creep more effectively than any
     other, because it gives a reviewer something to point at. -->

- [Not building this]
