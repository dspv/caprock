# Releasing Caprock

**All three phase releases are tagged and published** (2026-08-19): v0.1.0
(Observe), v0.2.0 (Control), v0.3.0 (Orchestrate). Phase 3 (Delight) has no plan
by design, so there is no planned next release. This doc is the runbook kept for
any future release:

## One-time setup

- ✅ The public tap repo **`dspv/homebrew-tap`** already exists (created
  2026-08-19). The `homebrew_casks` block in `.goreleaser.yaml` uploads the cask
  there on release.
- ✅ The **`HOMEBREW_TAP_TOKEN` secret is configured** on `dspv/caprock` (added
  2026-08-19). It is a fine-grained PAT with **Contents: Read and write** scoped
  to just `dspv/homebrew-tap`, which the cask push needs because the default
  `GITHUB_TOKEN` cannot write to another repository. (Before it was added, the
  first v0.1.0 run built and uploaded every binary but failed the cask push with
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
   - a Homebrew cask in `dspv/homebrew-tap` (once that repo exists),
   - `checksums.txt`, and a **draft** GitHub release.
4. Verify the draft's binaries on at least one machine per OS with the Phase 0
   DoD scenario, then publish the release.

### Re-running a release for an existing tag

If a release job failed partway (e.g. the cask push) after the tag was already
pushed, delete the draft release and its objects, then re-push the tag to
retrigger the workflow:

```bash
gh release delete v0.1.0 --yes --cleanup-tag   # removes the draft + the tag
git tag -d v0.1.0                               # local tag, if still present
git tag -a v0.1.0 -m "…" && git push origin v0.1.0
```

`goreleaser release --clean` is idempotent; with `HOMEBREW_TAP_TOKEN` set it will
complete the cask push it previously skipped.

## Version scheme

Versions map to the roadmap phases: **v0.1.0** = Observe, **v0.2.0** = Control,
**v0.3.0** = Orchestrate. All three are built; the tags are cut as each is
signed off. The version is stamped into the binary via
`-ldflags -X …/internal/version.Version`.
