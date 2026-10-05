# Caprock — Infrastructure

Toolchain, versions, CI, release, and local development. What is decided here follows [ADR-012](08-decisions.md#adr-012--sqlite-via-moderncorgsqlite-pure-go-no-cgo-anywhere), [ADR-017](08-decisions.md#adr-017--toolchain-go-126-moderncorgsqlite-coderwebsocket-fsnotify-cobra-react-19--vite-8--typescript-7-native-tailwind-4-vitest), [ADR-018](08-decisions.md#adr-018--release-mechanics-goreleaser-tags-v0xy-three-static-binaries--the-shim-per-os). Rules that bind how code is written are in [06-engineering-rules.md](06-engineering-rules.md).

## Versions (verified 2026-08-18)

Checked against `go.dev/dl`, `proxy.golang.org`, and the npm registry on 2026-08-18. Bump deliberately; record the date when you do.

| Component                        | Version   | Notes                                           |
| -------------------------------- | --------- | ----------------------------------------------- |
| Go                               | 1.26      | `go.mod` says `go 1.26`; local toolchain 1.26.4 |
| `modernc.org/sqlite`             | v1.56.0   | pure Go, no CGO                                 |
| `github.com/fsnotify/fsnotify`   | v1.10.1   | + poll fallback for network/odd filesystems     |
| `github.com/coder/websocket`     | v1.8.15   | context-native WS                               |
| `github.com/spf13/cobra`         | v1.10.2   | CLI subcommands                                 |
| `github.com/aymanbagabas/go-pty` | v0.2.3    | T0 candidate; ConPTY on Windows                 |
| Node.js                          | 22 LTS    | Vite 8 needs Node ≥22.12 (or ≥20.19)            |
| React / react-dom                | 19.2.x    |                                                 |
| Vite                             | 8.2.x     | `@vitejs/plugin-react` 6.x                      |
| TypeScript                       | 7.0.x     | native compiler; typecheck only                 |
| Tailwind CSS                     | 4.3.x     | tokens still live in `tokens.css`               |
| `@xterm/xterm`                   | 6.0.x     | Phase 1 terminal (+ `addon-fit`)                |
| Vitest                           | 4.1.x     | UI unit tests                                   |
| golangci-lint                    | latest v2 | pinned in CI by version                         |
| goreleaser                       | latest v2 | pinned in CI by version                         |
| Rust (desktop app)               | stable    | ≥ 1.90 (Tauri 2.12); added 2026-10-05           |
| Tauri                            | 2.12.x    | ≥ 2.11.1 (GHSA-7gmj-67g7-phm9); `app/`          |

## Repository layout

See [02-architecture.md § Repository layout](02-architecture.md#repository-layout). Two build roots: the Go module at the repo root and the npm project in `ui/`. The dashboard builds into `internal/api/dist/`, which **is committed** so `go install github.com/dspv/caprock/cmd/caprock@latest` embeds the real UI (a `dist-check`/CI gate rebuilds it and fails if the commit is stale — run `make ui` and commit after any UI change). `internal/api/ui.go` embeds that directory via `//go:embed`, falling back to a `placeholder/` page only if `dist/` is somehow empty. The Vite build is deterministic (content-hashed filenames), so the committed output is stable across rebuilds.

## Make targets

```bash
make help        # list targets
make dev         # daemon with live reload + vite dev server proxied to :22776
make build       # ui build + go build → ./bin/caprock, ./bin/caprock-hook
make test        # go test ./... + ui tests
make lint        # golangci-lint + tsc --noEmit
make smoke       # the DoD scenario with the fake claude (what CI runs per OS)
make docs-fmt    # tight-align markdown tables
make docs-check  # fail on unaligned tables
make docs-links  # fail on broken relative links
make check       # docs gates + lint + test (what CI runs, minus the OS matrix)
make app         # the desktop app, debug build (app/README.md)
make app-test    # cargo fmt --check, clippy -D warnings, cargo test
make app-bundle  # release bundles; APP_BUNDLES=app,dmg|nsis|deb|rpm|appimage to choose
make app-release TAG=vX.Y.Z  # macOS: universal .dmg for the tag, checked, attached, cask rendered
```

## CI (GitHub Actions)

- **`docs.yml`** — on push to `master` and on PRs: `make docs-check docs-links` (tables aligned, links and anchors resolve). The only workflow that runs before code exists.
- **`ci.yml`** — on push to `master` and on PRs. Jobs: `ui` (ubuntu; `npm ci`, typecheck, vitest, build, upload the `internal/api/dist` artifact), `go` matrix (`ubuntu-latest`, `macos-latest`, `windows-latest`; download the UI artifact, `go vet`, `golangci-lint`, `go test`, `go build` for the OS, the smoke test, upload the binary). `app` matrix (the same three OS; Go, Node and stable Rust, WebKitGTK 4.1 on ubuntu; `make app-test`, then `make app-bundle` — `.app` and `.dmg` on macOS, NSIS on Windows, `.deb` on Linux — and upload the bundles). CI artifacts are disposable and retained for 3 days; release assets are published separately. Windows job red = task not done.
- **`release.yml`** — on `v*` tags; goreleaser builds `caprock` + `caprock-hook` for darwin/linux/windows × amd64/arm64 with `CGO_ENABLED=0`, plus a macOS **universal** binary, attaches `checksums.txt`, pushes a **Homebrew formula** to `dspv/homebrew-tap`, and **publishes** the GitHub release directly (`release.draft: false`, so the formula push is not skipped). A `-rc`/`-beta` tag is marked a prerelease and its formula push is skipped. goreleaser runs only after an in-workflow `verify` job (npm ci + golangci-lint + `make check` + Windows cross-build on the tagged commit) passes — a tag push does not re-run `ci.yml` (which fires on branches/PRs, not tags), so this job is what keeps a red commit from shipping. After goreleaser, the desktop app (WP-17) is built from the same tagged commit and attached to the same release: `app-macos` runs `scripts/app-release.sh` (universal `Caprock_<v>_universal.dmg`, ad-hoc signed, checked for both architectures, the bundle id and the bundled daemon's version) and pushes the rendered cask `Casks/caprock-app.rb` to `dspv/homebrew-tap` on a stable tag when `HOMEBREW_TAP_TOKEN` is set; `app-other` builds the NSIS installer on `windows-latest` and the AppImage, `.deb` and `.rpm` on `ubuntu-22.04`. The app jobs are independent: a Windows or Linux failure does not hold up the `.dmg`. When Actions is unavailable, `make app-release TAG=vX.Y.Z` on a Mac does the macOS part ([docs/RELEASING.md](../docs/RELEASING.md#the-desktop-app)).
- Every third-party action in these workflows is pinned to a full commit SHA, with the human-readable release retained in a comment. Dependabot (`.github/dependabot.yml`) checks GitHub Actions, the root Go module, and `ui/` npm dependencies weekly. Updates are grouped by ecosystem and capped at three open PRs per ecosystem, while npm major updates remain individually reviewable, so a backlog does not flood the repository with one PR per package or silently bundle breaking changes.
- Secrets: CI needs none (the default `GITHUB_TOKEN`). The release job additionally needs **`HOMEBREW_TAP_TOKEN`** — a fine-grained PAT with `contents:write` on `dspv/homebrew-tap`, since the default `GITHUB_TOKEN` cannot write to another repository. Configured 2026-08-19; see [docs/RELEASING.md](../docs/RELEASING.md).

## Local development

```bash
git clone git@github.com:dspv/caprock.git && cd caprock
go mod download && (cd ui && npm ci)
make dev                 # http://localhost:22776
make test lint check     # before every push
```

Data dir and `CAPROCK_DATA_DIR` override: [ADR-013](08-decisions.md#adr-013--data-dir-and-config-conventions). To develop against a throw-away data dir: `CAPROCK_DATA_DIR=$(mktemp -d) make dev`.

## Release checklist

1. `14-build-status.md` and README progress bars updated; changelog entry written.
2. `ci.yml` green on `master` including all Windows jobs.
3. `git tag vX.Y.Z && git push --tags` → `release.yml` builds and publishes the release and pushes the Homebrew formula.
4. Verify: `brew untap dspv/tap 2>/dev/null; brew install dspv/tap/caprock; caprock --version`.
5. The desktop app's `.dmg` is on the release and `Casks/caprock-app.rb` in the tap at the new version (`app-macos`, or `make app-release TAG=vX.Y.Z` by hand).
