# 2026-09-03 — Vova, one week in: "нет функциональной исключительности"

A verbatim exchange in Telegram, relayed by Dima. Vova has been using Caprock
as his only surface for a week. This is the most useful thing anyone has said
about the product, because it is the first report from someone whose habits
have settled — and what he found is that the thing he likes is not the thing
we thought we were selling.

## What works, in his words

1. **"работаю с Claude только через Caprock"** — one place instead of hunting
   through an IDE, the Claude UI and Gemini for where he edited something.
   *"все в одном приложении - круто."*
2. **Free Gemini works.** He has not used it much.
3. **"обновлять легко и быстро."** He updates when he notices a version gap on
   the screen — *"вижу бамп версии - обновляюсь"* — so the version chip is
   doing the job the update banner was built for.

## The finding

> С одной стороны все ок, но я подумал, что вот по прошествии времени весь
> флоу работы устаканился и я понимаю что caprock в первую очередь **удобный**,
> но при этом **в нем нет функционала, который я бы не получил используя только
> бесплатные тулы, за исключением статы**.

And on the stats, which is the part this product was built around:

> она классно все показывает, но спустя неделю это вроде как **не самый главный
> для меня стал функционал** (тут наверное потому, что я сижу на корпоративном
> акке и вцелом похер на затраты).

The conclusion he draws himself:

> нет функциональной исключительности (если не берем удобство, что с одной
> стороны норм, но с другой **не многие наверное захотят платить большие бабки
> только за удобство**).

## Which free tools he compared against

Asked directly. Not other dashboards — **Google's AI mode and the Claude
desktop app**. His objection to them is not that they lack features:

> они без статы, **быстро теряют контекст**… Тоесть они бесплатные но неудобные

So the competition he actually feels is "free and awkward", and Caprock's win
over it is convenience plus stats — which he has just said he would not pay
much for.

## What he wants instead

> Чего мне кажется сейчас не хватает, спустя неделю: **оптимизиации токенов**…
> А если еще и будет показываться в стате сколько токенов сэкономлено - вообще
> огнище

With the qualifier that matters, added a message later:

> это была бы бомбическая штука, **если не теряется качество**

## Where he thinks the money is

> норм бабки, и тут я согласен с тобой - только в **enterprise**, точно не могу
> сказать какой функционал там необходим, но надо что-то **чего нельзя достичь
> без caprock**

## Dima's answers, for the record

- Paid Gemini needs only a billing account in AI Studio; only Flash is cheap,
  and Flash is materially worse at coding.
- On token optimisation he pushed back with what this project already measured:
  the few tools that claim it mostly compress inputs, RTK is reported to drop
  needed chunks, and **headroom compressed essentially nothing** — which is the
  finding that closed the previous product (`.ai/18-postmortem.md`).
- Both agreed the answer is to find an enterprise that will say what it needs,
  rather than guess.

## Why this matters more than a feature request

Three things in it are uncomfortable and worth keeping uncomfortable:

- **The stats are not the moat.** They are the product's headline and the
  reason it exists, and a week of real use demoted them — for a specific,
  common reason: somebody else pays. Every corporate seat is that user.
- **Convenience is the actual value, and it is hard to charge for.** He is
  right that few people pay well for it. But note what convenience meant to
  him: one place, and *not losing context* — which is a capability, not a
  polish item.
- **He arrived at token optimisation from the same direction the last product
  died in.** The measurement that killed it is in this repository. If it is
  attempted again it has to start from that number, not from the hope.

Nothing here is scheduled. It is filed because a settled user telling you what
your product is *for* is rarer than a bug report, and because the honest
summary — convenient, not exclusive — is the sentence the roadmap has to answer.
