# Contribute with your AI

You can contribute to Caprock by handing your own coding agent — Claude Code,
Codex, OpenCode or any other — one prompt. The repository is written to be
read by agents: [`AGENTS.md`](../AGENTS.md) and [`CLAUDE.md`](../CLAUDE.md)
carry the rules, and [`.ai/00-index.md`](../.ai/00-index.md) maps every doc to
the task that needs it, so the agent reads one file instead of the whole tree.

The one condition: **the checks run on your machine, not on our CI.** The full
gate, `make check`, is what CI runs minus the three-OS matrix, and it is green
locally when it will be green there. CI skips draft pull requests and runs when
a pull request is marked *Ready for review*, so iterate as a draft and flip it
once, when the work is done ([ADR-061](../.ai/08-decisions.md)). The rules
behind it are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## What you need

- Go 1.26 and Node 22; Rust through [rustup](https://rustup.rs) only for a
  change under `app/`.
- The GitHub CLI (`gh`), signed in, so the agent can fork and open the pull
  request as you.
- An issue to work on. [Good first issues](https://github.com/dspv/caprock/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
  are small on purpose; for anything else, open an issue first and say what you
  plan to change.

## The prompt

Paste this into a fresh session of your agent, in an empty folder. Put an issue
number in the first line, or leave it for the agent to pick a good first issue.
The four-line prompt under the banner in the [README](../README.md) is the
short way in: it forks and clones the repository, then sends the agent here to
follow this one.

```text
I want to contribute to Caprock (https://github.com/dspv/caprock), an
open-source desktop app for running coding agents. Work on issue #<number>
(if I left it blank, list the open issues labelled "good first issue" and
pick the smallest one, then tell me which).

1. Fork and clone it: `gh repo fork dspv/caprock --clone`, then work in that
   clone on a branch named feat/<short-name>, fix/<short-name> or
   docs/<short-name>.
2. Before changing anything, read AGENTS.md, CLAUDE.md and .ai/00-index.md,
   then only the one .ai/ file the index names for this task, and
   CONTRIBUTING.md. Follow their rules: English only, Conventional Commits
   with a scope, no invented numbers, docs change in the same commit as the
   behaviour they describe, `make docs-fmt` after editing any markdown table.
3. Keep the change to that one issue. If you find something else, write it
   down for me instead of fixing it.
4. Run `make check` and fix what it reports until it passes. If you touched
   app/, run `make app-test` too. Do not push to get feedback from CI: CI
   only runs once the pull request is ready for review.
5. Open the pull request as a draft: `gh pr create --draft`, filling in
   .github/PULL_REQUEST_TEMPLATE.md, with "Closes #<number>" and the last
   lines of the passing `make check` output pasted under the checklist.
6. When `make check` is green on the final commit, mark it ready:
   `gh pr ready`. Then stop and show me the pull request link.

Ask me before anything that is not on this list, and never force-push to a
branch that is not yours.
```

## What happens next

The 3-OS CI matrix runs when the pull request is marked ready. A maintainer
approves the run for an outside contributor first (GitHub asks for that), then
reviews. If CI finds something `make check` could not — usually a Windows or
Linux difference — fix it on the same branch: turn the pull request back into a
draft with `gh pr ready --undo` while you work, and mark it ready again once it
is fixed and `make check` passes.

Prefer to work without an agent? The same steps, by hand, are in
[CONTRIBUTING.md](../CONTRIBUTING.md).
