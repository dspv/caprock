# Caprock

### Mission control for Claude Code — watch, control, and orchestrate every `claude` session on your machine.

Caprock is a single local Go binary. Run `caprock up`, open `localhost:4173`, and every Claude Code session you start — in any terminal, any project — shows up live: what it's doing, what it's spending, and whether it's stuck. Then, when you want it, spawn and drive sessions from the dashboard and run a **verified multi-agent team** that only calls a task "done" when the tests actually pass.

Local-first, zero servers, no telemetry. Apache-2.0. Free for solo use, permanently.

[![docs](https://github.com/dspv/caprock/actions/workflows/docs.yml/badge.svg)](https://github.com/dspv/caprock/actions/workflows/docs.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![release](https://img.shields.io/github/v/release/dspv/caprock?color=feb157)](https://github.com/dspv/caprock/releases)
[![platform](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-informational)](#install)

```bash
brew install --cask dspv/tap/caprock
caprock up          # → http://127.0.0.1:4173
```

> **Status:** shipped and stable. v0.1.0 (Observe), v0.2.0 (Control), and v0.3.0 (Orchestrate) are released, green on the macOS / Linux / Windows CI matrix, with 116 tests. See the honest per-track state in [`.ai/14-build-status.md`](.ai/14-build-status.md).

---

## Why Caprock

You already run Claude Code every day. What you *don't* have is a window into it.

- **Dead-air waiting.** You hand Claude a task and watch a terminal scroll. There's nothing useful to look at, and no way to tell "working hard" from "stuck in a loop."
- **Token anxiety.** One looping session can burn a daily budget in minutes. Per-task cost is invisible until the bill arrives.
- **The trust gap.** How does an orchestrator *know* a worker actually finished? Nobody leaves agents running unattended without something checking their work.
- **The platform gap.** The incumbent tool is an Electron app that breaks on Windows and can only see the agents *it* spawned — not the `claude` you started yourself.

Caprock answers each of these with one static binary — macOS, Linux, and Windows from day one — that starts in **observe-only mode on the sessions you already run**, with nothing to change in your workflow. Everything else is additive from there.

## Quick start

```bash
brew install --cask dspv/tap/caprock   # macOS / Linux
caprock up                             # starts the daemon, offers to install the hook shim, opens localhost:4173
claude                                 # in any terminal, any project — Caprock sees it live
caprock status                         # daemon, hooks, ingest, and the pricing table in force
caprock down                           # stops the daemon; keeps every byte of your data
```

On first run, `caprock up` offers to register a tiny hook shim in `~/.claude/settings.json` — non-destructive, backed up first, and cleanly removable. Say yes for live activity; if you say no, Caprock still tails your transcripts (a few seconds delayed). Either way, a broken or absent daemon can never break your Claude session.

Optional: set `statusLine.command` to `caprock statusline` in your Claude Code settings to get a compact status in your terminal (model · context · cost · plan-limit windows) and feed plan-limit usage to the Cost screen (Pro/Max plans).

## What you see

A dense, fast dashboard — five screens, every pixel earning its place:

| Screen         | What it shows                                                                              |
| -------------- | ------------------------------------------------------------------------------------------ |
| Now            | Every live session: human-readable activity, health, plan progress, burn                   |
| Session Detail | Event timeline, live `git diff` of the session's work, an in-browser terminal              |
| Cost & Burn    | $/hr right now, today's totals, model mix, cache hit-rate, per-project, plan-limit windows |
| History        | Lifetime stats: cost per project / day / model, tool distribution                          |
| Tasks          | A kanban over `tasks/*.md`: the Stop-loop autonomy engine and approvals queue              |

Costs are computed from a dated, sourced pricing table — never invented. On a flat subscription they're an equivalent, not a charge.

## How it works

Caprock grows with you, in three layers you opt into one at a time:

- **Observe.** A loopback daemon captures every `claude` session through Claude Code's own hook events (via the shim) and by tailing the transcript files Claude already writes. It normalizes everything into one event stream in a local SQLite file and serves the dashboard. Nothing about your workflow changes.
- **Control.** Spawn `claude` sessions from the dashboard into their own git worktrees, with a live in-browser terminal. Pause, resume, or kill them — **but only sessions Caprock started**; the ones you launched yourself stay observe-only. Opt into auto-pausing a session the moment it starts looping.
- **Orchestrate.** Hand Caprock a task with `done_criteria` (shell commands: tests, typecheck, lint). An orchestrator — itself a real `claude` session — assigns it to a worker in an isolated worktree. When the worker says "done," **Caprock runs the commands**: only green checks move the task to Done; a red result bounces the failing output back to the worker. Destructive commands never run unattended, and cost is attributed per task. That verification-before-done is the whole point.

The orchestrator has been driven end to end **unattended** — a real `claude` orchestrator took a task from assignment through a failing build, a fix, and green verification with no human in the loop.

## Local by construction

- **Loopback only.** The daemon binds `127.0.0.1` — not reachable from your network. There is no Caprock server in the path.
- **No telemetry, no outbound calls, no update checks.** All your data lives in one SQLite file on your disk. Read the source before you run it.
- **Non-destructive.** The hook shim is backed up before it's written and removable with one command; your other hooks and your settings' key order are preserved untouched.
- **We never signal a process we did not start.** Control and input are for owned sessions only — a hard rule, enforced in code and tested.

## Install

**Homebrew** (macOS / Linux):

```bash
brew install --cask dspv/tap/caprock
```

**Release binary** — download `caprock` + `caprock-hook` for your OS/arch from [GitHub Releases](https://github.com/dspv/caprock/releases) and put them on your `PATH`.

**From source** (Go 1.26, Node 22):

```bash
git clone git@github.com:dspv/caprock.git && cd caprock
make ui && make build      # → ./bin/caprock, ./bin/caprock-hook
./bin/caprock up           # http://127.0.0.1:4173
```

Cross-platform binaries (darwin / linux / windows × amd64 / arm64, plus a macOS universal binary) and the Homebrew cask are produced by `goreleaser` on every `v*` tag — see [`.goreleaser.yaml`](.goreleaser.yaml). Full history in [CHANGELOG.md](CHANGELOG.md).

## Project layout

```
.ai/           source of truth for humans and agents — start at 00-index.md
cmd/ internal/ Go daemon, CLI, and hook shim
ui/            React + Vite dashboard, embedded into the binary via go:embed
pricing/       versioned, dated model pricing table
testdata/      transcript fixtures, hook payloads, a fake claude
scripts/       docs tooling (table aligner, link checker)
docs/          human-facing docs and the spec-migration audit
```

Building with an AI agent? Start at [`CLAUDE.md`](CLAUDE.md). Toolchain, CI, and release mechanics live in [`.ai/10-infrastructure.md`](.ai/10-infrastructure.md).

## Contributing

Issues and PRs welcome. The rules that apply to every change are in [`.ai/06-engineering-rules.md`](.ai/06-engineering-rules.md): English everywhere, Conventional Commits, one focused change per PR, and — the moat — **no change ships with a red Windows CI job**. Run `make check` before you push.

## Heritage

Caprock began as a free Python stats utility for Claude Code (`pip install caprock`, still on PyPI, now frozen). This repository is its successor: same name, same honesty about numbers, a new Go core. See [`.ai/01-product.md` § Relationship to Caprock-python](.ai/01-product.md#relationship-to-caprock-python-heritage).

## License

[Apache-2.0](LICENSE).
