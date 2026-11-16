# Jarvis's brain: what it sends, and where

Jarvis is Caprock's one chat with all your agents. Without a brain it routes
what you write the simple way: `@project` and the words, to that project's
newest agent Caprock started, or to a new one. With a brain it also
understands plain speech — "tell the caprock one to rebase", "what is
stuck?", "pick the recommended option in web" — and answers routine
questions your agents ask.

The brain is **your own coding agent, on your own subscription**: Claude
Code by default, or Codex, on the sign-in you pick (Settings →
Subscriptions lists them). Caprock has no model and no server of its own;
it never uses an API key of its own.

## Turning it on and off

Jarvis asks once, with Claude preselected: **Use my Claude subscription**,
**Choose…** (Codex, or another sign-in), or **Not now**. Until you choose,
no model is asked. Change it or turn it off from the same place; off, Jarvis
routes the simple way again. Answering routine questions has its own
switch, on by default once the brain is on.

## What a run is sent

Each message you write to Jarvis is one run of your agent. It is sent,
through your agent, to that agent's provider (Anthropic for Claude Code,
OpenAI for Codex) — the same place your sessions with it already go:

- your message, and the project it was addressed to, if any;
- for each thing waiting on you: its kind (permission, question, approval,
  loop), project, session id, one-line title, and a question's options;
- for each running agent: its session id, project, title, state ("working",
  "waiting", "idle", "stuck"), the one line saying what it is doing now
  ("Editing cache.go"), and whether Caprock may type into it.

To decide on a question an agent asked, a run is sent the question, its
options with their descriptions, the project and the agent's title.

**Never sent:** transcripts, files, folder paths, code, diffs, your other
messages, your settings or memory files. The run has no tools: it cannot
read a file, run a command or browse.

## What it can do

Only what Jarvis could do from the screen: give an instruction to an agent
Caprock started (never to one you started yourself), start a new agent in a
project Caprock knows, or press an option of a question dialog. Every
action is checked before it is done, and the reply says what was done and
what was not.

It answers a question for you only when it is a single multiple-choice
question in a session Caprock started, nothing in it mentions pushing,
merging, deploying, releasing, publishing, deleting, paying, credentials,
tokens or sending messages, and your agent calls it routine. Each answer is
listed under Handled for you with the reason.

## Where it runs, and what it costs

On your computer, as `claude -p` or `codex exec`, from an empty folder of
Caprock's, with your hooks, plugins, MCP servers and settings left out, and
with nothing saved as a session. So a run never shows up as one of your
sessions on Now or in Cost. It does use your plan: Jarvis shows what its
runs cost today when your agent reports a cost (Claude Code does; Codex
does not).

## When it fails

Signed out, not installed, too slow (90 seconds), or an answer Caprock
cannot read: Jarvis says so and routes your message the simple way.
