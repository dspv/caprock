# Caprock supports Cursor

Caprock shows your [Cursor](https://cursor.com) chats on the same screens as
Claude Code, Codex, OpenCode, Gemini CLI, DeepSeek Harness and Hermes Agent:
the Agent and Composer chats from the editor, with what Cursor itself recorded
they cost, the model each turn ran on, the prompts and replies (searchable on
the Memory screen), the tool calls and files, and the folder each ran in. It
also starts and continues Cursor's CLI, `cursor-agent`, and estimates how many
tokens Cursor sends on each request beyond what you typed.

## Setup

None for the editor. If Cursor is installed and has been used, Caprock finds
its database and reads it within a few seconds, including every chat from
before you installed Caprock. It looks where Cursor keeps it:
`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` on macOS,
`%APPDATA%\Cursor\User\globalStorage\state.vscdb` on Windows, and
`~/.config/Cursor/User/globalStorage/state.vscdb` on Linux.

For `cursor-agent` chats you start yourself, turn on Cursor's hooks: **Cost →
Cursor → Turn on Cursor hooks**. Caprock adds itself to `~/.cursor/hooks.json`
for six events — a prompt sent, a reply, a tool used or failed, a stop, a
compaction — and keeps every entry other tools put there. **Remove Cursor
hooks** takes out only Caprock's. The hooks never block, approve or change
anything Cursor does: Caprock answers each one with Cursor's "carry on" before
it does anything else.

## What you see

- **Home.** Cursor chats are on the session cards and in the projects list,
  marked with a cube. The agent switch in the header gains `cursor`.
- **Cost.** What Cursor recorded is part of every total. A **Cursor** panel
  under the totals shows it by model, with the request count Cursor kept.
  Cursor writes a cost for some chats and not others; a chat without one shows
  its tokens and *none recorded*, and the totals say they are partial, rather
  than Caprock guessing a price.
- **Beyond what you type.** The same panel estimates, per model, how many
  tokens Cursor sends on a chat's first request that are not the conversation:
  its system prompt, tool definitions, rules and the files it attaches on its
  own. Beside it is the same figure for Claude Code on the same model, when
  you have used both, and what Cursor's figure is worth at the model's list
  price. It is an estimate — the method is written under the table.
- **A chat's page** says how big Cursor's first measured request was and how
  much of it was not the conversation.

## Starting Cursor from Caprock

**New agent → Cursor** opens `cursor-agent` in a Caprock terminal tab, in the
folder you pick, with the model you type (or Cursor's default). *Bypass* starts
it with `--force`; plan and accept-edits start it as it is. A first message is
sent as its first prompt. **Continue here** and **Open in …** run
`cursor-agent --resume <chat>` for a chat the CLI has; an editor chat is
continued in Cursor. Sign in once with `cursor-agent login` in a terminal of
your own: Caprock never handles your Cursor sign-in.

## Privacy

Caprock opens Cursor's database read-only and reads only the chat rows; it
never reads the part of it that holds your sign-in. The hooks file is changed
only when you press the button. Nothing is sent anywhere.

## Not yet

- `cursor-agent` reports no token counts or cost through its hooks, so a CLI
  chat shows turns and tools but no spend.
- Cursor keeps one request's token count per turn on this machine, so token
  totals for the editor are a floor.
- Cursor's background agents and team usage live on Cursor's servers and are
  not read.

Details for contributors: [.ai/25-cursor.md](../.ai/25-cursor.md).
