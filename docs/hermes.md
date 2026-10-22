# Caprock supports Hermes Agent

Caprock shows your [Hermes Agent](https://github.com/NousResearch/hermes-agent)
sessions on the same screens as Claude Code, Codex, OpenCode, Gemini CLI and
DeepSeek Harness: what each session cost, the tokens, the prompts and replies
(searchable on the Memory screen), the tool calls, and the folder and branch it
ran in. Hermes's cron jobs and its chats through the gateway (Telegram, Slack…)
are counted too, and shown apart, because that spend happens with nobody
watching.

## Setup

None. If Hermes is installed and has run at least once, Caprock finds its
database and starts reading it — within a few seconds, and including every
session from before you installed Caprock. If you install Hermes later, Caprock
notices the database when it appears.

Caprock looks where Hermes keeps it: `$HERMES_HOME/state.db`, or
`~/.hermes/state.db` (`%LOCALAPPDATA%\hermes\state.db` on native Windows).

## What you see

- **Home.** Hermes sessions are on the session cards and in the projects list,
  marked with Hermes's glyph (a winged H). The agent switch in the header gains
  `hermes`, so you can look at Hermes alone.
- **Cost.** Hermes's spend is part of every total. A **Hermes Agent** panel
  under the totals splits it two ways:
  - **Provider-reported** (what the provider billed, when Hermes recorded
    that) and **Hermes estimate** (Hermes's own price list). Caprock never
    re-prices Hermes's tokens: these are Hermes's figures.
  - **Background**: cron jobs, gateway chats and one-shot runs, by source.
    Your Hermes CLI, TUI, desktop app and editor sessions are the rest.
  Calls Hermes could not price are counted and named, never shown as $0.
- **Subagents.** A task Hermes delegates appears inside the session that
  delegated it, the way Claude Code's subagents do. Its cost is counted once.
- **Memory.** What Hermes wrote back is searchable beside every other agent's
  replies, and found by the question you asked.

## Starting Hermes from Caprock

**New agent → Hermes** opens `hermes chat` in a Caprock terminal tab, in the
folder you pick, with the model you type (or Hermes's default). *Bypass* starts
it with `--yolo`; Hermes has no plan or accept-edits mode, so those start
Hermes as it is. A first message is sent as Hermes's first turn. Once a
Hermes session has ended, **Continue here** carries it on in a Caprock tab, and
**Open in …** on its card in your own terminal — both run `hermes chat
--resume <id>`.

If Hermes has no model chosen yet, Caprock shows `hermes model` as the step to
run — Hermes's own picker for a provider and its sign-in, typed into a shell
tab for you to run. Caprock never enters or reads your credentials.

A Hermes session Caprock started can be typed into and stopped from Caprock. A
session you started yourself is shown, never controlled.

## Privacy

Caprock opens Hermes's database read-only, never writes to it, and installs
nothing into Hermes — no hooks, no webhooks, no config change. Nothing is sent
anywhere.

## Not yet

- Only Hermes's default profile is read; sessions in a second `hermes profile`
  are not.
- A session that switched models with `/model` is shown under the model its
  record names.
- A Hermes session you started outside Caprock refreshes every few seconds,
  not instantly.

Details for contributors: [.ai/24-hermes.md](../.ai/24-hermes.md).
