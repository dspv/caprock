# Caprock — Decisions

The ADR log: decisions that are closed, with the reasoning that closed them. **Check this file before reopening anything.** A decision reversed without a new ADR is not a decision, it is drift.

Format: what was decided, what it rules out, and what would justify revisiting it. ADR-001…008 and ADR-010…012 were settled in the spec (resolved 2026-08-18; ADR-012 comes from task T2's wording). ADR-009 and ADR-013…018 were made while preparing this repo for development on 2026-08-18 and are **marked "repo-prep decision"** — Dima can overrule any of them.

---

## ADR-001 — Name: Caprock, hosted at caprock.dev

**Date:** 2026-08-18 · **Status:** accepted

The brand, the domain, and the "honest measurement" reputation from the Python measurer carry over; the launch story is "Caprock's big brother", not a cold start.

**Rules out:** fortem.dev (off-topic SEO authority, brand mixing with the ECS product); any new name.

**Revisit if:** open-core happens and an org-level brand is needed — even then caprock.dev stays as product domain or redirect.

---

## ADR-002 — License: Apache-2.0

**Date:** 2026-08-18 · **Status:** accepted

Consistent with the existing Caprock, and carries a patent grant.

**Rules out:** MIT (the corpus template's default LICENSE was MIT and was replaced), AGPL/BSL/source-available.

**Revisit if:** the open-core decision ([ADR-005](#adr-005--monetization-free-oss-through-phases-01-open-core-deferred-solo-mode-free-forever)) requires a different license for a paid tier — the solo/local core stays Apache-2.0 regardless.

---

## ADR-003 — UI stack: React + Vite, embedded in the Go binary via `go:embed`

**Date:** 2026-08-18 · **Status:** accepted

Single-binary distribution is preserved: `go build` yields one file per OS that serves the SPA at `/`. The only thing Electron buys is bundling Chromium; a Go daemon + browser tab gives the same UI with zero ABI pain, one `go build` per platform, and the option of a TUI later.

**Rules out:** Electron; a separately deployed frontend; native-addon dependencies of any kind.

**Revisit if:** a desktop wrapper is wanted for Phase 3 — Tauri/Wails is a *packaging* decision layered on top, not an architecture change.

---

## ADR-004 — Observe-only for externally started sessions: yes, it is the Phase 0 wedge

**Date:** 2026-08-18 · **Status:** accepted

The much larger population runs `claude` in a terminal today and wants to see what it's doing and costing without adopting a runtime (traceability #7). The user-level hook shim + transcript tailing captures every session on the machine.

**Rules out:** requiring sessions to be spawned by Caprock to be visible; per-project-only hook registration as the default.

**Revisit if:** the user-level registration proves too intrusive in launch feedback — a per-project mode would be added, not substituted.

---

## ADR-005 — Monetization: free OSS through Phases 0–1; open-core deferred; solo mode free forever

**Date:** 2026-08-18 · **Status:** accepted

Adoption friction is the enemy at launch; the trust story is "local-first, zero servers, runs on the subscription you already pay for". The open-core (team/cloud tier) decision waits for post-Phase-2 traction.

**Rules out:** paywalls, license keys, telemetry, or "phone home" of any kind in Phases 0–2; any pricing page before traction exists.

**Revisit if:** Phase 2 ships and there is measurable pull for team/cloud features. Solo/local mode stays free permanently — this part is not revisited.

---

## ADR-006 — PTY backend: ConPTY-capable wrapper behind our own `ptyman` interface

**Date:** 2026-08-18 · **Status:** accepted (backend candidate pending T0 spike)

`creack/pty` is POSIX-only. First candidate is `aymanbagabas/go-pty` (delegating to `creack/pty` on POSIX, ConPTY on Windows) behind our own `ptyman` interface so the backend is swappable; a one-day spike (T0) confirms it builds and passes a smoke test on all three OS. Windows startup failure is exactly where the incumbent bleeds users.

**Rules out:** shipping any PTY code that has not passed the Windows matrix job; a POSIX-only Phase 1.

**Revisit if:** the T0 spike fails on Windows — then evaluate ConPTY directly via `golang.org/x/sys/windows`; the `ptyman` interface stays.

---

## ADR-007 — The harness *is* Caprock: new Go codebase in `dspv/caprock`; Python measurer frozen

**Date:** 2026-08-18 · **Status:** accepted

Python is wrong for a long-running daemon owning PTYs and the Headroom dependency ties the roadmap to an upstream built for a different purpose; a mission-control daemon must own its ingest path. The brand, cost/cache math, and JSONL knowledge port over (rewrite, not wrap). Personal profile for the launch story and portfolio visibility; transferable to an org later if open-core happens. The Python repo is archived read-only; published PyPI versions keep working.

**Rules out:** pivoting Caprock-python in place; wrapping the Python code; carrying Headroom.

**Revisit if:** never for the language choice; the repo location moves to an org only if open-core happens.

---

## ADR-008 — Hooks are the source of truth for activity; single normalized event stream

**Date:** 2026-08-18 · **Status:** accepted

Two data planes (terminal bytes, hook events) plus transcript accounting all normalize into one `Event` type consumed by the UI, stats, orchestrator, and any future avatar skin. Hooks are real-time and tool-level; transcripts lag but carry token usage; PTY bytes are the last-resort fallback.

**Rules out:** parsing PTY output to infer activity when hooks are available; per-consumer event shapes.

**Revisit if:** Anthropic ships a first-party structured activity stream that supersedes hooks — then it becomes another source feeding the same `Event`.

---

## ADR-009 — Hook transport is the `caprock-hook` shim binary, not Claude Code's native http hook type

**Date:** 2026-08-18 · **Status:** accepted · *repo-prep decision (verified against the hooks reference the same day)*

Claude Code now supports `{"type":"http","url":…}` hooks that POST the same JSON directly. That would remove one binary — but on connection failure (daemon not running) Claude Code surfaces a `<hook name> hook error` notice in the user's transcript on every event. Caprock's trust contract says a stopped daemon must be invisible to the user's session; only a shim that swallows failures and exits 0 delivers that. The shim also gives us the Phase 2 Stop-decision request-response with a hard 5s budget and stdout control.

**Rules out:** registering `type: "http"` hooks in `~/.claude/settings.json` in v0.x.

**Revisit if:** Claude Code adds a "silent on failure" option for http hooks, or the shim's install/uninstall proves to be a support burden.

---

## ADR-010 — Hive state lives in files; the router is the single git committer; the Stop hook is the autonomy engine

**Date:** 2026-08-18 · **Status:** accepted

Plain files over cleverness: mailboxes and task state are markdown/JSON on disk, inspectable with `cat`; SQLite mirrors them for the UI and is rebuildable by rescan. Agents never run git on the hive repo — one writer avoids merge conflicts and gives a clean ledger. Forcing continuation via the Stop hook (`decision: block`) uses a mechanism Claude Code already honours, with a hard loop-guard.

**Rules out:** database-only task state; agents committing to the hive; a bespoke agent API for orchestration.

**Revisit if:** file-based mailboxes hit a concurrency or scale wall in real use (many agents, high message rate).

---

## ADR-011 — One server, one port (default 4173), per-run bearer token; loopback only

**Date:** 2026-08-18 · **Status:** accepted

`/v1/hook`, the REST API, the WebSocket, and the UI share one listener on `127.0.0.1:4173`; `runtime.json` carries `{port, token}` for the shim. Unix sockets are not portable to Windows; a single loopback listener with a random per-run token is the same code on all OS and keeps everything local.

**Rules out:** Unix-domain-socket hook transport; binding non-loopback interfaces; a separate hook port.

**Revisit if:** a remote/team mode is ever built (post open-core decision) — that would be a new listener with real auth, not a change to this one.

---

## ADR-012 — SQLite via `modernc.org/sqlite` (pure Go); no CGO anywhere

**Date:** 2026-08-18 · **Status:** accepted

Keeps CGO off and cross-compilation trivial: one runner builds static binaries for three OS. A CGO SQLite would reintroduce the toolchain/ABI failure class we are explicitly avoiding.

**Rules out:** `mattn/go-sqlite3`; any dependency that requires a C toolchain.

**Revisit if:** a measured performance problem in the event write path cannot be solved with batching/WAL — unlikely at Caprock's write rates.

---

## ADR-013 — Data dir and config conventions

**Date:** 2026-08-18 · **Status:** accepted · *repo-prep decision*

Data dir = `os.UserConfigDir()/caprock` (macOS `~/Library/Application Support/caprock`, Linux `~/.config/caprock`, Windows `%AppData%\caprock`), overridable via `CAPROCK_DATA_DIR`. It holds `caprock.db`, `runtime.json` (0600), the installed `caprock-hook` binary, an optional user `pricing.json` override, and `config.json` (loop-detector K/T, auto-pause opt-in, port). Chosen because it is what the Go standard library resolves per OS with no extra dependency, and it keeps everything a user might want to delete in one place.

**Rules out:** dotfiles scattered in `$HOME`; writing anything into the user's project directories except the hive (Phase 2, explicitly registered by the user).

**Revisit if:** users ask for XDG-strict paths on macOS — a `CAPROCK_DATA_DIR` override already covers it.

---

## ADR-014 — Commit to `master` directly until Phase 0 T6, then PRs

**Date:** 2026-08-18 · **Status:** accepted · *repo-prep decision*

The spec's "every task = one PR" rule is right once there is a running product to protect. During bootstrap (docs migration, T1 scaffold, T2 store, T3 hookd/shim, T4 ingest, T5 rollup, T6 api) there is one contributor, no users, and CI is being built at the same time; PR ceremony would only slow the loop. From **T7 (first UI slice) onward** every task lands as a PR referencing its task ID with the AC checklist, because from that point a broken build is user-visible and reviewable diffs matter. Dima asked the agent to pick the line; this is it, and it is earlier than the "after Phase 2" ceiling he allowed.

**Rules out:** force-pushes to `master` at any time; direct commits after T6.

**Revisit if:** a second contributor arrives before T7 — then PRs start immediately.

---

## ADR-015 — Pricing source: Anthropic first-party pricing page, versioned; the legacy repo has no `pricing.json`

**Date:** 2026-08-18 · **Status:** accepted · *repo-prep decision*

The spec says to copy `pricing.json` from Caprock-python; on inspection the legacy repo has no such file — it priced via Headroom/litellm and hard-coded Sonnet 4.5 Bedrock list prices in one measurement script, and stored only cache-savings token-equivalents. `pricing/pricing.json` is therefore authored fresh from the Anthropic first-party pricing page (per-MTok base input, 5m/1h cache write, cache read, output; fetched 2026-08-18) with `source` and `fetched_at` recorded, and versioned. The T5 parity test compares against the *formula* ported from `_savings.py` on our own fixtures, not against a legacy artifact that does not exist.

**Rules out:** inventing or "remembering" prices; unversioned in-place edits to the table.

**Revisit if:** the legacy transcript fixtures are found somewhere else, or Bedrock/Vertex pricing is added ([OQ-02](12-risks.md#open-questions)).

---

## ADR-016 — Corpus layout: numbered `.ai/` files, minimal root, spec deleted after audit

**Date:** 2026-08-18 · **Status:** accepted · *repo-prep decision*

The spec proposed `.ai/product.md`, `.ai/architecture.md`, … and told us to adjust to the template's conventions, never the other way around. The template fixes `00/01/08/12/14`; free slots are used as `02-architecture`, `03-contracts`, `04-ui`, `05-orchestration`, `06-engineering-rules`, `09-execution-plan` (roadmap + all phase plans in one file), `10-infrastructure`. Root holds `README.md`, `LICENSE`, `CLAUDE.md`, `AGENTS.md` (the template's accepted duplicate entry point) and nothing else; the corpus template's own `TEMPLATE.md`/`CONTRIBUTING.md` are removed. The audit checklist the spec wants as `.ai/migration-audit.md` lives at `docs/migration-audit.md` (human-facing, archival — `docs/` is that place in this template) and may be pruned after Phase 0 ships. `CaprockV2-SPEC.md` is deleted after a green loss audit, as the spec itself and Dima instructed, rather than archived.

The orchestrator system prompt the spec places at `.ai/orchestrator.md` takes the free numbered slot `.ai/07-orchestrator.md` when T21 creates it.

**Rules out:** unnumbered `.ai/` files; extra root markdown files; keeping the spec around as a shadow source of truth.

**Revisit if:** the corpus template changes its numbering convention.

---

## ADR-017 — Toolchain: Go 1.26, `modernc.org/sqlite`, `coder/websocket`, `fsnotify`, `cobra`, React 19 + Vite 8 + TypeScript 7 (native), Tailwind 4, Vitest

**Date:** 2026-08-18 · **Status:** accepted · *repo-prep decision*

Latest stable of everything, verified against the registries on 2026-08-18 ([10-infrastructure.md § Versions](10-infrastructure.md#versions-verified-2026-08-18)). `coder/websocket` over `gorilla/websocket`: context-native API, actively maintained, no wsutil boilerplate. `cobra` for the CLI because `up/down/status/hooks install|uninstall` wants real subcommands, help, and completions. TypeScript 7 (the native Go-based compiler) is used only for typechecking — Vite transpiles — so a regression there costs one config line to fall back to 6.x.

**Rules out:** `gorilla/websocket`, `mattn/go-sqlite3`, `urfave/cli`, CRA/Next.js for the UI, CSS-in-JS runtimes.

**Revisit if:** any of these blocks the Windows job or the T0 spike; the swap cost is local to one package.

---

## ADR-018 — Release mechanics: goreleaser, tags `v0.x.y`, three static binaries + the shim per OS

**Date:** 2026-08-18 · **Status:** accepted · *repo-prep decision*

The spec names goreleaser for T10 (v0.1.0 tag + binaries). Each release ships `caprock` and `caprock-hook` for darwin/linux/windows × amd64/arm64 (windows/arm64 included because ConPTY is architecture-neutral), built with `CGO_ENABLED=0`, `-trimpath`, and the version stamped via `-ldflags`. Homebrew tap / winget / `go install` come after v0.1.0 based on demand.

**Rules out:** hand-built release artifacts; releases without a green three-OS smoke job.

**Update 2026-08-19:** shipped with v0.1.0. Each release also produces a macOS **universal** binary and pushes a **Homebrew formula** to `dspv/homebrew-tap` (`brew install dspv/tap/caprock`), which needs a `HOMEBREW_TAP_TOKEN` PAT — see [10-infrastructure.md § CI/release](10-infrastructure.md) and [docs/RELEASING.md](../docs/RELEASING.md). A CLI binary ships as a formula, not a cask — casks are for GUI `.app` bundles, and a formula also installs on Linux Homebrew. **Update 2026-08-20:** a Scoop bucket (`dspv/scoop-bucket`, Windows) is pushed on release too, and the built dashboard is committed under `internal/api/dist/` so `go install …/cmd/caprock@latest` embeds a real UI (a CI `dist-check` keeps it in sync). winget still deferred (needs a PR into `microsoft/winget-pkgs` + their review) until there is Windows demand.

**Update 2026-08-20 — the `brews` deprecation is refused on purpose.** goreleaser marks `brews` deprecated and points at `homebrew_casks`. That is not a rename and we are not taking it: casks are macOS-only, and Homebrew on Linux raises `"This cask requires macOS"` unless the cask declares `supports_linux?` — which a goreleaser-generated cask over darwin archives does not. Adopting it would break `brew install dspv/tap/caprock` on Linux, which the README promises and the shipped formula delivers (it carries `on_linux` amd64/arm64 blocks), and would reverse the cask → formula move made the previous day.

The trade is a warning against a broken install, so the warning stays. Measured on 2026-08-20 against goreleaser 2.17.1 — the current latest — `goreleaser release` and `goreleaser build` succeed and only warn (v0.9.8 shipped through that path); only `goreleaser check` exits non-zero. Upstream removes deprecated options on major versions only, so `brews` holds for all of v2.

**Revisit if:** goreleaser v3 ships and actually removes `brews` — at which point Linux likely needs a hand-maintained formula in the tap beside the generated cask, and `brew install dspv/tap/caprock` has to keep resolving for both. Or the desktop wrapper (Phase 3) needs installers — goreleaser stays for the binaries.

---

## ADR-019 — `caprock up` detaches by default; hook-install consent is a TTY prompt (or `--yes`); sessions end after 12h of silence

**Date:** 2026-08-18 · **Status:** accepted · *repo-prep decision (made while building T1–T6; resolves OQ-08)*

`caprock up` re-executes itself as a detached background process logging to `<data_dir>/caprock.log` and returns once `runtime.json` appears; `--foreground` keeps it attached (dev, CI, service managers); `caprock down` asks the daemon to stop over `POST /v1/shutdown` with the per-run token (works identically on Windows, no signals). Hook install: when any of the eight events is missing and stdin is a TTY, `up` explains what it will write and asks `Install now? [Y/n]`; `--yes` answers for scripts; a non-TTY without `--yes` skips with a hint (transcript tailing still works). Session lifecycle: `active` → `idle` after 5 min → `ended` after 12 h without events, so the Now screen shows what is running today rather than every session ever ingested. The `caprock-hook` binary is copied from beside the `caprock` executable into the data dir; if absent, `<caprock> hook` (a hidden subcommand over the same `internal/shim` code) is registered instead, so a single-binary install still works.

**Update 2026-08-20:** `caprock up` also offers to register the **statusLine** (`caprock statusline`, which feeds Pro/Max plan-limit windows to the Cost screen) under the same consent contract — a TTY prompt, `--yes` for scripts, and a hint when skipped. It is written to the same `~/.claude/settings.json` (backed up once), never clobbers a statusLine the user already set to something else, and can be managed explicitly with `caprock statusline install|uninstall`. Without it the dashboard still works; only the plan-limit view needs it. Also: on a detached-start timeout `up` now surfaces the real cause from `caprock.log` (most often "port already in use → try `caprock status`/`caprock down`, or `--port`") instead of a bare "did not report ready" message.

**Rules out:** blocking prompts in non-interactive runs; a Unix-signal-only `down`; keeping every historical session in the active list.

**Revisit if:** users want `up` to stay attached by default, or a service-manager integration (launchd/systemd) replaces the detach.

---

## ADR-020 — Untrusted-writer boundaries: hive paths are validated, worker branches are never force-reset, and Caprock's writes to the user's files are reversible

**Date:** 2026-08-23 · **Status:** accepted · *security audit of v0.17.0*

A security audit found five defects sharing one root cause: **Caprock treated files written by a worker Claude session as trusted input.** A worker runs with `--dangerously-skip-permissions` and is the *designed* author of mailbox messages and task files, so no external attacker is needed — a confused or prompt-injected worker is enough. The decisions taken:

- **Every id that becomes a path is validated at the point of use, not only at creation.** `Send` validated its `to`; `Deliver` re-parsed the message from disk and did not, so `to: ../../../x` made `MkdirAll` + write land anywhere on the machine — `~/.zshrc` or `~/.claude/settings.json` with partly-controlled content is code execution as the user. `CreateTask` validated its id; `GetTask`/`UpdateTask` did not, and `ListTasks` reads the id from *inside* a task file, so a hand-written file was a traversal primitive on the next write. `validID` now runs in all of them, backed by a `withinRoot` containment check as a second layer that survives a future weakening of `validID`.
- **A refused message is quarantined, not dropped and not fatal.** It moves to the sender's `rejected/` and is ledgered as `mail.rejected`. Dropping it would erase the evidence that a worker misbehaved; leaving it in the outbox would retry it forever; failing the whole pass would let one poisoned file wedge every other agent's mail.
- **A worker's branch is never worth a user's commits.** `git worktree add -B` force-reset an existing branch, and since worker names are predictable and nothing removed branches, a second run silently dropped the user's commits to the reflog. It now reattaches to the worktree it already owns, and otherwise refuses with an error naming the branch and the fix. `-b` replaces `-B` so the failure is loud even if the checks are bypassed.
- **Worktrees and branches are deliberately NOT auto-removed.** Removing a worktree on task completion would delete unmerged commits — exactly the data loss this ADR closes — and it would contradict [05-orchestration.md § the visible-output rule](05-orchestration.md), which requires a `done` card to show *where the work is* and *how to take it*, with landing left to the user. Accumulating worktrees is a housekeeping cost the user can see and undo; deleting their work is neither. A future `caprock worktree prune` that removes only worktrees whose branch is fully merged would be the safe form of cleanup.
- **What Caprock writes into the user's files, Caprock can put back.** `~/.claude.json` is read and written through the ordered-JSON codec, because a `map[string]any` round-trip sorted the user's 200KB config alphabetically and truncated integers past 2^53. Folder-trust grants are recorded in Caprock's own data dir so `hooks uninstall` revokes exactly what Caprock granted and never a folder the user trusted themselves. The `settings.json` backup refreshes when the content changed instead of being taken once and going stale for months, keeps the oldest (pre-Caprock) snapshot plus the most recent few, and `caprock hooks restore` exists to use them.

**Rules out:** trusting any field parsed out of a hive file to be a safe path component; force-resetting a branch under any circumstance; deleting a worktree that may hold unmerged work; whole-file rewrites of a user's config through an order-losing codec; one-way changes to files Caprock does not own.

**Revisit if:** the hive gains a legitimate need for hierarchical agent ids (then `validID` needs a defined grammar rather than a character denylist, and `withinRoot` becomes the primary guard); or worktree accumulation becomes a real complaint, in which case the merged-only prune above is the shape to build.
