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
| `github.com/shirou/gopsutil/v4`  | v4.26.9   | process CPU and memory (resource meter)         |
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

See [02-architecture.md § Repository layout](02-architecture.md#repository-layout). Two build roots: the Go module at the repo root and the npm project in `ui/`. The dashboard builds into `internal/api/dist/`, which **is committed** so `go install github.com/dspv/caprock/cmd/caprock@latest` embeds the real UI, and is written only by the `dist.yml` workflow on `master` — a pull request never carries it ([ADR-068](08-decisions.md#adr-068--the-dashboard-bundle-is-rebuilt-on-master-never-carried-by-a-pull-request)). A local `make ui` leaves it modified; don't commit that (`make dist-reset` undoes a commit that did). `internal/api/ui.go` embeds that directory via `//go:embed`, falling back to a `placeholder/` page only if `dist/` is somehow empty. The Vite build is deterministic (content-hashed filenames), so the committed output is stable across rebuilds.

## Make targets

```bash
make help        # list targets
make dev         # daemon with live reload + vite dev server proxied to :22776
make build       # ui build + go build → ./bin/caprock, ./bin/caprock-hook, ./bin/caprock-pty-host
make test        # go test ./... + ui tests
make lint        # golangci-lint + tsc --noEmit
make smoke       # the DoD scenario with the fake claude (what CI runs per OS)
make e2e         # the app's golden paths in Playwright's headless shell against a sandboxed daemon (§ E2E)
make docs-fmt    # tight-align markdown tables
make docs-check  # fail on unaligned tables
make docs-links  # fail on broken relative links
make pr-check    # before a PR: changed Go packages vet + test -race, changed tests -count=3, Windows vet + test compile, the whole UI suite, make e2e when ui/ or internal/api changed
make check       # docs gates + lint + test (what CI runs, minus the OS matrix)
make app         # the desktop app, debug build (app/README.md)
make app-test    # cargo fmt --check, clippy -D warnings, cargo test
make app-bundle  # release bundles; APP_BUNDLES=app,dmg|nsis|deb|rpm|appimage to choose
make app-release TAG=vX.Y.Z  # macOS: universal .dmg for the tag, checked, attached, cask rendered
make app-local   # macOS: this checkout's app (host arch) over /Applications/Caprock.app; app-local-revert undoes it
```

## CI (GitHub Actions)

- **`docs.yml`** — on push to `master` and on PRs that are not drafts: `make docs-check docs-links lang-check` (tables aligned, links and anchors resolve, no Cyrillic). The only workflow that runs before code exists.
- **`ci.yml`** — on push to `master` and on PRs that are not drafts (a draft runs nothing; marking it ready runs everything once, [ADR-061](08-decisions.md)). Jobs, all started at once:
  - **`no-dist`** (PRs only): fails when the PR's merge commit changes `internal/api/dist` against its first parent, with the command that drops the change.
  - **`changes`** lists a PR's files (`gh api …/pulls/N/files`) and says whether the app jobs run: only when the PR touches `app/`, `Makefile`, `scripts/check-app-mic.sh` or `ci.yml` itself. A push to `master`, or a PR whose file list cannot be read, runs everything. The app bundles `app/` plus a daemon the `go` jobs already compile on every OS; the dashboard is not in it (the window loads it from the daemon). A skipped app job shows as skipped, not failed. No branch protection or required check exists on `master` today; if one is added, require the jobs that always run, or add an always-run summary job, because a required check on a skipped matrix job is reported under the unexpanded name and would wait forever.
  - **`ui`** (ubuntu; `npm ci`, typecheck, vitest, the release-script tests, and a build whose output is discarded).
  - **`e2e`** (ubuntu only; `make e2e`, [§ E2E](#e2e-make-e2e)): the commit's dashboard against a sandboxed daemon in Playwright's headless shell. The go matrix already runs the daemon on three OS; what this adds is the page. On a failure it uploads the HTML report and the traces (`e2e-report`, 7 days).
  - **`go`** matrix (`ubuntu-latest`, `macos-latest`, `windows-latest`): `go vet`, `golangci-lint`, `go test`, `go build` for the OS, the smoke test, upload the binary. It builds against master's committed `internal/api/dist`, which may be one merge behind `ui/`: no Go test reads the dashboard's bytes, and `make build (windows-latest)` builds the dashboard on Windows anyway.
  - **`pty spike`** (informational, 3 OS) and **`make build (windows-latest)`**, the command a contributor runs.
  - **`app`** matrix (the same three OS; Go, Node and stable Rust, WebKitGTK 4.1 on ubuntu; `make app-test`, then `make app-bundle` — `.app` and `.dmg` on macOS, NSIS on Windows, `.deb` on Linux — and upload the bundles), gated by `changes`.
  - **Caches.** The Go build and module cache is one key per OS and `go.mod`/`go.sum`, written only by the `go` job on a `master` push and read by every Go job (setup-go's own cache let whichever job finished first write the shared key, which left Windows with 28 MB of it). Rust uses `Swatinem/rust-cache` (registry plus compiled dependencies; the app crate always rebuilds), one key per OS, written only from `master`. The `e2e` job's headless shell (`~/.cache/ms-playwright`) is one key per `@playwright/test` version, written only from `master`; on a hit it installs just the system libraries.
  - **Concurrency.** A new push to a PR cancels the run it supersedes; a push to `master` never cancels another, so every `master` commit gets a full run and writes the caches PRs read.
  CI artifacts are disposable and retained for 3 days; release assets are published separately. Windows job red = task not done.
- **`dist.yml`** — on a push to `master` that touches `ui/` (or by hand, `gh workflow run dist.yml`): `make ui` and, when `internal/api/dist` differs, a `chore(dist): rebuild the dashboard for <sha>` commit pushed to `master` with `GITHUB_TOKEN` (retried from the new head when another merge wins the race). It cannot loop: the commit is outside its `paths`, a `GITHUB_TOKEN` push starts no workflow, and it skips the Actions bot. `master` has no branch protection; adding some means allowing this push.
- **`release.yml`** — on `v*` tags; goreleaser builds `caprock` + `caprock-hook` + `caprock-pty-host` for darwin/linux/windows × amd64/arm64 with `CGO_ENABLED=0`, plus a macOS **universal** binary, attaches `checksums.txt`, pushes a **Homebrew formula** to `dspv/homebrew-tap`, and **publishes** the GitHub release directly (`release.draft: false`, so the formula push is not skipped). A `-rc`/`-beta` tag is marked a prerelease and its formula push is skipped. goreleaser runs only after both halves of the in-workflow `verify` job pass — `verify (go)` runs `make check-go` (docs gates, `go vet` + golangci-lint, `go test`, smoke) and the Windows cross-build, `verify (ui)` runs `make check-ui dist-check` (typecheck, vitest, release-script tests, and the tag's committed dist equal to its `ui/` built, which is what `go install …@vX.Y.Z` embeds); `make check` is exactly those two — because a tag push does not re-run `ci.yml` (which fires on branches/PRs, not tags), so this job is what keeps a red commit from shipping. The desktop app (WP-17) is built from the same tagged commit **at the same time as `verify`**, since building publishes nothing: `app-macos-build` runs `scripts/app-release.sh --no-upload` (universal `Caprock_<v>_universal.dmg`, ad-hoc signed, checked for both architectures, the bundle id and the bundled daemon's version) and `app-other-build` builds the NSIS installer on `windows-latest` (reading the `master` Rust cache) and the AppImage, `.deb` and `.rpm` on `ubuntu-22.04`, each handing its files on as an artifact. Only after goreleaser has published do `app-macos` (attach the `.dmg`, push the rendered cask `Casks/caprock-app.rb` to `dspv/homebrew-tap` on a stable tag when `HOMEBREW_TAP_TOKEN` is set) and `app-other` (one leg per OS) attach them, so a red `verify` leaves nothing published. The app jobs are independent: a Windows or Linux failure does not hold up the `.dmg`. goreleaser publishes with `make_latest: false`; the last job, `app-latest` (`scripts/app-latest.sh`), attaches version-less copies of the app files (`Caprock-macOS.dmg`, `Caprock-Windows-setup.exe`, `Caprock-Linux.AppImage`/`.deb`/`.rpm`) for the site's `releases/latest/download/<name>` links, adds them to `checksums.txt`, and marks the release Latest only when all five are attached (otherwise the previous release stays Latest and the job fails). When Actions is unavailable, `make app-release TAG=vX.Y.Z` then `make app-latest TAG=vX.Y.Z` on a Mac do the macOS part ([docs/RELEASING.md](../docs/RELEASING.md#the-desktop-app)).
- Every third-party action in these workflows is pinned to a full commit SHA, with the human-readable release retained in a comment. Dependabot (`.github/dependabot.yml`) checks GitHub Actions, the root Go module, and `ui/` npm dependencies weekly. Updates are grouped by ecosystem and capped at three open PRs per ecosystem, while npm major updates remain individually reviewable, so a backlog does not flood the repository with one PR per package or silently bundle breaking changes.
- Secrets: CI needs none (the default `GITHUB_TOKEN`). The release job additionally needs **`HOMEBREW_TAP_TOKEN`** — a fine-grained PAT with `contents:write` on `dspv/homebrew-tap`, since the default `GITHUB_TOKEN` cannot write to another repository. Configured 2026-08-19; see [docs/RELEASING.md](../docs/RELEASING.md). Optional, for Mail's *Sign in with Google / Microsoft*: **`CAPROCK_MAIL_GOOGLE_CLIENT_ID`**, **`CAPROCK_MAIL_GOOGLE_CLIENT_SECRET`** and **`CAPROCK_MAIL_MICROSOFT_CLIENT_ID`**, which `release.yml` passes to goreleaser and both app build jobs and which are compiled into the daemon with `-X …/internal/mail/oauth.*`; unset, they are empty and the build still succeeds (Mail then offers app passwords). How to make them: [docs/mail-oauth.md](../docs/mail-oauth.md).

## Local development

```bash
git clone git@github.com:dspv/caprock.git && cd caprock
go mod download && (cd ui && npm ci)
make dev                 # http://localhost:22776
make pr-check            # before opening a pull request (scripts/pr-check.sh)
make test lint check     # before every push
```

`make pr-check` is cheap on purpose: it covers only what the branch changed
against `origin/master` and catches the three failure classes CI kept finding
in fresh agent pull requests (2026-10-14/15: 17 failed of about 118 runs) —
data races, which CI does not look for (it runs no `-race`); Windows-only
semantics (`filepath.IsAbs("/a/b")` is false there), caught by
`GOOS=windows go vet ./...` and compiling the changed packages' tests for
Windows; and tests that fail one run in three, caught by running the changed
tests `-count=3`. The dashboard is the exception to "only what changed": when
`ui/` changed it runs the typecheck and the whole vitest suite, because a
change to one component breaks tests it never touched (#705 broke
`SidebarClose.test.tsx` that way, 2026-10-16). The suite took 2 min 16 s
on a 10-core Mac (2026-10-16). `PR_CHECK_COUNT` and `PR_CHECK_BASE` override the count and
the base.

When `ui/` or `internal/api/` changed, `make pr-check` also runs `make e2e`;
on a machine without Playwright's headless shell it skips that step and prints
the install command, and `PR_CHECK_E2E=0` skips it by choice.

### E2E (`make e2e`)

The app's golden paths, driven in a real browser before CI sees them:
`ui/e2e/` (Playwright's test runner, `@playwright/test` pinned in `ui/`). One
stand per run, started by `ui/e2e/stand.ts`, and torn down after it:

- **The daemon** is `bin/caprock` from `make build-go`, started under `env -i`
  with a temp `HOME`, data directory and `TMPDIR`, `CAPROCK_SECRET_STORE=file`
  (no keychain, no OS dialog), its own `CAPROCK_SERVICE_LABEL`, a free loopback
  port, `--no-hooks --no-open`, update checks, notifications and keep-awake
  off, and a `PATH` whose `claude` is `testdata/fakeclaude` (built into the
  stand). Two projects under the temp `HOME`, one fake session each.
- **The page** is this checkout's `ui/`, built with `vite build --outDir` into
  the stand (about 3 s) and served by `vite preview`, whose proxy points at the
  stand's daemon (`CAPROCK_DAEMON_URL`, `ui/vite.config.ts`). The binary's
  embedded dashboard is not used: on a branch it is master's (ADR-068), and
  `internal/api/dist` is never written.
- **The browser** is Playwright's own `chromium-headless-shell`, launched by
  the runner; never the system Chrome, never a running browser. Install it
  once with `cd ui && npx playwright install chromium-headless-shell`;
  `ui/e2e/has-browser.mjs` checks for it and prints that command.
- **What it kills** is only what it started: the daemon, `vite preview`, and
  the pty-hosts that daemon recorded in its own data directory.

Every test gets a fresh page and fails on any console error, uncaught
exception or request that leaves the stand. The scenarios
(`ui/e2e/golden.spec.ts`): the dashboard and the app workspace load; a session
appears in the sidebar and its tab opens on its terminal; every open tab has a
sidebar row in Tree and in Flat; typing reaches the pty (the fake claude
answers `you-said:<line>`); pasted text reaches it line by line; a native drop
(`caprock:drop-paths`, as the app's shell sends it) types the quoted path into
the terminal under the point, and a drop on the sidebar into the terminal
used last; the command palette
opens and runs a command; Settings opens and closes; Second Brain and Pipeline
render; the share dialog draws its card and closes. `ui/e2e/redraw.spec.ts`
runs after them: the fake claude's `agents [frames] [tag]` redraws a subagent
list in place as Claude Code's renderer does (relative moves in synchronized
updates, the viewport cleared on a resize; `testdata/fakeclaude/agents.go`),
and the terminal must show one copy of it, with the pixels xterm would draw
now, after the window was out of sight (no animation frames, past
`PAGE_HIDDEN_SUSPEND_MS`), after its tab was behind another past
`HIDDEN_HOLD_BYTES`, and after its WebGL context was lost, told, silently or
given back; and `box` draws Claude Code's input box, whose key hint must go
when the window loses focus. Each run carries a tag of its own and only its
own rows are counted: a page attaching is replayed the ring, which starts
mid-frame, and the fake idle at its prompt redraws nothing on the attach's
repaint (Claude Code clears its viewport on every resize), so an earlier
test's rows and its `agents-done` line can still be on screen — on the CI
runner, and on a Mac under a 6x CPU throttle (`REDRAW_THROTTLE=6`;
`REDRAW_DEBUG=1` prints the screen). Terminal text is read
from xterm's buffer through the bench hook (`ui/src/lib/benchhook.ts`). The
whole `make e2e` took 21-22 s of wall time on the owner's Apple Silicon Mac
(three runs, 2026-10-16; 37 s with the machine under heavy load). `E2E_ARGS` passes flags to
`playwright test` (`make e2e E2E_ARGS='-g palette'`); `CAPROCK_E2E_KEEP=1`
keeps the stand's directory for its logs.

What it cannot reach is the native shell itself: the drop the app's window
receives is checked in `app/src-tauri/src/main.rs`'s tests instead (the mock
runtime keeps no listeners, so those tests call the handler and check that
both the window's and the webview's drop events are registered and reach
it).

Data dir and `CAPROCK_DATA_DIR` override: [ADR-013](08-decisions.md#adr-013--data-dir-and-config-conventions). To develop against a throw-away data dir: `CAPROCK_DATA_DIR=$(mktemp -d) make dev`.

### Profiling the daemon

Release binaries are stripped, so `sample` and `footprint` on an installed
daemon show addresses, not Go frames. Measure a local build instead, against a
copy of a real database, with the opt-in profiling listener:

```bash
D=$(mktemp -d); mkdir -p $D/data $D/home
sqlite3 "$HOME/Library/Application Support/caprock/caprock.db" ".backup '$D/data/caprock.db'"   # never cp a live database
go build -o $D/caprock ./cmd/caprock
env -i HOME=$D/home CAPROCK_DATA_DIR=$D/data CAPROCK_PPROF=127.0.0.1:6391 PATH=/usr/bin:/bin \
  $D/caprock up --foreground --no-hooks --no-open --port 4391 --data-dir $D/data &
go tool pprof -top $D/caprock "http://127.0.0.1:6391/debug/pprof/profile?seconds=60"
go tool pprof -sample_index=inuse_space -top $D/caprock http://127.0.0.1:6391/debug/pprof/heap
```

`CAPROCK_PPROF` is off unless set, takes a loopback address only (anything
else, `localhost` included, is refused and logged), and serves Go's
`net/http/pprof` on a listener of its own — never on the API port, which a
paired phone can reach. The Go heap is not the whole footprint: SQLite's page
caches and sorter memory are allocated by the driver outside it, so compare
`footprint <pid>` with the heap profile's `HeapInuse`.

## Release checklist

1. `14-build-status.md` and README progress bars updated; changelog assembled from its fragments (`python3 scripts/changelog.py assemble X.Y.Z YYYY-MM-DD`, see [docs/RELEASING.md](../docs/RELEASING.md)).
2. `ci.yml` green on `master` including all Windows jobs.
3. `git tag vX.Y.Z && git push --tags` → `release.yml` builds and publishes the release and pushes the Homebrew formula.
4. Verify: `brew untap dspv/tap 2>/dev/null; brew install dspv/tap/caprock; caprock --version`.
5. The desktop app's `.dmg` is on the release and `Casks/caprock-app.rb` in the tap at the new version (`app-macos`, or `make app-release TAG=vX.Y.Z` by hand).
