# Contributing to Caprock

Thanks for helping. Small PRs, green CI, honest numbers.

**Working with a coding agent?** [Contribute with your AI](docs/contributing-with-ai.md)
has one prompt to hand it: it reads the rules below, runs every check locally
and opens the pull request as a draft until they pass.

## English only

Everything in the repository is in English: code, comments, docs, commit
messages and pull requests. Test input that exercises non-English text
(Greek, CJK, emoji) is the one exception; Cyrillic is never used, and
`make lang-check` fails on it.

## Dev setup

Prereqs: **Go 1.26**, **Node 22**.

```bash
git clone git@github.com:dspv/caprock.git && cd caprock
make build         # builds the UI (installs its deps on first run) + the binaries
./bin/caprock up   # http://127.0.0.1:22776
make pr-check      # before opening a PR: what you changed, with -race, and compiled for Windows
make check         # docs + lint + tests + smoke — the full CI gate, minus the OS matrix
```

The desktop app (`app/`) also needs Rust via [rustup](https://rustup.rs). To
try a change to it on your Mac without a release, `make app-local` builds this
checkout's app (release, this Mac's architecture, in about half a minute once
its cache is warm) and installs it over `/Applications/Caprock.app`; the app
then moves its daemon onto the new build, and running sessions carry on.
`make app-local-revert` goes back to the release. Details, and how to run it
against a throw-away data directory: [app/README.md](app/README.md#trying-a-change-on-your-own-mac).

`make check` is what CI runs (minus the 3-OS matrix). If it's green locally, CI
is almost always green — the exception is a platform-specific bug on Windows or
Linux, which only the CI matrix can catch. Run a single package's tests with
`go test ./internal/<pkg>/...`.

`make pr-check` is the step before opening a pull request, and catches most of
what a targeted test run on a Mac misses. On the Go packages your branch
changed (against `origin/master`, uncommitted files included) it runs `go vet`,
`go test -race` once, and the tests in your changed `_test.go` files three
more times; then `GOOS=windows go vet ./...` and your packages' tests compiled
for Windows; the smoke tests your change defines; and, when `ui/` changed, the
typecheck and vitest on your changed test files. A one-package change takes
about two minutes; touching `internal/daemon`, `internal/api` or
`internal/projects` takes longer, because their suites are the largest. It
exists because the failures CI keeps finding in fresh pull requests are data
races (CI runs no `-race`), Windows path and build differences, and tests that
pass once and fail one run in three. It does not replace `make check`.

On a pull request the desktop app's three CI builds run only when it touches
`app/`, the `Makefile`, `scripts/check-app-mic.sh` or `.github/workflows/ci.yml`;
otherwise they show as skipped. Every push to `master` builds them.

## Making a change

1. Open an issue first for anything non-trivial.
2. Branch: `feat/<short-name>`, `fix/<short-name>`, or `docs/<short-name>`.
3. Keep the PR to **one focused change**.
4. **Conventional Commits with scope**: `feat(hookd): …`, `fix(ingest): …`,
   `docs(ai): …`, `ci: …`, `chore(release): …`.
5. **A changelog entry is its own file**, not an edit to `CHANGELOG.md`:
   add `changes/unreleased/<pr-or-branch-slug>.md` with `kind:` front matter
   and a `- **scope:** …` bullet ([`changes/README.md`](changes/README.md)).
   The release assembles them; parallel PRs never touch the same lines.
6. **Never commit `internal/api/dist`.** It is the built dashboard, committed
   so `go install` embeds a real UI, and only master's `dist` workflow writes
   it, after your PR merges ([ADR-068](.ai/08-decisions.md)). `make build` and
   `make ui` leave it modified locally; leave that out of your commits. CI's
   *no dist in the PR* check (and `make check`) fails a PR that changes it;
   `make dist-reset` and a commit drop the change.
7. `make pr-check` before you open the pull request, and `make check` must
   pass. **No red Windows CI — no exceptions.**
8. Reference the issue in the PR body: `Closes #<n>`.
9. Fill in the PR checklist.
10. **Iterate as a draft; CI runs when it is ready.** Draft pull requests run no
    CI at all: open it with `gh pr create --draft`, run `make check` locally
    until it is green, then mark it ready (`gh pr ready`), which runs the full
    3-OS matrix once. A pull request from a fork also waits for a maintainer to
    approve the run. Don't push to a ready PR just to see what CI says —
    that is what `make check` is for ([ADR-061](.ai/08-decisions.md)).

## Rules that matter

Full engineering rules: [`.ai/06-engineering-rules.md`](.ai/06-engineering-rules.md). The non-negotiables:

- **Local-first** — no telemetry, and no outbound call the user did not switch
  on (the release check, and integrations the user turns on — Gemini, GitHub,
  Telegram — each off by default and saying what it sends).
- **No invented numbers** — a figure that isn't measured or sourced doesn't ship.
- **The shim never breaks a user's Claude session** — every error path exits 0.
- **Contracts change with their docs, together** — a new/changed endpoint, DB
  table, or price updates [`.ai/03-contracts.md`](.ai/03-contracts.md) (and a
  migration / `pricing_version` bump) **in the same commit**.
- **Docs land with the change** — a behaviour change updates its docs, including
  [`.ai/14-build-status.md`](.ai/14-build-status.md), in the same PR.

New to the codebase? Read [`.ai/00-index.md`](.ai/00-index.md) first — it maps
every doc to when you'd read it.

## Screenshots

The images at the top of the README (`docs/readme/`, WebP, dark and light) are
the site's captures of the real-session fixture (`testdata/demo/`), copied from
`caprock-web/public/shots/`; the rest, below, come from `make shots`.

The README's other screenshots are taken from a real database, which is what makes
them worth showing — and also what makes them dangerous. `scripts/shots.py`
scrubs the copy it captures from: project directories are renamed unless they
are on a short allow-list, so a name it has never seen is anonymised by default
rather than published because nobody thought to block it. The script refuses to
run if the scrub fails.

```bash
make shots              # capture, commit to a branch, open a PR
```

It snapshots your database with sqlite's own `.backup` (never a `cp` — copying
a file being written to yields one that may not open), serves the copy on a
throwaway daemon on port 4290 with `--no-hooks`, captures both themes, and
opens a PR. **Look at the images before merging.** The scrubber is careful, but
the only real check on what is about to be public is a person seeing it.

This is not a CI job on purpose. CI has no real database, and generating a
plausible one would put invented figures in front of the public — rule 6.

**Refresh them on a minor version, not on every patch.** The header carries the
running version, so a screenshot taken on v0.31.2 says v0.31.2 after v0.31.3
ships — and that is fine. Re-shooting for a hotfix costs a review of eight
images to change one digit nobody is reading. Shoot when a screen actually
changed.

The site keeps its own copies in `caprock-web/public/shots/` rather than
pulling from this repository's `master`, so refreshing the README cannot change
what is published on caprock.dev.

**Recording video? `make record`.** It serves the same scrubbed database on
:4291 and holds it open until you stop it. Record from that window, never from
the live dashboard on :22776 — a screenshot can be replaced after posting and a
video cannot, and the live one has real repository names on it. Copy them across and commit them separately
when you want the site to move.

## Where we're headed

The three phases — Observe, Control, Orchestrate — have shipped (v0.1.0–v0.3.0).
There's no fixed roadmap after that by design; the direction we care about:

- **Sharper observation** — better narration, richer cost/limit insight, catching
  more failure modes (loops, runaway spend) earlier.
- **Trustworthy orchestration** — making verified multi-agent runs more robust and
  easier to drive; more done_criteria types, better approvals.
- **Reach** — more platforms and setups working smoothly (all three OS stay a hard
  gate); packaging that's easy to install.
- **A team edition** later (shared dashboards, multi-user orchestration) — only
  once solo use proves out. The local, solo core stays free and Apache-2.0.

Guardrails never move: local-first (no telemetry, no outbound call the user did
not switch on), no invented
numbers, the shim never breaks a session. If a change fights those, it's the wrong
change. Have an idea? Open an issue — that's how direction gets set.

## A good PR, concretely

> `fix(ingest): tolerate unknown transcript fields`
> One code file (`internal/ingest/parser.go`) + a fixture in
> `testdata/transcripts/` + a line in `.ai/14-build-status.md` — all in one
> commit, `make check` green, `Closes #42`.

## Code of Conduct

By participating, you agree to uphold our
[Code of Conduct](CODE_OF_CONDUCT.md) — be kind, be constructive.

## License

By contributing, you agree your work ships under [Apache-2.0](LICENSE).
