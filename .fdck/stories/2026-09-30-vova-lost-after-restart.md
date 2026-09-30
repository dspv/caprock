# 2026-09-30 — Vova: finding his sessions after the computer restarted

Dima asked the question the context-continuity idea turns on: *when did you
last lose context, and what did you have to recover, from where?* Relayed from
Telegram.

## In his words

> у меня это конечно не критичная проблема, я обычно все таки укладываюсь в 1
> сессию, но вот вчера все-таки потерял, было обновление компа и закрлся
> caprock, поэтому пришлось покопаться в Show ended sessions, но там тяжело
> что-то найти без указания description сессии

> неудобно что я вижу вот такое в показе show ended queries … видишь с одной
> репой я якобы работал в 4 сессиях, хотя по моим ощущениям я на репу не
> открываю больше 2-х, и вот приходится в каждую заходить и проверять

His screenshot: four ended cards, three of them in one repository on three
branches, each with a description, and **every one reading "ended 29 Sep
18:26 · 17h ago"**.

## What it tells us

- **The pain is real but narrow, and he says so.** Not "agents forget", but
  "after the machine restarted I could not find where I was". The trigger was
  an OS update; the cost was opening cards one by one. This does not confirm
  cross-agent context as a moat — it confirms that picking up after an
  interruption is a thing he had to do by hand.
- **The one time on the card was the restart, not his work.** The card showed
  the session's last event, and the shutdown sends every session an end event —
  so four sessions last worked at different times all read 18:26, and the only
  field that could have told them apart said nothing. The same effect was
  measured on the owner's database: 7 of 101 ended Claude Code sessions showed a
  time more than 10 minutes after their last real work (5 more than an hour),
  moved by an end, a `/clear` or a continuation event.
- **More cards than he opened.** Why four is not knowable from here; a
  `/clear` in one terminal and a fork from Caprock each make a new session id,
  and so would switching branches between them. Only links that are facts are
  used to group cards.

## What we did

See FB-037 to FB-040 in [the ledger](../01-ledger.md).

## Follow-up the same day

> При этом сейчас вот проверил - я хочу продолжить сессию за 0.75 баксов -
> если я просто в нее зайду и там открою терминал - то будет пусто, а если в
> списке нажму continue кнопку - то заработает

That is FB-040. And on the session descriptions shipped the day before (FB-035):

> Ах ты ж красавчег, сделал Description, вот этого не хватало
