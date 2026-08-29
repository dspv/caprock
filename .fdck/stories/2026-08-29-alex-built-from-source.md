# Alex builds from source, and reads the schema

**2026-08-29.** Second report from the Windows user who found the hook bug
([FB-001](../01-ledger.md#fb-001--windows-hooks)). This time he
cloned the repository, built it himself, ran it, then went and looked at the
database.

In his own words:

> Собрал, запустил. Симпатичный тул, хотя пока кажется польза ограниченная,
> все долларовые цифры про "если бы ты был дурак и платил за токены вместо
> подписки") Но всё равно круто, спасибо!
>
> Пара рекомендаций от виндоюзера, если мы твоя ЦА:
>
> + используй winget для распространения — это делается буквально одним
>   запуском их утилиты для создания манифеста, и winget есть на любой винде
>   по умолчанию, ничего не надо дополнительно ставить
> + ставься в `%USERPROFILE%\.local\bin`
> + хорошо бы чтобы `make build` не ломался на винде из коробки
>
> И кросс-платформенно: sqlite база у меня сожрала сразу полгига, а я даже не
> вайб-кодер. Сходу вижу у тебя там минимум три лишних индекса, но самый лютый
> винрар (pun intended) можно получить, если жать payloads при помощи zstd с
> пред-тренированным словарём: выигрыш в три раза как с куста, затраты CPU
> незаметные на современных системах. Яблоюзерам с их ценами на SSD особенно
> актуально будет.

Four requests, filed as [FB-023](../01-ledger.md#fb-023--the-database-reaches-half-a-gigabyte)
through [FB-026](../01-ledger.md#fb-026--the-dollar-figures-read-as-an-insult).

## What was worth measuring

His compression claim was checked against a real database rather than accepted
or argued with. It held: **x2.94** with a dictionary trained on 3,000 real
payloads, against his "roughly threefold". The size complaint held too — 598 MB
on Dima's machine, the same half-gigabyte he saw.

**His diagnosis was the one part that did not hold.** He blamed redundant
indexes; indexes are 27% of the file and payloads are 56%. The remedy he
proposed in the same breath is right, and it is right for a reason he did not
give. Worth recording because it is the shape of a good report: the observation
and the fix were sound, the causal story in the middle was a guess.

## The part that is not a feature request

*"все долларовые цифры про если бы ты был дурак"* is the only piece of this
report with nothing to build. He is a subscriber; list-price totals describe a
bill he will never receive, so the headline number reads as an accusation.

The number is not wrong and the framing is. What survives a subscription is the
**ratio** — 46% of spend on running commands against 12% on writing code — and
that is buried under a total that invites the wrong question. FB-026 is open
because the wording is not obvious, and because this is one person's reading.

## What it says about who is showing up

Alex was previously filed as a light user on Windows whose report *looked* like
an edge case and turned out to be universal. That description no longer fits: he
built from source, read the schema, and returned unprompted with a measured
suggestion. He is the first person outside Dima to engage with Caprock as a
codebase rather than as a tool.
