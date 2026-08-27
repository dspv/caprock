# Releasing Caprock

**All releases are tagged and published**: v0.1.0 (Observe), v0.2.0 (Control),
v0.3.0 (Orchestrate), v0.4.0 (post-Orchestrate polish, 2026-08-19), v0.4.1
(Homebrew hook-shim fix, 2026-08-19), v0.5.0 (distribution polish — statusLine
auto-install, honest first-run errors, release CI-gate, 2026-08-20). Phase 3
(Delight) has no plan by design. This doc is the runbook kept for
any future release:

## One-time setup

- ✅ The public tap repo **`dspv/homebrew-tap`** already exists (created
  2026-08-19). The `brews` block in `.goreleaser.yaml` uploads the formula
  there on release.
- ✅ The public Scoop bucket repo **`dspv/scoop-bucket`** exists (created
  2026-08-20). The `scoops` block uploads the Windows manifest there on release.
- ✅ The **`HOMEBREW_TAP_TOKEN` secret is configured** on `dspv/caprock` (added
  2026-08-19). It is a fine-grained PAT with **Contents: Read and write** scoped
  to the tap, which the formula push needs because the default `GITHUB_TOKEN`
  cannot write to another repository. (Before it was added, the first v0.1.0 run
  built and uploaded every binary but failed the formula push with `403 Resource
  not accessible by integration`.) If it ever expires, regenerate the PAT and
  replace the secret under **Settings → Secrets and variables → Actions**.
- ⚠️ **The same PAT must also be granted `Contents: write` on
  `dspv/scoop-bucket`** (the goreleaser `scoops` block reuses `HOMEBREW_TAP_TOKEN`).
  Until that scope is added, the Scoop push is skipped by `skip_upload: auto`
  (the release still succeeds) — so the bucket serves nothing and `scoop install
  caprock` fails. Add the repo to the PAT's resource list, or issue a new
  fine-grained PAT covering both `homebrew-tap` and `scoop-bucket`.

## Cutting a release

1. Make sure `master` is green locally: `go test ./...`, `golangci-lint run ./...`,
   `make check`, `go test -tags smoke ./internal/smoke/... ./internal/board/...`,
   and `GOOS=windows go build ./...`.
2. Update `CHANGELOG.md` and the progress in `.ai/14-build-status.md` + README.
3. Tag and let `goreleaser` build + publish the GitHub release:

   ```bash
   git tag v0.1.0 && git push --tags
   ```

   `.github/workflows/release.yml` gates `goreleaser release --clean` behind a
   `verify` job that re-runs `make check` + the Windows cross-build on the exact
   tagged commit (the full 3-OS matrix already ran on master before you tagged);
   a tag on a red commit never publishes. On success it produces:
   - `caprock` and `caprock-hook` for darwin/linux/windows × amd64/arm64,
   - a macOS **universal** binary,
   - a Homebrew formula pushed to `dspv/homebrew-tap` and a Scoop manifest pushed
     to `dspv/scoop-bucket` — both **automatically**, because the release is no
     longer a draft (`release.draft: false`); a prerelease skips both,
   - `checksums.txt`, and a **published** GitHub release.
4. Verify the published binaries and the formula end to end:
   `brew untap dspv/tap 2>/dev/null; brew install dspv/tap/caprock; caprock --version`,
   then `caprock up` and confirm `caprock status` reads `hooks: 8/8` — this catches
   a formula that installs the wrong binaries or a stale formula path. No manual
   formula edit is needed — goreleaser writes `Formula/caprock.rb` directly
   (`directory: Formula` in `.goreleaser.yaml`). A `-rc`/`-beta` tag is marked a
   prerelease and its formula push is skipped by `skip_upload: auto`, so a
   prerelease never overwrites the stable formula.

   The full pipeline — the CI-gate (`verify` job), `release.draft: false`
   auto-publish, and `directory: Formula` auto-push — was exercised end to end on
   **v0.5.0** (2026-08-20): the first tag failed the `verify` gate (golangci-lint
   ran before the UI build, so `//go:embed all:dist` had nothing to embed) and
   goreleaser was correctly **skipped** — nothing shipped. After fixing the gate
   (build the UI first) and re-tagging, the release published and the tap formula
   bumped to 0.5.0 on its own; a clean `brew upgrade` → `caprock up` reads `8/8`.
   Earlier release-plumbing bugs (v0.4.1): the formula must install **both**
   `caprock` and `caprock-hook`, and goreleaser must write to `Formula/` (not the
   repo root, which `brew` ignores in favour of `Formula/`).

### Re-running a release for an existing tag

If a release job failed partway (e.g. the formula push) after the tag was already
pushed, delete the release and its objects, then re-push the tag to retrigger the
workflow:

```bash
gh release delete v0.1.0 --yes --cleanup-tag   # removes the release + the tag
git tag -d v0.1.0                               # local tag, if still present
git tag -a v0.1.0 -m "…" && git push origin v0.1.0
```

`goreleaser release --clean` is idempotent; with `HOMEBREW_TAP_TOKEN` set it will
complete the formula push it previously skipped.

## Never move a tag that has already run (2026-08-27)

`release.draft: false` means the first `goreleaser` run **publishes** — the
release and its assets exist the moment the workflow succeeds at that step.
Force-moving the tag afterwards does not replace them: the second run finds the
release already there and every upload fails with

```
422 Validation Failed [{Resource:ReleaseAsset Field:name Code:already_exists}]
```

and the published release keeps binaries built from the **earlier** commit,
while `CHANGELOG.md` describes the later one. The tap formula points at those
older tarballs by sha, so `brew install` serves them too.

**Finish every change before tagging.** If a tag has to be re-cut anyway,
delete the release and the remote tag first, and check the download counts
before you do:

```bash
gh api repos/dspv/caprock/releases/<id> --jq '.assets[] | "\(.name) \(.download_count)"'
gh release delete vX.Y.Z --yes
git push origin :refs/tags/vX.Y.Z
git tag -d vX.Y.Z && git tag -a vX.Y.Z -m "…" && git push origin vX.Y.Z
```

Deleting a release people have already downloaded is a different decision and
needs asking first — zero downloads is what makes the delete safe, not the fact
that it is broken.

## The `brews` deprecation warning is expected (2026-08-20)

Every release logs `DEPRECATED: brews should not be used anymore`. **This is
known and deliberate — do not "fix" it.** The release still succeeds; v0.9.8
shipped through this exact path.

goreleaser's replacement is `homebrew_casks`, which is not a rename. Casks are
macOS-only: Homebrew on Linux raises `This cask requires macOS` unless the cask
declares `supports_linux?`, which a goreleaser-generated cask does not. Adopting
it would break `brew install dspv/tap/caprock` on Linux, which the README
promises and the shipped formula delivers.

Only `goreleaser check` exits non-zero on the warning; `release` and `build`
merely print it. Upstream removes deprecated options on major versions only, so
`brews` holds for all of v2 (2.17.1 is the current latest). When v3 ships and
removes it, Linux will likely need a hand-maintained formula in the tap beside
the generated cask. See [ADR-018](../.ai/08-decisions.md) and the note at the
top of the `brews` block in `.goreleaser.yaml`.

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
