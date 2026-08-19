# Releasing Caprock

**All releases are tagged and published** (2026-08-19): v0.1.0 (Observe), v0.2.0
(Control), v0.3.0 (Orchestrate), v0.4.0 (post-Orchestrate polish). Phase 3 (Delight) has no plan
by design, so there is no planned next release. This doc is the runbook kept for
any future release:

## One-time setup

- ✅ The public tap repo **`dspv/homebrew-tap`** already exists (created
  2026-08-19). The `brews` block in `.goreleaser.yaml` uploads the formula
  there on release.
- ✅ The **`HOMEBREW_TAP_TOKEN` secret is configured** on `dspv/caprock` (added
  2026-08-19). It is a fine-grained PAT with **Contents: Read and write** scoped
  to just `dspv/homebrew-tap`, which the formula push needs because the default
  `GITHUB_TOKEN` cannot write to another repository. (Before it was added, the
  first v0.1.0 run built and uploaded every binary but failed the formula push with
  `403 Resource not accessible by integration`.) If it ever expires, regenerate
  the PAT and replace the secret under **Settings → Secrets and variables →
  Actions**.

## Cutting a release

1. Make sure `master` is green locally: `go test ./...`, `golangci-lint run ./...`,
   `make check`, `go test -tags smoke ./internal/smoke/... ./internal/board/...`,
   and `GOOS=windows go build ./...`.
2. Update `CHANGELOG.md` and the progress in `.ai/14-build-status.md` + README.
3. Tag and let `goreleaser` build + draft the GitHub release:

   ```bash
   git tag v0.1.0 && git push --tags
   ```

   `.github/workflows/release.yml` runs `goreleaser release --clean`, producing:
   - `caprock` and `caprock-hook` for darwin/linux/windows × amd64/arm64,
   - a macOS **universal** binary,
   - a Homebrew formula in `dspv/homebrew-tap`,
   - `checksums.txt`, and a **draft** GitHub release.
4. Verify the draft's binaries on at least one machine per OS with the Phase 0
   DoD scenario, then publish the release (`gh release edit vX --draft=false --latest`).
5. **Update the Homebrew formula.** `skip_upload: auto` makes goreleaser skip the
   formula push for a **draft** release (every release starts as a draft), so the
   tap does **not** auto-update. After publishing, refresh
   `dspv/homebrew-tap/Formula/caprock.rb` to the new version + the four
   `tar.gz` sha256s from the release's `checksums.txt` (macOS/Linux × amd64/arm64),
   then verify: `brew untap dspv/tap; brew install dspv/tap/caprock; caprock --version`.
   This is the one manual step the draft flow leaves; a stale formula ships the
   previous version to every `brew install` until it is refreshed.

### Re-running a release for an existing tag

If a release job failed partway (e.g. the formula push) after the tag was already
pushed, delete the draft release and its objects, then re-push the tag to
retrigger the workflow:

```bash
gh release delete v0.1.0 --yes --cleanup-tag   # removes the draft + the tag
git tag -d v0.1.0                               # local tag, if still present
git tag -a v0.1.0 -m "…" && git push origin v0.1.0
```

`goreleaser release --clean` is idempotent; with `HOMEBREW_TAP_TOKEN` set it will
complete the formula push it previously skipped.

## Cask → formula migration (2026-08-19)

Up to and including v0.3.0 the tap shipped a **cask** (`brew install --cask`).
A CLI binary belongs in a **formula** (casks are for GUI `.app` bundles, and a
formula also installs on Linux Homebrew), so `.goreleaser.yaml` now uses a
`brews` block. On the next release:

- The formula lands at `dspv/homebrew-tap/Formula/caprock.rb`; the old
  `Casks/caprock.rb` should be deleted from the tap so `brew install
  dspv/tap/caprock` resolves the formula, not the stale cask.
- Users who installed the cask (`brew install --cask dspv/tap/caprock`) keep a
  working install; to switch they run `brew uninstall --cask caprock` then
  `brew install dspv/tap/caprock`. No data is touched — Caprock's SQLite lives
  in `~/.caprock`, outside Homebrew.

## Version scheme

Versions map to the roadmap phases: **v0.1.0** = Observe, **v0.2.0** = Control,
**v0.3.0** = Orchestrate. Post-phase work bumps the minor for a notable change
(a feature or a meaningful fix) and the patch for small fixes: **v0.4.0** is
plan-limit windows + orchestrator-lifecycle fixes + the Homebrew formula. The
version is stamped into the binary via `-ldflags -X …/internal/version.Version`.
