# 2026-08-26 — Vova replaced his IDE with Caprock

Relayed by Dima from a conversation with Vova. Not a transcript: Dima recounted
it from memory, so the wording below is his paraphrase except where marked as a
direct quote.

Covers [FB-003](../01-ledger.md#fb-003--willingness-to-pay) through
[FB-008](../01-ledger.md#fb-008--pay-for-models-from-inside-caprock).

## The headline

He **replaced the Claude Code IDE with Caprock**. He says he has everything he
needs there and it works well.

The reason he was able to move is the **terminal** — Dima's note was that he
had not realised the terminal existed or worked, and that it turned out to be
the whole reason the move was possible. That reframes the terminal from a
Phase 1 control feature into the thing that makes Caprock somewhere a person
can live.

## Money

Asked what he would pay, he gave three numbers:

- **$20/month** for what exists today — "точно"
- **$50/month** with third-party models
- **$100/month** with Claude and GPT together

Then he went and looked at the pricing page, found **$30 per year**, and
stopped. He said he would buy after payday.

Dima's read: *"мы на правильном пути"* — we are priced an order of magnitude
under what a user who lives in the tool says it is worth.

**What this is not.** No money has changed hands. Three quoted figures from one
person on one day, and a stated intention to return. It is the first time
anyone reached the card, and that is genuinely new — but the only evidence
that settles it is him coming back unprompted.

## What he asked for

1. **JetBrains Mono in the terminal.** The existing font rendered Russian
   badly enough that Dima's relayed wording was *"ублюдский шрифт"*. He named
   the font he wanted. → [FB-004](../01-ledger.md#fb-004--jetbrains-mono-in-the-terminal)

2. **Third-party models, free ones first.** → [FB-005](../01-ledger.md#fb-005--third-party-model-providers)

3. **Quick chat, and get the new-project button out of the corner.** Plus:
   creating a project should create the folder. Dima's wording — *"вынуть из
   жопы кнопка создания проекта"*. → [FB-006](../01-ledger.md#fb-006--quick-chat-and-the-new-project-button)

4. **Show plan limits, and let him pay for models.** → [FB-007](../01-ledger.md#fb-007--show-plan-limits),
   [FB-008](../01-ledger.md#fb-008--pay-for-models-from-inside-caprock)

## What we did about the font, same day

Not a missing font — JetBrains Mono was already bundled with all six of its
subsets. Three defects in how it reached the terminal, all invisible because
xterm.js paints to a canvas rather than the DOM:

- it was handed the literal string `var(--font-mono)`, which a canvas context
  cannot resolve, so it silently used the system monospace;
- the character cell was measured against that fallback and never
  re-measured once the real face loaded;
- no subset was ever fetched, because subsets load lazily when a matching
  character appears in the DOM and canvas text never does.

All six subsets are now requested by name: latin, latin-ext, cyrillic,
cyrillic-ext, greek, vietnamese. Between them that covers Russian, Ukrainian,
Polish, Czech, Turkish, Hungarian, Romanian, Greek, Vietnamese and the rest of
Latin/Cyrillic Europe.

**CJK, Arabic, Hebrew and Thai are not in JetBrains Mono at all.** No setting
turns them on. They fall through to the system monospace, which keeps columns
aligned but changes the face. Closing that properly means bundling a second
font, and CJK faces are tens of megabytes against a 19 MB binary — a separate
decision, not a follow-up.

## Open questions this raised

- **FB-005 is ambiguous and expensive to guess wrong.** "Third-party models"
  could mean observing sessions that already run through Bedrock/Vertex/a
  proxy, or running non-Claude models from inside Caprock. Weeks apart. Ask.
- **FB-007 may not be a feature at all.** Plan limits already ship on the Cost
  screen. If he did not find them, moving them beats building them again.
- **Pricing.** Three quotes all sit far above $30/year. One person is not a
  pricing study, but it is the only pricing evidence that exists.
