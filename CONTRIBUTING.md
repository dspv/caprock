# Contributing to Caprock

Thanks for helping. Small PRs, green CI, honest numbers.

## Dev setup

Prereqs: **Go 1.26**, **Node 22**.

```bash
git clone git@github.com:dspv/caprock.git && cd caprock
make ui && make build      # → ./bin/caprock, ./bin/caprock-hook
./bin/caprock up           # http://127.0.0.1:4173
make check                 # tests + lint + typecheck — what CI runs
```

## Making a change

1. Open an issue first for anything non-trivial.
2. Branch; keep the PR small and focused.
3. Conventional Commits (`feat:`, `fix:`, `docs:` …).
4. `make check` must pass. **No red Windows CI — no exceptions.**
5. Fill in the PR checklist.

## Rules that matter

Full engineering rules: [`.ai/06-engineering-rules.md`](.ai/06-engineering-rules.md). The non-negotiables:

- **Local-first** — no telemetry, no outbound calls from the daemon.
- **No invented numbers** — a figure that isn't measured or sourced doesn't ship.
- **The shim never breaks a user's Claude session** — every error path exits 0.

New to the codebase? Read [`.ai/00-index.md`](.ai/00-index.md) first.

## License

By contributing, you agree your work ships under [Apache-2.0](LICENSE).
