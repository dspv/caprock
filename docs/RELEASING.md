# Releasing Caprock

Caprock is not tagged yet. The gate before the first tag is a **live, unattended
orchestrator run with hooks installed** (see `.ai/14-build-status.md`). Once that
is trusted end to end, cut a release:

## One-time setup (before the first tag)

1. Create a public tap repo **`dspv/homebrew-tap`** (empty is fine). The
   `homebrew_casks` block in `.goreleaser.yaml` uploads the cask there; until it
   exists, `skip_upload: auto` skips it without failing the release.

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

## Version scheme

Versions map to the roadmap phases: **v0.1.0** = Observe, **v0.2.0** = Control,
**v0.3.0** = Orchestrate. All three are built; the tags are cut as each is
signed off. The version is stamped into the binary via
`-ldflags -X …/internal/version.Version`.
