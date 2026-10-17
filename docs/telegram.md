# Your agents in Telegram

Caprock can message you in Telegram when a session needs you, and — with
Premium — let you answer from there: reply to a session's message and Caprock
types it in. Every message says which agent, project and session it is from:

```
🟠 Claude Code · caprock · Fix the cache test
✅ Finished
~/dev/caprock · main
4m · $0.62 · 12 tool calls
2 files changed: cache.go, cache_test.go
💬 The cache test was reading a stale fixture; fixed and green.
```

(An example message; the figures in it are made up.)

It works through **a bot you create yourself**. There is no Caprock server:
your computer talks to Telegram directly, asks it for your replies (nothing on
your computer accepts a connection), and it works wherever your phone has
Telegram — Wi-Fi, mobile data, another country.

| What                                   | Plan    |
| -------------------------------------- | ------- |
| Alerts: waiting for approval, finished | Free    |
| Mute a session, `/mute`, `/unmute`     | Free    |
| Open the session on your phone (link)  | Free    |
| Reply to a session to type into it     | Premium |
| Approve / Deny under a question        | Premium |
| `/sessions`, `/new`, `/stop`           | Premium |

## Set it up

Settings → **Telegram**.

The section shows one card with three numbered steps; each turns into a tick
when it is done.

1. **Copy the token.** Press **Open @BotFather** (or open `@BotFather` in
   Telegram), send `/mybots` and pick your bot — or `/newbot` for a new one,
   with a username ending in `bot` — then **API Token** → **Copy**.
2. **Paste it here.** Press **Paste** (it reads the clipboard; a whole token
   connects at once), or paste into the field and press **Connect**. The
   token looks like `123456789:AAH…`. Caprock asks Telegram whether it is
   real before keeping it; a wrong one is refused with Telegram's own reason
   and nothing is saved.
3. **Send this code to your bot.** Caprock shows a six-digit code and a
   button, **Open @yourbot**. On your phone, that button (or opening the bot
   and typing `/start 123456`) sends the code. Within a couple of seconds the
   card becomes one line, *Connected to @yourbot · alerts to <your name>*,
   with **Change bot**, **Pair again** and **Disconnect**. The code works for
   ten minutes, only from a private chat, and only once. Where the token is
   kept and what it is sent to is behind the **i** beside them.
4. **Choose what to hear.** Tick *When a session is waiting for approval*
   and/or *When a session has finished*, then **Send a test alert**.
5. **Talk back (Premium).** With a licence, tick *Let my paired chat talk to
   sessions* in **Talk to your agents from Telegram**, just under. It is off
   until you turn it on, licence or not.

Already used phone alerts with a chat id typed in by hand? It keeps working;
Settings says *alerts to a chat id typed in by hand*. Press **Pair again** to
switch to a paired chat.

## What you can do from Telegram

- **Reply to a message** (swipe it, or long-press → Reply) and type. Caprock
  types your text into that session and presses Enter; a 👍 on your message
  means it went in. The answer comes back in the same chat as soon as the
  agent's turn ends — straight away, not after the alert's one-minute wait —
  for an hour after you last wrote to it.
- **Approve / Deny** appear under *Needs approval* when the session is one
  Caprock started and only one question is waiting. They answer the way the
  app's card does: Caprock reads the menu on the session's screen and presses
  the option's key. When several questions are waiting, answer in Caprock.
- **`/sessions`** lists the live sessions, numbered, each with whose it is and
  what it is doing. Tap a number to talk to that one.
- **`/new <project> <first message>`**, e.g. `/new caprock fix the flaky test`,
  starts Claude Code in that project (a few letters of the name are enough),
  in your default mode. If your default is Bypass, the bot asks first: *Start
  in Bypass*, *Ask first instead* or *Cancel*.
- **`/stop <number>`** (or `/stop` as a reply) asks, then stops a session
  Caprock started.
- **`/mute`** as a reply, `/mute 2`, or **Mute this session** under any
  message: that session sends nothing more. `/mute all` silences everything;
  `/unmute` undoes it.
- **`/help`** lists all of this.

**Only sessions Caprock started can be typed into.** A session you started
in your own terminal is watched — you get its alerts — but Caprock never types
into a process it did not start. A reply to one answers *I can only watch this
one*; continue it in Caprock to talk to it from Telegram.

## What is sent to Telegram

Telegram can read everything the bot sends. That is:

- **Alerts:** the agent, project and session title; the folder and branch;
  for a question, the tool and the command, file, URL or question it is about
  (up to 100 characters); for a finished run, how long it took, what it cost,
  how many tool calls, which files changed and the first line of the reply
  (a switch turns that line off); a link to the session when phone access is
  on.
- **When you talk to a session (Premium):** its replies, up to 3,000
  characters. Code blocks are replaced by a line like *[go, 12 lines]* unless
  you tick *Send code blocks in replies*. Tool output is never sent.
- **`/sessions`:** each live session's header and state.

Nothing is sent until you set up a bot and switch something on. Caprock reads
updates from Telegram only while there is something to answer — during
pairing, or while alerts or two-way chat are on.

## Security

- **One chat.** The bot listens only to the chat that sent the pairing code.
  A message from anyone else — even someone who finds your bot — gets no
  answer and does nothing. Groups cannot be paired.
- **The token** is stored on your computer in Caprock's data folder, readable
  only by you (`config.json`, mode `0600`). It is never shown again (Settings
  shows `••••••` and its last four characters), never written to the log, and
  sent nowhere but `api.telegram.org`.
- **Two switches for control.** Typing into sessions needs a Premium licence
  *and* the switch, which is off by default. **Disconnect** forgets the token,
  the chat and everything the bridge learned.
- **Old messages are not replayed.** A message sent while Caprock was not
  running is skipped rather than typed into a session that has moved on.
- If you think the token leaked: in `@BotFather`, `/revoke` it, then paste
  the new one into Settings.

## Troubleshooting

- **"Telegram does not recognise this token."** Copy the token again from
  BotFather — the whole line, including the part before the colon.
- **The code does nothing.** It must come from a private chat with *your*
  bot, within ten minutes. Press **Pair again** for a new code.
- **"Conflict: terminated by other getUpdates request".** Something else is
  reading this bot's messages — a second Caprock on another computer, or a
  webhook another tool set. Use one bot per computer.
- **No alerts arrive.** Check the switches, press **Send a test alert**, and
  read the last error under it. A muted session or `/mute all` sends nothing;
  `/unmute` in the chat.
- **A reply got "Two-way chat is off".** Tick *Let my paired chat talk to
  sessions* in Settings.
- **The Open on phone button is missing.** It appears only when phone access
  is on (Settings → Open Caprock on your phone); the link opens only on a
  phone that can reach your computer (the same Wi-Fi, or Tailscale).

How it is built, and why: [ADR-047](../.ai/08-decisions.md), and the contract
in [.ai/03-contracts.md](../.ai/03-contracts.md).
