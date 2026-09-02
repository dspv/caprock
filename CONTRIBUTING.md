# Contributing to Caprock

Thanks for helping. Small PRs, green CI, honest numbers.

## Dev setup

Prereqs: **Go 1.26**, **Node 22**.

```bash
git clone git@github.com:dspv/caprock.git && cd caprock
make build         # builds the UI (installs its deps on first run) + the binaries
./bin/caprock up   # http://127.0.0.1:4173
make check         # docs + lint + tests + smoke — the full CI gate, minus the OS matrix
```

`make check` is what CI runs (minus the 3-OS matrix). If it's green locally, CI
is almost always green — the exception is a platform-specific bug on Windows or
Linux, which only the CI matrix can catch. Run a single package's tests with
`go test ./internal/<pkg>/...`.

## Making a change

1. Open an issue first for anything non-trivial.
2. Branch: `feat/<short-name>`, `fix/<short-name>`, or `docs/<short-name>`.
3. Keep the PR to **one focused change**.
4. **Conventional Commits with scope**: `feat(hookd): …`, `fix(ingest): …`,
   `docs(ai): …`, `ci: …`, `chore(release): …`.
5. `make check` must pass. **No red Windows CI — no exceptions.**
6. Reference the issue in the PR body: `Closes #<n>`.
7. Fill in the PR checklist.

## Rules that matter

Full engineering rules: [`.ai/06-engineering-rules.md`](.ai/06-engineering-rules.md). The non-negotiables:

- **Local-first** — no telemetry, no outbound calls from the daemon.
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

The README's screenshots are taken from a real database, which is what makes
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
the live dashboard on :4173 — a screenshot can be replaced after posting and a
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

Guardrails never move: local-first (no telemetry, no outbound calls), no invented
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
