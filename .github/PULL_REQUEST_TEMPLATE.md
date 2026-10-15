## What & why

<!-- one or two lines -->

Closes #<!-- issue number -->

## Checklist

- [ ] `make check` passes locally (docs + lint + tests + smoke)
- [ ] Conventional Commit title **with scope** (e.g. `fix(ingest): …`)
- [ ] One focused change
- [ ] No invented numbers; no new outbound calls from the daemon
- [ ] Contract/DDL/pricing change (if any) updates `.ai/03-contracts.md` + a migration in the same commit
- [ ] A user-visible change adds `changes/unreleased/<slug>.md` (see `changes/README.md`), never an edit to `CHANGELOG.md`
- [ ] Docs updated if behaviour changed (incl. `.ai/14-build-status.md` + README bars when a track moves)

<!-- The 3-OS CI matrix (incl. Windows) runs after you open this PR and must be green to merge. -->
