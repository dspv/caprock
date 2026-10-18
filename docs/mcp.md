# Use Caprock from your agents (MCP)

Caprock records every coding-agent session on your computer. `caprock mcp`
lets the agent you are working with ask it — through the
[Model Context Protocol](https://modelcontextprotocol.io), which Claude Code,
Codex and most other agents speak:

- "Did we decide this before?" — Second Brain's memories, searched.
- "Which session explained the SSO change?" — the prose agents wrote, searched
  across every session.
- "What did the last sessions in this repository do?" — titles, branches,
  files touched, pull requests, what each wrote at the end.
- "What has this repository cost this week?" — spend and tokens per day and
  model.
- "Is CI green?" — GitHub Actions on the default branch and the open pull
  request, once GitHub is connected in Caprock.
- "Is anything stuck?" — running sessions repeating a tool call.

It is read-only and free.

## Turn it on

Caprock has to be running (`caprock up`, or the desktop app). Then add the
server to your agent.

**Claude Code** — in the project you want it in:

```bash
claude mcp add caprock -- caprock mcp
```

Add `--scope user` after `add` to have it in every project. Check it with
`claude mcp list`, or `/mcp` inside a session.

**Codex:**

```bash
codex mcp add caprock -- caprock mcp
```

or add these lines to `~/.codex/config.toml`:

```toml
[mcp_servers.caprock]
command = "caprock"
args = ["mcp"]
```

**Any other MCP client:** a stdio server whose command is `caprock` and whose
one argument is `mcp`.

If `caprock` is not on your `PATH` — the desktop app installs none — use the
full path to the binary instead. Settings → *Use Caprock from your agents
(MCP)* shows it, with every command ready to copy: turn on *Use the full path to
caprock*. On Windows the path ends in `caprock.exe`; quote it if it holds a
space.

To turn it off, remove it from the agent: `claude mcp remove caprock`,
`codex mcp remove caprock`, or delete the lines. Nothing in Caprock changes
either way.

## The tools

A tool about "this repository" uses the directory your agent started the
server in — normally the project it is working in — unless it is given
another (`repo`). A linked git worktree counts as its repository.

| Tool                   | What it answers                                                        |
| ---------------------- | ---------------------------------------------------------------------- |
| `search_memories`      | Second Brain's memories matching some words, with their topics         |
| `get_memory`           | One memory in full, with what it links to                              |
| `memory_topics`        | The topics Second Brain knows, and the memories per project            |
| `next_session_handoff` | What a new session in this repository is handed, and whether it is on  |
| `recent_sessions`      | Recent sessions here (or everywhere): status, branch, cost, loop alert |
| `session_summary`      | One session: description, files touched, pull requests, cost           |
| `session_prose`        | What one session's agent wrote, newest first                           |
| `search_prose`         | What agents wrote, searched across every session                       |
| `cost`                 | Spend and tokens per day and model, for this repository or all         |
| `ci_status`            | GitHub Actions on the default branch and the open pull request         |
| `loop_alerts`          | Running sessions repeating the same tool call                          |

Costs are Caprock's own figures at API list prices; on a Pro or Max plan they
are what the same usage would cost on the API, not what you were billed.
Memories and prose can be stale: the agent is told to check them against the
code.

## What it can and cannot do

- **Read-only.** No tool can type into a session, start or stop one, write a
  memory or change a setting. The server can only send `GET` requests to
  Caprock.
- **No port.** Your agent starts `caprock mcp` as its own child process and
  talks to it over stdin and stdout. It reads the running Caprock over
  `127.0.0.1`. Nothing else on your computer can reach it.
- **Where the answers go.** What a tool returns goes into your agent's
  conversation, and so to the model your agent runs on — the same place your
  prompts and code already go. Adding the server is that choice. Caprock sends
  nothing anywhere itself; `ci_status` reads GitHub only through the
  connection you made in Caprock's Settings, as its CI panel does.
- **Trimmed.** Lists stop at 50 items (10 unless asked), long prose is cut,
  and one answer is at most 48 KiB. Paths of transcripts, process ids and
  commands Caprock used to start sessions are never included.
- **Redacted.** Text shaped like a credential — `sk-…` API keys, GitHub,
  Slack, AWS, Google, Stripe and Telegram tokens, JWTs, bearer values,
  private keys — is replaced with `[redacted]`. That catches keys that look
  like keys, not every secret.

## When it says Caprock is not running

Every tool answers *caprock is not running on this computer* while the
daemon is down. Start it (`caprock up`, or open the app) and ask again; the
agent does not need restarting.

The protocol and every field each tool returns are specified in
[.ai/03-contracts.md § MCP server](../.ai/03-contracts.md#mcp-server); the
decision is [ADR-078](../.ai/08-decisions.md).
