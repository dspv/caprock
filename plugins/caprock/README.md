# Caprock plugin for Claude Code

Lets Claude Code ask [Caprock](https://caprock.dev) — the app that records
every coding-agent session on your computer — instead of you pasting things
in: Second Brain's memories and the decisions in force for this repository,
what past sessions did and wrote, spend and tokens per repository, CI status
on GitHub, and running sessions stuck repeating a tool call.

```bash
claude plugin marketplace add dspv/caprock
claude plugin install caprock@caprock
```

## What it does with your data

- **Read-only.** It adds one MCP server, `caprock mcp`. No tool can type into
  a session, start or stop one, write a memory or change a setting.
- **Local.** The server is a child process of Claude Code on stdin and
  stdout, opens no port, and reads the Caprock app running on this computer
  over `127.0.0.1`.
- **Sends nothing anywhere.** Neither the plugin nor the server sends data
  to Caprock or anyone else, and it has no telemetry. What a tool returns
  goes into your Claude Code conversation, and so to the model Claude Code
  uses, like your prompts and code. Credentials and payment details in the
  answers are redacted first. The CI tool reads GitHub only through the
  connection you made yourself in Caprock's Settings, as the app's CI panel
  does.

## It needs the Caprock app

Install it from https://caprock.dev/install and keep it running. The launcher
in `scripts/` finds `caprock` on your `PATH` or where the app and the package
managers install it; if there is none, it says so on stderr with that link
and starts nothing. It downloads nothing.

Every tool, what it returns and what is redacted:
[docs/mcp.md](https://github.com/dspv/caprock/blob/master/docs/mcp.md).
Licence: Apache-2.0.
