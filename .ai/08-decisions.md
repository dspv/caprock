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

*Amended 2026-10-05 by [ADR-038](#adr-038--the-desktop-app-is-a-thin-tauri-v2-shell-around-the-existing-react-ui-and-xtermjs-on-the-go-daemon):*
the wrapper is now wanted, and is that packaging decision: a Tauri v2 window
around this same UI, still served by the binary.

---

## ADR-004 — Observe-only for externally started sessions: yes, it is the Phase 0 wedge

**Date:** 2026-08-18 · **Status:** accepted

The much larger population runs `claude` in a terminal today and wants to see what it's doing and costing without adopting a runtime (traceability #7). The user-level hook shim + transcript tailing captures every session on the machine.

**Rules out:** requiring sessions to be spawned by Caprock to be visible; per-project-only hook registration as the default.

**Revisit if:** the user-level registration proves too intrusive in launch feedback — a per-project mode would be added, not substituted.

---

## ADR-005 — Monetization: free OSS through Phases 0–1; open-core deferred; solo mode free forever

**Date:** 2026-08-18 · **Status:** accepted, and its condition has since been met — see [ADR-022](#adr-022--the-licence-key-is-an-offline-string-with-an-expiry-and-nothing-more)

> Read the "Rules out" below with its scope: it forbade paid surfaces **in
> Phases 0–1**, and the revisit condition — Phase 2 shipping with measurable
> pull — is what happened. Paid plans on an offline licence key are live. Solo
> mode is still free forever, which is the part this entry says is never
> revisited.

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

## ADR-011 — One server, one port (default 22776), per-run bearer token; loopback only

**Date:** 2026-08-18 · **Status:** accepted · **Amended:** 2026-09-11 (default port), 2026-10-05 (relayed loopback)

`/v1/hook`, the REST API, the WebSocket, and the UI share one listener on `127.0.0.1:22776`; `runtime.json` carries `{port, token}` for the shim. Unix sockets are not portable to Windows; a single loopback listener with a random per-run token is the same code on all OS and keeps everything local.

**2026-09-11 amendment — the default moved to 22776.** `4173` is Vite Preview's
default port, so a developer running `vite preview` beside Caprock hit a bind
collision on the very machine Caprock is built for. A fresh install now defaults
to **22776** (unassigned by IANA, spells CAPRO on a phone keypad, below the
common ephemeral range). An existing install that never wrote `config.json`
keeps its old `4173` origin — the presence of `caprock.db` is the durable
evidence it predates the change, and a port is part of a browser origin, so
silently moving it would strand bookmarks and LAN-pairing tokens held in
localStorage. The one-server-one-port shape is unchanged; only the default
number moved.

**2026-10-05 amendment — loopback is the machine only when nothing relayed it.**
"Loopback only" was read as "a loopback peer is the owner", and the kernel
names only the last hop. A tunnel or reverse proxy on the Mac — cloudflared,
ngrok, Caddy, `tailscale serve`, `ssh -R` — connects from 127.0.0.1 for a
visitor from anywhere, so that visitor got every right the owner has with no
token: a `curl` through the tunnel with `Content-Type: application/json` passed
the CSRF layers and could `POST /v1/agents`. ADR-036 had already named this for
`tailscale serve`. A loopback request now counts as from the machine only when
it carries no proxy header and its `Host` names loopback; otherwise it is a
device under ADR-029/ADR-034 — a paired token and its role, or `401`, and with
network access off simply `401`. Headers are read for presence only, which is
safe in this direction: a caller can add one to lose rights, never to gain
them. `Host` is compared by hostname, not port, so `ssh -L` on another local
port (the owner's own forward) and Vite's dev proxy keep working, and a TCP
relay that adds no header is still caught by the name the visitor typed. Not
covered: a relay configured to strip every marker and rewrite `Host` to
localhost — only the owner can set that up, and it is indistinguishable from a
local client. Contract: `.ai/03-contracts.md`, *Who may connect*.

**Rules out:** Unix-domain-socket hook transport; binding non-loopback interfaces; a separate hook port; trusting a loopback peer that a proxy or tunnel relayed.

The choice was checked against the boundary cases that prompted the report.
`4173` is Vite Preview's default and is registered by IANA (TCP Reserved; UDP
`mma-discovery`), so it is a poor default for a tool commonly developed beside
Vite. Ports 80/443 require privileged binding or certificates; 49152–65535 are
IANA's dynamic/private range and Windows' default dynamic range; Linux commonly
uses 32768–60999 for ephemeral client ports. “Pretty” alternatives such as
41717 or 42424 therefore risk colliding with ordinary outbound connections.
Random-port fallback was rejected because the stable origin is part of browser
bookmarks, localStorage, LAN pairing, and installed-service arguments. **22776**
is unassigned in the IANA registry, below those ephemeral ranges, and spells
`CAPRO` on a phone keypad. It is a stable, loopback-only default, not a claim
that the number is reserved forever; an explicit `config.json` or `--port`
still wins.

Sources: [Vite preview options](https://vite.dev/config/preview-options),
[IANA service-name registry](https://www.iana.org/assignments/service-names-port-numbers/service-names-port-numbers.csv),
[Chromium restricted ports](https://chromium.googlesource.com/chromium/src/+/master/net/base/port_util.cc),
[Linux IP sysctl documentation](https://kernel.org/doc/html/v6.1/networking/ip-sysctl.html),
and [Microsoft's Windows dynamic-port guidance](https://learn.microsoft.com/en-us/troubleshoot/windows-server/networking/service-overview-and-network-port-requirements).

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

## ADR-019 — `caprock up` detaches by default; hook-install consent is a TTY prompt (or `--yes`); sessions end on `SessionEnd`, or after an hour of silence

**Date:** 2026-08-18 · **Status:** accepted, except for session lifetime — **that part is superseded by [ADR-028](#adr-028--a-session-ends-when-its-process-does)** · *repo-prep decision (made while building T1–T6; resolves OQ-08)*

> **The timeouts below are history.** A session no longer ends after an hour, or
> after any period of silence: it ends when its process does. The "Revisit if"
> at the foot of this entry asked for exactly the evidence that arrived —
> 44 sessions paused for more than an hour and then continued — so the sweep is
> now a backstop for sessions with no known pid, and `SessionEnd` no longer ends
> a session either, because it also fires on `/clear` and Escape. Read ADR-028
> for what replaced this.

`caprock up` re-executes itself as a detached background process logging to `<data_dir>/caprock.log` and returns once `runtime.json` appears; `--foreground` keeps it attached (dev, CI, service managers); `caprock down` asks the daemon to stop over `POST /v1/shutdown` with the per-run token (works identically on Windows, no signals). Hook install: when any of the registered events is missing and stdin is a TTY, `up` explains what it will write and asks `Install now? [Y/n]`; `--yes` answers for scripts; a non-TTY without `--yes` skips with a hint (transcript tailing still works). Session lifecycle: `active` → `idle` after 5 min → `ended` after 12 h without events, so the Now screen shows what is running today rather than every session ever ingested (superseded by the 2026-08-31 update below). The `caprock-hook` binary is copied from beside the `caprock` executable into the data dir; if absent, `<caprock> hook` (a hidden subcommand over the same `internal/shim` code) is registered instead, so a single-binary install still works.

**Update 2026-08-20:** `caprock up` also offers to register the **statusLine** (`caprock statusline`, which feeds Pro/Max plan-limit windows to the Cost screen) under the same consent contract — a TTY prompt, `--yes` for scripts, and a hint when skipped. It is written to the same `~/.claude/settings.json` (backed up once), never clobbers a statusLine the user already set to something else, and can be managed explicitly with `caprock statusline install|uninstall`. Without it the dashboard still works; only the plan-limit view needs it. Also: on a detached-start timeout `up` now surfaces the real cause from `caprock.log` (most often "port already in use → try `caprock status`/`caprock down`, or `--port`") instead of a bare "did not report ready" message.

**Update 2026-08-31 (session end is an event, and the sweep is only a backstop):** the shim now also registers **`SessionEnd`**, and it ends the session the moment the user leaves it. The 12-hour sweep was never a lifecycle signal — it was the *only* signal, because nothing consumed the one hook that says a session is over. The visible cost was that the Now screen counted a whole day's finished sessions as live (14 sessions, 0 active) and the live pulse drew a row per known session, so a day in one repository became six identical rows over six flat hairlines. With a real end event the sweep drops to **1 hour** and becomes what it should always have been: the case where the hook never fired — `kill -9`, a closed terminal, a dead host. Ending early is cheap because it is not a tombstone: the session upsert revives an ended session on its next event, which is the same rule that already stopped a daemon restart from burying a working agent.

**Rules out:** blocking prompts in non-interactive runs; a Unix-signal-only `down`; keeping every historical session in the active list; inferring the end of a session from silence alone when the agent reports it.

**Revisit if:** users want `up` to stay attached by default, or a service-manager integration (launchd/systemd) replaces the detach; or an hour of silence proves too short for a workflow that keeps a session open across a long break *and* loses its `SessionEnd` (the pair is what would make it wrong).

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

## ADR-021 — The team tier is self-hosted, and the free product is not carved up

**Decided 2026-08-25. Specified, not built.**

A team version aggregates what the single-machine product already computes:
cost per person and per repository across every machine, one live screen, loop
alerts anyone can see. Three decisions fix its shape.

**Self-hosted only.** The team runs the server on a box they control. Caprock's
whole premise is that a binary reading every transcript on a developer's disk
sends nothing anywhere; a hosted tier would mean shipping prompts, replies and
tool output to us, and no engineering leader signs that off for a cost
dashboard. The privacy promise is the product, not a feature of it.

**The free product stays whole.** Everything Apache-2.0 today remains so and
unchanged. What is paid is the cross-machine aggregation, which does not exist
and cannot be had by running the free binary harder — so nothing is removed
from anyone to manufacture a reason to pay.

**The reporter cannot leak prose.** It sends session identity, totals and the
activity phrase. Prompts, replies and tool output are absent from the payload
by construction rather than by configuration, so a misconfiguration cannot
send one.

Deliberately excluded from a first version: SSO, roles, budget enforcement that
stops someone else's session, a cross-machine task runner. Each is a real
request that is cheaper to add once asked for than to guess at now — and
killing a colleague's session from a dashboard is the kind of feature that gets
a tool banned rather than adopted.

Full shape and the open questions are in [17-teams.md](17-teams.md). Whether to
build it at all is still gated on demand.

## ADR-022 — The licence key is an offline string with an expiry, and nothing more

**Decided 2026-08-26.**

Paid features unlock when a key is present. The key is a plain string carrying
its own expiry, pasted into the dashboard's settings, checked locally. No
signature, no online validation, no machine binding.

**No online check, ever.** [Rule 4](../CLAUDE.md) is not a feature of this
product, it is the argument for it: `/teams/` says counters leave a machine and
content never does, and that sentence is what turns a security review into a
conversation. A licence call home would be the first mandatory outbound request
in a tool sold as local-first, and it would break in exactly the situations
where a paying customer is least forgiving — on a plane, behind a corporate
proxy, on an air-gapped machine.

**No cryptography either.** The binary is Apache-2.0. Anyone who wants the
features can delete the check and rebuild in five minutes; an Ed25519 signature
would raise that to fifteen. That is not defence, it is a week of work spent
producing the *feeling* of defence. The key is a convenience for people who
want to pay, not a lock against people who do not — and it is the same thing
Ubuntu Pro's `pro attach` is, minus the servers that make theirs enforceable.

**The real risk is the opposite one.** With zero paying customers, the failure
worth engineering against is not theft; it is someone paying and not receiving
the feature. Everything above optimises for that: a key that works offline
cannot fail to work.

**Seven days of grace after expiry.** Features keep running for a week with a
warning. A card that did not go through, a bank holding a renewal, a changed
address — none of those are the customer choosing to stop paying, and an angry
email from someone cut off by their bank's timing costs more than a week of
features given away.

**When to revisit.** If a key is published somewhere public and we see it, add
revocation. Not before, and not because someone might. That is an open question
in [12-risks.md](12-risks.md), not a promise of future work.

**A paid feature must be one that does not exist yet.** The free product is the
whole product for one person, and the moment a lock covers something that used
to work, the free tier becomes a hostage and every promise on the site reads as
a sales tactic. `ui/src/components/Paywall.test.tsx` enforces it by reading the
screens: a lock may only wrap a feature marked unbuilt, it may never wrap a
panel that reads live data, and every feature we charge for must be visible
somewhere so people can see what they would be buying.

It has already been decided against us twice. The cap's locked preview showed
today's real spend behind glass — a figure the same screen gives away for free
at the top, so a user would have seen their own number blurred and read it,
correctly, as something taken away. And third-party pricing was going to be
paid until the prices turned out to be cheaper to add than to gate: DeepSeek
and MiniMax now cost out for everyone, and the feature was removed from the
paid list rather than kept as a claim.

**Amended 2026-10-04: the tool drill-down is gated on the server.** The
drill-down's Premium half — output, failure rate and trend per group, and the
hints — is new: the per-tool totals stay free in Breakdown and Lifetime, and
nothing that used to be shown is now locked. Its gate goes further than
[ADR-023](#adr-023--gemini-runs-on-a-key-caprock-never-holds-read-from-the-environment)
drew it, which kept server checks for features that spend money or reach the
network. A drill draws a panel, but its paid half *is* the response: a gate
that only blurs the page hands every figure to anyone who opens the network
tab. So `GET /v1/tools/drill` removes those fields without an active licence
and sends one hint in full as the teaser, and the UI's blur is placeholder
glyphs over nothing. A feature whose paid part is a computation gets this
server gate; a feature whose paid part is a control, like the spend cap,
keeps the page gate.

**What this constrains.** Paid features must be things the local binary can
switch on. Anything that needs our infrastructure — cross-machine aggregation,
the weekly report's delivery — is enforced by that infrastructure and needs no
key at all, which is the tier boundary [ADR-021](#adr-021--the-team-tier-is-self-hosted-and-the-free-product-is-not-carved-up)
already draws.

---

## ADR-023 — Gemini runs on a key Caprock never holds, read from the environment

**Decided 2026-09-01.** *Second paid feature.*

A user can point Caprock at Google's Gemini through their own Google AI Studio
key. Caprock makes the call; the user pays Google directly. Two decisions shape
it, and both exist to keep the product's foundation intact.

**Caprock never stores the key.** It is read from `GEMINI_API_KEY` in the
daemon's environment, the way every CLI tool on the machine already does it —
never written to `config.json`, never accepted by `PUT /v1/settings`, never
returned by `GET /v1/settings`. This is the direct answer to the objection
recorded in [17-teams.md](17-teams.md) § Not a secret store: *"a bug in Caprock
shows a wrong number, and with a vault a bug in Caprock leaks credentials."*
A key held in the environment cannot leak from a database Caprock does not
write. It also rules out the alternative — an OS keychain across three
platforms — which is real work, a Windows CI surface, and still leaves Caprock
custodian of somebody's credential.

The cost is honest and worth naming: the user sets an environment variable
before starting the daemon, which is a worse first run than pasting a key into
a field. That is the price of not being a secret store, and it is the right
trade for a tool whose whole argument is that it holds nothing.

**Rule 4 gains its second exception, and it is opt-in per call.** [Rule
4](../CLAUDE.md) says all data stays on the machine, with the release check as
the only exception — an outbound call that carries nothing about the user. A
Gemini call carries both a credential and the user's own content, which is
categorically further than that exception reaches, so it is written down here
rather than assumed. What keeps it inside the spirit of the rule: nothing is
sent unless the user asks a question in that turn, no background call is ever
made, the destination is Google's documented endpoint and nowhere else, and
with the variable unset the feature does not exist — there is no default-on
path to disable. Caprock still sends nothing about the user to Caprock.

**The gate is checked on the server, unlike the spend cap.** [ADR-022](#adr-022--the-licence-key-is-an-offline-string-with-an-expiry-and-nothing-more)
made the licence a convenience rather than a lock, and the spend cap follows
that: its paywall is a React component, and a free user who sets the threshold
by curl gets a working cap. Copying that here would be wrong. The cap spends
nothing; a Gemini call spends the user's quota and opens an outbound
connection, so an unpaid caller is not merely reading a screen they did not pay
for. `license.Parse(...).Active` is therefore checked in the handler before the
request leaves, which is a new precedent in this codebase and deliberately
narrow: it applies to features that spend money or reach the network, not to
features that draw a panel.

**Usage is counted from the response, not from Google.** There is no per-key
billing API — Google's own answer is that per-key breakdowns "can't be done via
AI Studio usage dashboards", and the console reports per *project*. So the
figures come from `usageMetadata` on each response (`promptTokenCount`,
`candidatesTokenCount`, `cachedContentTokenCount`, `thoughtsTokenCount`),
priced through the same `pricing/` table as everything else and stamped with
the same basis. Two consequences are stated on screen rather than hidden: the
history starts when the feature is first used, because nothing before that
passed through Caprock, and the total is what Caprock sent, not what Google
billed.

**Rules out:** storing the key in `config.json` or any Caprock-managed store;
an OS keychain; reading Google's usage dashboard; any background or speculative
call; presenting a Caprock-side total as the user's Google bill.

**Revisit if** Google ships a per-key usage API (then the numbers can be
reconciled rather than only counted), or if setting an environment variable
proves to be the thing that stops people using the feature — in which case the
question is a better handoff, not a key Caprock keeps.

---

## ADR-024 — The weekly report holds a bot token, and only reports what a baseline supports

**Decided 2026-09-01.** *Third paid feature; amends the scope of [ADR-023](#adr-023--gemini-runs-on-a-key-caprock-never-holds-read-from-the-environment).*

A weekly message saying what moved, sent to the user's own Telegram bot. Three
decisions, and the first one walks back a line drawn yesterday.

**The bot token is stored, and the Gemini key still is not.** ADR-023 said
Caprock never holds a credential, and that remains true of the thing it was
written about. A Google AI Studio key and a Telegram bot token are not the same
object: the key is attached to a billing account and can spend real money, while
the token drives a bot the user created for this one purpose, which can send
messages to the chats it was invited to and nothing else. Leaking the first
costs money; leaking the second costs a stranger the ability to message you.
That difference is large enough to price differently.

The deciding argument is what the alternative does to the feature. Putting the
token in the environment means: talk to BotFather, find the chat id, edit a
launchd plist or a systemd unit, reinstall the service, restart the daemon — on
Windows, worse. The premium page promises "about two minutes", and a setup that
long would not be dishonest so much as unused. A feature nobody finishes setting
up is not a feature.

It is stored the way the licence key already is: `config.json`, mode `0600`,
inside a `0700` data dir (amended 2026-10-14, below: no longer). It never appears in an error either: a network
failure's text carries the request URL, which carries the token, and that text
was logged and shown on the Settings screen until 2026-10-01 —
`weekly.Sender.Send` now reports the cause without the URL. It is **write-only over HTTP** — accepted by
`PUT /v1/settings`, never returned by `GET /v1/settings`, which is a new pattern
in this codebase and exists because the settings response is read by the
dashboard on every render and by `caprock report`. What comes back instead is
whether a token is set, which is all any screen needs to know.

**A finding needs a baseline and a floor, or it is not reported.** The premium
page says "the repository that cost 3× its usual week". Two weeks compared give
a ratio, not a finding: a repository that cost $2 and then $6 is 3× and means
nothing. "Usual" is therefore the median of the preceding four weeks, not last
week, and no movement is reported at all unless the change also clears an
absolute floor — a few dollars, not a few cents. Below that the message says the
week was ordinary, which is a true and useful thing to say.

This follows what `assembleWork` already does in `caprock report`: withhold a
breakdown whose linkage is too weak rather than publish a confident wrong
ranking. A weekly message is worse than the dashboard for this, because the
reader cannot click into it to check.

**It is the first background outbound call, and that is the part to be careful
with.** ADR-023 ruled out "any background or speculative call" for Gemini, and
that stands for Gemini: it spends the user's money per call. This spends
nothing, goes only to Telegram's documented API, and carries figures the user
already sees on their own screen — no prompts, no replies, no tool output, no
file paths, on the same rule as the Gemini context. It sends only when the user
has configured a bot, which is the opt-in; with no token there is no timer and
nothing to disable.

**Scheduling is a comparison, not a countdown.** A laptop is closed at
weekends, so a ticker anchored to Monday 09:00 fires for nobody. The daemon
instead checks hourly whether the ISO week of the last sent report is behind the
current one, and sends on the first tick after the send time — which means a
machine opened on Wednesday gets Monday's report on Wednesday, labelled with the
week it covers. The marker lives in the `meta` table beside the tool-link
cursor, because an in-memory marker sends a second copy after every restart:
that is exactly the bug `cap.Guard.firedOn` has, tolerable for a cap and not for
a message.

**Rules out:** a token in the environment; a report that names a mover without a
baseline behind it; a fixed weekly timer; an in-memory sent-marker; sending
anything the dashboard does not already show the user.

**Revisit if** a user asks for a second channel (a webhook is the same shape with
a different URL), or if the token turns out to be worth more than this decision
assumes — a bot added to a company Slack-style group chat is a wider blast radius
than a personal one, and that would be the signal to move it out of the file.

---

**Amended 2026-10-14: the token, and the DeepSeek key, live in the secret
store, not `config.json`.** The owner asked how a user is reassured the
DeepSeek key (ADR-048 amendment, 2026-10-13) is safe, and the honest answer
was that it sat in plain text in `config.json` — the file Time Machine copies,
support bundles carry and dotfile syncs publish — while the GitHub token
(ADR-039) and Mail passwords already lived in the keychain. The precedent
had moved; this decision had not.

- **One store, `internal/secret`,** factored out of `internal/github`
  unchanged: the macOS login keychain through `/usr/bin/security` with the
  value as an argument and the keychain file named explicitly (no dialog,
  ever), else a `0600` file in the data directory, and the store says which.
  The GitHub token keeps its service, account, label, file and notes.
- **Moved once, at start.** A value in `config.json` goes to the store and
  out of the file in one atomic write. A store that refuses leaves it where
  it was and still used: a start must never lose a key.
- **Write-only stays.** `GET /v1/settings` still never returns either; it
  says whether one is set, a hint, and now where it is kept.
- **The DeepSeek key is read at spawn,** so one deleted in Keychain Access is
  gone for the next session too.
- **Settings shows it** in one secure field (lock, masked monospace, an eye
  only while typing, a locked pill once saved) with an (i) that says where it
  is, what it is sent to, how backups treat it, and how to revoke it.

**Mail's passwords, on macOS only, moved after** (2026-10-14): one item
per account in the login keychain through this store's `security` call,
which names the keychain file, with Mail's `0600` file
(`mail-secrets.json`) behind it. The items keep `go-keyring`'s service
(`dev.caprock.mail`) and account (`account-<id>`), and a value `go-keyring`
wrote base64-encoded is decoded, so a password saved by an earlier build is
found where it is. On Windows and Linux they stay on `go-keyring` (Credential
Manager, Secret Service), so nothing there changes place. The store is built
on the first password read or write: an unused Mail runs no process. The
Gemini key (ADR-025) is unchanged here.

## ADR-025 — Keys go in the interface, stored write-only, because a key nobody can enter is a feature nobody uses

**Decided 2026-09-01.** *Supersedes the storage half of [ADR-023](#adr-023--gemini-runs-on-a-key-caprock-never-holds-read-from-the-environment).*

ADR-023 kept the Gemini key out of Caprock entirely: read from `GEMINI_API_KEY`
at the moment of the call, never stored. The reasoning was sound and the outcome
was not.

**What the environment actually costs.** The owner's own machine runs the daemon
as a login agent, and a login agent inherits nothing from a shell profile — so
`export GEMINI_API_KEY=…` does nothing at all for him, and the honest
instruction is "edit this XML, then reinstall the service." Anyone who ran
`caprock service install`, which the product recommends, is in the same
position. A setup step that hard turns a paid feature into one nobody finishes
switching on, and an unused feature protects no credential: it just fails to
exist.

**What changes, and what does not.** Keys are entered in the dashboard and
stored in `config.json`, mode `0600` inside a `0700` data dir — the same posture
as `~/.claude` and `~/.aws`, which hold exactly this class of secret on the same
disk. The environment variable keeps working and takes precedence, so a machine
already set up that way is untouched and a CI runner can still inject one
without writing a file.

Every stored key is **write-only over HTTP**: accepted by `PUT /v1/settings`,
never returned by `GET`, which reports only whether one is set. That is the
pattern [ADR-024](#adr-024--the-weekly-report-holds-a-bot-token-and-only-reports-what-a-baseline-supports)
introduced for the Telegram token, and the two decisions are now one rule rather
than two positions on the same question — which is the second reason to make this
change. Holding a bot token and refusing an API key was a distinction the code
could state but nobody could feel.

**The objection in [17-teams.md](17-teams.md) still stands, and this is not a
vault.** That passage warns against becoming a secret store — competing with
1Password, putting every buyer's security review in front of a two-person
product. Storing the credentials for the features Caprock itself calls is a
different thing from offering to keep the user's secrets in general. The line
this holds is: Caprock stores a key **only** when Caprock is the one making the
call, and never as a service to the user.

**What it buys, beyond setup.** A key entered in the interface is a key Caprock
can account for. The product's whole subject is where the money went, and "which
key spent what" is the same question one layer out — which is not possible at
all for a value it can only read and never name.

**Rules out:** returning any stored key over HTTP; storing a credential for
something Caprock does not itself call; an OS keychain (three platforms of work
for a file-permission difference on one of them); removing the environment
variable as an option.

**Revisit if** a user asks Caprock to hold a key it does not use — that is the
line, and the answer is no.

## ADR-026 — Gemini CLI is a session Caprock starts, not a chat panel it owns

**Date:** 2026-09-02 · **Status:** accepted

> **The key is stored now.** Reading it only from the environment made a
> feature nobody could reach; [ADR-025](#adr-025--keys-go-in-the-interface-stored-write-only-because-a-key-nobody-can-enter-is-a-feature-nobody-uses)
> reverses the storage decision below. Everything else here still holds.

[ADR-023](#adr-023--gemini-runs-on-a-key-caprock-never-holds-read-from-the-environment)
put a Gemini key to work answering questions *about* Caprock's own data — a
panel on the Cost screen that composes a prompt from today's spend and returns
prose. That is a real feature and it stays. It is not what somebody who has a
Gemini key wants it for. They want to work with the model: ask it things, have
it write code, start a session. The panel answers questions about the tool
instead of doing the job, and the gap only became visible when a user with a key
went looking for where to start a session with it and found a chat box about his
own bill.

**The decision.** Gemini CLI is a third agent in the New Session dialog,
alongside Claude Code, and everything downstream of the spawn is unchanged: same
PTY, same terminal, same directory picker, same row in the sessions list, same
cost stream. Caprock passes `GEMINI_API_KEY` into the child's environment when
the ambient environment does not already set one, so the key entered once under
[ADR-025](#adr-025--keys-go-in-the-interface-stored-write-only-because-a-key-nobody-can-enter-is-a-feature-nobody-uses)
works in every shell without being exported into any of them.

**The flags are not the same, so the picker is not cosmetic.** Claude Code takes
`--model` and `--permission-mode`; Gemini CLI takes `-m` and `--approval-mode`,
whose four values (`default`, `auto_edit`, `yolo`, `plan`) cover the same ground
as Claude's six. Two of Claude's — `manual` and `dontAsk` — have no counterpart
that is not a guess, and are left off so Gemini falls back to asking. Both
accept `--session-id`, so Caprock's id is passed to either and the row in the
sessions list names the same session the agent thinks it is in. The picker
appears only when a `gemini` binary is on the daemon's PATH — a choice that
fails on click is worse than no choice.

**Gemini must be told the directory is trusted, or it does not start.** It
refuses to run in an untrusted folder and waits for confirmation, which inside a
PTY nobody is watching is an invisible hang rather than an error — the same trap
Claude Code's folder-trust dialog sets, which Caprock already pre-accepts.
Caprock passes `--skip-trust`, and the thing that makes that sound rather than
reckless is that Caprock only ever launches a directory the user chose in the
dialog: the click *is* the consent the prompt is asking for.

**This section is a correction.** Its first version claimed Gemini had neither
`--session-id` nor permission modes, and shipped a model list with two ids that
do not exist. All four claims were written from memory rather than from
`gemini --help`, and none survived ten minutes with the real binary installed.
The models offered are now checked against both the CLI and `pricing.json`, so a
session cannot open a terminal and then die on a model name Caprock invented.

**Rule 7 is not bent by this.** "We never signal or type into a process we did
not start" is about processes Caprock finds; this is a process Caprock starts,
on an explicit click, and it is subject to every rule that already governs a
spawned session — the daily cap pauses it, graceful shutdown waits for it,
`caprock down` does not orphan it.

**The key never travels through the browser.** `GeminiKey` on the spawn request
is `json:"-"`: it cannot be supplied by a client and is filled server-side from
config. A dashboard that could hand a key to a process it spawns is a dashboard
where a page can exfiltrate one.

**Rules out:** a Gemini chat panel *replacing* the terminal; asking the user to
re-enter the key per session; passing a key when the environment already has
one (an exported variable stays the source of truth); shipping the picker on
machines without the CLI.

**Revisit if** a third coding CLI arrives — two special cases in one switch is
fine, four is a table.

## ADR-027 — Gemini is observed through the telemetry it already writes

**Date:** 2026-09-02 · **Status:** accepted

[ADR-026](#adr-026--gemini-cli-is-a-session-caprock-starts-not-a-chat-panel-it-owns)
made Gemini a session Caprock starts. It said nothing about seeing what that
session does, and the answer for two releases was: nothing. A live Gemini
session sat in the list with zero turns, zero tokens and no cost, under a line
admitting Caprock could not measure it. Starting an agent you cannot see is
half a feature in a product whose whole subject is where the money went.

**Claude Code has two sources and Gemini has neither.** Hooks call a shim on
every event; the transcript is a JSONL file with `usage` on every reply. Gemini
CLI has no hook Caprock can install and writes no transcript in a format
anything else reads. What it does have is OpenTelemetry, and
`GEMINI_TELEMETRY_OUTFILE` makes it write that to a file we name — which is
the same shape as the transcript: something the agent writes for its own
reasons that Caprock is allowed to read.

**The decision.** A spawned Gemini session gets four variables in its
environment: telemetry on, target local, outfile inside Caprock's data
directory, prompts off. The file is per-session and named by Caprock's session
id, so the ingester needs no correlation step — the file name *is* the join
key. A tailer reads each file from a remembered offset every three seconds and
records `user_prompt`, `api_response` and `tool_call` as `turn.user`,
`turn.assistant` and `tool.post`.

**Why the file rather than the terminal.** The bytes flowing through the PTY
are a picture of a terminal, and a TUI redraws its whole box constantly. A
parser over that would be guessing at token counts from rendered text and would
break on Gemini's next release. The telemetry is structured, versioned by
Google, and carries exactly the fields Caprock already stores.

**The file lives in Caprock's data directory, not the project.** A telemetry
file appearing inside somebody's repository is a file they have to gitignore,
and one they might commit.

**Prompts are turned off, and that was verified rather than assumed.**
`GEMINI_TELEMETRY_LOG_PROMPTS=false` leaves `prompt_length` and drops the
prompt text. Checked on a live session, because the flag existing in the bundle
would not have proved it worked — the same class of assumption that made
[ADR-026](#adr-026--gemini-cli-is-a-session-caprock-starts-not-a-chat-panel-it-owns)
wrong twice.

> **Amended 2026-10-01: prompts are on.** Off was a caution from before Memory
> existed, and no reason beyond it was recorded. Once Memory kept the prompts
> and replies of Claude Code, Codex, OpenCode and DeepSeek Harness, Gemini was
> the one agent whose question could not be found. The telemetry file sits in
> the same `0700` data directory as their transcripts. Spawned sessions now set
> `GEMINI_TELEMETRY_LOG_PROMPTS=true`; on a live Gemini CLI 0.58.0 session the
> `gemini_cli.user_prompt` record then carries `prompt`, which lands in
> `turn.user` `payload.prompt` and is searched like every other agent's. What
> Gemini *replied* was not verified — that session's key was rejected by the
> API — so Gemini replies are not read yet.

**Cache writes stay zero.** Gemini reports what it read from cache and has no
counterpart to Claude's cache-write figure. The column means "we do not know",
and inventing a number for it would break rule 6 on the screen whose entire
promise is that its figures are measured.

**Rules out:** parsing the terminal; an OTLP collector (a second process to
install, for a file read); reading Gemini's own session files (undocumented,
and the telemetry answers the question); writing telemetry into the user's
project.

**Revisit if** Gemini ships hooks Caprock can install, which would make this
the fallback rather than the mechanism.

## ADR-028 — A session ends when its process does

**Date:** 2026-09-02 · **Status:** accepted

Caprock decided a session was over because it had been silent for a while, and
every number chosen for "a while" was wrong for somebody. Twelve hours left the
day's work marked live at midnight. One hour closed a session while its owner
was at lunch — an hour *is* lunch, and the comment justifying it said the
opposite. Eight hours was the same guess with a safer margin and would have
failed anyone leaving a session over a weekend.

**Every one of those was a guess about a person's day standing in for a fact
about a process**, and the fact was available the whole time. Caprock records
the pid of every session it spawns, and for a session started in a terminal the
shim knows its own parent — the Claude Code that ran it — and now reports it as
`X-Caprock-Ppid`.

**The decision.** The sweep asks whether the session's process is alive. A
session with a live pid stays open however long it has been quiet; one whose
process is gone ends on the next sweep with no threshold involved. Measured on
a real database before changing anything: 44 sessions had paused for over an
hour and then carried on, 86 of those pauses between one and three hours. The
interruption this used to punish is the normal shape of a working day.

**A header, not a body field.** The hook body belongs to Claude Code and the
shim forwards it verbatim; the shim's first rule is to never be the reason a
session breaks, and adding a field to somebody else's payload is a way to break
one.

**Two exceptions.** Agents Caprock only observes — OpenCode today — are judged
by the clock alone: their rows come out of another tool's database, arrive
months old, and have no process of ours behind them. The first cut of this
missed that and filled the Now screen with 97-day-old sessions marked live.
And sessions with no pid at all keep a 24-hour staleness sweep, because there
is nothing to verify.

**Amended 2026-10-14: the disk is a fact too.** A test script wrote nine
synthetic transcripts under `~/.claude/projects` and deleted them; the nine
pid-less sessions read from them sat in the sidebar as working and would have
stayed a day. A session with no pid whose transcript (one actually read) or
directory no longer exists now ends on the next sweep. Observed agents stay on
the clock alone.

**Separately, the Now screen filters by recency.** Status cannot tell a quiet
session from imported history, so anything silent for two days is not shown
there whatever its status — two days rather than one so a Friday evening
session survives to Monday morning. Anything *working* shows regardless of age.

**Windows needs its own check.** `Signal(0)` errors for every pid there,
including live ones, so the unix probe would have declared every session dead —
the exact failure this exists to prevent. `OpenProcess` plus
`GetExitCodeProcess` instead.

**Known unsoundness, accepted:** pid reuse. Detecting it means comparing
process start times across three platforms, for a case requiring a wrap of the
pid space between two sweeps. Its cost is a stale row; the cost of not doing
this at all was a session vanishing while somebody worked in it.

**A blind spot found later: two sessions can share one live process.** `/clear`
does not end a session and does not reuse its id — Claude Code keeps the
process and starts a **new** session id inside it. The old row's process is
therefore not merely alive, it is the very process now serving its replacement,
so this sweep could never retire it: one editor showed on the dashboard as two
working sessions, the stale one frozen at the moment it was cleared with its
whole cost and a 95%-full context still presented as current.

The rule holds — a process that runs one conversation at a time makes a sibling
on the same pid finished by definition — but liveness alone cannot see it,
because the signal is shared. The replacement is recorded explicitly instead,
keyed off the `SessionStart` whose source is `clear` (the only one of the two
hooks that names the session meant to survive; the `SessionEnd` beside it
carries the id being replaced). See
[03-contracts.md § Hook shim](03-contracts.md#hook-shim).

Deliberately **not** extended to closing such sessions in bulk after the fact.
Retiring a session whose process is running is the failure this ADR exists to
prevent, and one left over from before the fix ages to `idle` on its own and
closes when its process exits.

**Rules out:** any silence threshold as the primary rule; killing a session
because the daemon restarted.

**Revisit if** pid reuse is ever observed in practice, which would make start
times worth the three platforms of code.

---

## ADR-029 — A second device gets in over the LAN, with a code, or not at all

**Date:** 2026-09-03 · **Status:** accepted

Reaching Caprock from a tablet needs the daemon to answer something other than
loopback, and that is a real reduction in safety rather than a feature with a
caveat. Bound to loopback, being on the machine *was* the authorisation. Bound
to the network, every device on it can open the socket — the guest on the home
wifi, the stranger in the coworking space — so the premise has to be replaced
rather than stretched.

The replacement is one rule: **a request that did not come from this machine
must carry a device token.** Loopback is unaffected, so nothing about the local
experience changes and no existing client needs anything. From the network,
three paths are open before a token exists and no others: `POST /v1/pair`, the
dashboard's own files (they carry no figures), and nothing else — every other
`/v1` path is closed by default, so a route added next year is private until
someone decides otherwise.

**Three decisions inside it are worth stating, because each had an easier
wrong answer.**

- **Not a stored setting.** Storing it would mean a laptop opened in a
  coworking space carries a decision made at home on a trusted network. The
  *devices* persist — walking to the tablet again after every restart would be
  its own punishment — but the open door does not.

  It is switchable at runtime (`POST /v1/pair/lan`, loopback-only) as well as
  by `--lan` at startup. Requiring a restart made the feature reachable only
  from a terminal on the machine, and the person who wants it is usually
  holding the tablet. The rule that matters is "off unless switched on, and off
  again next start", not "only settable before the process exists".
- **One named address, never `0.0.0.0`.** The wildcard accepts on every
  interface the machine has now or acquires later: a VPN coming up, a container
  bridge, a tethered phone. None of those is what anyone agreed to. One
  address is a promise that can be shown on screen and checked, and it is the
  address the pairing panel displays.
- **The DNS-rebinding defence is widened by exactly one host.** `checkOrigin`
  refuses a browser request whose `Host` is not loopback, which is what stops a
  name an attacker controls from resolving to an address we answer on.
  Admitting the whole private range would leave that door open for every
  address in it; admitting the single address the user chose costs exactly the
  feature and nothing around it.

The pairing store itself (`internal/pairing`) was built and tested a fortnight
earlier and is unchanged: six-digit single-use codes, five-minute expiry,
burned after five wrong guesses, constant-time comparison, a full-length token
that does not expire, and per-device revocation that takes effect on the next
request.

**The token travels as a header, and as a WebSocket subprotocol.** A cookie
would ride along on requests the user did not make, which is what makes CSRF
possible, and this API starts sessions and runs commands. A browser's
`WebSocket` constructor cannot set headers, so `/v1/live` takes the token as
`caprock.device.<token>` and echoes it back — not as a query parameter, which
would write it into every access log and browser history entry on the device.

**A token makes a device a reader, not the owner** (added 2026-10-01). As
shipped, the token was the whole check: past the gate a paired phone could
start a command (`POST /v1/agents`), type into a session, kill it, change
settings, approve a task or start the orchestrator — the "second control room"
this ADR rules out, built by omission. The gate now holds an allowlist of
method and route that a paired device may use, all of them reads, and answers
anything else with 403; a route added later is closed to it until someone names
it. Read-only rather than "reads plus pause and kill": nothing in this ADR, the
contracts, the README or the changelog ever gave a paired device a control, and
a kill from a tablet is still a kill. The terminal socket is excluded although
it is a `GET`, because every frame it receives is typed into the session.

*Amended 2026-10-04 by [ADR-034](#adr-034--a-phone-the-owner-chooses-can-work-on-sessions-and-nothing-else):*
reading stays the default, and the owner can make one paired device a
controller, on the machine, revocably. *ADR-034 amended 2026-10-14:* the
owner may make that choice when showing the code, and the dashboard's box
for it starts ticked; a code issued without a role still pairs a reader.

*Amended 2026-10-05 by [ADR-011](#adr-011--one-server-one-port-default-22776-per-run-bearer-token-loopback-only):*
"loopback is unaffected" means this machine's own clients; a request a proxy
or tunnel relays onto loopback is a device here, token and role included.

*Amended 2026-10-14 by [ADR-060](#adr-060--phone-access-may-stay-on-across-restarts-when-the-owner-ticks-it):*
"not a stored setting" holds by default; the owner can tick *Keep on after
Caprock restarts*, and turning access off clears it.

*Amended 2026-10-14 by [ADR-058](#adr-058--a-phone-reaches-the-machine-from-anywhere-through-a-relay-that-carries-only-ciphertext)
(the one way in):* the dashboard no longer offers this listener; it is
started from a terminal (`caprock up --lan`, `caprock pair`) for a machine
without internet, and Settings shows it, to turn off, only while it is on.
The gate, the codes and the roles here are unchanged.

**Rules out:** a relay of ours (sessions would pass through a machine we run,
which contradicts rule 4 and three sentences on the site) — *superseded
2026-10-13 by [ADR-058](#adr-058--a-phone-reaches-the-machine-from-anywhere-through-a-relay-that-carries-only-ciphertext):
a relay that carries only end-to-end ciphertext, off by default*; binding the wildcard
address; a stored "LAN on" setting; pairing from a device that is already
paired — a tablet is somewhere to read figures, not a second control room, so
issuing codes and revoking devices stay loopback-only.

**Revisit if** somebody needs this from outside their own network. That is a
different decision with different costs (see FB-019), and the honest answer
today is Tailscale, which people already install for Claude Code.

---

## ADR-030 — A session opening known ground is handed what was left there

**Date:** 2026-09-03 · **Status:** accepted

Caprock's first settled user, asked why free tools were unusable, did not say
"no stats" — he said they **lose context**. We had built the stats. The gap
between his complaint and our headline is where this comes from.

**Measured before building, on the owner's own database.** 120 of 151 sessions
(79%) open in a repository that already had sessions; 36 of those resume after
more than a day. Claude Code keeps only the user's own prompts across projects
(19k entries, 4.1 MB) and prunes transcripts after 30 days; Caprock holds what
the *agent* said — 48k turns, 28.4 MB, since May, across 31 repositories.

**Recency beats retrieval, and that was a surprise.** The first design searched
prior prose by the terms of the opening prompt. It helped in 4 of 15 resumed
sessions and missed the clearest case there is — *"remind me what we were looking
into last time"* (asked in Russian), 384 candidate passages, no term overlap, because an opening question
shares no words with its own answer. Taking the **last substantial passage**
instead answers 12 of 19. The cheap thing works better than the clever one, so
the clever one is not built.

**The channel already existed.** The shim has returned a reply into a live
session since Phase 2 — that is how the orchestrator's Stop decision reaches
the agent. `SessionStart` uses the same path with a different payload, in the
shape Claude Code documents and we verified against a live session before
writing any of it:

```json
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}
```

Verifying first mattered: the payload field is `source`, not the
`startup_reason` the documentation also names, and guessing it would have
produced a feature that silently did nothing.

**Rule 7 is untouched.** We do not type into a process we did not start; we
answer a question the session asked of its own hook.

**Four bounds, each for a reason:**

- **Only `source == "startup"`.** SessionStart also fires on resume, `/clear`
  and after compaction. A resume already holds the conversation, and
  re-injecting the same passage after every compaction turns a note into noise
  that grows with the session.
- **1,200 runes.** Claude Code documents no limit and there are reports of an
  oversized reply being dropped silently, so this stays well short of any
  plausible cap — and costs a returning session a couple of hundred tokens
  rather than a page of its window.
- **400 runes minimum.** "Done." is true and says nothing about where the work
  stood.
- **Fourteen days.** Beyond that the last thing said is usually not what you
  are returning to, and presenting it as context misleads.

The text says where it came from — *"the user has not said this to you, and it
may be stale"* — because an agent handed an unattributed paragraph treats it as
an instruction.

**Rules out:** searching by prompt terms (measured worse); injecting on resume
or after compaction; anything that types into a session.

**Revisit if** the handoff is switched off in practice, which is the honest
signal — or if a distilled summary measurably beats the last passage, which
requires the same kind of measurement rather than an argument.

## ADR-031 — Codex and OpenCode are started like Claude Code, and linked to what they write

**Date:** 2026-10-04 · **Status:** accepted (owner approved 2026-10-04)

[ADR-026](#adr-026--gemini-cli-is-a-session-caprock-starts-not-a-chat-panel-it-owns)
put Gemini CLI in the New session dialog and said to revisit when a third CLI
arrived: "two special cases in one switch is fine, four is a table". Codex and
OpenCode are the third and fourth. Both are observed already; a user who works
in them had to leave Caprock to start one.

**The decision.** Both are agents in the dialog, started as their own TUI in a
PTY with everything downstream unchanged — terminal tab, pause and kill, the
daily cap, graceful shutdown. The dialog offers only agents whose binary is
found and remembers the viewer's last choice. The argv is a table of one
builder per agent, each written from that CLI's own `--help` and exercised
before it shipped; the flags and the versions they were read from live in
[19-codex.md](19-codex.md) and [16-opencode.md](16-opencode.md). A permission
mode an agent has no honest counterpart for is left to the agent's own config
and the dialog says so.

**Neither CLI can be told an id, so the session has to be linked.** Codex names
its thread itself; OpenCode creates its session on the first message. Without a
link one session is two rows. `internal/sessionlink` makes it:

- **OpenCode exactly.** The TUI runs a server on a port Caprock chose; its
  `session.created` frame names the session it made.
- **Codex by a heuristic, said to be one.** Same folder, written by the TUI,
  thread started within two minutes of the spawn. Codex stamps a thread at TUI
  start, measured, which is what makes the window tight. The failure modes are
  in [19-codex.md](19-codex.md).

The link is stored on the session (`native_id`, migration 0032) and the
importers file the agent's events under Caprock's id. Rejected: keeping two
rows and joining them on screen (every total and list would have to know about
the pair), and renaming the Caprock row to the agent's id once known (the
terminal's URL and websocket are keyed on the first id).

**Continuing is resuming, never forking.** `codex resume <id>` and `opencode
--session <id>` take the agent's own id. Both CLIs' forks copy history with its
cost, which Caprock would count twice, so a session that is still running is
offered nothing until it ends.

**Rule 7 is not bent.** Every process typed into is one Caprock started on an
explicit click. Reading the event stream of the OpenCode server Caprock started
is reading, on a port it chose. Nothing is written into either tool's config:
Codex's folder trust is a per-run `-c` override, OpenCode's ask-before-commands
an environment variable for the child.

**Rules out:** a model list written into Caprock for Codex (it reads Codex's own
catalog); Claude Code's `~/.claude.json` trust grant for agents that are not
Claude Code; claiming "bypass" for OpenCode, whose overrides cannot remove its
own asks.

**Revisit if** Codex gains a way to name a new thread, which would make its
link exact, or OpenCode a way to pre-create a session.

## ADR-032 — Continue in another agent is a new session with a brief, said to be one

**Date:** 2026-10-04 · **Status:** accepted (owner approved 2026-10-04)

A session's work sometimes has to move: to another agent (Codex is free this
week, Claude Code is out of quota), or to a fresh session when continuing the
old one cannot work (its transcript is gone, its agent is not one Caprock
resumes). No agent can load another's conversation, and none of them can be
handed one.

**The decision.** "Continue in… ▾" on the session page starts a **new** session
in the chosen agent, in the same folder, whose first message is a brief Caprock
writes locally (`internal/relay`): the last substantial passage the agent wrote
(recency beats retrieval — the SessionStart handoff's measured finding, and its
clip, reused), the working tree as it is now, and the PRs the session opened.
The brief is shown in full and editable before anything is sent; the user's
click sends it. The dialog's first sentence says it is a new session with a
summary, not the same conversation. The two sessions name each other
(`sessions.relay_from`, migration 0036).

**The brief goes on the command line, not into the terminal.** All four CLIs
take a first message as an argument (read from their `--help` on 2026-10-04:
claude `[prompt]`, codex `[PROMPT]`, opencode `--prompt`, gemini
`--prompt-interactive`). Typing it into a TUI that may not have drawn its
input yet would be a race, and a brief of many lines through a terminal
depends on each TUI's newline handling. Rule 7 holds either way: the process is
one Caprock starts for this purpose.

**What it does not claim.** No PRs are listed for agents that do not record
them; command text is not mined for URLs. The git section is the folder now,
not what the old session saw. Through a Windows batch shim the brief arrives
as one line.

**Rejected:** injecting the brief as hidden context (the SessionStart route) —
it works only for Claude Code and hides from the user what the new agent was
told; and a model-written summary, which would spend money and tokens before
the user has agreed to anything.

**Revisit if** an agent gains a way to import another's history, which would
make a real continuation possible.
---

## ADR-033 — An owned session outlives the daemon: its terminal lives in a pty-host

**Date:** 2026-10-04 · **Status:** accepted

A session Caprock started died whenever Caprock stopped. The daemon held the PTY
master, so an upgrade — `brew upgrade`, then `launchctl kickstart -k` — ended
it: the owner's `claude` exited with 143, SIGTERM from the daemon's own
shutdown, which sent it on purpose so Claude Code could flush its transcript.
That was the gentlest available way to lose the session, and it was still
losing it. He expected to come back after a restart, find the session running,
and type into it. A tool that watches your work must not be the thing that ends
it, least of all when the user did nothing but update it.

**The decision.** Each owned session runs under its own small process,
`caprock pty-host` (same binary, hidden subcommand). The holder starts the
agent, owns the PTY master and a 256 KiB scrollback ring with terminal-mode
tracking (`internal/termbuf`, shared with the daemon), and serves one client —
the daemon — over a loopback TCP socket guarded by a per-session random token.
It is started detached from the daemon: its own session on POSIX (`setsid`),
its own process group and hidden console on Windows, outside the daemon's job
object when the job allows it. Its registry entry,
`<data_dir>/ptyhost/<session>.json` (`0600`), says where it listens and the
token it wants. The daemon is a client: on shutdown it closes the connection
and the holder carries on; at startup it reads the registry, reconnects, and
the holder's snapshot repaints the terminal. The contract is in
[03-contracts.md § Terminal holders](03-contracts.md#terminal-holders-caprock-pty-host).

**Every agent Caprock starts, not only Claude Code.** Codex, OpenCode and
Gemini sessions are spawned through the same path
([ADR-031](#adr-031--codex-and-opencode-are-started-like-claude-code-and-linked-to-what-they-write)),
so they get a holder too. What the daemon tracks about them beyond the process
— which agent it is, and the port an OpenCode TUI's own server listens on —
travels in the registry entry's `meta`, and on reattach the daemon resumes what
a spawn had set up: it follows an OpenCode session's stream again (learning its
id first if the last run had not), expects a not-yet-linked Codex thread again,
and tracks a Gemini session's telemetry again.

**Why a holder of our own and not tmux.** tmux would do the holding on macOS
and Linux, where it is often installed, and not at all on Windows, where rule 2
says a feature is not done. It would also be a second path with its own failure
modes — the user's `.tmux.conf`, their key bindings, a server shared with their
own sessions — to keep working beside the PTY path we already have and test on
three systems. The holder is the existing `ptyman` backend moved one process
over: go-pty on POSIX, ConPTY on Windows, the same code the session ran on
before. No external dependency, nothing to install, one behaviour everywhere.

**Why loopback TCP and not a Unix socket or a named pipe.** It is the one
transport that is the same code on all three systems. Any local account can
connect to a loopback port, so the token is what keeps them out: 32 random
bytes, compared in constant time, sent in the first frame; the holder refuses
anything else within five seconds. The token travels to the holder on its
stdin, never in argv (which every local process can read) and never in a file
other than the `0600` registry entry in the `0700` data directory.

**Upgrades.** A holder started by one release must keep working with the daemon
of the next, so the protocol is versioned (`proto`, in the hello and the
registry entry) and additive: frame types are never renumbered or repurposed,
an unknown frame is ignored, and a change that cannot be additive raises
`proto`, after which the daemon keeps speaking every older version while a
holder of it can still be running. Old holders run their child until it exits
whatever release the daemon is. On Windows the holder runs from a hash-named
copy of the binary in the data directory: Windows will not replace an
executable a process runs from, and a long session would otherwise make the
next `scoop update` refuse.

**What the service managers do, and what we changed.** launchd, when a job
stops, kills what is left in the job's **process group** unless
`AbandonProcessGroup` is set; the holder has left that group by `setsid`, and
the plist now sets the key as well, as a second lock. systemd's default
`KillMode=control-group` kills everything in the unit's **cgroup**, whatever its
process group, so the unit now sets `KillMode=process`. Both are template
changes: an existing install keeps its old file until `caprock service install`
rewrites it (`caprock service status` already reports the difference). On
macOS the `setsid` alone keeps sessions alive meanwhile; on Linux an old unit
still takes them on a service restart. Windows' Startup-folder script starts the
daemon with `start /b` and no job object, so nothing reaches the holder there.
The launchd behaviour is from its documented semantics and was not exercised
against a real `launchctl` in this change — the rule for this work was not to
touch the owner's launchd. The CI test stops the daemon the way a service
manager does (SIGTERM on POSIX, a hard kill on Windows) and then kills it
outright, and the session survives both.

**What stays the same.**

- **Rule 7.** A holder signals and types into exactly one process: the child it
  started. Pause, resume, kill and resize from the dashboard go through it.
- **Rule 3** is untouched: the shim does not know holders exist.
- **[ADR-028](#adr-028--a-session-ends-when-its-process-does)**: the session's
  pid is the agent's, not the holder's, so liveness still asks the right
  process. A holder exits when its child does and removes its registry entry;
  an exit nobody heard is left as `<session>.exit` for the next daemon to
  record. A registry entry whose port answers nothing is a holder that died,
  and the next daemon deletes it.
- **`caprock down` stops the daemon, not the sessions** — that is the same act
  as the restart this exists for. A session ends when the user ends it (exit,
  or kill from the dashboard).

**What remains of the "terminal went with that run" panel.** Two cases: a
session started by a release from before this one (it was in the daemon's PTY,
so the upgrade that installs this still ends it — there is no way to hand a PTY
master to a process that did not exist when it was opened), and a session whose
holder died with its child surviving the hangup. The panel now says so in plain
words — *"This session's terminal was closed when Caprock restarted. The
conversation is saved — Continue it here resumes it in a new terminal."* —
with continue as the primary action and a copy (`--fork-session`) as a
secondary one that says it leaves the old process running. Continue under the
same id would put two processes on one transcript while the terminal-less one
lives, so the daemon stops it first: SIGTERM, then SIGKILL after five seconds,
and only when the row says Caprock started it and the recorded pid is alive.
That is a process Caprock started, which is what rule 7 permits.

**Fallback.** If a holder cannot be started, the session starts in the daemon's
own PTY as before and a warning is logged: a session that ends with the daemon
beats no session. A child that cannot start (a missing binary) is the spawn's
own error and is not retried.

**Rules out:** tmux or screen as the holder; a daemon shutdown that signals
sessions held by pty-hosts; restarting or resuming a session on the user's
behalf after a restart (the process simply never stopped); signalling a
leftover process the store does not mark as Caprock's.

**Amendment (2026-10-05, terminal protocol v2, WP-03).** The holder counts the
offset of every byte its child printed and reports it in `W` with its ring's
start; a resuming `H` may ask `since` an offset and gets the missed bytes; and
two new frames, `J` (sequenced input from a named client) and `K` (its
answer), let the holder apply each client's input once, keeping the table
120 s, so the guarantee survives a daemon restart. All of it is additive under
this ADR's rule — still `proto` 1: an older daemon ignores the new fields and
never sends `J`, and a holder from before it is met by a daemon that
deduplicates itself and counts that holder's offsets from its own clock.
[03-contracts.md § Terminal holders](03-contracts.md#terminal-holders-caprock-pty-host).

**Amendment (2026-10-11, the holder ships as its own binary).** A local
benchmark against another terminal manager found Caprock's memory growing
fastest per terminal, one holder each. A Go process pays for every package its
binary links before `main` runs, and `caprock` links the whole daemon. The
largest single cost is the SQLite driver's pure-Go libc, which reads
`/etc/services` and `/etc/protocols` into tables at start-up on macOS: a holder
built with nothing but `internal/ptyhost` measured 4.45 MB physical footprint,
the same with that libc linked 9.09 MB, and the full `caprock pty-host` about
11 MB (M1 Pro, macOS 27, 2026-10-11, a login shell in each, median of three).
Freeing those tables after start-up gave nothing back: on that system the Go
runtime's release of freed heap did not lower the footprint (50 MB of garbage
freed with `debug.FreeOSMemory` took the footprint from about 56 MB to
49–52 MB in two runs), and neither did
`GOGC`, `GOMEMLIMIT` or `GOMAXPROCS` for the holder. So the holder became
`cmd/caprock-pty-host`, a separate binary over the same package, which the
daemon prefers when it sits beside `caprock`; releases, the Homebrew formula
and the desktop app ship it. Through a preview daemon opening four login
shells, three runs, median per holder: 11.2 MB before, 4.7 MB after (resident
20.3 MB → 10.9 MB). It is invoked as `caprock-pty-host pty-host`, so the sweep
for orphaned holders, which goes by `argv[1]`, finds both kinds; the protocol,
registry and lifecycle are this ADR's unchanged. A missing holder binary falls
back to `caprock pty-host`, so a single-binary build loses nothing but the
saving.

**Revisit if** a holder is ever seen orphaned without a registry entry (a leak
the cleanup cannot see), if a service manager is found that kills detached
processes by some other grouping (a launchd coalition, a Windows job without
breakaway), or if the protocol needs a non-additive change — which is the
moment the daemon's multi-version support has to be written, not before.

---

## ADR-034 — A phone the owner chooses can work on sessions, and nothing else

**Date:** 2026-10-04 · **Status:** accepted

The owner's top request: leave the desk and keep working — start a session in a
project, pick the agent, type into it, answer what it asks, stop it — from the
phone. ADR-029 made every paired device a reader on purpose, because a token
had silently been a second control room. This keeps that default and adds one
deliberate exception.

**The decision.** A paired device holds a role: `viewer` (what pairing always
gives) or `controller`. The owner grants it per device, on the machine, in
Settings — **Let it control sessions** — and takes it away with one button.
The role lives beside the token in `devices.json`; a file written before roles
existed reads as all viewers, which is what those devices were. The gate checks
the role on every request, and the terminal socket re-reads it before every
frame a device sends, so taking control away stops the next keystroke on a
terminal already open (the socket closes with 1008).

**What a controller may do is an allowlist, like ADR-029's:** start a session,
type into one (socket and `input`), pause/resume/kill one, paste a file into
one, read the recent projects, folder listing (under home), models and relay
brief the start form needs, and approve or reject a task. Rule 7 is unchanged and enforced below the API: the
agent manager only types into or signals processes Caprock started.

**Four narrower choices, each with an easier wrong answer:**

- **A phone starts a coding agent under home, not a command anywhere.**
  The dashboard on the machine may name any binary, arguments or folder,
  because whoever sits there already can. From a device the spawn request may
  not carry `command`, `args` or `chat`, and its folder must be under the home
  directory — checked after `EvalSymlinks`, so `~/link-to-/etc` is outside.
  The first cut's "a folder a session has already run in" is gone, so a
  project outside home (`/private/tmp`, a volume) is started on the machine.
  `create` may make one new folder, and only
  when its parent resolves inside home. `/v1/browse` is open to a controller,
  rooted at the owner's browse root when that lies inside home and at home
  otherwise, so a phone's picker never lists anything above it.
- **Bypass is allowed from a phone** (owner decision, 2026-10-04, reversing the
  first cut of this ADR the same day). The first cut refused
  `permission_mode: "bypassPermissions"` from a device: a phone is used when
  nobody watches the machine, and its token is a bearer secret. The owner's
  goal is to *fully work from the phone*, and the refusal bought nothing: a
  controller can already run any command by typing `!cmd` into a session, so
  controller already equals shell access in that folder. The real guard is who
  holds the role — granted only on the machine, taken away there with one
  click that holds on the next keystroke, and reachable only on the owner's own
  network (Wi-Fi or Tailscale, no relay). The phone's dialog offers bypass
  again and asks once, inline, before starting it: "The agent won't ask before
  running commands or editing files. Start?"
- **The machine stays the machine's.** Settings, pairing (codes, roles,
  revocation, network access), the hive and orchestrator, creating or verifying
  tasks (verify runs commands), hooks install, shutdown, outbound calls, and
  `open-terminal` (a window on the Mac's screen) remain loopback-only whatever
  the role. A controller cannot promote another device or itself.
- **No relay.** It works where the phone can reach the daemon — the same Wi-Fi,
  or Tailscale — and nowhere else. Nothing leaves the machine (rule 4); a phone
  on mobile data without Tailscale cannot reach it, and the pairing panel
  already says which kind of address it shows.

**Rules out:** control granted by pairing (a code read off a screen is proof of
presence, not of intent to hand over a keyboard) — *narrowed 2026-10-14
(below): the intent is now stated by the owner on the machine, with the
code, and the code only carries it*; a global "phones may control"
switch (control is a property of one device, so losing one phone costs one
button); typing into sessions Caprock did not start.

**Revisit if** a controller token is ever reachable off the owner's network
(the bypass and folder decisions lean on that), if an owner needs control
without either network (that is the relay
ADR-029 rules out), or if a controller needs one of the machine-only actions —
each would be its own decision, added to the allowlist by name.

*Amended 2026-10-05 (WP-05, WP-08; [21-app.md](21-app.md) decision 8):* a
controller may also start work, not only sessions — add, create or clone a
project (`POST /v1/projects`), rename, pin or unlist one (unlisting deletes
nothing), and create or remove a worktree (`POST`/`DELETE
/v1/projects/{id}/worktrees…`). The folder rule is this ADR's: the path, or
the parent a project is created or cloned in, resolves under home, and the
worktree routes refuse a project outside it. A clone takes an `https://` or
`user@host:path` address only, so it cannot name a local path or a
transport that runs a command. Removing a worktree never forces and refuses
one with any change. A viewer may read the projects list, its worktrees and
the clones in flight. **Shell tabs stay off the phone** (P1, owner decision
8): `/v1/shells` is not on the list, and a shell's terminal, input and
signal are refused to every device in the handler, although those routes are
a controller's for a session.

*Amended 2026-10-06 (WP-15, the phone's start-work screens):* the four
start-work actions are named controller actions — **add** and **create**
(`POST /v1/projects` with `path` or `create`), **clone** (`POST /v1/projects`
with `clone`) and **worktree** (`POST /v1/projects/{id}/worktrees`) — and a
viewer is refused each with `403` (tests in `internal/api/startwork_test.go`).
From a phone a clone address must also start with `https://` or `git@`: the
machine's wider `user@host:path` is narrowed to what a hosting service hands
out, and anything else is `400` before git runs. A clone or new project never
lands on an existing name, a dangling link included. The listener rule of
"one named address" becomes **at most two named addresses**, one of each
kind: when the machine has both a LAN and a Tailscale address, LAN access
listens on both (still never `0.0.0.0`), and the origin check admits those two
and the Tailscale address's MagicDNS name, read once from `tailscale status
--json` (read-only; Tailscale's configuration is never written). Without
Tailscale nothing changes: a phone off the Wi-Fi cannot reach the daemon, and
nothing is relayed.

*Amended 2026-10-06 (Changes: commit and push without a terminal):* a
controller may also finish the work — stage and unstage files or hunks,
discard unstaged changes (two calls, the second quoting the first's token),
commit, push, pull and fetch (`POST /v1/projects/{id}/changes/…`) — in a
worktree that resolves under home. A viewer may read the status and the
diffs, as it reads a session's diff, and is refused every write with `403`.
The narrower choices: a push is never forced and goes only to the branch of
the same name; a pull only fast-forwards; discard never touches staged work
or follows a link out of the worktree; hooks always run. A controller could
already run `git push --force` by typing it into a session, so this grants
nothing a controller lacked — it removes the reason to.

*Amended 2026-10-06 (WP-19, GitHub; [ADR-039](#adr-039--github-the-daemon-talks-to-the-api-with-the-gh-login-a-pasted-token-or-a-device-flow-token-that-never-leaves-it)):*
a viewer may read GitHub's state — `GET /v1/github` (the account, never
the token), `/v1/github/owners`, `/v1/github/repos`, `/v1/github/prs` and
`/v1/projects/{id}/github` — so the phone shows checks, reviews and the clone
picker. A controller may also open a pull request from a worktree
(`POST /v1/projects/{id}/github/pr`, which pushes first like the Changes
push) and ask for a re-read (`…/github/refresh`). Connecting, the device
flow, disconnecting, the notification switch and creating a repository stay
the machine's: they change where Caprock talks to and what it holds.

*Amended 2026-10-14 — control chosen with the code.* The owner (translated):
"The phone integration instructions are crap. I see the QR code, scan it
with the phone, install the app, go in — and I can't do anything, and say
I've already left the house. So the steps must be spelled out clearly + add
integration statuses and what's left, e.g. allow typing from there." Pairing
made a viewer, and control was a second click on the machine that nobody
remembers to make before walking out — and once out, there is no machine to
click on.

- **The owner states the role when showing the code.** Beside **Show a
  code**, **This phone can type and start agents**, ticked by default (the
  person pressing the button is the owner, at the machine) and remembered on
  that computer. `POST /v1/pair/code` takes `{role}`, loopback-only like
  every pairing route; the code carries it and the device that redeems it
  gets it. Unticked, the phone pairs as a viewer, as before.
- **Still a decision on the machine, never from the phone.** The phone's
  redeem names no role and anything it sends is ignored; a code issued with
  no role (`caprock pair`, `caprock remote`, an older dashboard) pairs a
  viewer. The code stays single-use, five minutes, five guesses: what it
  proves is presence, and the tick is the intent this ADR asked for.
- **Nothing else moves.** **Let it control sessions** and **Take control
  away** stay beside each device; taking control away still holds on the
  next keystroke; a controller's allowlist and the machine-only actions are
  unchanged.
- **The panel says what is done and what is left**, live: access from
  anywhere, the phone paired (by name), whether it can type — with the one
  button that fixes it — and whether it runs as the installed app (the
  phone reports it, `GET /v1/pair/me?app=1|0`, stored as a label in
  `devices.json`, never an authorisation). The phone opens on a short
  **Ready** card saying the same, and where on the computer to fix a
  view-only pairing.

The risk taken: a code shown with the box ticked and scanned by someone
else's camera hands over a keyboard, not only a screen. It was already the
case that a code admitted whoever scanned it in five minutes; the owner
judged a phone that cannot type once he has left the house the worse
failure, and one click removes either.


---

## ADR-035 — A permission prompt is answered with a button, found by its hook

**Date:** 2026-10-04 · **Status:** accepted

The owner wants to work fully from the phone. The phone's terminal already had
Esc, arrows and Enter (ADR-034), and answering a Claude Code permission prompt
with them works — on a five-inch screen, reading a menu drawn for a terminal,
counting rows to the one wanted. The prompt is the most common thing a session
waits on, so it gets buttons: **Yes**, the second option when Claude Code
offers one (*Yes, and don't ask again*, *Yes, allow all edits this session*),
and **No**, under the command or file being asked about. They show on the
machine's dashboard too.

**Found by Claude Code's `PermissionRequest` hook, not by reading the screen.**
The hook fires as the dialog is drawn and carries the tool, its input and
`permission_suggestions` — what the second option would add. The screen holds
the same facts as cursor moves between words (Ink writes
`Do\x1b[5Gyou\x1b[9Gwant`), so reading it means emulating a terminal, and its
wording changes between releases. The hook is registered like the other nine,
fire-and-forget, and nothing is stored: it is a moment, not an event.

**Answered with the keys a person would press**, measured on Claude Code
2.1.289 against three real prompts (Bash with a rule, Bash outside the
project, Write): `1` picks Yes at once, `2` picks the suggestion's option, Esc
is No. The menu is not always the same length — Bash adds *switch to auto
mode*, so No is `4` there and `3` for Write — which is why No is Esc rather than
a digit. The second button is offered only when the first suggestion is a kind
seen on a real prompt (`addRules`, `addDirectories`, `setMode acceptEdits`),
never for `ExitPlanMode`, and `AskUserQuestion` gets no buttons at all, because
its menu is the question's answers and `1` would pick one.

**Rules out the hook's own decision output.** `PermissionRequest` may answer
`{"behavior":"allow"}` itself, and that would need no keys. But it has to be
printed before the hook exits, and the shim exits within a second (rule 3) —
long before anyone has looked at a phone. Holding the hook open for a person
would put Caprock in front of every prompt on the machine, including in
sessions nobody is watching from a phone.

**A button cannot answer a question it did not show.** Each prompt gets a
random id, and `POST /v1/agents/{id}/permission` presses a key only while that
id is still waiting. A prompt is cleared by whatever answers it: a button; a
single Enter, Esc, Ctrl+C or digit typed into the terminal (arrow keys move
through the menu and do not); its own tool's `PostToolUse`; the next prompt or
`Stop`; the session ending.

**Rule 7 is untouched:** only sessions Caprock started get buttons, the agent
manager refuses the rest below the API, and a viewer phone sees the prompt
(the live socket already carries tool inputs) but gets 403 on the answer.

**Codex and OpenCode get no buttons.** Neither reports an approval prompt in a
structured way (Codex's `notify` fires at the end of a turn; OpenCode has no
hook), and the screen is the only signal — the reading this decision rules out
for Claude Code. Their prompts are still answered with the keys bar.

**Revisit if** Claude Code renumbers its menu (the three captured prompts in
the tests would no longer match a real one), if the hook's decision output can
be given after the hook returns, or if Codex or OpenCode report approvals in a
structured way.

*Amended 2026-10-04 by [ADR-036](#adr-036--a-phone-hears-that-a-session-needs-it-through-the-owners-own-telegram-bot):*
the hook is also stored, as a `permission.prompt` event for every session, so
Now can say *waiting for approval* and the phone can be told.

*Amended 2026-10-05:* the prompt an owned session waits on is no longer held in
memory only. The dialog outlives a daemon restart on the session's screen
(ADR-033), so its buttons do too: the prompt is stored (migration 0039) and
restored on reattach under the same id. A prompt whose session recorded
anything since that means it moved on is dropped instead — a missing button
costs a tap in the terminal, a stale one would type `1` into a prompt.

*Amended 2026-10-06:* the desktop app's macOS notification answers the prompt
too, with the same `prompt_id`. It offers Approve only when its text shows the
whole request; a clipped or multi-line command, or a tool whose input it does
not show, gets Deny and a link to the card. Never "always" from a
notification. See [21-app.md § Notifications](21-app.md#notifications).

*Amended 2026-10-06:* a new prompt is stored before its hook is answered, not
after. Written in the background, it was lost when the daemon was killed in
the moment after the hook returned — what Windows CI's hard stop did to the
restart smoke test, intermittently — and the dialog came back without its
buttons. A crash must not lose an open dialog on any OS. Clearing a prompt
stays in the background: a lost clear is caught by the events on restore.

*Amended 2026-10-06 (owner):* in the desktop app the card is not drawn for the
session whose terminal is in front. The terminal's own menu is the answer
surface there — Enter answers it — and a card beside it read as the question
asked twice, sometimes for a different request (a subagent's) than the one on
screen. The card shows when the chat or a Changes view covers the terminal,
says *↵ Enter in the terminal = Yes*, and never takes focus; the Inbox, the
menu bar, the notification and the phone keep their buttons. See
[21-app.md § What the user sees](21-app.md#what-the-user-sees).

*Amended 2026-10-07 (owner), reversing the above:* the card is drawn under the
session's terminal again. He lives in the terminal and wanted the card's
wording and its "don't ask again" by key; the mouse is the wrong instrument
there. What made two surfaces read as two questions is answered by keys, not
by hiding: `Y`, `A` and `N` answer the card from that session's own terminal
and are kept from it, which is safe because Claude Code shows a menu, not an
input, while a permission question waits; Enter and Esc stay with that menu,
where they already mean Yes and No. The subagent mix-up was the queue, fixed
since (below).

*Amended 2026-10-06 (the owner lost work to it all day):* **a button reads the
menu off the screen before it types, and prompts queue.** The fixed keys were
wrong on a real menu: in auto mode the classifier's dialog ("This command
requires approval") is `1. Yes  2. No`, while the hook still carries the
suggestion that used to mean `2` = *don't ask again*, so **Yes, for the rest of
this session** typed `2` and rejected the call. And one prompt per session,
overwritten by every `PermissionRequest` (a subagent's included), let a card
name one request while its key landed in another's dialog. Now:

- **The key comes from the screen.** When a button is pressed, the session's
  recent output (the ring the pty-host keeps, so it holds across a daemon
  restart) is replayed onto a screen by a small emulator (`termbuf.Screen`:
  printing, cursor moves, erases, both buffers; colours and modes ignored),
  and the menu at its bottom is read: numbered options, one marked `❯`, an
  option starting *No*, and at most a footer under it. Yes is the option
  whose text is just *Yes*; the always button is an option starting *Yes,* (or
  *Yes and*) that says *session*, *don't ask* or *allow*; No is Esc. No menu,
  or no such option, and nothing is typed: `422`, *that option is not on the
  prompt — answer in the terminal*, shown on the card. Esc too needs a menu:
  with none it interrupts the turn. This undoes the first paragraph's "not by
  reading the screen" for answering only; finding the prompt is still the
  hook's job.
- *Amended 2026-10-08:* **when the whole ring shows no menu, the bytes since
  the prompt's hook are read alone.** After an app restart the ring began
  mid-frame, and the renderer's relative cursor moves laid the dialog over
  stale rows; every button on the owner's card answered *not on the prompt*.
  The dialog is drawn after its hook as new rows, so on a blank screen those
  bytes show it whole. Up to six rows may sit under a waiting menu (footer,
  status line, a background-task line), not four.
- **Prompts queue per call.** Claude Code queues dialogs and shows the oldest;
  so does Caprock (`tool_use_id` when the hook sends one, `agent_id` for a
  subagent's). The card shows the oldest and how many wait behind it, a later
  hook never overwrites an earlier one, and a button for a queued prompt is a
  `409`. Each is cleared by what answers it: Enter or a digit in the terminal
  answers the oldest, Esc or Ctrl+C clears them all (it rejects and
  interrupts), a `PostToolUse` its own call, a `SubagentStop` that subagent's,
  `Stop`, the next prompt or the session ending all of them. Stored one row
  per prompt (migration 0042), still committed before the hook is answered.
- **Keys on the card.** With a card in view and focus outside a text field or
  the terminal, `Y` or Enter is Yes, `A` the always option (when offered), `N`
  or Esc is No; the buttons say so. A focused terminal keeps every key.

*Amended 2026-10-09 (the owner pressed Y and was unsure what he had
approved):* **a button answers only a prompt that is alone, and every prompt
says who asks.** Subagents running in parallel inside one session — the
owner's normal case now — ask at once, and "Claude Code shows the oldest" was
an assumption no hook confirms: on the owner's database, prompts outstanding at
the same time finished in either order, and no event records which dialog was
in front. Pressing Yes on the card for the oldest could type `1` into a newer
one the reader never saw. Now:

- **One outstanding: buttons, as before. Two or more: none.** The card lists
  every outstanding prompt with who asks ("Subagent (general-purpose): Bash
  `rm -f $C/*`", "Claude: Edit …") and offers **Open terminal** instead of Yes
  and No; its keys are off. The API refuses `allow`, `always` and `deny` while
  more than one is outstanding (`422`, nothing typed), including when a second
  arrives while the screen is being read. `dismiss` types nothing, so it may
  take any of them. The menu bar popover drops Approve and Deny the same way,
  and a notification carries no `prompt_id`, so no actions.
- **A key typed into the terminal clears a prompt only when one is
  outstanding.** With several, it answered whichever was in front, which
  Caprock cannot name. Each goes by its own call instead.
- **A prompt is tied to its call.** `PermissionRequest` carries no
  `tool_use_id` (0 of 283 stored on the owner's database); the id is taken
  from the newest `PreToolUse` by the same agent with the same tool and input,
  so the call's `PostToolUse` clears its own prompt and not another subagent's
  running the same command.
- **Who asks.** The hook's `agent_id` and `agent_type` travel with the prompt
  (`agent_type` stored by migration 0043): the card, the cockpit's Now line,
  the popover and the notification body say "Subagent (general-purpose) wants
  to run Bash". A subagent's dialog is drawn in the parent's terminal; unnamed,
  it read as the parent's own request.

**Revisit if** Claude Code renames its options (the menus in
`internal/agents/permmenu_test.go` would stop matching), or its dialog stops
being the last thing on the screen; or if a hook or the screen ever says which
of several queued dialogs is in front — then the one in front can have its
buttons back.

---

## ADR-036 — A phone hears that a session needs it through the owner's own Telegram bot

**Date:** 2026-10-04 · **Status:** accepted (owner, 2026-10-04)

*PR #189 carries the proposal this accepts, under the number it had there;
the options weighed are summarised here, and the owner's answers to its open
questions are the decision.*

The phone can do the work (ADR-034) and answer a permission prompt with a
button (ADR-035), but it only knows a session is waiting if someone opens it.
The most common request of the 2026-10 interface panel was the same: tell me
when an agent is waiting.

**The signal is the `PermissionRequest` hook ADR-035 registered, now also
stored.** It fires as the dialog is drawn, for every session on the machine.
ADR-035 keeps it in memory for owned sessions only, because only those can be
answered; an alert needs every session, so the hook is also stored as a
`permission.prompt` event. Now and the session page say *waiting for
approval* with the *waiting on you* badge, which they could not before:
"waiting" meant only "the last event was `Stop`". Claude Code's `Notification`
hook was the first candidate and is not registered: its `permission_prompt`
says what `PermissionRequest` already says, and its `idle_prompt` repeats the
`Stop` before it. One hook, one detector.

**Delivery: Telegram, through the bot the weekly report already uses**
(ADR-024). Weighed against Web Push (needs HTTPS, so a Tailscale certificate
with its renewal, a new origin and re-pairing — about three times the work),
a self-signed or local CA (a certificate profile on every phone — ruled out)
and ntfy (a second app, no better on privacy). Telegram reaches a phone on
mobile data with no Tailscale and no HTTPS, and its token, chat, sender and
write-only field exist. The tap opens Telegram, not Caprock; the message
carries the link.

**What leaves the machine** — rule 4 is kept the way ADR-024 kept it. Telegram
reads the text, so the text is the project's folder name, the status, the
agent and a link to the session on the LAN or Tailscale address (omitted when
phone access is off). Never a prompt, a reply, a tool, a command, a file name
or a path. Nothing is sent until the owner has set up a bot.

**The owner's answers:**

- **Free.** The weekly report stays paid; alerts are not, so the bot is set
  up in Settings outside the report's lock, and the daemon checks no licence.
- **Every session**, not only those started from the phone, with one switch
  per kind in Settings; both on by default once a bot is set. *Amended
  2026-10-05 (owner):* both are off until switched on, so a bot set up for
  the weekly report does not start sending alerts on its own.
- **Waiting for approval at once; finished after a minute** with nothing new,
  so an owner replying at the keyboard is never paged.
- **No spam:** one message per dialog, one alert of a kind per session in 3
  minutes, 20 an hour across all sessions (the twentieth says the rest are
  held), and an event more than 2 minutes old pages nobody, so re-reading
  transcripts after a restart stays quiet. A failed send is shown in Settings
  and never retried: a late "waiting for approval" is worse than none.

**Codex and OpenCode alert nothing yet.** Neither reports an approval prompt
or a turn end in a structured way Caprock reads, so neither records a
`permission.prompt` or an `agent.stop`. The rules run over every stored event
from every source, so an agent that starts reporting either gets alerts with
no change here.

**Rules out:** a relay of ours; a self-signed or local-CA certificate;
`tailscale serve` in front of the daemon (it made every phone look
local and bypass pairing; since the ADR-011 amendment of 2026-10-05 a relayed
request needs a device token instead, but the dashboard's origin checks still
refuse a browser on the `ts.net` name); sending anything beyond project, status, agent and
link.

**Revisit if** Caprock serves HTTPS on Tailscale for another reason, or an
owner refuses Telegram — then Web Push reuses the hook and the rules and swaps
the sender.

*Amended 2026-10-05 (owner):* the message carries more than "What leaves the
machine" above allowed, because the first version said too little to act on —
the owner got "Caprock · caprock has finished / Claude Code / link" and could
not tell which session it was or what had happened. It is his own bot, and he
chose usefulness. A message is now Telegram HTML, every session-derived string
escaped, and its first line — what a lock screen shows — says what happened and
which session: *✅ Finished · <title>*, *⚠️ Stopped: rate limit · <title>*,
*⏳ Needs approval · <title>*, *❓ Needs your answer · <title>*. The title is
the name Now shows: the agent's own title, or the first prompt that says
something. Then:

- **Where:** the session's folder with the home directory as `~`
  (`~/Downloads/caprock`, since several folders share a name), its git branch,
  and the agent unless it is Claude Code.
- **A dialog:** the tool and what it asks about, clipped to 100 characters — a
  Bash command's first line, a file path relative to the session's folder, a
  URL, or AskUserQuestion's question.
- **A finished run** (since the owner's last prompt): how long it took, what
  it cost, the tool calls, how many files it changed with the first three
  names, and, while *Include the last reply's first line* is on (the default),
  up to 120 characters of the final reply. A StopFailure (rate limit,
  overload, billing) now ends a turn for the alert as a Stop does, and says so.

Telegram reads all of it: titles, paths, branches, commands and that reply
line. Code, diffs and tool output are still never sent, and nothing is sent
until a bot is set up. This replaces the list under "What leaves the machine"
and the "sending anything beyond project, status, agent and link" in *Rules
out*; the rules of when an alert fires are unchanged.

*Amended 2026-10-10 by [ADR-047](#adr-047--the-owner-talks-to-his-agents-through-his-own-telegram-bot-integrations-he-turns-on-may-leave-the-machine):*
the first line is now whose the message is — the agent's mark and name, the
project and the session's title — and what happened moves to the second
(*✅ Finished*, *⏳ Needs approval*). Each alert carries *Mute this session*
and, with phone access on, *Open on phone*; both free. The chat is paired
with a one-time code instead of a typed chat id.

---

## ADR-037 — A session can be removed, for good, from the machine

**Date:** 2026-10-05 · **Status:** accepted

Test runs left about thirty sessions in the owner's database — their folders
under `/private/tmp/claude-501/…/scratchpad` — and they showed in Recent
projects and every total. Nothing could take them out.

**The decision.** `POST /v1/sessions/remove`, *Remove from Caprock* on the
session page (two clicks, the second on a line naming the cost) and
`caprock sessions rm` (by id or `--cwd-prefix`, a dry run unless `--yes`)
delete a session's events and everything counted from them, take its turns
back out of each day's totals, and record a tombstone in `removed_sessions`.
The recorder stores nothing for a tombstoned session, so the transcript still
on disk is never recorded again. Contract in
[03-contracts.md](03-contracts.md) (*Removing sessions*).

**Delete with a tombstone, not a `deleted_at` column.** A soft delete on
`sessions` would keep every row and leave every screen to filter it out:
dozens of queries over `sessions` and `events`, several on covering indexes a
new filter column would uncover (as `internal = 0` did, migration 0026). A missed filter is a total that silently still counts the
session — the failure this exists to fix. With the rows gone there is nothing
to filter. It follows the repository's own precedent: the Codex repair
deletes imported threads' rows and takes them out of the rollups the same way
(`internal/codex/repair.go`).

**What it costs.** It cannot be undone from the dashboard. The tombstone keeps
the folder and the cost for the record, and the transcript is untouched, so a
restore would be deleting the tombstone and re-reading the file — not built.
Hook events are not in any file and would not come back.

**The machine only.** A phone gets `403` whatever its role (ADR-029,
ADR-034): removing history is not working on a session. A session still
running — held by Caprock, or `active` — is skipped, because every event it
went on to send would be dropped.

**Verified** on a copy of the owner's database (2026-10-05): removing the 31
sessions under `/private/tmp/claude-501` took Lifetime, the all-time summary
and the daily totals down by exactly $24.5953297, their summed session cost,
and the session counts by 31. One day row had been filed under a project name
the folder no longer resolves to (`repo`, now `hive2`); a row of that day and
model holding exactly the session's tokens and cost is taken as its own.

**Revisit if** a removed session is wanted back, or removal is wanted from a
phone.


---

## ADR-038 — The desktop app is a thin Tauri v2 shell around the existing React UI and xterm.js, on the Go daemon

**Date:** 2026-10-05 · **Status:** accepted (owner, 2026-10-05)

**Context.** The owner wants people to *live* in Caprock: an installed app in
the dock or taskbar, terminal-first, across many projects, with the monitoring
Caprock has and a phone that can start work. The reference app (Orca) has that
shape and fails on freezes, dropped phone connections, a jumping chat scroll,
hidden GitHub errors and hanging terminals. He needs macOS, Windows and Linux,
and a mobile app later from the same code; speed to market matters. Developers
use the app; managers use the Caprock Teams web dashboard; the app is free and
teams pay.

The first plan (2026-10-04) was a Swift app with SwiftTerm, macOS only. Its
spike (PR #180, branch `spike/macos-app`) measured, on one Apple Silicon Mac:
native echo 5–6 ms p50 against 12–19 ms for the web terminal, opening a
session in about 0.1 s against 0.25–1.1 s, and 34–53 MB against 280–440 MB for
a Chrome tab. **That plan is superseded by this decision; its numbers stand**
and are the baseline in [21-app.md](21-app.md#performance-budgets). The spike
also found that echo latency is not where native wins — up to a frame of the
web figure is vsync alignment, and neither stalled at 1,000 lines a second —
while opening, memory and focus are.

**The decision.**

- **Tauri v2** is the app shell on all three desktop OS: Rust, kept minimal —
  the window, tray or menu bar, OS notifications, global hotkey, badge, update
  notice and starting the bundled daemon. Nothing else is written in Rust.
- **The existing React UI (`ui/`)** is the app's interface, loaded from the
  daemon's loopback URL so the UI and the API it calls always come from the
  same release. It gains an app layout (sidebar, terminal tabs) when it
  detects the shell.
- **xterm.js** stays the terminal, behind the tab component, so a native
  renderer can replace it without touching the rest.
- **The Go daemon stays the only engine**: sessions, pty-hosts (ADR-033), the
  store, hooks, pricing, pairing and the phone's roles (ADR-034 to ADR-037),
  alerts. The app is one more client of its API, beside the browser and the
  phone.
- **Mobile later from the same codebase** (Tauri v2 targets iOS and Android);
  until then the phone is the web dashboard, made resilient.

**Alternatives, and why not.**

- **Swift with SwiftTerm (the first plan).** Best measured latency and memory,
  macOS only. Windows and Linux would each need another app, and rule 2 says a
  feature is not done until it works on Windows.
- **Native per OS, three times** (SwiftUI, WinUI, GTK). The best feel, three
  codebases and three terminal integrations to keep equal; months before the
  first release on all three.
- **Rust with gpui and alacritty_terminal.** One native codebase and a fast
  GPU terminal, but every screen Caprock has would be rewritten in a young UI
  toolkit, and the phone would still need web.
- **Electron.** The UI as is, Chromium's rendering everywhere, but a
  bundled Chromium in every install (the reference app's `app.asar` alone is
  126 MB, measured 2026-10-05), a Chromium process tree per window, and the
  reference app's freezes come from this shape. ADR-003 ruled it out.
- **Flutter.** One codebase including mobile, but every screen rewritten in
  Dart and no mature terminal widget at xterm.js's level.
- **Qt** (C++ or QML). Native-feeling and fast, but a rewrite of the UI, C++
  or a binding, and licensing to read.
- **Wails** (Go and a system WebView). The same WebView as Tauri and Go
  instead of Rust, but no mobile targets, a smaller ecosystem for tray,
  notifications and updates, and the shell would tempt logic into the app
  process the engine already owns.
- **Rewrite the engine** in Rust inside the app. Throws away a released,
  three-OS-tested daemon and the pty-host work, and the phone and browser
  would lose the server they talk to.

**Why Tauri, in short.** It reuses every screen that exists, runs on the system
WebView (no bundled Chromium), targets the three desktops and both phones, and
keeps the native part small enough that the engine stays in Go. The one cost
is that the terminal is xterm.js in a WebView, which the spike says costs
latency we can afford and saves everything else.

**Consequences.**

- `ui/` serves three layouts (browser, app, phone) from one codebase; the
  app's surfaces are switched on by detection, never forked.
- The daemon grows what the app needs, and the phone benefits from all of it:
  `api_level`, terminal protocol v2 (byte offsets, resume, exactly-once
  input), projects (migration 0041), shell tabs, the `notify` live frame and
  `/v1/live` replay. The specs are in [21-app.md](21-app.md); each lands in
  [03-contracts.md](03-contracts.md) with its work package.
- Releases ship two artefacts from one tag: the binaries and the app, which
  bundles the daemon it was built with.
- A new toolchain (Rust, Tauri's bundler, per-OS signing) joins CI; the app
  is built and tested on all three OS like the daemon.
- The app keeps rule 4: no telemetry, outbound calls only when switched on.

**Rules out:** Electron; a native app per OS for the MVP; business logic in
the Rust shell; a UI bundled in the app that can disagree with the daemon's
API (until mobile, which brings `api_level` into force); a second terminal
backend beside the pty-host.

**Revisit if** echo latency or typing comfort draws complaints that a budget
in [21-app.md](21-app.md#performance-budgets) confirms on any OS — then a
native terminal view per OS via libghostty behind the same tab interface (F23)
is the next step, not a new shell; if WebKitGTK cannot meet the budgets on
Linux with any xterm.js renderer; if Tauri's mobile targets cannot host the
phone UI acceptably when F22 starts; or if the Rust shell passes its line
budget because something belongs in it that the daemon cannot do.

---

## ADR-039 — GitHub: the daemon talks to the API with the gh login, a pasted token or a device-flow token that never leaves it

**Date:** 2026-10-06 · **Status:** accepted (WP-19, decided without the owner;
he may overrule it)

F14 needs a GitHub token. The reference app shells out to `gh` and hides what
fails. Decision 4 in [21-app.md](21-app.md#decisions-owner-2026-10-05) named the OAuth device
flow; WP-19's brief put three sources in order of how little the user has to
do, and this records that order and where each token lives.

**The decision.**

- **The daemon calls `api.github.com` itself** (`internal/github`), over
  `net/http`, with no new library. The token is sent only there (and the
  device flow's two calls to `github.com`); the client refuses any other
  host, and no endpoint, frame, log line or config field carries it. The UI
  sees the account, the scopes and the token's kind (by prefix), never the
  value.
- **Three sources, one at a time, the easiest first:**
  1. **The GitHub CLI's login.** `gh auth token --hostname github.com`, run
     with the login shell's environment when a call needs it, cached in
     memory for 10 minutes and re-read once on a 401. Caprock never writes
     it down; disconnecting stops using it and leaves `gh` alone.
  2. **A pasted token** (fine-grained or classic), checked with `GET /user`
     before it is kept. On macOS it goes to the user's **login keychain**
     through `/usr/bin/security` with argv (no shell), naming the keychain
     file explicitly — `<home>/Library/Keychains/login.keychain-db`, the home
     read from Directory Services for the process's uid, not `$HOME`. When
     that file is missing or `security` fails, the token goes to a `0600`
     file in the data directory and Settings says why. On other OS it is the
     `0600` file. Never in SQLite, `config.json` or a log.
  3. **The OAuth device flow**, offered only when `github_client_id` is set
     in `config.json` (a Caprock OAuth app's public client id; no secret on
     the machine). The user approves on github.com; the token is kept like
     a pasted one. Scopes asked: `repo read:org`.
- **Disconnect removes only what Caprock stored** (the keychain item or the
  file); a `gh` login is untouched.
- **No dialog, ever.** A keychain call without an explicit keychain file
  falls back to the user's default-keychain search, and when that is missing
  macOS shows "Keychain Not Found" with a **Reset To Defaults** button. That
  happened during WP-19 under a test daemon with a throwaway `$HOME`. So the
  Keychain backend refuses to run without a file path, the path comes from
  the OS user record, the store is read at startup only when a stored token
  is the chosen source, `CAPROCK_SECRET_STORE=file` forces the file (tests
  and throwaway daemons set it), and no test runs the real `security` — the
  backend is tested by the argv it builds.
- **Polling is polite.** A repository with a followed pull request is read
  at most once a minute, doubling to 8 minutes while nothing changes; every
  read is conditional (`If-None-Match`, a `304` costs no rate limit), a rate
  limit pauses that resource until `Retry-After` or the reset, and a push
  through Caprock asks for a re-read (at most every 10 s). Changes reach the
  UI as `github` live frames; CI failing or a review landing is a `notify`
  frame (kinds `ci`, `review`), switchable in Settings.
- **Rule 4.** Nothing is sent to GitHub until the user connects; the
  connection is the switch, and Settings → Privacy names it.

**Rules out:** depending on `gh` (it is one source, not a requirement);
shelling out to `gh api` (its errors are what the reference app hides);
a client secret on the machine; keeping the token in the database; a
keychain library or CGO; polling faster than a minute; a keychain call that
can raise a system dialog.

**Revisit if** GitHub ships a device flow that needs no registered app (then
it can be on by default), if Windows or Linux users ask for their OS
keychain (a pure-Go backend behind the same `TokenStore`), or if `security`
ever prompts for an explicit, unlocked login keychain.

---

## ADR-040 — On macOS the app's own daemon runs, from one path, and nothing isolated touches the guarded folders

**Date:** 2026-10-06 · **Status:** accepted (decided without the owner; he
may overrule it)

**Context.** macOS asked the owner for "Files and Folders" access, and
System Settings → Privacy & Security → Files and Folders listed many
"caprock" entries, none with an icon. TCC (the privacy database) remembers
an answer per program and checks it against the program's *designated
requirement* (DR): "macOS solves this problem by recording your app's DR in
its database … Each time your app tries to access the microphone, macOS
checks that this version of the app satisfies the original DR", and "Ad hoc
signed code … has a DR but it's tied to that specific version of the code"
([TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements),
read 2026-10-06). Every Caprock binary is ad-hoc signed (no Apple account):
`codesign -d -r-` on the 0.78.0 formula binary prints `designated => cdhash
H"…"`, so every release is new code to TCC and asks again.

The *number* of entries is the other half. A command-line binary with no
bundle is listed under its file name, which is why each reads "caprock" with
no icon; the entries are separate because they are separate programs to TCC
— inferred from what the list shows, since TCC.db is not readable without
Full Disk Access. What the machine runs, measured 2026-10-06:

- The Homebrew daemon is launched as `/opt/homebrew/bin/caprock`, but that
  is a symlink and the process's executable is
  `/opt/homebrew/Cellar/caprock/0.78.0/bin/caprock` (`lsof` `txt`): **a new
  path every release.**
- The daemon is a launchd agent, so it is its own responsible process, and
  every `caprock pty-host` it starts — and every `claude` or `codex` under
  one — is attributed to it. An agent working in `~/Documents` asks in
  Caprock's name. (No longer: since ADR-044 every session starts
  responsible for itself.)
- The app's bundled daemon, when it runs, runs from
  `<data_dir>/bin/caprock`: one path, copied there by the app.
- Agents' test and preview daemons run from their own builds (worktrees,
  scratchpads): one more path each. One that copies the real database knows
  the real projects, and watches them and runs `git` in them.

**The decision.**

- **macOS: the app's own daemon is the one that runs.** The app starts its
  bundled copy at `<data_dir>/bin/caprock`, never the formula's, and when it
  finds the formula's daemon running (its executable resolves into a Cellar)
  it moves it onto its own once per launch — the copy in place, a clean
  `/v1/shutdown` (sessions live on in their pty-hosts, ADR-033), then a
  start as a login service when one was registered or chosen. It does not
  when the bundled daemon is older than the running one, or when app.json
  says `"own_daemon": false`. This amends ADR-038's "a running daemon always
  wins" and the supervisor's "never stop a daemon it did not start", for
  this one case: the result is one daemon path that never changes, so one
  entry instead of one per release. The `caprock` CLI from Homebrew keeps
  working as a client. Linux and Windows keep the old rule; they have no
  TCC.
- **An isolated daemon stays out of the guarded folders.** A daemon whose
  HOME is not the account's own (every test, stand and preview sets a
  temporary HOME) refuses the account's Desktop, Documents and Downloads in
  the projects watcher and every `git` it runs (`internal/tcc`), whatever its
  database says. `bench/stand.sh` refuses to put a stand there.
- **No stable identifier on ad-hoc builds.** `codesign -s - -i
  dev.caprock.daemon` sets the identifier and leaves the DR a cdhash, so it
  changes nothing TCC checks. An explicit DR of `identifier
  "dev.caprock.daemon"` on ad-hoc code would be satisfied by anything
  signed with that string, so a binary swapped in at that path would
  inherit the user's grant silently; TN3127 also says not to write DRs by
  hand. Not done.
- **Spawned agents keep Caprock's responsibility.** Disclaiming it (the
  private `responsibility_spawnattrs_setdisclaim`) would make each `claude`
  its own TCC client: an entry per agent binary and version (Claude Code
  installs each version at its own path), prompts naming a program the user
  did not knowingly start, and a private API the pure-Go daemon (no CGO)
  cannot call through `os/exec` anyway. Attributed to Caprock, the prompt
  names the program that started the session, as Terminal's does for what
  runs in it. The cost: access granted for one agent's work extends to
  every session Caprock runs.

**What needs the Apple account.** A Developer ID signature gives a DR of
the form `anchor apple generic and identifier "…" and certificate
leaf[subject.OU] = "<team>"` (TN3127), which every later release satisfies:
one entry, no re-asks after updates. With it, the daemon should ship inside
the app as a helper registered with `SMAppService`, so it carries the app's
name and icon; that attribution is to verify on a signed build, not
claimed here.

**Rules out:** a CLI identifier or hand-written DR to fake continuity;
disclaiming responsibility for spawned agents; a test daemon with the
user's real HOME.

**Revisit if** the Apple account exists (sign, bundle the helper, measure
the list again), or if moving a Homebrew daemon onto the app's surprises a
user who runs both.

**Amended 2026-10-06 (`make app-local`).** The move above covered only a
formula's daemon, so an app upgraded to a new release kept running its own
daemon at the old version until that fell below `MIN_API_LEVEL`. The same
move now also replaces the app's *own* daemon, once per launch, when the
bundle carries a different one: another `caprock version`, or the same
version with other bytes (`<data_dir>/bin/caprock` against the sidecar).
The bundle wins in both directions, because the app's daemon is a copy of
it: a new release, a local build (`<last tag>-dev+<commit>`) and a step
back to a release each leave the daemon matching the app. Only an app
running from a `.app` does it; `make app` (`cargo run`) leaves the running
daemon alone. `"own_daemon": false` still turns all of it off.

**Amended 2026-10-07 (the page follows the swap).** After `brew upgrade
--cask` to 0.78.2 the app loaded its window from the 0.78.1 daemon still
running, replaced that daemon two seconds later, and never reloaded: the
owner ran 0.78.1's UI for the rest of the run, with no reload command to
recover. The replacement is now decided at launch, before the window loads
anything; when the app replaces the daemon, the window waits on the fallback
page and goes to the dashboard once the new daemon answers. A swap that
still happens under a loaded page (a daemon that came up after launch)
reloads the main window and the popover once the new daemon answers,
keeping the route. Independently of the shell, the daemon writes its version
into the page it serves and the page reloads itself when the live link comes
back to a different version — once, never in a loop, and not under an open
sheet with typed text, where it offers a one-click reload in the status strip
instead (a terminal's input lives in its pty-host, so a reload is safe
there). The app gains View → Reload (⌘R); F5 elsewhere. Details in
[21-app.md § Updating the daemon](21-app.md#updating-the-daemon).

## ADR-041 — The first bypass session asks for consent in Caprock, never in a screen whose default is "No, exit"

**Context.** Bypass became the default for a new session on 2026-10-07 and
is spawned as `--dangerously-skip-permissions`. Claude Code shows a one-time
warning the first time it runs that way ("WARNING: Claude Code running in
Bypass Permissions mode", *Yes, I accept* / *No, exit*), with focus on
*No, exit*, unless `skipDangerousModePermissionPrompt` is true in the user's
settings. The owner had it set, so he never saw it; a new user pressing Enter
was dropped from the session into a shell, and a session started from a
phone sat on a screen no card shows (it is not a hook).

**Decision (owner, 2026-10-07).** Caprock shows the warning itself, once per
machine, in the dialog the user is already in: a note above the start
button, which reads *Accept and start*. Pressing it writes the key Claude
Code writes on *Yes, I accept* (`POST /v1/claude/bypass-consent`), then
starts. The daemon refuses a bypass start without it (409 `bypass_consent`),
which the dialogs turn into the same note, so a stale page or a script
cannot reach the warning screen. A paired device cannot give the consent:
it is given at the machine.

**Rejected.** Passing `--settings '{"skipDangerousModePermissionPrompt":true}'`
on every start: with bypass the default, users would run without asking
having agreed to nothing. Leaving Claude Code's screen with a hint: the
Enter trap and the stuck phone session remain.

## ADR-043 — A new install asks before running commands; the mode picked is kept

**Date:** 2026-10-08 · **Status:** accepted (owner, 2026-10-08; amends the
bypass default of 2026-10-07 that ADR-041 starts from)

**Context.** From 2026-10-07 a new session started in bypass unless Settings
named another mode, so a first session on a stranger's work laptop never
asked before running a command. Anthropic's permission docs keep bypass for
isolated environments. A visitor audit of the site (2026-10-08) put this
first: a reader expects a session to ask, as Claude Code does.

**Decision.** With no saved preference the New agent sheet and the spawn
dialog open on *Accept edits · asks first*. A mode the user picks in either
is saved as `spawn_permission_mode` once the session has started, so picking
bypass once is picking it until something else is picked. A paired device
never changes the machine's preference. The ADR-041 consent and the phone's
bypass confirmation are unchanged. Installs that relied on the old default
now get Accept edits until they pick bypass once; the owner's preference was
saved as bypass before the change.

**Rejected.** Keeping bypass as the default with a louder note: the reader
the audit worried about never opens the sheet's fine print. Asking on every
start: the owner's point that a session you leave must not keep stopping is
kept by the remembered pick.

## ADR-042 — The app updates itself in one click: a minisign-signed bundle, one channel, checked only when the release check is on or the user asks

**Date:** 2026-10-06 · **Status:** accepted (owner asked for it: "no
convenient seamless app update" was what bothered him most, translated) ·
**Amended:** 2026-10-15 (hourly checks, Update automatically; below), 2026-10-16 (every 15 minutes and on focus; below)

**Context.** Until now the app named the command for how it was installed
(F12) and never replaced itself: a Homebrew user ran `brew upgrade --cask`,
everyone else downloaded the release again. WP-21 (F20) is opt-in
auto-update. There is no Apple Developer ID yet (expected within days), so
the macOS build is ad-hoc signed and not notarized; whatever is built now
must keep working when notarization is added.

**The decision.**

- **tauri-plugin-updater, with our own minisign key.** Every release
  attaches, beside the installers, a signed update bundle per platform:
  `Caprock_<v>_universal.app.tar.gz` (macOS), the NSIS installer (Windows)
  and the AppImage (Linux), each with a `.sig`. The app verifies the
  signature against the public key in `tauri.conf.json`, and the version
  the signature was made for (`requireSignedVersion`), before anything is
  written; a manifest pairing a new version with an old bundle is refused.
  The private key and its password live only in GitHub secrets
  (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) and the
  maintainer's machine; losing the key means the next app must be
  installed by hand once, with a new public key.
- **One channel: the Latest release.** The app reads
  `https://github.com/dspv/caprock/releases/latest/download/latest.json`.
  `scripts/app-latest.sh` writes it from the attached `.sig` files and
  attaches it before it marks the release Latest, so the manifest never
  names a file that is not there, and a prerelease (never Latest) never
  reaches it. No server of ours, no per-user URL.
- **When the app asks the network.** Finding out that a release exists is
  still the daemon's release check (`/v1/update`, at most every 6 hours, off
  until the user turns it on; on its first launch the app asks once, in the
  app, Yes highlighted). The app itself fetches `latest.json` and the
  bundle only when the user clicks **Update to vX.Y.Z — Restart**, **Check
  for Updates…** (macOS app menu, the tray menu) or *Check for updates* in
  the palette. Those requests carry the plugin's `User-Agent`
  (`tauri-plugin-updater/<version>`) and an `Accept` header: no cookie, no
  identifier, no version in the URL. GitHub learns an address asked for the
  latest Caprock app, as with the release check (rule 4).
- **Where it cannot update itself, it says so and never tries.** A
  development build, a `.deb` or `.rpm` install (told to install the new
  package with its package manager; `latest.json` has no `linux-x86_64` or
  `-deb`/`-rpm` key, only `linux-x86_64-appimage`), and a macOS app run from
  the disk image or a translocated copy (told to move it to Applications).
  Those keep F12's command.
- **The daemon follows the app.** The new bundle carries the new daemon. The
  relaunched app finds its own daemon (`<data_dir>/bin`, ADR-040) older than
  the bundled one and moves it over once, the way it adopts a Homebrew one:
  the copy in place, a clean `/v1/shutdown`, a start. Sessions live on in
  their pty-hosts (ADR-033). A daemon a package manager owns is never
  touched.
- **macOS without notarization.** The updater downloads with its own HTTP
  client and unpacks the bundle itself, so the new `Caprock.app` carries no
  `com.apple.quarantine` attribute and Gatekeeper does not stop it on the
  next launch — verified on a real update between two local builds
  ([14-build-status.md](14-build-status.md), 2026-10-06). TCC still treats
  each ad-hoc release as a new program (ADR-040).
- **The cask says `auto_updates true`**, so `brew upgrade` leaves an app
  that updates itself alone unless asked with `--greedy`, and the two do not
  fight.

**What changes with the Developer ID.** Signing and notarization slot into
the same bundle step (the Apple variables for `tauri build` that
[RELEASING.md § The desktop app](../docs/RELEASING.md#the-desktop-app)
lists): the `.app` inside the
update tarball is then Developer ID signed and notarized like the `.dmg`,
the minisign layer stays as the update's own check, and the cask's
quarantine step goes. Nothing in the app changes.

**Rejected.**

- *Sparkle* (macOS only, and a second signing scheme beside Tauri's).
- *A server of ours answering per version* (`{{current_version}}` in the
  URL): a request that says which version a user runs, and a service to
  keep up, for nothing a static file does not do.
- *Downloading in the background before the click*: an outbound transfer
  the user did not ask for. The download starts on the click and shows its
  progress.
- *Installing deb/rpm through the plugin* (pkexec): a privilege prompt from
  an app, for a file the package manager should own.

**Revisit if** the Apple account exists (sign and notarize the bundle,
measure that an update still opens without a prompt), a second channel
(beta) is wanted, or GitHub's `releases/latest/download` redirect stops
serving release assets.

**Amended 2026-10-15: checked hourly, and Update automatically is a
choice.** The owner asked (translated): "the product should check for a new
version a bit more often. And add an option — either turn on auto-update,
or ask the user right now." Releases now ship several times a day, so a
six-hour throttle meant most of them were announced after the next one was
out.

- **The release check is due hourly** (`update.Interval`), on a five-minute
  tick measured on the wall clock, so a check that fell due while the Mac
  slept runs within minutes of waking; after a failure the next unforced
  try waits 15 minutes. It is the same conditional request to the same
  endpoint (an unchanged release is a `304` with no body), still off until
  switched on. Nothing new is sent. Settings → **Updates** holds the
  switch, when it last asked, and **Check now**.
- **Settings → Updates, in the desktop app where it can replace itself:
  Ask me (the default) / Update automatically** (`app_update` in
  `/v1/settings`). Ask me is everything above, unchanged. Update
  automatically reverses one rejected option above, *downloading in the
  background before the click*, because now the user asked for it: once
  the daemon reports a newer version, the app fetches `latest.json` and the
  bundle — the same two requests a click makes, with the same signature
  and version checks — and holds the verified bytes (`app_update_download`,
  phase `ready`). Choosing it also switches the release check on.
- **It restarts only when it is safe:** no session working or waiting on a
  permission prompt (`GET /v1/update/busy`, the keep-awake count; a count
  that cannot be read counts as busy), the page left alone for two minutes
  (no key, click, pointer move or scroll), and nothing typed into a text
  field on the page. Otherwise it looks again every 30 seconds. Then a
  ten-second notice, *Updating to vX in 10 s*, with **Not now** (holds that
  version back an hour) and **Restart now**; a key or a click elsewhere
  calls it off until the next quiet moment. After the restart one line
  says *Updated to vX · What's new*.
- **Sessions and tabs come back as on any update** — the path is the one a
  click on Update takes: each session's terminal lives in its pty-host,
  which outlives the app and the daemon (ADR-033; the daemon's restart
  tests, `TestSessionSurvivesItsDaemon`, `TestAPromptSurvivesADaemonRestart`),
  and the page keeps tabs, splits and scroll in its storage. What is typed
  in a terminal is in the session's process and survives; a draft in a
  page field would not, hence the rule above.
- **The update card offers *Always update automatically*** as a secondary
  action that flips the setting; it does not restart there and then.
- **Unchanged:** the daemon never overwrites its own binary, and a
  Homebrew, Scoop, `go install` or downloaded daemon is still told the
  command (F12). Only the app's own minisign-verified bundle installs
  itself, and only the app's page acts on `app_update`; a `.deb`, `.rpm`,
  development or translocated app still cannot update itself and shows no
  choice.

**Amended 2026-10-16: every 15 minutes, and on focus.** The owner asked
(translated): "why isn't the update highlighted when there is an update?"
— 0.124.0 had been published for twelve minutes and his 0.123.1 app said
nothing, because the hourly check had not fallen due. The background check
is now due every 15 minutes (`update.Interval`), and when the main window
gains focus or is shown the page asks for one more
(`POST /v1/update/check?soon=1`), run only if the last check is ten minutes
old (`update.SoonInterval`, held by the page and by the daemon, on one
shared last-checked time). Unforced checks therefore never exceed one per
ten minutes; **Check now** and **Check for Updates…** are still forced. It
is the same conditional request (an unchanged release is a `304` with no
body, not counted against GitHub's rate limit), still off until switched on,
and nothing new is sent. The answer to any check is said in the status
strip beside the version, where the owner looks for it, not in a banner at
the top (04-ui.md § Update notice).

## ADR-044 — Sessions answer for themselves to macOS privacy prompts; background reads skip every guarded place

**Date:** 2026-10-09 · **Status:** accepted (decided without the owner; he
may overrule it)

**Context.** The owner kept being asked, in Caprock's name, for "files on a
network volume" (`kTCCServiceSystemPolicyNetworkVolumes`) and for "your
music, video activity, and media library" (`kTCCServiceMediaLibrary`),
"periodically". The `tccd` log (`log show --predicate 'process == "tccd"'`,
read 2026-10-09; it reached back about twelve hours) holds every prompt
shown in that window: eight, all with the installed daemon as the
responsible process and none from the daemon's own code. The accessing
binary was `claude` seven times and an OpenCode binary once. Matched to the
events table by time: 10:52 an agent ran `ls ~/Desktop/*.png
~/Downloads/*.png` (Desktop, Downloads); 11:32 a subagent ran `find /
-maxdepth 6 -name playwright` (Documents, Media Library twice, Network
Volumes twice); 01:44 `opencode debug agents` scanned from a scratch home
(Network Volumes). The log also shows why it repeats: "Failed to match
existing code requirement for subject …/caprock/bin/caprock" — the earlier
answer belonged to an earlier ad-hoc build (ADR-040).

macOS names a process's *responsible* program, inherited down the tree from
the app or launchd job that started it, unless a parent disclaims it when
spawning the child. iTerm2 (`iTermPosixTTYReplacements.c`) and Chromium
(`base/process/launch_mac.cc`) do, through the private but long-stable
`responsibility_spawnattrs_setdisclaim` on a `posix_spawn` attribute (macOS
10.14+); iTerm2 with `POSIX_SPAWN_SETEXEC`, in place of an exec. Go's
`os/exec` forks, so the attribute cannot be set there, and
06-engineering-rules forbids cgo.

**The decision.**

- **Every process Caprock starts for the user runs through a re-exec
  trampoline on macOS.** `disclaim.Wrap` turns `prog args` into `caprock
  __disclaim-exec <abs prog> <argv0> args`; the binary's `main` calls
  `disclaim.Main` first, which calls `posix_spawn` with `SETEXEC`,
  `SETSIGDEF` (all signals), an empty `SETSIGMASK` and the disclaim
  attribute. The process keeps its pid, descriptors, session and controlling
  terminal; only the program and its responsibility change. libSystem is
  called the way `golang.org/x/sys/unix` calls it (dynamic imports,
  assembly trampolines, `syscall.syscall6`), so the build stays
  `CGO_ENABLED=0`; the private symbol is looked up with `dlsym`, so a macOS
  without it loads the binary and falls back to a plain exec. Wrapped:
  PTY sessions (`ptyman`, in the pty-host and the in-process fallback), the
  login-shell read (`userenv`), verify commands (`board`). Not wrapped: git
  and other fixed helpers, which the daemon runs for itself and which are
  kept out of guarded places instead. Cost: one start of the caprock binary
  per spawn, about 19 ms measured on the owner's M-series Mac.
- **Background reads skip every guarded place** (`tcc.Guarded`): the
  account's Desktop, Documents, Downloads, `Library/Mobile Documents`,
  `Library/CloudStorage`, Music, Movies, Pictures, and `/Volumes`, for `$HOME`
  and the account's home. Symlinks are followed one component at a time and
  each prefix is checked before it is read, so a link in `~/dev` to a share
  is recognised from the link. It replaces the textual `protectedDir` of
  2026-10-07 and now also covers the folder picker (`/v1/browse`,
  `/v1/recent-dirs`). A read the user asked for (opening a session, a file
  tab, a folder) is unchanged.
- **A session's own folder is walked in Desktop, Documents and Downloads,
  never in the rest** (`tcc.GuardedBeyondWork`, for ingest's
  `store.findRepoRoot` and `store.ProjectWorthListing`). The first user
  keeps every project in `~/Documents`; labelling those sessions by folder
  instead of repository would break his sidebar. A session there means the
  user works there, the walk reads only the folder's own ancestry (never its
  siblings), and one prompt per release for that folder is legitimate until
  releases are Developer ID signed. Music, Movies, Pictures, iCloud Drive,
  cloud storage and `/Volumes` stay untouched: a session there keeps its
  folder's name.

**Verified.** Without a dialog: macOS checks the Developer Tools service
silently whenever a new unsigned binary starts, and logs the attribution.
A fresh binary started directly from a session was logged with
`responsible_path=…/caprock/bin/caprock`; the same binary started through
`caprock __disclaim-exec` had no separate responsible process — the subject
was the binary itself (2026-10-09). Tests cover pid, directory, environment,
exit status and a PTY shell remaining its terminal's foreground group.

**Consequences.** A prompt now names `claude` (`com.anthropic.claude-code`,
Developer ID signed, so the answer survives Claude Code's updates and
Caprock's), `codex`, or the user's shell (a shell binary under `/bin` is
Apple's, and macOS may attribute it further; untested). A session in a media
library, cloud storage or on a share is labelled by its folder rather than
grouped under its repository, since finding the repository would mean
reading there; the user can still add such a project by hand. Caprock itself
may still ask once per release for Desktop, Documents or Downloads when a
session runs there.

**Revisit if** Apple removes or changes the attribute (the fallback is a
plain exec, so the symptom would be prompts in Caprock's name again), or
Caprock ships as a Developer ID app whose own grants should cover its
sessions.

## ADR-045 — The app and its daemon may ask for the microphone

**Date:** 2026-10-10 · **Status:** accepted (decided without the owner; he
may overrule it)

**Context.** Claude Code's voice mode in a Caprock terminal said "No audio
detected from microphone", and macOS showed no prompt. The `tccd` log
(`log show --predicate 'process == "tccd"'`, read 2026-10-10) holds every
request: the accessing binary was `claude` itself, the responsible program
was the app's daemon at `<data_dir>/bin/caprock`, and each request ended
with

> Prompting policy for hardened runtime; service: kTCCServiceMicrophone
> requires entitlement com.apple.security.device.audio-input but it is
> missing for responsible=… caprock/bin/caprock … Policy disallows prompt …
> access to kTCCServiceMicrophone denied

(`authValue=0, authReason=5`). The daemon is the bundler's universal
sidecar, signed `flags=0x10002(adhoc,runtime)` with no entitlements; the
app is signed the same way. Under the hardened runtime a program without
`com.apple.security.device.audio-input` is refused the microphone without a
prompt, and CoreAudio hands the recorder silence. The Homebrew formula's
binary is only linker-signed (`flags=0x20002(adhoc,linker-signed)`, no
runtime), so this gate does not apply to it.

The failing session had started on 2026-10-07, before ADR-044, under a
pty-host that does not disclaim, which is why the daemon was responsible.
A session started since ADR-044 is responsible for itself, and `claude`
(Developer ID, hardened runtime) carries the entitlement; the daemon is
still responsible wherever the disclaim does not happen (sessions from an
older pty-host, a macOS without the private call, anything the daemon starts
unwrapped), and the app is responsible for a daemon it starts with `caprock
up` rather than through launchd.

**The decision.**

- **The app and the daemon it bundles are signed with
  `com.apple.security.device.audio-input`** (`app/src-tauri/Entitlements.plist`,
  `bundle.macOS.entitlements`). The bundler signs the sidecar with the
  same options as the app, and the app copies the sidecar byte for byte to
  `<data_dir>/bin/caprock`, so the launchd daemon carries it too.
- **The app's Info.plist gains `NSMicrophoneUsageDescription`**
  (`app/src-tauri/Info.plist`, merged by the bundler): the sentence macOS
  shows when the app is the responsible program.
- **Checked at build time.** `scripts/check-app-mic.sh`, run by CI's macOS
  app job and by `scripts/app-release.sh`, fails when the app, the daemon or the terminal holder (`caprock-pty-host`, ADR-033) lacks the entitlement or the Info.plist lacks the
  string.
- Nothing else is asked for: no camera, no other entitlement.

**Rejected.**

- *Running the daemon from `Caprock.app/Contents/MacOS/`* so the bundle
  answers for it: the copy outside the bundle exists because an unsigned
  app may run translocated from a random read-only path and a login service
  must outlive the app being moved or deleted (ADR-040). The entitlement is
  needed either way, since the bundle's binaries run with the same hardened
  runtime.
- *An Info.plist linked into the Go binary* (`-sectcreate __TEXT
  __info_plist`): external linking, so a C toolchain for every darwin
  build, for a purpose string that the log shows is not what refused the
  request; the formula's binary has no runtime gate to pass.
- *Signing without the hardened runtime*: the entitlement is the narrower
  change, and a Developer ID build has to be notarized, which requires the
  runtime and then this entitlement anyway.

**Consequences.** When the daemon or the app is the responsible program, a
recording agent now gets macOS's one-time prompt, naming "caprock" (the
daemon) or Caprock (the app), and works after Allow. Being ad-hoc signed,
the answer lasts until the next release (ADR-040). A Homebrew-only install
has no runtime gate; its prompt names "caprock".

**Unverified.** That the prompt appears and recording then works needs a
person at the microphone; no test here may raise a privacy dialog. Also
unverified: that a session whose responsible program is a daemon binary
replaced on disk since it started is judged by the new file (tccd's log
reads the responsible program's static code from its path, which suggests
so).

**Revisit if** Caprock is Developer ID signed (keep the entitlement; the
daemon as an `SMAppService` helper may change who is responsible), or an
agent needs another device.

## ADR-046 — The agent pickers list every agent with what it lacks; Grok Build is a sixth agent; custom agents are Premium

**Date:** 2026-10-10 · **Status:** accepted

The owner, 2026-10-10 (translated): "When you create a new session or chat
there's a model choice, and OpenCode there is empty — either give buttons to
connect it or remove it"; "Gemini is missing — I think it was on the paid
tier; in any case we need to finish this part"; "I also want to add Grok";
"I'd also let people add new agents themselves, but in Premium (Pro)."

**What was wrong.** The pickers knew one fact per agent: whether its binary
was found. OpenCode was offered with *OpenCode default* and nothing else even
on a machine with no provider connected, so it had nothing to run on. An agent
that was not found was hidden, so the way to get it was nowhere — which is how
Gemini CLI, installed under nvm, read as "missing". Gemini CLI as an agent was
never paid ([ADR-026](#adr-026--gemini-cli-is-a-session-caprock-starts-not-a-chat-panel-it-owns)
is free); the paid Gemini feature is *Ask Gemini* on the Cost screen
([ADR-023](#adr-023--gemini-runs-on-a-key-caprock-never-holds-read-from-the-environment)),
and that stays as decided.

**The decision: one catalog.** `GET /v1/agents/catalog` lists every agent
Caprock knows — Claude Code, Codex, OpenCode, Gemini CLI, Grok and the user's
custom ones — with installed, ready, the models its own files list, whether
Caprock reads its sessions, and, when something is missing, a sentence, the
command that fixes it and the agent's own docs page (`internal/agentcat`). It
reads files the agents already wrote and the login shell's environment, and
runs nothing: `opencode models` and `grok models` fetch catalogs over the
network, and rule 4 forbids a call the user did not switch on.

- **OpenCode** is connected when a provider has a credential
  (`<data>/opencode/auth.json`), an entry in its config, or one of its
  environment variables set — the three sources `opencode providers list`
  shows (opencode 1.15.10). Its models are those providers' models from the
  models.dev catalog OpenCode cached (`<cache>/opencode/models.json`), as its
  own `provider/model` ids. Nothing connected: *no provider connected*, with
  `opencode auth login`.
- **Not installed**: the agent stays in the list, after the installed ones and
  marked, never the default; picked, it shows the official install command.
- **The fix is typed, never run.** *Install in a shell tab* / *Connect a
  provider* opens a Caprock shell tab with the command at the prompt
  (`POST /v1/shells` `type`), after the shell has drawn its prompt, without
  Enter and with anything after a line break cut off. The user reads it and
  runs it. A copy button and the docs link stand beside it, and the
  dashboard's dialog, which has no tabs, offers those only. Rule 7 holds: the
  shell is one Caprock started.
- **Binaries under nvm, Volta, `~/.npm-global` or bun** are found even when
  the login shell's PATH does not carry them.

**Grok Build.** xAI ships an official terminal coding agent, `grok`
(docs.x.ai/build/overview, read 2026-10-10). Its argv was read from the real
`grok --help` (grok 0.2.114) and is Claude-shaped: `--session-id <uuid>`,
`--resume`, `--fork-session`, `--model`, `--permission-mode` with Claude
Code's own mode names, `--rules` for appended instructions, and the first
message as a positional prompt. It is launch-only: its sessions are written to
`~/.grok/sessions/<cwd>/<id>/` (`updates.jsonl`, `signals.json` with token
usage), but Caprock does not read them, because a cost would need Grok prices
in `pricing.json` that nobody has sourced (rule 6). The session row, terminal
and tab are there; turns and cost are not, and the pickers say so. Details and
traps in [23-grok.md](23-grok.md). Its glyph is a neutral one of ours: no
xAI mark is licensed for use here.

**Custom agents (Premium).** In Settings → Custom agents a licensed user adds
an agent by name, command, arguments (one per line; `{prompt}` is the first
message, `{model}` the model; an argument whose placeholder has no value is
left out with the flag before it) and optional models. It is stored in
`config.json` (`custom_agents`), listed in the catalog as `custom:<id>`, and
started in a Caprock terminal like the built-ins. Rules:

- **Gated on the server, on the existing offline licence**
  ([ADR-022](#adr-022--the-licence-key-is-an-offline-string-with-an-expiry-and-nothing-more)):
  `PUT /v1/agents/custom` answers 402 without an active licence, and a spawn of
  a custom agent is refused without one. The list is kept when a licence
  lapses (the catalog marks those agents locked), so renewing restores them.
  Free users see the section behind the Premium lock with the upgrade path,
  as the daily cap and the window stop are shown.
- **The command comes from the config, never from the request.** The browser
  names `custom:<id>`; the daemon looks it up, resolves the binary like an
  agent's, and fills the template. Each argument stays one argument — nothing
  passes through a shell. A paired phone may neither set nor start one
  (ADR-034: a phone starts only the agents Caprock knows).
- **No observation, no mapped flags.** Caprock does not know a custom agent's
  flags, so no permission mode is mapped and no session is resumed; it reads
  no turns or cost for it, and the Settings section and pickers say so.

**Rules out:** running an install or sign-in for the user; asking an agent's
CLI over the network for its models; inventing Grok prices to show a cost;
custom agents as a shell string; letting a request carry a custom command.

**Revisit if** Grok's session files are priced (a Grok entry in
`pricing.json` with a source), which would make Grok observed like Codex; or
OpenCode moves its credentials out of `auth.json`.

---

## ADR-047 — The owner talks to his agents through his own Telegram bot; integrations he turns on may leave the machine

**Date:** 2026-10-10 · **Status:** accepted (owner, 2026-10-10)

*Builds on [ADR-024](#adr-024--the-weekly-report-holds-a-bot-token-and-only-reports-what-a-baseline-supports)
(the stored bot token), [ADR-036](#adr-036--a-phone-hears-that-a-session-needs-it-through-the-owners-own-telegram-bot)
(the free alerts) and [ADR-035](#adr-035--a-permission-prompt-is-answered-with-a-button-found-by-its-hook)
(answering a prompt). Amends rule 4's wording.*

The owner wants to chat with his agents from Telegram instead of opening the
phone app (translated): every message must say which agent it came from —
agent, project and session — and replying should reach that session. He
expects people to buy Caprock for it, and wants it on the site.

**The decision.** The bot the alerts already use becomes two-way. Each user
creates their own bot with `@BotFather`; there is no Caprock server. The
daemon reads what the one paired chat sends with `getUpdates` long polling, so
nothing on the machine listens and a laptop on mobile data is reached the same
way as one on the office Wi-Fi — the reachability ADR-034 cannot give without
a relay. Every message the bot sends opens with a header naming the agent
(with a coloured mark), the project and the session's title — *🟠 Claude Code
· caprock · Fix the cache test* — and the status moves to the second line.

**Setup is guided, and the chat is paired, not typed.** Settings → Telegram:
paste the token, Caprock checks it with `getMe` and keeps it only when
Telegram knows it, then shows a six-digit code and a `t.me/<bot>?start=<code>`
link. The first **private** chat to send the code within ten minutes becomes
the only chat the bot listens to; a group is refused, five wrong codes end the
pairing, and every message from any other chat is dropped without an answer.
This replaces the chat-id field (open `getUpdates` in a browser, copy
`chat.id`). A chat id typed in before keeps working, for the alerts and the
weekly report, and is shown as set by hand.

**The token.** Stored where ADR-024 put it: `config.json`, `0600` in a `0700`
data directory, write-only over HTTP. The screen shows `••••••` and its last
four characters with the bot's `@name`. It never appears in a log line, an
error or a response — a transport error carries the request URL, which carries
the token, so the URL is dropped before an error leaves the client. What the
bridge learns as it runs (the bot's name, the paired chat's name, the update
offset, which message was about which session, mutes) is `telegram.json` in
the same directory, also `0600`. **Keychain and Credential Manager later:**
once the app is Developer-ID signed, the token moves to the OS store; with
ad-hoc signing every update would ask for access again.

**Free and Premium.** Alerts stay free, as ADR-036 decided, and gain two
buttons that need no licence: *Mute this session* and *Open on phone* (when
phone access is on). Talking back is Premium, checked on the server with the
offline licence of ADR-022 — it reaches the network and controls sessions, the
class ADR-023 gated in the daemon — **and** a switch, *Let my paired chat talk
to sessions*, off until turned on even with a licence, because it is control
of the machine from outside it. Premium covers: a reply to a session's message
types into it and presses Enter; `/sessions`, `/new <project> <message>`,
`/stop <n>`; Approve and Deny under a question. Without a licence (or with
the switch off) the chat hears one short line saying so, at most once a day,
and never "coming soon" (rule 11).

**Rule 7 below the bridge.** A reply is typed only into a session Caprock
started and is running; for any other the answer is *I can only watch this
one*, and the daemon's typing path refuses it again whatever the bridge asks.
`/stop` is the same. A session waiting on a permission prompt is not typed
into: text in a menu would answer it.

**Approve and Deny are the card's answer, not a second one.** They call
`AnswerPermission`, which reads the menu off the session's screen and presses
the matching option's key — the path fixed in 0.78.2 after a card typed `2`
into a Yes/No menu and rejected calls the owner meant to approve. They appear
only when the prompt is the only one outstanding (ADR-035, amended
2026-10-09), and are replaced by the outcome once pressed.

**A conversation answers at once.** The alert waits a minute after a Stop so
that someone at the keyboard is not paged. A session the owner typed into from
Telegram, or started there, is answered there for an hour: its questions go
at once, every time, and its reply the moment its turn ends — the whole reply
up to 3,000 characters, inline code and bold kept, each fenced code block a
one-line note (*[go, 12 lines]*) unless *Send code blocks in replies* is on.
The rules' own alerts skip that session meanwhile.

**`/new` and Bypass.** `/new` starts Claude Code in a listed project (exact
name, else the only one it starts, else the only one containing it) in the
owner's default mode. When that is Bypass, the bot asks first (*Start in
Bypass* / *Ask first instead* / *Cancel*), and the one-time consent of ADR-041
still applies.

**Telegram's limits.** One message a second to the chat; a 429's
`retry_after` is waited out (up to ten seconds in the call, the queue held for
longer ones); more than three plain messages waiting are joined into one; an
alert not out within thirty seconds is dropped rather than sent late, as
ADR-036 never retries.

**Rule 4, reworded.** It said the release check was the single exception.
That stopped being true with Gemini (ADR-023), the weekly report (ADR-024),
the alerts (ADR-036) and GitHub (ADR-039), each argued in its own ADR. The rule
now says what all of them share: loopback listeners only, no telemetry,
nothing ever sent to Caprock, and the only outbound calls are the release
check and **integrations the user turns on — off by default, revocable, to a
destination the user chose, and saying where they are switched on what they
send**. `CLAUDE.md`, `.ai/00-index.md` and `.ai/06-engineering-rules.md` carry
the same wording. What Telegram is sent: the alert text ADR-036 describes,
the replies above, the session list, and nothing while no bot is set up or
nothing needs answering — no update is read then either.

**Rules out:** a relay or server of ours; a webhook (an inbound port);
answering any chat but the paired one; pairing a group; typing into a session
Caprock did not start; a digit typed blind into a menu; sending code unless
the owner switches it on; logging or returning the token.

**Revisit if** the app is Developer-ID signed (move the token to the OS key
store); a user asks for a second chat (a family or team group needs per-person
rules, which this one-chat design does not have); Telegram changes what a bot
may read; or Codex and OpenCode report turns and prompts, which would make
their replies flow here with no change to the bridge.

*Amended 2026-10-14 by [ADR-062](#adr-062--caprock-may-ask-a-question-and-the-user-may-send-the-answer-to-caprockdev):*
besides the integrations the user turns on, one survey answer may go to
caprock.dev, only on the user's click, after the card names every field.

---

## ADR-048 — Several sign-ins per agent, each in a config directory of Caprock's; three per agent are free

**Date:** 2026-10-10 · **Status:** accepted

The owner, 2026-10-10 (translated): "make subscription management so several
subscriptions can be authorised and you can work through them." Decided with
it: three subscriptions per agent kind are free, a fourth and more are
Premium. Orca, a competitor, offers it free; parity is the reason it is not
paid outright. (ADR-047 is the Telegram bridge.)

**What the agents document, read 2026-10-10.**

- Claude Code: "To stay signed in to multiple accounts at once … give each
  account its own configuration directory … Each directory has its own
  settings, session history, and claude.ai login or API key", and with
  `CLAUDE_CONFIG_DIR` set it "keys the macOS Keychain entry to that directory
  too, so a session with a different `CLAUDE_CONFIG_DIR` reads a different
  entry" (code.claude.com/docs/en/authentication). The path must be absolute
  (code.claude.com/docs/en/env-vars). `claude auth login` is the sign-in
  (code.claude.com/docs/en/cli-reference).
- Codex: "Codex stores its local state under `CODEX_HOME`"; `file`
  credentials are `auth.json` under it (developers.openai.com/codex/auth,
  /codex/config-advanced). Its keyring entry is keyed by a hash of the
  `CODEX_HOME` path — `compute_store_key` in
  github.com/openai/codex `codex-rs/login/src/auth/storage.rs` — so a second
  directory is a second entry there too. `codex login` is the sign-in.

No real sign-in was run to check this: it opens a browser and, on macOS, the
Keychain, and that is the owner's to do.

**The decision.**

- **A subscription is a directory**: `<data dir>/profiles/<id>/`, stored as
  `{id, label, agent, created_at}` in `config.json`. The user's normal
  sign-in is the **Default** subscription — never stored, always listed,
  `''` on a session.
- **Caprock never signs anyone in.** Adding one makes the directory and types
  the agent's own sign-in, pointed at it, into a shell tab, not run; the user
  presses Enter. Whether a directory is signed in is read from what the
  agent wrote (`oauthAccount` in its `.claude.json`, `.credentials.json`,
  Codex's `auth.json`) — nothing is run, no secret is kept, the Keychain is
  never touched.
- **A new Claude Code directory gets Caprock's hooks and status line**, the
  same entries `caprock hooks install` writes into `~/.claude/settings.json`,
  because a new `CLAUDE_CONFIG_DIR` is a new `~/.claude` and a session in it
  would otherwise be invisible. The user's acceptance of the bypass warning
  is carried over (ADR-041: it is the user's consent, not an account's).
  Nothing else is copied: settings, plugins and MCP servers start at the
  agent's defaults, and the page says so.
- **A session runs on the one picked**, in New agent and Quick chat, shown
  only when an agent has more than one, remembered per project. The daemon
  sets `CLAUDE_CONFIG_DIR` or `CODEX_HOME`; the request names an id, never a
  path. A continued session runs on the one it ran on. Sessions record it
  (`sessions.subscription`, migration 0044); the session's card, inspector
  and page name it, and Settings shows each one's last seven days.
- **Plan windows are per subscription**, stored under `sub:<id>:` and never
  over the Default one's. The near-limit note (≥ 90% of a current window on
  the chosen subscription) names one with room, and a click picks it for the
  next session only. **Never a switch of a running session, never an
  automatic rotation**: the providers' terms do not allow working around a
  plan's limits, so the product offers a choice the user makes and its copy
  says "you choose which subscription this session uses", nothing about
  avoiding limits. The plan-window stop watches and pauses the Default
  sign-in's sessions only.
- **Three per agent free, the Default one included**; the daemon refuses a
  fourth without a licence (402) and the page opens the Premium dialog.

**Rejected.** Copying `~/.claude` into each directory (it would copy the
user's credentials file on Linux and Windows, and settings drift apart from
the copy); rotating to the subscription with room when one fills (terms, and
a session's conversation lives in its own directory); running `claude auth
status` to read a sign-in (it is a process reading the Keychain, from a
daemon, on a timer).

**Revisit if** Claude Code or Codex add a documented account switch that does
not move the whole configuration directory, or stop keying credentials to it.

**Amended 2026-10-12: Make default and a plan per account.** A tester could
not change which account new sessions use without signing the default in
again, and had one plan picker for accounts on different plans. The own
sign-in stays what `claude` uses with no variable; *Make default* is
Caprock's choice of directory for the sessions it starts when none is
picked (`default_subscription` in `config.json`) — moving or rewriting
`~/.claude`'s credentials was rejected: it would touch the Keychain and the
user's own terminal sessions. A running session still never changes
account; the inspector offers a relay (ADR-032) onto another. Each added
account may carry its own plan; the main plan stays the own sign-in's and
the fallback, so nothing already stored moves and no migration is needed —
it all lives in `config.json`.

**Amended 2026-10-13: Claude Code on DeepSeek is an entry in the same
picker.** The owner, 2026-10-13 (translated): "in sessions you should be
able to use DeepSeek" — a user wants to start Claude Code from Caprock on
DeepSeek's models, not DeepSeek Harness. Free, decided with it. DeepSeek
publishes an Anthropic-compatible endpoint and the variables Claude Code
needs (api-docs.deepseek.com/quick_start/agent_integrations/claude_code,
read 2026-10-13), and Claude Code documents that a credential variable
replaces the saved claude.ai login for the process and that the
subscription's limits then do not apply (code.claude.com/docs/en/llm-gateway,
read the same day).

- **It is offered as a subscription, `id: "deepseek"`,** because the
  question it answers is the picker's: which account pays for this session.
  Its sessions record it in `sessions.subscription` (no migration), so the
  rules above carry over unchanged — their plan windows, if any, never land
  on the Default one's, the plan-window stop leaves them alone, the card
  names it, a relay can start one. It has no directory: the session uses the
  user's own `~/.claude`, so its settings, hooks and history are the user's.
  It is not a sign-in, so it does not count toward the free three, and it
  cannot be renamed, made the default or removed there; the key is removed
  in Settings, where it is pasted.
- **The key is the user's, write-only, and goes only into the child's
  environment** as `ANTHROPIC_AUTH_TOKEN` — not `ANTHROPIC_API_KEY`, which
  Claude Code makes the user approve once in the session. Caprock makes no
  call with it (rule 4: the session talks to DeepSeek, as a session already
  talks to Anthropic), and Settings and the launcher say what the session
  sends where before one starts.
- **Never offered as the way past a Claude limit.** The near-limit note
  names only sign-ins: a different provider is a different model, not more
  room on the same plan, and steering a user to it is not Caprock's call.

**Rejected:** a new agent kind (`claude-deepseek`): every Claude Code
surface — hooks, transcripts, resume, permission modes — would need it
taught; and a model entry in the launcher's Model list: the provider
changes the credential and the endpoint, not only the model, and a model
list cannot say where the work goes.

## ADR-049 — Caprock keeps the computer awake while agents work; on by default

**Date:** 2026-10-11 · **Status:** accepted

An agent left on a long task overnight stops when the Mac idles to sleep, and
the morning finds half a run. Orca, a competitor, offers *on / while working /
off*. Caprock already knows which sessions are working, of every agent and
whoever started them, so it is the right place to hold the machine awake.

**Decision.**

- **Three modes**, `keep_awake` in `config.json`: *Off*, *While agents work*
  and *Always* (while Caprock runs). Settings → *Keep awake*.
- **Idle system sleep only, never display sleep.** The screen still dims and
  locks, and a laptop's lid still sleeps it. macOS: `caffeinate -i -w <daemon
  pid>`, a child that exits with the daemon, crash included. Windows:
  `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` from one OS
  thread kept for the purpose; Windows drops it when the process exits.
  Linux: `systemd-inhibit --what=idle:sleep --mode=block` around a shell loop
  that ends once the daemon's pid is gone; without `systemd-inhibit` the
  setting says it cannot, rather than pretending.
- **Working** means a session, of any agent, whose turn is in progress: the
  main thread mid-turn, subagents still at work after it, or a permission
  dialog waiting for an answer — the machine must stay reachable for an
  approval sent from the phone. A finished turn waiting for the next prompt
  does not count. Thirty minutes of silence ends it whatever the last event
  said: a tool call in flight sends nothing until it returns, so a long
  build is believed for half an hour, and a session whose process died
  mid-turn stops holding the machine after that.
- **The daemon checks every 15 seconds** and on a changed setting at once,
  takes the assertion when wanted and releases it when not, and on exit.
- **Nothing here may break anything.** The OS call sits behind an interface;
  a helper that will not start is logged once, reported on the setting, and
  tried again after five minutes; one that dies on its own counts as a
  failure, not a hold. A failed query counts as nothing working, so a
  broken check lets go rather than holding forever. Tests never run the
  real helpers; the smoke run and in-process test daemons get no holder.
- **Default: *While agents work*.** It is safe because it is narrow: idle
  sleep only, released within a check of the last agent stopping, bounded by
  the half-hour silence rule, never across a closed lid, and costing one
  sleeping child process (none on Windows) only while held. Off by default
  would leave the feature where nobody finds it until a night's run is lost,
  which is the complaint it answers. A status-strip mark (*awake*, a cup)
  says when it is holding, so the machine staying up is never unexplained.

**Not rule 7.** Nothing is signalled or typed into an agent: the only
process Caprock stops here is the helper it started.

**Rejected.** IOPMAssertion through cgo (the binary is static and
cgo-free; `caffeinate` does the same through the same API); holding display
sleep too (a screen left on all night is a battery and a privacy cost the
user did not ask for); counting a session waiting at the prompt as working
(it would hold the machine for as long as a terminal stayed open).

**Revisit if** users report the machine staying up when nothing visibly
works, or ask for the display to stay on as well.

## ADR-050 — A new copy is ready to run: .worktreeinclude files come along, and a project's setup command runs in the agent's terminal first

**Date:** 2026-10-11 · **Status:** accepted

A fresh worktree is a checkout of what git tracks and nothing else: no `.env`,
no `node_modules`. An agent started in one fails on its first test run, or
spends its first minutes installing what the main checkout already had. Claude
Code's own `--worktree` and Orca copy the git-ignored files a repository lists
in `.worktreeinclude`; Orca also runs a per-project setup command. (ADR-049
is keeping the computer awake, decided the same night in its own change.)

**Decision.**

- **`.worktreeinclude`**, with Claude Code's semantics: gitignore patterns in
  a file at the repository root, and a file is copied only when it matches one
  **and** git ignores it — a tracked file is already in the worktree, and an
  untracked file nobody ignores is work in progress. Git decides both (`git
  ls-files --others --ignored --exclude-from=.worktreeinclude`, then `git
  check-ignore`), so the semantics are git's own. Applied to every worktree
  Caprock makes: a New agent copy and the sidebar's new copy (`POST
  /v1/projects/{id}/worktrees`, which reports it in `copied`).
- **The copy never leaves the worktree.** No path with `..`, never an
  overwrite (the worktree's own file wins), a directory resolved through
  symlinks must still be inside the worktree, and a symlink is recreated only
  when it is relative and points inside the repository; anything else is
  skipped and counted. At most 5000 files and 256 MB; past that the copy stops
  and says so.
- **A setup command per project**, `defaults.setup_command` (no DDL change:
  the column is already JSON). It runs only in a worktree created for the
  agent being started, never in one reattached to, never in the main
  checkout.
- **In the agent's own terminal, before the agent.** The session's process
  is `caprock worktree-setup -- <agent> <args…>`: it prints what was copied,
  runs the command through `/bin/sh -c` (`cmd.exe /d /s /c` on Windows) with
  no input, prints how it went, then **becomes the agent** — `exec` on macOS
  and Linux, so the pid Caprock recorded, signals and watches is the agent's;
  on Windows it starts the agent and waits, inside a kill-on-close job so
  stopping the session stops both. The command and its limits travel in the
  environment and are removed before the agent starts.
- **Never blocks for long.** Ten minutes at most, then the whole process tree
  is stopped (its own process group; `taskkill /T` on Windows); Ctrl+C skips
  it; a failure is shown in red and the agent starts anyway. A first message
  that is typed into an agent (OpenCode) waits for the wrapper's marker, so
  it is never typed into the setup.
- **Set on the machine.** A paired controller may start agents but may not
  set or change a project's setup command (`403`): it is a command this
  machine runs, and shells are not a phone's either (ADR-034).
- **Nothing here can stop a spawn.** A failed copy is logged and said in the
  terminal; a daemon with no Caprock binary to run the wrapper from (an
  in-process test) starts the agent without the command and logs why.

**Rejected.** Running the command in the daemon and blocking the start
request on it (minutes with no output, and a request that outlives its
caller); a shell wrapper around the agent (`sh -c 'setup; exec claude'`: no
timeout without job control, and no `exec` on Windows); copying every ignored
file (a `node_modules` per copy, gigabytes, for a repository that did not ask);
a separate setup tab (two places to look, and the agent would start before the
setup ended).

**Revisit if** Claude Code changes `.worktreeinclude`'s semantics, or users
want a per-project timeout or a teardown command when a copy is removed.

## ADR-051 — Saved prompts and commands: kept by the daemon, used anywhere, changed on the machine

**Date:** 2026-10-11 · **Status:** accepted

People type the same things into their agents many times a day — "run the
tests and fix what fails", "commit and open a PR" — and the same shell lines
— `pnpm dev`. On a phone each one is a paragraph typed on glass. Orca has
Quick Commands: saved shell commands and agent prompts, global or per
project, run from the tab bar and synced to its phone app.

**Decision.**

- **Two kinds, one list.** A *prompt* is text for an agent; a *command* is
  one shell line. Each has a name and is for every project or for one. The
  daemon keeps them (`saved_prompts`, migration 0045), not the browser, so
  the phone, the app and a browser tab see one list.
- **A prompt goes only to a session Caprock started** (rule 7), through the
  input path the keyboard uses: the text with line breaks as ESC CR, then
  Enter on its own. On the desktop, ⌘K and the tab strip's + → *Run saved…*
  send it to the session in front when that is a running session Caprock
  started; otherwise New agent opens with it as the first message, never
  into anything else.
- **A command runs in a new shell tab**, in the folder in front — the focused
  session's worktree, else the project's root — typed and then Enter
  (`POST /v1/shells` gained `run`). One line only, so what runs is what was
  shown. Never in an existing shell: something may be running there.
- **The phone gets prompts as chips** above the message field, in the chat and
  the terminal's keys bar, for every project and the session's own. A tap
  puts the prompt in the field and does not send it: one more tap, with a
  chance to add a file name, and no prompt sent by a stray touch. The phone
  gets no commands: shells are not a phone's (ADR-034, ADR-050).
- **Changed on the machine only.** A paired device reads the list and may
  not add, change or delete one (`403`): a command is something this machine
  runs, and Settings are the machine's (ADR-029). Settings → *Saved prompts
  and commands* edits them.
- **Small.** A name of 80 characters, a prompt of 8 KiB, a command of 1 KiB,
  200 rows in all: these are shortcuts, not documents.

**Rejected.** Browser storage (the phone would not see what the Mac saved);
the daemon's `config.json` (a list people add to daily is data, and Settings
writes would race the editor); sending a chip's prompt at once (one stray tap
sends a paragraph to an agent with permissions skipped); commands from the
phone (a shell is not a phone's, and a command saved on the Mac would run on
the Mac from the phone); running a command in an existing shell (it may be in
the middle of something).

**Revisit if** people want variables in a prompt (`{file}`, `{branch}`), a
key per saved prompt, or commands from the phone once shells are.

## ADR-052 — One prompt, N attempts: separate copies from one commit, compared by what they changed and what they cost

**Date:** 2026-10-11 · **Status:** accepted

Asking an agent once is a sample of one. Orca's headline flow runs the same
prompt in several worktrees, one agent each, and lets the user pick. What
Orca cannot show is what each attempt cost; Caprock prices every session it
reads, so the comparison can say it.

**Decision.**

- **In New agent, under a new copy of a branch**: *Attempts*, 1 to 4, default
  1 and not remembered. Two or more need a first message (it is what each one
  works on). One request, `POST /v1/agents` with `attempts`; the daemon starts
  the same agent with the same message, model, mode and sign-in N times, each
  in its own copy (`caprock/<name>-1` … `-N`), through the ordinary spawn — so
  `.worktreeinclude` and the project's setup command (ADR-050) apply to each.
- **The same starting code.** The base is fetched once, for the first copy;
  the others start from the commit the first copy started from, not from the
  branch name again, which may have moved or may differ from its remote.
- **Grouped, not merged.** Each session records its group, its number and the
  total (`attempts`, migration 0046) and is titled *attempt 2/3 · …* in tabs,
  the sidebar and ⌘K. All N open as tabs, the first in front.
- **Compare** (⌘K *Compare attempts: …*, or *Compare* in the inspector of an
  attempt) lists them side by side: state, files changed and lines added and
  removed since the shared commit (committed, uncommitted and new), cost so
  far from the session's own pricing (the cheapest marked), and time, with
  *Open* and *Review changes* (the copy's Changes view) on each. Read again
  every five seconds while open.
- **The user picks.** Nothing is merged, committed, stopped or removed by
  Caprock: the one kept is committed or opened as a pull request from its
  Changes view, the others stay until the user removes their copies.
- **A failure stops the rest** and is said beside the ones that started; the
  group's total is what started.
- **At most four.** Each attempt is a folder, a setup run and an agent's
  spend; four is already a lot of all three on one machine.

**Rejected.** Different agents per attempt in the first version (one more
choice per row in a sheet that is already full; the same agent is what the
gap analysis asked for, and a mix can come later); starting the copies in
parallel (git's worktree list is one file per repository and concurrent
`worktree add` races on it); measuring changes against the trunk as the
Changes panel does (a base other than main would count the base's own
commits as the attempt's); picking a winner automatically (tests and taste
are the user's; cost alone is not quality).

**Revisit if** people want different agents or models per attempt, a test
command whose result the comparison shows, or a one-click *keep this one*
that removes the other copies.

## ADR-053 — Queued messages: the daemon holds what the chat sends mid-turn and types it in when the turn ends, one per turn

**Date:** 2026-10-11 · **Status:** accepted

Typing the next instruction while the agent works is how people use Claude
Code, and on the phone it is the only way: the chat field typed straight into
the running turn, and the only queue was the phone's own while it was offline
(*Will send when connected*). Orca queues messages in its chat; the gap
analysis of 2026-10-11 ranked it phone first. With it come the `/` and `@`
pickers, because typing a command name or a path on a phone keyboard is the
other half of the same complaint.

**Decision.**

- **The daemon decides, not the page.** The chat field sends to `POST
  /v1/agents/{id}/queue`; the daemon types the text in at once when the
  session sits at its prompt with nothing queued, and holds it otherwise.
  Held in SQLite (migration 0047), so the phone and the Mac show one queue,
  it outlives a phone going to sleep and a daemon restart, and every change
  is a `queue` frame.
- **Delivered on the turn's end and nothing else.** The end of a turn is the
  session's own `Stop` hook, on the main thread, recorded, and not answered
  "keep going" by the task runner's Stop-loop. After 700 ms the daemon reads
  the state again and types the oldest message only if the session is still
  at its prompt with no permission prompt and no question on the screen.
  Not on silence (a long build is silent), not on `StopFailure` (a rate
  limit would eat the queue one message at a time), never into a menu.
- **One message per turn, in order.** Not "send all as one". Each message
  was written against what the user saw when they wrote it; delivered one
  per turn, the agent finishes one before it reads the next, and the user
  can still edit or cancel the later ones after seeing the first answer.
  Joining them would make one prompt of two decisions and take that chance
  away. The cost — N turns for N messages — is what the user asked for by
  sending N messages.
- **Send now** on a bubble types that one in regardless of the turn — the
  way out when no `Stop` is coming (a turn interrupted with Esc may not
  send one) — and is refused while a prompt or a question is on
  the screen.
- **Only where the turn can be read.** Claude Code with its hooks
  recording. Codex, OpenCode, Gemini and Claude Code without hooks say
  nothing when a turn ends, so their messages are typed in at once, as
  before: a queue that never drains is worse than none.
- **Only Caprock's sessions** ([rule 7](../CLAUDE.md)): the manager types,
  and a session that ends loses its queue, whatever ended it.
- **The keys bar under the terminal is not queued.** What is typed there
  answers what is on the screen, a menu or a question included; a queue
  there would hold the answer. The pickers are in both fields.
- **Pickers read the disk, read-only.** `/` lists the agent's built-ins and
  the `.claude/commands` and `.claude/skills` of the session's folder, its
  repository root and `~/.claude` (Codex: its built-ins and
  `~/.codex/prompts`); `@` lists the folder's files as the file tab does. A
  pick puts text in the field; nothing is sent until Send.

**Rejected.** A browser-side queue (the Mac would not see what the phone
queued, and a sleeping phone would not deliver); delivering when the
session goes quiet (a quiet minute is not the end of a turn); joining the
queue into one message; typing into the running turn and letting Claude
Code hold it (it does, but nothing on the phone would show it, and it lands
in a permission menu as an answer); queueing raw keys (an Esc a minute late
answers a different question — WP-13's rule stands).

**Revisit if** Claude Code reports an interrupted turn in a hook (then Esc
can deliver too), another agent gains a turn-end signal, or people ask to
reorder the queue.

## ADR-054 — The permission mode changes in a running session: Shift+Tab typed in, or the same conversation restarted in the new mode

**Date:** 2026-10-11 · **Status:** accepted (owner asked for it, translated:
"I need to be able to change the approval scheme — ask, bypass and so on —
in an already running session; this is very, very important")

**Context.** The mode was chosen once, at the start, and the only way to
change it was the terminal. What Claude Code allows was read from 2.1.296
itself — `claude --help` and the bundled source — not from memory:

- Shift+Tab (`chat:cycleMode`, sent as `ESC [ Z`; `meta+m` only on
  Windows under a Node runtime outside 22.17–22.x and 24.2+; the native
  build takes Shift+Tab) cycles a live session: default →
  acceptEdits → plan → bypassPermissions → auto → default. Bypass is in the
  cycle only when the process was started with
  `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`
  or `--permission-mode bypassPermissions` (`isBypassPermissionsModeAvailable`);
  auto only when the account's auto-mode gate is open. Setting bypass in a
  process without it is refused: "the session was not launched with
  --dangerously-skip-permissions".
- The footer names the mode: `⏸ manual mode on` (the default is titled
  *Manual* in 2.1.29x), `⏸ plan mode on`, `⏵⏵ accept edits on`,
  `⏵⏵ bypass permissions on`, `⏵⏵ auto mode on`, `⏵⏵ don't ask on`.
- Every hook payload carries `permission_mode`, but no hook fires when the
  mode changes, so only the screen confirms a switch.
- `--allow-dangerously-skip-permissions` shows the one-time bypass warning
  at start exactly as `--dangerously-skip-permissions` does, unless
  `skipDangerousModePermissionPrompt` is already set.

**Decision.**

- **A chip says the mode** in the session header and the agent cockpit: the
  footer read now, else the newest hook or Caprock's own switch, else the
  command line. For a session Caprock did not start it is read-only and its
  tooltip says Shift+Tab in that terminal (rule 7). Other agents show none.
- **Switching in the session is typing Shift+Tab**, one press at a time,
  reading the footer after each, until it shows the mode asked for. It stops
  when a press changes nothing (Shift+Tab rebound, a footer hidden) or the
  cycle comes round without the mode (auto on an account without it), and
  says where the session was left. Never while a permission prompt or a
  question is on the screen, and never mid-turn on a way that passes through
  bypass.
- **A mode the process cannot reach is "Restart in …"**: confirmed first,
  only with the agent at its prompt, the process is stopped and the same
  conversation resumed under its own id with the new flag, the model it had
  and the size of its terminal. The terminal keeps the tab: its exit frame
  says `restart` and it reconnects to the new process. A restart into
  bypass asks for the ADR-041 consent like any bypass start.
- **New Claude Code sessions get `--allow-dangerously-skip-permissions`
  where the bypass warning was already accepted**, in the settings the
  session reads (a subscription's own, ADR-048), so bypass is a Shift+Tab
  away without a restart. Without the consent the flag is not added: it
  would open the session on the warning whose default is *No, exit*, which
  is what ADR-041 exists to prevent. Consent is never written for the user.

**Rejected.**

- **Always adding the allow flag.** A new user would meet Claude Code's
  warning on every start; silently writing the consent to avoid it is the
  path ADR-041 rejected.
- **Counting presses from a table instead of reading the footer.** Whether
  auto is in the cycle depends on the account, and a user can rebind the
  key; a count would land in a mode nobody chose and report success.
- **Setting the mode through a hook's `setMode` permission update.** It
  answers a permission request, so it exists only while one is open — the
  moment the switcher refuses to act.
- **Restarting mid-turn.** It cuts off the work in flight; the menu waits for
  the turn to end instead.

## ADR-055 — Multi-repo projects: a folder of repositories is one project, its members named, its agents given each other repository

**Date:** 2026-10-12 · **Status:** accepted (owner asked for it, translated:
"It must be easy to create new projects or open projects — both monorepo and
several repos. This is very important and must be done carefully.")

**Context.** A project was one git repository (a monorepo already got its
per-directory cost) or one plain folder. A person whose work is `~/work/api`,
`~/work/web` and `~/work/infra` had three rows, three costs to add up, and
agents that could reach only the repository they started in. Adding
`~/work` itself listed a folder with no git state and no split.

What the agents allow was read from their own `--help`, not from memory:

- Claude Code 2.1.296: `--add-dir <directories...>`, "Additional directories
  to allow tool access to". It is **variadic**: its option parser (commander,
  read in the binary) keeps taking words after `--add-dir a` until the next
  option, so a first message passed as the positional prompt after it became
  a directory. `--add-dir=a` takes exactly one value. Caprock already passed
  its paste and chat folders as `--add-dir a`; a start with a first message
  and no project instructions lost the message to that.
- codex-cli 0.161.0: `--add-dir <DIR>`, "Additional directories that should
  be writable alongside the primary workspace", one per flag.
- Gemini CLI: `--include-directories`, an array option.
- OpenCode and Grok Build: no such flag.

**Decision.**

- **Adding a folder that holds two or more repositories asks once** —
  two levels deep at most, never inside a repository, hidden folders and
  dependency trees (`node_modules`, `vendor`, …) skipped, the walk capped:
  *One project of N repositories* (the default) or *N separate projects*,
  each repository a checkbox. A folder inside one repository asks nothing.
- **A multi-repo project is the folder plus named members**
  (`project_repos`, migration 0050). A repository is a member of one
  project; a repository listed on its own is folded in (unlisted, its
  sessions now count here). A member's sessions never list it again.
- **Attribution is by containment, the closest match winning**: a
  session's repository root (else its cwd) goes to the longest project root
  or member that holds it, a member winning a tie. The project's sessions and
  today's spend sum its members and the folder; each member has its own
  share. Monorepos are unchanged.
- **Agents start in the folder** and so already reach every member below
  it. One started inside a member (or in a worktree, or with a member outside
  the folder) gets each other member: `--add-dir=<repo>` for Claude Code,
  `--add-dir <repo>` for Codex, `--include-directories=<repo>` for Gemini.
  OpenCode and Grok start without them. Every `--add-dir` is now written in
  the `=` form, which also fixes the swallowed first message.
- **Git per member, never watched.** A member's `git status` runs once on
  add, edit and daemon start, after an agent edits in it (2 s debounce), and
  when the project page asks (at most every 30 s). No fsnotify tree per
  member and no timer; `GET /v1/projects`, polled every minute by the app,
  never runs git for members. Open pull requests per member are read only
  when the project page opens (`GET /v1/projects/{id}/repos`), one
  conditional GET per repository, kept 60 s.
- **Editing**: rename; tick or untick members; *Rescan* the folder for new
  repositories; merge repository projects in; split into one project per
  member (an absorbed project comes back with its old name and settings).
  Nothing deletes a file. Scan, split and merge are the machine's; a paired
  controller may add or edit members under home.

**Not chosen.**

- **A chosen primary repository to start agents in.** Starting in the
  folder reaches every member without a flag; a primary is a later choice
  if the folder proves wrong for someone.
- **Watching every member like a repository project.** A folder of twelve
  repositories would be twelve more fsnotify trees for state that matters
  when someone looks.
- **A new project kind.** The table's `kind` CHECK would need a rebuild;
  members are a property of a folder project, and an empty member list makes
  it an ordinary one again.
- **Merging projects that share only the home folder.** An agent started in
  home reaches everything; the merge is refused with the reason.

## ADR-056 — The phone home and the Inbox: a home-screen web app that starts chats and saves, and a controller phone may write the Inbox

**Date:** 2026-10-13 · **Status:** accepted (owner picked the layout)

**Context.** The owner (translated): "I really miss a Caprock app on the
phone with quick access — to start new chats, save stuff, and so on." The
phone already had chat, start work and pairing (Phone v2 Phase A), but it
opened on the desktop's Now screen, starting a chat was three screens deep,
and there was nowhere to put a thought for later. A native app is P2 (F22)
and needs store approval.

**Decision.**

- **The web app becomes the phone app.** At phone width `#/` is the phone
  home (04-ui.md § The phone home): what waits on you, Continue, Saved, and
  a field docked at the bottom with **Save** and **Start chat**. The full
  Now screen is `#/now`. Two layouts were drawn at 390×844; the owner chose
  the docked one over tiles at the top.
- **The Inbox is its own table** (migration 0053, 03-contracts.md § Inbox),
  not saved prompts: a saved prompt has a name and is changed only on the
  machine (ADR-051), while an Inbox item is unnamed, may carry photos, and
  is written from the phone.
- **A controller may save to and delete from the Inbox** (`POST
  /v1/inbox`, `DELETE /v1/inbox/{id}` join `controllerRoutes`); a viewer
  reads it. Saving types nothing into any session — a chat starts from an
  item only when the user starts one — so it is less than what a controller
  may already do (start a session with a first message).
- **Files are the daemon's.** Photos are written through the paste path's
  checks into `<data_dir>/inbox`, kept until their item is deleted, and
  served back as images only, so a saved HTML file never runs as the
  dashboard.
- **Shortcuts and Share are declared, not promised.** `manifest.json` names
  New chat and Save shortcuts and a GET share target; they work only in an
  installed web app on an `https` origin, which Caprock does not serve yet
  (OQ-12), and the user docs say they do nothing today.

**Not chosen.**

- **A native app now.** Store review and signing for both platforms, for
  what the web app does once on the home screen.
- **Reusing saved prompts.** It would have opened a machine-only table to
  phone writes and forced a name onto a note.
- **A service worker for the share target's POST.** No service worker can
  register on an `http://` origin, and figures must never be served stale
  (04-ui.md § From a phone).

## ADR-057 — Caprock Mail: an IMAP client inside the daemon, off until the user adds an account

**Date:** 2026-10-13 · **Status:** accepted

**Context.** The owner asked for a mail client to replace Apple Mail as an
experiment: one inbox for every account, fast, local, with AI from a model on
the machine. The alternatives each lack one of those — Gmail's web client
dislikes foreign accounts, Thunderbird is slow, Apple Mail is neither fast nor
searchable. Caprock already has the pieces: a loopback daemon, SQLite, a
dashboard and a desktop app on three OSes.

**Decision.**

- **Inside the daemon, beside it in storage.** `internal/mail` is a separate
  package tree with its own database, `mail.db` in the data directory, so mail
  never shares a migration chain, a vacuum or a lock with the event store.
  It is served under `/v1/mail/*` behind the same pairing gate and CSRF guard
  as every other route, and drawn by a lazily loaded screen at `#/mail`.
- **Off until used (ADR-047).** Before the first account nothing is opened:
  no database file, no goroutine, no connection; `GET /v1/mail/state` answers
  from nothing. Adding an account is the switch, removing the last one ends
  the traffic. Once on, Caprock talks only to the IMAP and SMTP servers the
  user typed in, and — only when AI is turned on in Mail's settings and the
  user runs an AI action — to the AI provider chosen there (amended
  2026-10-15, below) — and, for an account signed in with Google or
  Microsoft, to that provider (below). Nothing is sent to Caprock. The
  add-account form says so.
- **Passwords in the OS keychain**, a 0600 file only where there is none
  (Linux without a Secret Service). iCloud has no OAuth for mail, so an
  app-specific password stays the only way there; any IMAP host takes a
  password.
- **Sign in with Google or Microsoft** (added 2026-10-14). The installed-app
  OAuth flow (RFC 8252): authorization code with PKCE (S256) in the user's
  browser, redirected back to the daemon's own loopback port. What is sent
  where, all only after the user clicks the button: the browser goes to
  accounts.google.com or login.microsoftonline.com and the user approves
  there; the daemon then sends the authorization code and the PKCE verifier
  (with the client ID, and for Google the desktop client's non-confidential
  "secret") to that provider's token endpoint — oauth2.googleapis.com or
  login.microsoftonline.com — and from then on the refresh token to the same
  endpoint for a new access token, about hourly while Mail syncs. The access
  token goes only to the provider's own IMAP and SMTP servers (imap.gmail.com
  and smtp.gmail.com; outlook.office365.com and smtp.office365.com) inside
  SASL XOAUTH2. The refresh token lives where passwords live — the OS
  keychain item of the account — and the access token only in memory. The
  scopes are mail only (`https://mail.google.com/`; Microsoft's
  `IMAP.AccessAsUser.All` and `SMTP.Send`, `offline_access`) plus `openid
  email` for the address. Revoking: remove the account in Mail (deletes the
  token here), and at the provider — Google at myaccount.google.com/permissions,
  a personal Microsoft account at account.live.com/consent/Manage, a work
  account at myapps.microsoft.com or by its Entra admin. The client IDs are
  the Caprock owner's app registrations, compiled in or given by environment
  ([docs/mail-oauth.md](../docs/mail-oauth.md)); without one the button is not
  offered and nothing else changes. The callback is the one `/v1` route the
  CSRF guard admits as a cross-site GET, on a loopback Host only, with the
  single-use state as its protection.
- **Import, not retype.** On first use Mail offers the accounts the user
  already has in another client. `GET /v1/mail/import` reads only that
  client's own local files under the user's home and opens nothing else.
  Thunderbird is read in full: servers from `prefs.js`, passwords decrypted in
  pure Go from `logins.json` + `key4.db` (NSS: PBKDF2-SHA256 + AES-256-CBC key
  wrap, then a 3DES or AES login blob — no cgo, no NSS library); a profile with
  a primary password imports settings only. Apple Mail is read from
  `~/Library/Accounts/Accounts4.sqlite` (the keyed-archiver property store) for
  server settings only — its passwords live in the login keychain under items
  that cannot be matched to an account, so the user types the password once;
  and because that path is TCC-protected, without Full Disk Access the answer
  is `needs_permission: "full_disk_access"` with how to grant it. Nothing read
  for import ever leaves the machine and no password is ever put in an HTTP
  answer (rule 4): on `POST /v1/mail/import` the sources are re-read so the
  decrypted password goes straight to the user's own IMAP/SMTP server and
  nowhere else. *Import everything* (amended 2026-10-14, owner request)
  lists every account found once, merged by address across the apps,
  Apple's Internet Accounts (Google, iCloud, Exchange) included, and walks
  the ticked ones one at a time through the single step each still needs:
  nothing for a saved password, the browser sign-in for Google and
  Microsoft (an app password when the build has no client ID), an
  app-specific password for iCloud, the server's password otherwise. A
  source it cannot read (Apple Mail without Full Disk Access) is not shown
  at all, and each shown source says when its profile was last used.
  Outlook for Mac is not read: its profile is
  in another app's group container, behind an OS prompt Caprock does not
  raise, and its accounts are mostly Microsoft 365, which sign-in covers.
- **Headers are read whole.** The list is built from `BODY.PEEK[HEADER]`,
  parsed locally, never from ENVELOPE or `HEADER.FIELDS`: iCloud has sent
  ENVELOPEs with unescaped quotes in the Message-ID (one bad answer fails
  the whole FETCH, and clients stop syncing) and has answered HEADER.FIELDS
  with another message's lines. A batch whose answer cannot be read is split
  until the one message is found, which is stored without its body structure;
  a folder never stops on one message.
- **Sync shape.** The newest 500 messages per folder first, older history in
  steps of 500 per full pass up to 20,000; text parts fetched by IMAP part
  path, attachments only on demand; IMAP IDLE on INBOX for new mail, a poll
  where the server has none; "All Mail"-style virtual folders are not synced.
- **HTML mail never acts.** Scripts, frames, refreshes and event handlers are
  stripped, and the body renders in a sandboxed iframe under a CSP with no
  script and no network; remote images (tracking pixels) load only when the
  user allows them.
- **The screen polls a change counter** every 4 s while it is open and the
  page is visible, rather than adding frames to the live socket.
- **Offered once.** A *Mail* item marked *new* sits last in the dashboard's
  screen row (not in the app's project sidebar), and one banner offers it
  through the nudge system after two days of use, only while no account
  exists; opening Mail or dismissing it answers it.

- **AI through the provider the user picks** (amended 2026-10-15; the
  owner, translated: "Why only Ollama — just let the user authorise any
  subscription they want, like Caprock does now"). Until then the
  assistant spoke only to an OpenAI-compatible server on the machine. Now
  *Summarise* and *Draft reply* go to one provider chosen in Mail's
  settings: the user's own logged-in coding CLI — Claude Code, Codex or
  Gemini CLI, run headless with no tool, no hooks, no session file and the
  thread on stdin (the Second Brain pattern of ADR-063) — an API with the
  user's key (Anthropic's Messages API; OpenAI, OpenRouter or DeepSeek
  through the OpenAI-compatible API), or the local server as before.
  *Automatic*, the default, takes the first of claude → codex → gemini →
  local that this computer has, so with `claude` installed nothing needs
  setting up beyond turning AI on. What is sent where: the last eight
  messages of the thread (sender, date, subject, text), the user's
  instruction for a draft, and the account's name, to that CLI's vendor
  through the CLI's own login (Anthropic, OpenAI, Google), or to
  api.anthropic.com, api.openai.com, openrouter.ai (which passes it to the
  model's vendor), api.deepseek.com or the local address — only when the
  user clicks an AI action, never in the background. The settings panel
  states the destination for the chosen provider under the picker. Keys
  go through `internal/secret` (the macOS login keychain, else a 0600 file
  in the data directory), never `mail.db`, `config.json` or a log, and no
  route returns one. Mail content is fenced as data between nonce lines
  the instructions name, and no CLI is given a tool, so a message cannot
  make the model act. Turning AI off, or picking the local server, stops
  it; a key is removed from the same panel.

- **Adding an account is an address and a password.** Server settings come
  from a table of about 40 consumer and hosting services, each entry citing
  the provider's own settings page (QQ Mail, NetEase, Naver and Spectrum are
  left out until one can be read); then the domain's MX against that table;
  then RFC 6186 SRV records; then the domain's own autoconfig file; then the
  `imap.` / `smtp.` convention. Discovery asks only the user's own domain,
  never Mozilla's ISPDB or any other directory, so an address goes nowhere
  but where its mail already lives (rule 4).

**Consequences.** One more outbound path exists, to destinations the user
chose (the mail servers, and the AI provider while AI is on); the binary
grows by the IMAP, SMTP and MIME libraries. Not built:
server-side drafts, notifications, rules, mail on a paired phone
(attachments and the iframe's images need the device token, which plain URLs
do not carry).
## ADR-058 — A phone reaches the machine from anywhere, through a relay that carries only ciphertext

**Date:** 2026-10-13 · **Status:** accepted (owner, translated: "I want someone
without an App Store app to use Caprock running on their machine, local or
remote — a laptop or a Mac mini for agents — reliably, through a relay over the
internet, for when I'm out walking the dog. Make it mobile first."). Amends
[ADR-029](#adr-029--a-second-device-gets-in-over-the-lan-with-a-code-or-not-at-all),
which ruled out "a relay of ours", and rule 4 in `CLAUDE.md`.

**Context.** A phone could reach the daemon only on the same Wi-Fi or over
Tailscale, which needs an app from the App Store on the phone — the thing the
owner is avoiding until Apple approves the developer account. A machine at
home sits behind a router, often behind carrier NAT too, and accepts no
connection from the internet. The only route that works behind any router is
two outbound connections meeting at a public address.

**Decision.**

- **Off by default, on by a decision on the machine** (Settings → Phone →
  *From anywhere*, or `caprock remote on`), and **remembered**: unlike the LAN
  listener, the machine this is for is the one nobody sits at. It cannot be
  turned on, or the relay changed, from a phone.
- **The daemon dials out** to the relay (`wss://relay.caprock.dev` by default,
  any relay by `--relay`) at `/v1/host/<id>`; the id is its Ed25519 public key,
  and it proves it with a signature over the relay's nonce. No inbound port, no
  account, no database on the relay.
- **The phone dials the same relay** at `/v1/c/<id>`, and the relay splices
  the two, one Durable Object per machine on Cloudflare (`relay/`), or
  `internal/remote/relaysrv` (`caprock remote relay`) for a relay of one's own.
- **End to end: Noise_NK_25519_AESGCM_SHA256.** The QR carries the machine's
  static X25519 key; the phone runs NK against it, so a relay — ours or
  anyone's — forwards bytes it cannot read or alter, and a reply from anything
  but that machine fails the handshake. Go side `internal/remote/noise.go`,
  phone side `ui/src/remote/noise.ts`, held to the same bytes by
  `testdata/remote/noise-vector.json`.
- **Inside the channel, the phone's dashboard runs unchanged.** Its `fetch()`
  and `WebSocket` for `/v1/…` become streams (`internal/remote/proto.go`), and
  the daemon replays each onto its own loopback marked `Via: 1.1
  caprock-remote` — so the gate treats it as a paired device: the same pairing
  code, device token, viewer and controller roles and revocation as on the LAN,
  not a second set. Browser headers (Origin, Sec-Fetch-*, cookies) are dropped
  inside the channel; paths that could leave loopback are refused.
- **The phone's page is static**, built with `vite build --mode remote` and
  served over https (`m.caprock.dev` by default, any by `--app`). It keeps
  several machines, one at a time, each with its relay, pinned key and token.
  https gives what a plain LAN address could not: an installable app on
  Android, and later Web Push.

**What the relay sees.** Which machine id a phone connects to, when, from which
IP address, and how many bytes pass. Not a session, a token, a command or a
figure.

**Consequences.**

- Rule 4 now reads "nothing readable is ever sent to Caprock": the relay is a
  Caprock service, carries ciphertext only, and is optional.
- The phone's page is code we serve; whoever controls it could read what the
  phone shows. It is the same trust as any web app, stated here, and the page
  can be self-hosted (`--app`).
- The free plan's limits on Durable Object requests are an open question for
  many users (`.ai/12-risks.md`); `caprock remote relay` is the way out.

**Rules out:** relaying plaintext or terminating TLS for the user; an account
on the relay; turning remote access on from a phone; storing anything on the
relay.

*Amended 2026-10-14 — the one way in.* The owner's Android phone was paired
at 15:11 while only the network listener was on
(`http://10.100.102.7:4173`); *From anywhere* went on at 15:12. The phone
kept the Wi-Fi link, reached nothing on mobile data, and nothing said why
(translated): "the phone opens a link with IP 10.100 on the local network, no
online, no internet… maybe I didn't finish setting it up — there are
different settings for remote vs your own Wi-Fi." His decision (translated):
"I'd remove every option except the normal online one — who cares about
working only inside your own Wi-Fi; everyone wants to work online."

- **The pairing panel offers the relay alone.** No Wi-Fi / Tailscale switch,
  no Wi-Fi step, no *Keep on after Caprock restarts* box. **Show a code** on
  the machine turns access from anywhere on when it is off, and a line under
  the button says so: pressing it is the decision on the machine this ADR
  requires, and it is remembered as before. A click that only arrives at the
  section (the sidebar's *phone*, the palette) shows a code only when the
  relay is already on — it never turns it on.
- **The network listener stays, off the screen.** `caprock up --lan` and
  `caprock pair` (which draws the listener's QR while the relay is off) keep
  it for a machine without internet. Ripping it out would cost the
  no-internet case, the Tailscale path and ADR-029/ADR-060's tested gate for
  nothing the owner asked; hiding it costs one footer line — while it is on,
  Settings shows its address with **Turn off**. A build without the relay
  still pairs over it.
- **Each device says how it reaches the machine.** The gate records `via`
  per device — `relay` (a request on loopback carrying `Via: 1.1
  caprock-remote`), `tailscale` (from 100.64/10) or `lan` — in
  `devices.json`, saved when it changes. It is a label, never an
  authorisation. Settings shows *anywhere*, *anywhere with Tailscale* or
  *Wi-Fi link*; a Wi-Fi link gets one line with **Show the code**, the relay
  QR the phone pairs with once more. `GET /v1/pair/me` answers `via` and
  `anywhere`, and a phone on the Wi-Fi link shows a strip naming the app and
  the path to the code.

*Amended 2026-10-14 — a phone that never waits silently.* The same evening
the owner's phone sat on *Connecting…* with nothing after it (translated:
"On the phone I now have 'Connecting' and nothing … apparently some
duplication with installing Caprock"). A computer that went to sleep left its
relay connection open on paper; the relay spliced the phone to it and the
handshake went nowhere, and the phone had no deadline. Separately, Chrome
reinstalled the app from its own prompt in a browser tab.

- **The relay drops a machine unheard for 75 s** (three missed pings): a
  phone arriving or sending is told 4404 at once. No new state on the relay;
  the hosted one reads the runtime's ping timestamp.
- **The phone gives up an attempt after 10 s and says why**, checks the
  machine itself, not only the relay, while connected, retries on its own
  with backoff, and names the problem after 5 s with **Retry** and **Pair
  again** (`.ai/04-ui.md` § From anywhere).
- **Installing is the page's button, once.** Chrome's automatic prompt is
  held for an **Install the Caprock app** button that exists only while
  Chrome says the app is not installed. The manifest `id` stays `/`, so a
  new build is the same app. Existing pairings are untouched.

*Amended 2026-10-14, later — a paired phone stays paired.* Right after the
page and the relay were redeployed, the owner's phone told him to pair again
(translated: "my connection to Caprock dropped and it asks me to go to
Caprock settings again. It has to never drop — hold firm and for a long
time"); his computer still listed it as a controller. Three faults,
reproduced on a stand with a v0.117.0 daemon, the local relay and the page:

- **A phone hanging up mid-answer took the machine off the relay.** The
  daemon wrote each frame with the phone's context, and the WebSocket
  library closes the whole connection when a write's context ends part-way:
  every other phone dropped with it. Writes are now bounded by the relay
  connection's own context; a phone that has gone sends nothing more
  (`internal/remote/host.go`, the same in `relaysrv`).
- **The hosted relay reused a phone's number at once.** It gave a new phone
  the lowest free number, while frames for the phone that had just left
  were still on their way from the machine; the newcomer read one as its
  handshake reply. It now draws a random unused 32-bit number — no storage,
  survives hibernation. `relaysrv` already counted up.
- **The page believed one bad answer.** A message that did not finish the
  handshake was `wrong-machine`, and one 401 anywhere was `removed`, both
  for good. Now a stray message is skipped while the real reply comes;
  `wrong-machine` is three refused handshakes in a row; `removed` is
  `GET /v1/pair/me` saying 401 on two separate connections. Behind either
  screen the page checks once a minute and recovers by itself.

**No new daemon answer for "revoked".** Telling a revoked token from an
unknown one would need the daemon to keep revoked tokens (or their hashes),
new state in `devices.json`, and would still not help a phone talking to
v0.117.0. The confirmation above reads only what every daemon already says,
and lanauth's one 401 for both stays. The page needs nothing new from the
daemon at all: an older daemon answers a newer page's new routes 403 or
404, never 401 (`TestAPhonesTokenIsOnlyDisownedByA401`, which v0.117.0
passes too).

*Amended 2026-10-15 — a paired phone finds its way back.* Vova, our first
user (translated): "yesterday I opened the phone app, then closed the tab;
in Caprock the device shows as paired; today I want to open the app again
but I don't remember the link — and that's it … But even then I can't work
— the link doesn't load; maybe it's some restrictions, my VPN isn't working
well right now." The phone's token was already kept on the page's origin,
so the plain address reconnects; nothing said so, anywhere.

- **The address is the way back, and it carries nothing.** Settings shows,
  beside every paired device, *Already paired — just open m.caprock.dev on
  that phone*, a QR of that address alone and the Add to Home Screen tip.
  The QR pairs nothing: no code, no machine key, no token.
- **Sent to Telegram only where the owner already sends.** *Send the link
  to my phone* (`POST /v1/pair/send-link`, loopback-only) posts the address
  to the chat of the bot the owner connected (ADR-047), through the same
  path as the alerts, and the button says so. No new destination; a phone
  cannot ask for it.
- **The page says which of three things failed**: it cannot reach the relay
  (its connection, a VPN), the relay has no computer (the computer), or the
  computer removed it (pair again), with a folded *Details* of the last
  error, its close code and the times. A browser with no token says *This
  browser isn't paired* and where to pair, not an error.
- **The page asks the browser to keep its storage** (`storage.persist()`)
  once paired: the token is the pairing.

Not done: a service worker that would show the page's shell when
m.caprock.dev itself cannot be reached. A cached shell that then reaches
nothing says little more than the browser's own error, and a stale shell is
a risk of its own.


## ADR-059 — The doctor lists processes that look abandoned, and stops one only on a direct, confirmed click (rule 7 amended)

**Date:** 2026-10-14 · **Status:** accepted (owner approved, 2026-10-14)

**Context.** The owner asked (2026-10-13, translated): "I'd like to be able
to monitor such orphans, including Claude's orphans. Maybe also an
additional cleanup — an advanced mode." On his Mac were a 7-day-old
`caprock pty-host` from an old Homebrew install, a `caprock up` that another
tool had started from a job's temporary directory hours earlier, leftover
preview holders from agent tests, and, he suspected, `claude` processes and
node MCP servers that outlived their sessions. Caprock already stopped its
own reapable terminal holders on its own; everything else it only named, and
rule 7 ("we never signal or type into a process we did not start") kept it
from offering more — a person had to find each pid and run `kill` by hand.

**Decision.**

- **Monitoring anything is allowed.** Reading the process table — parents,
  start times, terminals, argv, environment — signals nothing. The footprint
  gains `orphans`: other Caprock daemons, terminal holders no Caprock will
  reattach to, any other caprock command whose parent is gone, a `claude`
  whose session ended in Caprock's history or whose parent is gone, an MCP
  server whose parent is gone, and what a Claude Code session started
  (`CLAUDECODE` in its environment) that outlived its parent. Each is listed
  with why. The heuristics are conservative: a process with a controlling
  terminal, in a live session's tree, of another user, younger than two
  minutes or inside a macOS app bundle is never listed. The list is taken on
  demand (the open doctor, `caprock doctor`); the 10-minute sweep keeps a
  count for the status strip; there is no new polling.
- **Signalling a process Caprock did not start is allowed only as a direct,
  per-item, confirmed user action from the doctor** — the panel's Advanced
  mode (off by default, on the machine itself: never from a paired phone)
  with a confirmation, or `caprock doctor --stop <pid>` with a prompt (`--yes`
  skips it). The request names pid and start time; the daemon takes the list
  again and signals only a process that list holds with that start time,
  re-checking the start time before SIGTERM and before SIGKILL five seconds
  later (Windows: TerminateProcess). Only that pid is signalled, never its
  children.
- **Never automatic, never by the orchestrator or an agent, never typing.**
  No sweep, rule, cap or agent stops a process Caprock did not start; nothing
  is ever typed into one. Caprock's own reapable holders keep being stopped on
  their own, as before (§ Resources).

**Rules out:** an automatic cleanup of non-Caprock processes; a "stop all"
without a per-item list the user saw; stopping a process tree; the stop on a
paired device's route list.

**Revisit if:** a listed process turns out to be one a user needed and the
heuristics cannot tell it apart — narrow the heuristics before widening
anything.

**Amended 2026-10-15 (owner: the doctor must say what is wrong in one line
and fix it with one button).** The Advanced checkbox is gone: on the machine
itself the doctor shows **Clean up** and a **Stop** per row by default. Each
opens one confirmation that lists every process it would stop on its own line
with its own checkbox, the safe ones ticked (test copies of Caprock in a
temporary folder or worktree, terminals the daemon reaps itself, ended
claudes, MCP servers, Claude Code leftovers, caprock commands outside an app
bundle) and the rest shown unticked with why. One click on *Stop N* then
stops the ticked ones. This is read as satisfying "a direct, per-item,
confirmed user action": the person sees each item, can untick each, and
nothing is signalled before that click; a stop-all that does not show the
items stays ruled out. Unchanged: never automatic, never from a paired
device, never the orchestrator or an agent, pid and start time re-checked by
a fresh scan. Considered and not done: stopping test copies on their own
after N minutes without a client (a Settings toggle, off by default) — that
is an automatic stop of a process Caprock did not start and needs its own
ADR.

## ADR-060 — Phone access may stay on across restarts, when the owner ticks it

**Date:** 2026-10-14 · **Status:** accepted

**Context.** The owner (2026-10-14, translated): "Is it normal that we still
have this feeling that there's no connection with the phone such that you can
reach it from different networks?" His panel said *Phone access is off — It
switches off whenever Caprock restarts*, with Tailscale folded under *Then:
…*, and the only paired device was a Mac last seen 41 days earlier. Two
things made the phone feel disconnected: every restart (an update, a reboot)
closed the door until someone at the Mac turned it on again, and the panel did
not say, until a code was on screen, that "anywhere" needs Tailscale on both
devices. ADR-029 made the listener deliberately not a stored setting.

**Decision.**

- **A stored opt-in, `lan_keep_on` in `config.json`, off by default.** When
  true, the daemon turns phone access on at start as `--lan` would. It is set
  only with `POST /v1/pair/lan {on: true, keep: true}` — the checkbox *Keep
  on after Caprock restarts*, offered beside **Turn on** and under the panel
  while access is on — and **turning access off always clears it**: an "off"
  that comes back at the next start is not off. Existing installs keep
  ADR-029's behaviour until someone ticks it.
- **Why that is safe enough.** Only paired devices get in: every `/v1` route
  but `POST /v1/pair` refuses a request without a device token, codes are
  issued only from the machine, are six digits, single-use, five minutes and
  burned after five wrong guesses, and pairing itself is unchanged. What the
  setting keeps open on the network is the pairing page and the dashboard's
  static files on one named address (or two: LAN and Tailscale), never the
  wildcard. The residual risk ADR-029 named — a laptop opened in a coworking
  space still listening — is that a stranger on that Wi-Fi sees the pairing
  page and cannot get past it. A Tailscale address is reachable only from the
  owner's own tailnet.
- **Where the phone works is said first.** `GET /v1/pair/state` reports
  `tailscale: true` when the machine has a Tailscale address now (read from
  the interface list, listened on or not, while access is off too), and the
  panel leads with *Works on this Wi-Fi only* or *Works anywhere (Tailscale)*.
  Without Tailscale it gives the one step (install it on this computer and
  the phone, same account) with the three downloads. The panel polls the
  state every 5 s while visible, so installing Tailscale flips it without a
  restart.
- **Tailscale that appears while access is on is listened on.** `POST
  /v1/pair/lan {on: true}` while already listening now also opens the
  Tailscale listener when one is missing, leaving the first listener alone;
  the panel sends it once when it sees `tailscale` without a Tailscale
  address. The old "turn phone access off and on" is gone.
- **A new code prefers the Tailscale address** when there is one and the
  owner has not picked another: a phone's token is per address, so one paired
  on the Wi-Fi address works on that Wi-Fi only.

**Rules out:** keep-on by default; keep-on surviving Turn off; any relay in
this decision (that is ADR-058's question, not this one's).

**Revisit if:** a paired device is ever let in without a token, or the
unauthenticated surface grows past `POST /v1/pair` and static files — keep-on
would then be keeping that open too.

*Amended 2026-10-14 by ADR-058 (the one way in):* the checkbox, the
*Works on this Wi-Fi only* / *Works anywhere (Tailscale)* card and the
address choice left the panel with the listener itself. `lan_keep_on` is
still read at start, and **Turn off** in the footer (shown while the
listener is on) still clears it.

## ADR-061 — Draft pull requests run no CI; contributors check locally, CI runs once when a PR is ready

**Date:** 2026-10-14 · **Status:** accepted

**Context.** The owner (2026-10-14, translated) asked for a way for anyone to
contribute by handing their own coding agent one prompt, "with conditions that
tests run locally, so contributors don't hammer our CI/CD — CI should only be
hit by the final PR." Every push to a pull request ran the full three-OS matrix
(ci.yml) and the docs gate (docs.yml), and an agent that pushes to see what CI
says can push many times. `make check` already runs everything CI runs except
the OS matrix.

**Decision.**

- **CI skips draft pull requests.** `ci.yml` and `docs.yml` listen to
  `pull_request` types `opened, synchronize, reopened, ready_for_review`, and
  every job carries `if: ${{ !github.event.pull_request.draft }}` (the app
  builds already depend on `changes`, so they skip with it). Marking a PR
  ready runs the full gate once; pushes after that run it again as before.
  Pushes to `master` are unchanged.
- **Contributors iterate as drafts, with `make check` locally.** The flow and
  the prompt for an agent are in `docs/contributing-with-ai.md`, linked from
  the README's top and from CONTRIBUTING.md: fork, read AGENTS.md, CLAUDE.md
  and the `.ai/` index, `make check` (and `make app-test` for `app/`) until
  green, `gh pr create --draft` with the summary pasted, `gh pr ready` last.
- **A non-draft PR runs exactly as before.** The maintainer's own agents open
  ready PRs and get every job on every push; nothing here needs a label or a
  manual trigger. `master` has no required status checks, so a skipped run on
  a draft blocks nothing.
- **Fork runs still need a maintainer's approval.** The repository's setting
  for workflows from forks was `first_time_contributors` on 2026-10-14; the
  recommendation is `all_external_contributors`, so a ready PR from a fork
  costs CI only after a person has looked at it. A repository setting, not
  code: the owner changes it in Settings → Actions.

**Rules out:** a CI run per push while a contributor iterates; a
label-triggered or `workflow_dispatch`-only gate that the maintainer's own PRs
would also have to pass through.

**Revisit if:** drafts start landing un-run (a PR merged while still a draft
would have no CI result — GitHub refuses to merge a draft, so this needs a
manual mistake), or required status checks are turned on for `master`, which
would need the skipped jobs reported as passing.

---

## ADR-062 — Caprock may ask a question, and the user may send the answer to caprock.dev

**Date:** 2026-10-14 · **Status:** accepted (owner, 2026-10-14)

*Amends [ADR-047](#adr-047--the-owner-talks-to-his-agents-through-his-own-telegram-bot-integrations-he-turns-on-may-leave-the-machine)
and rule 4's wording.*

**Context.** The owner (2026-10-14, translated): "Caprock is a local
utility; we don't see our users and can't talk to them. So we talk through
banners inside the app and extra pages. Right now I'd like to test an
offer: 'Want to earn money watching ads?' — a short question: how many
hours do you work a day, then roughly what share of that you spend in
Caprock. Or even better — 'want to watch YouTube?', somewhere on the left.
That's the second variant to test. We just collect sign-ups." And later
the same day (translated): "I'd try to sell Second Brain first. Show a
Second Brain banner a couple of times, and it sells just the subscription
(the usual Premium step). It's local. Cloud backups are separate money —
we'll study that too. For now we study demand with super-short forms going
to my Telegram through our bot." Rule 4 said nothing is ever sent to
Caprock, and every outbound call so far is an integration the user switches
on. A survey answer is neither: it is one message the user writes to us.

**Decision.**

- **A user-initiated, disclosed submission to caprock.dev is allowed.** A
  survey card (`OfferStrip.tsx`) sends one answer through `POST /v1/offer`
  to `https://caprock.dev/api/offer`, and only when the user presses
  **Send**. Under the button the card says, word for word, what goes and
  where: *Sends these answers, and your email if you add one, to
  caprock.dev. Nothing else.* The site stores it in KV and posts one line to
  the owner's Telegram through the site's own bot — the answers and whether
  an email came, never the address.
- **What is sent is fixed by the daemon, not the page.** Which offer, the
  one-click answers to its two questions, and the email only when typed —
  not even the version, because the card does not say it. The body is
  rebuilt from per-offer enums in `internal/api/offer.go`, so no identifier,
  install id, path or usage figure can ride along. There is no install id at all: two answers from one
  machine are indistinguishable from two machines.
- **A small list of offers, each with its own copy and show rule**
  (`ui/src/lib/offer.ts`; the copy is the owner's): two surveys —
  *Hugging Face models on this computer* (what first; what machine) for
  every install at most twice on different days, and a pair drawn once per
  install at random, locally, *short ads to earn money* or *YouTube while
  agents work*, asked once.
- **Second Brain is sold, not surveyed** (owner, later the same day,
  translated: "a short banner leading to a modal that explains how it works.
  Then it's simply available in Premium: you buy Premium and you'll have it
  in three days"). A strip and a dialog that says how it works, then the
  usual Premium purchase step. It is a **dated pre-order with a refund
  promise**, worded exactly: *Second Brain comes to Premium on 18 October
  2026. If it doesn't, write to us for a full refund.* A licence holder is
  told *It's included in your Premium — it arrives on 18 October 2026.*
  This is not "coming soon" (rule 11): it names the date and what happens if
  the date is missed. It sends nothing to us (a purchase already notifies
  through the existing Stripe flow, tagged `app-second-brain`), it is tried
  first, at most twice on different days, and it stops on 18 October 2026 or
  as soon as the build sets `SECOND_BRAIN_BUILT`. If the date slips, the
  wording is changed before it, never left standing. *Superseded
  2026-10-14:* Second Brain shipped and was made free (ADR-063, § Free), so
  the sale, its dialog and its pre-order line are gone from the product;
  the `second-brain` id stays only so the answers installs already keep
  stay valid.
- **Dismissing sends nothing.** *Not interested* and × record locally that
  the question was answered, and that card never returns. Nobody who says
  no is counted; the test measures who answers and what they say.
- **Calm, and never stacked**: after two days with sessions, one offer a day
  at most, once the keyboard has been still for 20 s, never while a session
  waits on a permission prompt, never on a paired phone, one banner at a
  time (`lib/nudges.ts`). Wording is a question, not a promise — *We're
  considering…*; never "coming soon" (rule 11's spirit).

**Rules out:** anything automatic — an impression count, a "seen" ping, a
"no" sent home, a retry in the background; a stored identifier of any kind;
reusing this route for anything but a card the user answers.

**Revisit if:** an offer is wanted that sends more than one-click answers
and an optional email, or anyone proposes sending something the user did
not see on the card. Adding an offer of the same shape is a row in the
three schemas, not a new decision.

## ADR-063 — Second Brain: the sessions' decisions and findings, kept as a graph on this machine; free

**Date:** 2026-10-14 · **Status:** accepted (owner, 2026-10-14)

*Builds the product ADR-062's in-app offer pre-sells.*

**Context.** The owner sells "Second Brain" in Premium with a date on it, 18
October 2026, and described it (translated): "On the left a collapsible block
where my second brain is constantly being built — a knowledge graph. Like in
Hogwarts they pulled memories out with a wand and put them in the Pensieve —
here ideas get put into the graph: everything done, researched, etc." Caprock
already keeps every answer Claude wrote (`/v1/notes`, about 30,000 notes on
the owner's machine); what it lacks is a place where the few worth keeping
are kept as conclusions, linked to each other, rather than found again by
searching prose.

**Decision.**

- **Memories and the entities they hang off.** A node is a memory — an
  *idea*, *decision*, *finding* or *question* — or an entity: a *topic*,
  *person* or *project*. A title is a line (80 characters), a summary a
  paragraph (400). Every memory records where it came from: the session, the
  event (an assistant note), the moment and the project, so it links back to
  the place in the record. An entity exists once per normalised title (lower
  case, spaces collapsed, punctuation at the ends dropped), so "SQLite" and
  "sqlite." are one topic. Edges are *relates*, *follows*, *contradicts* and
  *part_of*, one per pair and kind, weighted (dropping the same link again
  adds to it, capped at 10). Three tables in the daemon's own database
  (migration 0055): `brain_nodes`, `brain_edges`, and `brain_runs`, which
  the automatic extraction records each read in.
- **Dropped in by hand.** *Drop into brain* under any answer on the Memory
  screen, in a session's Notes and in the chat view sends only the answer's
  event id; the daemon reads its text, session, time and project from the
  record. The quick capture (⇧⌘H, Ctrl+Shift+H off macOS, or ⌘K *Add to
  brain…*) takes a line or a paragraph, a kind and topics. The first line
  that says something, without its Markdown, is the title; the passage,
  flattened, is the summary. A memory hangs off its project and its topics
  from the first drop, so the graph clusters without any model.
- **Free, all of it** (owner decision, 2026-10-14, amending the first
  version of this ADR). As built first, twenty memories dropped in by hand
  were free, the twenty-first was refused by the daemon (`402`) and the
  automatic build needed a licence. The owner then said (translated): "I'm
  not Premium myself. Either we try to convert users to Premium, or give it
  free — we offer it, the user uses it, and later we offer to host this
  Second Brain in the cloud for a subscription. Maybe something cooler goes
  into Premium." So Second Brain is free: no cap on the memories kept by
  hand, and the automatic build for everyone who says yes — it runs on the
  user's own `claude`, which costs Caprock nothing. No route in it answers
  `402`, and a licence, present or lapsed, changes nothing in it. The yes
  first (below) is unchanged. Anyone who bought Premium on the pre-order
  (ADR-062) keeps that licence exactly as it is; Premium keeps every other
  feature it had. A paid add-on around the brain, if one is ever built, is
  its own decision; nothing public names one (rule 11).
- **On this machine.** Everything above is local: the graph is the daemon's
  SQLite file, served on loopback, readable by a paired device and written
  only on the machine.
- **Reads that stay fast.** The graph read takes the newest memories that
  pass the filter (pinned first), the entities linked to them and every edge
  between what it returns, without summaries unless asked; a large selection
  scans the edge table once instead of walking it per node. On a test graph
  of 5,000 memories, 200 topics and 15,000 edges the whole-graph read took
  45–50 ms on the development Mac under load and a project's 20 ms
  (`TestBrainGraphReadsFiveThousandNodesQuickly`, 2026-10-14).

- **Built automatically, only after a yes.** The
  Brain screen asks everyone once — *Build it from your sessions automatically?* —
  and Settings → Second Brain holds the switch afterwards. Until the user
  answers, nothing runs (`brain.auto` in `config.json` is absent, not
  false). The brief asked for it to be on by default; rule 4 lets an
  outbound call exist only when the user turned it on and the place it is
  switched on says what it sends, and this one sends the user's transcripts.
  So it is one click, asked in the place the feature lives, with the line
  that says where the prose goes: to the user's own `claude`, which sends it
  to Anthropic under the user's login — where the session already went —
  and nothing to Caprock. Turning it on reads from that moment; *Build from
  my last 30 days* reads the past month, after showing an estimate of how
  many sessions and tokens that is.
- **How a session is read** (`internal/brain`). A session is read once it
  has ended or been quiet for ten minutes, and again only when it has new
  prose; at most four per wake, a wake every five minutes and one at once
  when it is turned on, one at a time, off the request path. A wake that
  read a full four is followed by the next three seconds later, so a
  backfill reads straight through within the daily limit instead of four
  sessions per five minutes (2026-10-15: the screen that shows the build
  as it happens sat still between wakes). A session whose agent wrote fewer than 300
  characters is recorded as skipped and never sent. The read is the
  session's prompts and answers (main thread only, the newest 24,000
  characters when there are more), the project's name and the topics
  already in the brain, sent on stdin to `claude -p --output-format json
  --tools "" --no-session-persistence --setting-sources local --settings
  <{"disableAllHooks": true}> --model haiku --system-prompt … --json-schema
  …`: no tools, no transcript written, none of the user's hooks or plugins
  loaded — so the read neither appears as a session in Caprock nor runs the
  user's hooks. The flags were read off `claude --help` (2.1.299) and one
  call made by hand on 2026-10-14; skipping the user's settings cut the
  fixed cost of a call from 16,637 input tokens to 4,318. A Windows `.cmd`
  shim cannot carry JSON on its command line, so there the instructions and
  schema go on stdin too.
- **What is kept, and its limits.** Each memory records the read it came
  from (`brain_runs`: model, tokens, cost, status) and the passage it
  cites, so its source link opens the moment it was said; it hangs off the
  project and its topics, with *relates* and *contradicts* between memories
  of one read. A daily token limit (100k, 300k by default, or 1M, in a
  rolling 24 hours, counted from what `claude` reports) stops reads until
  the day rolls over. A failed read is recorded and retried after 15
  minutes, doubling, and given up after four failures until the session has
  new prose.
- **New sessions draw on it.** A served handoff (SessionStart, the memory
  between sessions) adds up to five of the repository's memories, pinned
  first, in a budget of 700 characters of its own — so sessions started
  after this change in the handoff experiment's served group receive
  slightly more than before.
- **Drawn, and in the sidebar.** The `#/brain` screen opens on the graph —
  memories and the topics and projects they hang off, laid out by a
  force simulation written for it (`ui/src/lib/forcegraph.ts`: Barnes–Hut
  repulsion, springs, a pull to the centre), the list one click away. The
  edges, nodes and labels are drawn into a cached layer only when they
  change; panning and zooming scale that layer and redraw it when the
  view rests. On a preview stand with 3,011 memories, in the headless
  Chromium the screenshots use (software rendering, so slower than a
  real window), a frame took a median 9.2 ms while the layout settled and
  8.4 ms while zooming (2026-10-14); before the cached layer, stroking every
  edge every frame took 225 ms. The app's sidebar has a Brain block below
  the projects: a small graph of the newest thirty memories, where one that
  is kept drops in from above with a ring where it lands (none with
  prefers-reduced-motion), the three newest titles and the count. Unfolded
  by default for everyone, with *How it works*, a short explainer that
  opens the Brain screen.

**Rules out:** an embedding index or a vector store (a dependency and a model
for what titles, topics and links do); a graph library in the dashboard
(the layout is under 300 lines we can read); a server of ours; an API key of
Caprock's or a model call made any way but the user's own `claude`; running
the extraction before the user says yes; storing the graph
anywhere but the daemon's database; locking a user out of memories already
kept.

**Revisit if:** people keep far more than a few thousand memories (the graph
read returns at most 5,000 and the screen would need clustering on the
daemon); or the brain's cost to the machine — the database, the reads —
turns out to need a limit of its own.

---

## ADR-064 — The Work board: a branch is the unit of work, columns derived and never stored, estimates only with a measured basis

**Date:** 2026-10-15 · **Status:** accepted (owner ask, 2026-10-15)

*Number note: taken as the next free one on 2026-10-15. If another ADR
lands as 064 first, this one is renumbered in the same PR that merges
second.*

**Context.** The owner asked (translated): "I'm missing project vision in
Caprock — something like a kanban: what is in work, release plans, roughly
the time until done, who works on what and what it costs." Caprock already
records everything such a board needs except a plan: every session, its
turns and their lengths (the Queue's estimates, RISK-08), the agent's own
task list, the pull requests a session's own commands opened or merged
(`session_prs`), the task runner's tasks, the queued messages, and — from
the Pipeline (PRs & CI) — each pull request's stage, CI and the releases.
What is missing is one view that puts them side by side per piece of work.

**Decision.**

- **A branch is the unit of work.** A card is a repository and a branch, in
  the furthest stage it has reached (planned → in work → pull request →
  merged → released); the live sessions on that branch attach to it. A
  session on the default branch is its own card.
- **Columns are derived, never stored.** They are computed on each read
  from what Caprock already records — sessions, turns, todos,
  `session_prs`, the task runner's tasks, queued messages — and the
  Pipeline's pull request board. Nothing is written; there is no new task
  store and no DDL. *Planned* is only the task runner's tasks and queued
  messages: things someone actually asked an agent to do.
- **One local answer.** `GET /v1/work` (03-contracts.md § Work) answers the
  sessions, tasks, queue, repositories and totals; it never calls GitHub.
  The pull request stages come from the Pipeline's own board, whose reads
  are already kept; the page joins the two by branch.
- **An estimate appears only with a measured basis, and its basis is
  stated.** Allowed: the running turn's range from the project's finished
  turns (`internal/eta`, RISK-08); the medians the Pipeline measures — CI,
  open → merge, merge → release — and the median gap between releases
  (`release_gap_median_ms`, from the releases already read, at least three
  gaps); the median gap between local tags; a lane clearing at its recent
  pace, only above stated thresholds of history. Never: a task's
  completion time, a per-PR merge countdown, or a clock time for the next
  release.
- **Release plans are read locally.** The `[Unreleased]` section of
  `CHANGELOG.md` at the remote's default branch (and, since 2026-10-15, the
  changelog fragments in `changes/unreleased/` there), the newest tags and the
  commits past the last one come from `git show`, `git for-each-ref` and
  `git rev-list` against refs the clone already has. Caprock never runs
  `git fetch` for this; the board labels it "as of your last fetch". Every
  git spawn goes through `internal/hidewin`.
- **A session is tied to a pull request two ways only:** the pull requests
  its own commands recorded, or its branch when that is not the default.

**Rules out:** a local free-text task list (a second, unsynced backlog
beside the issues and the task runner); predicting release times; guessing
which session made which pull request by title similarity; polling GitHub
beyond what the Pipeline already keeps; running `git fetch` in the
background.

**Revisit if:** a per-PR merge range is shown — only after a backtest says
it is calibrated (12-risks.md); people want a plan item that no agent was
asked to do yet (then the task runner's inbox is the place, not a new
store); or the board's reads stop being cheap (measured 9 ms warm on the
owner's database, 2026-10-15).

---

## ADR-065 — A project can start from a template: copied, briefed and handed to an agent, through the user's own gh

**Date:** 2026-10-15 · **Status:** accepted (owner, 2026-10-15)

**Context.** The owner keeps a public template repository on GitHub, Corpus
(`dspv/corpus`): a `.ai/` documentation skeleton whose `TEMPLATE.md` tells an
agent how to build the project's corpus from a spec dropped in
`docs/source-spec.md`. He asked (translated, 2026-10-15): "I have a public
template repo on GitHub, Corpus. I create a new repository from it, feed it
to an agent with a brief of the project, and it builds it — docs and
research first, as the template says. Build this harmoniously into Caprock
so I use it and it doesn't get in other people's way." Today that is four
tools: GitHub's *Use this template* button, a terminal to clone, an editor
for the brief, and Caprock to start the agent.

**Decision.**

- **A template is the user's, and there are none until they add one.** A
  GitHub template repository (`owner/name`), a folder on this machine, or
  both, with the path the brief is written to and the first prompt
  (`{brief}` its only variable) and, optionally, the agent. Kept in
  `<data_dir>/project-templates.json`, at most 50, written atomically; a
  corrupt file is set aside as `.bad-<ts>` and logged. No DDL. Nobody who
  does not add a template sees anything change.
- **GitHub only through the user's own gh, only on a click.** Making the
  repository is `gh repo create <login>/<name> --template <owner/name>
  --private|--public`, then `gh repo clone`; reading a template to fill in
  the form is `gh repo view` and `gh api` for its `TEMPLATE.md` and README.
  Whether gh is ready is read from gh's own config (`gh config get -h
  github.com user`), on this machine. Caprock never reads or stores the gh
  token and adds no GitHub client of its own for this: the outbound calls
  are gh's, to GitHub, on the user's click, for the repository they named
  (rule 4).
- **Without gh, a local copy — never chosen by the daemon.** The local path
  copies the template folder's last commit (`git archive HEAD`, unpacked by
  the daemon), or its files when it is not a repository, into a new
  repository with one commit. The request names the path (`via`); a request
  for GitHub with gh missing or signed out is `409`, not quietly turned into
  a local copy, so the user is never surprised by where the project lives.
  The copy keeps ADR-050's limits: 5,000 files, 256 MB, links only relative
  and inside.
- **The brief is committed, never pushed.** It is written at the template's
  path inside the new project (symlinks resolved; a link that leads out is
  refused) and committed alone as "Add the project brief". Without a git
  identity the files stay uncommitted and a note says how to set one; the
  project is still made.
- **A failure cleans up only what Caprock made on this machine.** A folder it
  created is removed; an empty folder the user had made is emptied and kept.
  A repository made on GitHub is never deleted — the operation says it is
  kept and can be retried, and Retry clones it rather than making another.
  GitHub fills a repository made from a template a moment after it exists,
  so an empty first clone is tried again (six tries, 2 s apart).
- **The agent starts as any other.** The daemon makes and lists the
  project; the app then starts the agent with the existing `POST
  /v1/agents` and the template's prompt. One way to start a session, not
  two.
- **The machine's, and free.** Every route is refused to a paired device: a
  phone does not create repositories on the user's GitHub account. Nothing
  is gated.

**Rules out:** a built-in list of templates (Caprock does not recommend
anyone's repository); Caprock's own GitHub token or API client for this; a
silent fall-back from GitHub to a local copy; deleting a remote repository,
ever; pushing the brief; creating a project from a phone.

**Revisit if:** people want templates hosted somewhere other than GitHub
(GitLab, a plain git URL), which would need a path that is not gh; or
operations lost to a daemon restart mid-way (`RISK-09`) turn out to matter
in practice.

## ADR-066 — When GitHub cannot be read, the daemon asks GitHub's status page whose fault it is; watching it is opt-in

**Date:** 2026-10-15 · **Status:** accepted (owner, 2026-10-15)

**Context.** A GitHub read that timed out said *Couldn't refresh: could not
reach GitHub (api.github.com): context deadline exceeded. Check the
connection; Caprock tries again later · showing data from 17:27*. The owner
could not tell from it whether GitHub was down or his connection was, and
asked for a shorter line that answers that, plus an optional informer while
GitHub has an incident. Caprock already reads `www.githubstatus.com`'s
public summary for Now's CI/CD section, under the GitHub integration.

**Decision.**

- **Same destination, same integration, one more moment.** After a GitHub
  read fails on the network or with a 5xx (`isReachFailure`), the dashboard
  asks `GET /v1/github/statuspage` and the daemon reads the status page —
  the existing `github.StatusPage`: a plain GET of the public summary, no
  token, no cookie, nothing about the user, kept five minutes, and nothing
  while GitHub is not connected. A refused token, a spent rate limit or a
  missing repository asks nothing: the status page cannot explain them.
- **The summary, not `status.json`.** It carries the indicator and
  description `status.json` has, plus the incident's name and link the line
  shows, and it is already the one read and kept; a second URL would be a
  second request for less.
- **Watching is opt-in and the viewer's.** *Watch GitHub Status*, ticked in
  that line, asks every five minutes while GitHub is connected and shows a
  status-bar dot only while GitHub reports an incident. Off by default,
  kept in the viewer's browser storage; the daemon's five-minute keep bounds
  the outbound reads whatever the number of windows.
- **Said where it is switched on** (rule 4, ADR-047): Settings → GitHub
  says that Caprock also checks githubstatus.com when GitHub can't be
  reached, and every five minutes with the tick; `docs/app.md` and
  `03-contracts.md` § GitHub list it with the other destinations.

**Rules out:** the browser calling githubstatus.com itself; asking it while
GitHub is not connected; polling it without the tick.

**Revisit if:** GitHub's status page moves or changes its API, or a user
wants the watch to drive a notification rather than a dot.

## ADR-067 — Your computers reach each other through the same relay; the local daemon speaks for the others

**Date:** 2026-10-15 · **Status:** accepted (owner, 2026-10-15, translated:
"yes, let's go", on the plan's defaults). Amends
[ADR-058](#adr-058--a-phone-reaches-the-machine-from-anywhere-through-a-relay-that-carries-only-ciphertext)
(a daemon is now a relay client as well as a host) and
[ADR-034](#adr-034--a-phone-the-owner-chooses-can-work-on-sessions-and-nothing-else)
(a third kind of paired device, a computer, with its own scope).

**Context.** The owner works on a MacBook and keeps agents running on a Mac
mini, and wants to see and type into the Mac mini's sessions from the MacBook
the way a phone already can (ADR-058). Later the same should reach a Windows
box, a Linux VM, or a hosted machine. Two shapes were weighed. *A*: the
dashboard or app opens a relay channel to each machine itself. It was
rejected: the UI is built for one daemon and switches machines by reloading,
tokens and pinned keys would sit in each window's browser storage, every
window would open its own channels, and nothing outside the page (the CLI,
Telegram, the app's notifications, cost totals) could see another machine.
*B*, chosen: **federation** — each daemon is a relay client to the user's
other daemons, and the dashboard and app only ever talk to their own daemon.

**What a machine is.** One Caprock daemon with its own identity:
`remote.json` (0600) holds its Ed25519 key, which is its id on a relay, and
its X25519 static key, which every handshake pins (ADR-058). A future hosted
box is just another machine. To be reached, a machine has *access from
anywhere* on — the one switch that exists today. Its relay is its own choice
and travels in its pairing link, so two machines may use different relays.

**Decisions on the plan's open questions** (the plan's defaults, as approved):

- **Pairing is one-way per link.** Pairing the MacBook to the Mac mini lets
  the MacBook reach the Mac mini and nothing back; the reverse is a separate
  pairing. Three computers that all reach each other are six pairings, each
  revocable on its own. A "my computers" group was rejected: it widens what
  one stolen machine reaches.
- **Control is granted at pairing time, on the target, with the computer's
  name shown.** The target's owner shows a code *for a computer* (Settings,
  or `caprock pair --computer` over SSH on a machine with no screen). The
  controller redeems it, and the target then shows *"MacBook wants to
  control this computer"* with **Allow** / **Deny** — on its screen, or as a
  prompt in the terminal that ran `caprock pair --computer`. **On a headless
  target the command line is the screen:** `caprock machines allow <name>`
  (and `caprock machines deny <name>`), run on the target over SSH, counts
  as Allow, exactly as the button does; `caprock machines pending` lists
  what waits. Run on the target, by whoever holds a shell there, it is the
  owner's decision on the machine. Until the owner
  allows it the token reaches nothing but `GET /v1/pair/me`, which answers
  `pending`; nothing is read before the owner has seen the name. The kind
  travels with the code, never with the redeeming request: a device cannot
  call itself a computer to get a computer's rights, exactly as it cannot
  name its own role (ADR-034, amended 2026-10-14).
- **A computer has full controller scope** — the work surface of the
  machine itself, not the phone's limits: any folder (not only under home),
  `command`, `args` and `chat` on `POST /v1/agents`, shell tabs and their
  terminals, tasks, the hive and the orchestrator. It is still an allowlist
  (`computerRoutes`, a superset of `controllerRoutes`), so a route added later
  is closed until named. **What stays the machine's own**, whatever the
  role — and here the code decides, not taste:
  - *Pairing, roles, codes, access from anywhere and the LAN switch.* A
    computer that could mint itself a second token would survive its own
    revocation; revoke on the target has to be final.
  - *Settings writes.* They hold the licence key and the tokens of the
    integrations the owner turned on (Telegram, GitHub, Gemini); a paired
    computer that could repoint them could send the target's data somewhere
    its owner never chose (rule 4, ADR-047).
  - *The doctor's stop* (ADR-059 rules it out for any paired device),
    shutdown, update and restart, hooks install, and the routes that open a
    window on the target's own screen (`open-terminal`, the editor).
  Rule 7 is unchanged: a computer starts, types into or signals only what
  Caprock started **on that machine, through that machine's daemon** — the
  agent manager there enforces it as it does for the dashboard.
- **Revocable from the target at any time.** Devices → **Remove** there kills
  the token on the next request, and from PR2 also closes that device's open
  sockets (`/v1/live` kept streaming to a revoked device until it reconnected;
  the terminal already re-read the role per frame and closed with 1008).
  On the controller, **Forget** deletes the token here and asks the target,
  best effort, to drop it too (`DELETE /v1/pair/me`).
- **Connected on demand.** A channel opens when a view, a request or a
  command needs that computer, stays up while anything is open on it (a
  terminal can be open for hours), and closes after 90 s with nothing open.
  A computer added and never looked at costs the relay nothing. Phase 3's
  merged session list holds one channel per computer only while a dashboard
  is open.
- **Pairing input is the link.** The target shows a link (and the QR the
  phone uses); `caprock pair` prints it for a headless box. The controller
  pastes the whole link or only the part after `?`. A six-digit code alone
  is not enough — it cannot say which relay, which machine or which key to
  pin — and making it enough would need a password-authenticated
  rendezvous on the relay: new cryptography and a relay change, so not in
  this decision.

**The pairing flow.**

1. On the target: *Let another computer in* (or `caprock pair --computer`)
   turns access from anywhere on if it is off — pressing it is that decision
   on the machine (ADR-058, amended 2026-10-14) — and shows the link, valid
   five minutes, once.
2. On the controller: Settings → Computers → *Add a computer*, paste.
   Its daemon parses the link, dials the target's relay, runs Noise NK
   against the pinned key, and redeems the code through the channel with
   `POST /v1/pair` and its own name.
3. On the target: the owner allows it, by name — the button, the prompt,
   or `caprock machines allow <name>` over SSH. The device is stored with
   `kind: "machine"` and the controller role.
4. The controller keeps `{id, key, relay, name, token, device_id,
   added_at}` in `machines.json`, 0600, beside `remote.json` and
   `devices.json`. The token never leaves that file except inside the
   channel to that one computer.

**Trust model.**

- *The target's owner decides everything about the target*: whether it can
  be reached, which computer, with what role, and for how long.
- *Not transitive.* A phone paired with the MacBook never reaches the Mac
  mini through it: the controller's computer routes (`/v1/machines`,
  `/v1/m/{id}/…`) are loopback-only and on no device allowlist, and a test
  asserts that a device gets 401/403 there.
- *A compromised relay* — ours or self-hosted — sees machine ids, IP
  addresses, timing and sizes (keystroke cadence included), and that a
  long-lived daemon-to-daemon link exists. It can drop, delay or refuse
  connections. It cannot read or alter traffic (AES-GCM under Noise,
  nonce-ordered), impersonate the target (pinned key), impersonate the
  controller (the token is inside the ciphertext), or register the
  target's id (challenge and Ed25519 proof).
- *A compromised controller* holds its tokens to every target that let it
  in, with full scope there. The cure is **Remove** on each target. Binding
  the token to the controller's own key (a signature over the handshake hash
  in the first frame) is Phase 4 hardening; Go-only, phones unaffected.
- *No hosted code in the path.* Federation runs inside the two daemons; the
  desktop window still loads only `127.0.0.1`, and `m.caprock.dev` is a
  phone-only concern.

**What crosses the relay.** Exactly what crosses it for a phone (ADR-058):
one WebSocket per controller, Noise ciphertext inside, the frame protocol of
`internal/remote/proto.go`. Nothing new is sent anywhere (rule 4): the relay
is the one the target chose; the controller dials it only after the user
pasted that target's link, which is the switch, off until then and undone by
Forget; and the Computers panel says what it sends and to which relay
(ADR-047). Both sides count relay messages and bytes each way (`Host.State`,
`Client.State`), so what a computer costs the relay is measured (OQ-14), not
guessed.

**Failure modes.**

- *The target is offline* (asleep, off the internet, Caprock not running,
  access from anywhere off): the relay closes the controller with 4404, and
  the computer reads *offline* with the reason. A failed attempt backs off
  from 1 s to 30 s, during which a request is answered at once with the last
  failure; a user's retry skips the wait. The target's sessions keep running
  there (pty-host, ADR-033); an open terminal closes (1006) and reopens on a
  new channel, resuming from its byte offset with term v2 (PR3).
- *The relay is down or unreachable:* the same, worded as the relay.
- *The target reset its keys or is another machine:* it hangs up on the
  handshake; the computer reads *refused* and has to be paired again.
- *The controller was removed there:* `GET /v1/pair/me` answers 401 through
  a channel only that machine can speak on, so it is the target's word, not
  a relay's; the computer reads *revoked*, stays listed until forgotten, and
  comes back by itself if a later check is answered.
- *A slow reader:* each stream has its own queue of 512 frames; a reader
  that falls that far behind loses its stream, never the channel.
- *Version skew:* the Welcome carries the target's version. A target from
  before PR2 pairs as an ordinary device with a phone's limits — the link it
  shows is a phone's — which still works; the Computers panel says *update
  Mac mini for full control*.
- *Clock skew:* nothing depends on two clocks agreeing. Codes expire on the
  target's clock, tokens do not expire, Noise carries no timestamps, and
  `last_seen` is the clock of whichever machine records it. Times from
  another computer are shown as that computer stated them; the merged list
  (Phase 3) orders by them and does not correct them.

**A headless target.** A Mac mini in a cupboard, a Linux VM or a box at a
provider has no screen: everything the target's owner does goes through
SSH — `caprock remote on`, `caprock pair --computer` (prints the link),
`caprock machines allow|deny <name>`, and **Remove** as `caprock
machines revoke <name>` (all new in PR2). It must keep running with
nobody logged in. On macOS the launchd
agent (`caprock service install`) runs while the user's session exists,
which on a Mac mini with automatic login is always. On Linux the systemd
**user** unit stops when the user's last session ends unless lingering is
on: `loginctl enable-linger <user>` (once, as root or with polkit). From
PR2, `caprock service install` and `caprock pair --computer` on Linux say
so when lingering is off; they never run it. Without it the target goes
offline the moment the SSH session that set it up closes.

**The Windows host.** A Windows machine is a target like any other: the
Host, the relay client and Noise are plain Go, and sessions run under
ConPTY in the pty-host. `machines.json`'s 0600 is not enforced there; the
file lives in the user's own profile directory, as `devices.json` does. A
daemon started from the Startup folder runs only while that user is logged
in, so such a target is offline when nobody is. Paths on a target are its
own (`C:\Users\…`) and are passed through as strings, never interpreted by
the controller; the folder picker reads them from the target (Phase 2).
Phase 2's smoke adds a Windows target to the matrix.

**Phases.**

- **Phase 1 — from the MacBook, see and type into the Mac mini's sessions.**
  Three pull requests:
  - *PR1 — the Go relay client, the stream layer and the peers store* (this
    ADR's pull request). `internal/remote/client.go`: `Client` with
    `RoundTrip` (an `http.RoundTripper` over streams) and `OpenWS`,
    on-demand with idle close, backoff, state and counters; `ParsePairLink`,
    `PairLink`'s inverse. `internal/peers`: `machines.json` and a `Manager`
    that pairs by link, carries requests and sockets as the paired device,
    checks `GET /v1/pair/me`, renames and forgets. Relay message counters
    on `Host`. Unit tests on a real relay (`relaysrv`) and Host, and a
    smoke in which the real binary is the target in its own home and data
    directory, on a relay in the test on loopback. No route, no UI, no
    daemon wiring.
  - *PR2 — computers in the daemon.* The target side: codes for a computer
    (`kind` on the code, `kind: "machine"` in `devices.json`), the pending
    state and **Allow** / **Deny** (the screen, the prompt of `caprock pair
    --computer`, and `caprock machines pending|allow|deny|revoke <name>` for
    the computers that reach this one),
    `computerRoutes` and the lifted spawn limits, `DELETE /v1/pair/me`, and
    sockets closed on revoke and demotion. The controller side:
    `internal/daemon` wiring, `GET/POST /v1/machines`, `PATCH/DELETE
    /v1/machines/{id}`, the `/v1/m/{id}/{path…}` proxy (HTTP through
    `httputil.ReverseProxy` on the peer's channel, WebSockets bridged, the
    device subprotocol never echoed, `503 offline`, `404` unknown), all
    loopback-only, and `caprock machines ls|add|forget` for the computers
    this one reaches. The smoke grows to
    two real daemons, the controller's routes included.
  - *PR3 — other computers in the app.* Sessions tagged by computer in the
    sidebar, the Session view and terminal through `/v1/m/{id}/…`,
    Settings → Computers, offline and revoked states, and `bench/peer.mjs`
    measuring keystroke-to-echo through the local relay and the hosted one,
    recorded with a date (no latency figure is stated before that, rule 6).
    And the **install hook** — the owner's goal (2026-10-15, translated):
    "encourage installing Caprock on their other computers":
    - *With no computer linked*, one quiet sidebar row, **+ Add a machine**,
      opening Settings → Computers with the steps for the other machine
      (install, `caprock remote on`, show the link). No badge, no modal.
    - *When this machine is loaded and a linked one is not*, the New-agent
      sheet says once — *"This Mac is busy — run it on Mac mini (12 GB
      free)?"* (figures here are examples) — with the machine picked by one
      click (the picker itself is Phase 2; until then the line opens that
      computer's sessions). Shown once per load episode, dismissible, never
      when the other machine is offline. "Loaded" and "free" are read, not
      guessed: `/v1/resources` gains machine-wide `cpus`, `load1`,
      `mem_total` and `mem_available` (a contract change in that PR, with
      `.ai/03-contracts.md`), read on each machine and fetched from the
      other through `/v1/m/{id}/v1/resources`. The thresholds are set from
      OQ-19's measurement, not before.
- **Phase 2 — start and finish work on another computer:** a Machine picker
  in New agent (projects, folders, models and agents read from the target;
  offline ones disabled); permission buttons, the queue, Changes, diff and
  PR for a remote session; a Windows target in the smoke. A shortcut, if
  any, goes through `keys()` and is checked on Windows and Linux (rule 12).
- **Phase 3 — one view across computers:** one upstream `/v1/live` per
  computer, re-published locally with `machine`; `?machines=all` on the
  session list and the cost summary, summing what answered and naming what
  did not (never counting it as $0, rule 6), each computer priced by its own
  `pricing_version`; notifications and Approve/Deny for remote sessions.
- **Phase 4 — capacity and hardening:** frame coalescing, the token bound to
  the controller's key, and whatever OQ-14's measurements call for (a relay
  of one's own is already `caprock remote relay`).

**What is claimed, and what it costs.**

- **Measure before any public claim** (rule 6). Four open questions in
  `.ai/12-risks.md` gate the copy: the round trip over the relay (OQ-17),
  terminal echo through a link (OQ-18), the memory and CPU a real task
  frees on this machine when it runs elsewhere (OQ-19), and whether the
  other machine is actually quicker at `go test` and the UI build (OQ-20).
  **The pitch is not "faster".** It is *this Mac stays responsive*, *more
  agents at once*, *work goes on with the lid closed* — and each of those is
  said with a measured figure or not at all.
- **Free, with no limit on machines, for now.** Linking computers is not a
  paid feature and is not counted. A hosted or resold machine (a VPS we run
  for the user) is **parked**: it would put the user's code and sessions on
  a server of ours, which rule 4 does not allow as things stand, and its
  only selling point would be speed nobody has measured (OQ-20).

No migration in Phases 1–3: nothing about another computer is stored in
SQLite.

**Rules out:** the dashboard or app holding relay channels or tokens; access
that is transitive or symmetric by default; a computer naming its own kind
or role; a computer managing the target's pairing, settings or the doctor's
stop; typing into or signalling anything the target's Caprock did not start;
a change to the relay for this; stating a latency, capacity or speed figure
before it is measured; selling "faster"; a limit on linked machines or a
hosted machine of ours, for now.

**Revisit if:** the hosted relay's limits (OQ-14) are reached by computers
rather than phones; a user needs a computer that may manage the target's
pairing (a fleet); or a short typed code turns out to be needed — that is a
PAKE on the relay and its own decision.

## ADR-068 — The dashboard bundle is rebuilt on master, never carried by a pull request

**Date:** 2026-10-15 · **Status:** accepted (owner, 2026-10-15)

**Context.** `internal/api/dist`, the built dashboard, is committed so `go
install github.com/dspv/caprock/cmd/caprock@latest` embeds a real UI without
Node, and CI failed every pull request whose copy differed from a fresh
build. So every PR that touched `ui/` carried a rebuilt bundle, and the
bundle's file names are content hashes: two such PRs always conflicted in
`dist` (a modified `index.html`, one deleted and one added asset each),
whatever else they changed. Of the last 30 merged PRs on 2026-10-15, 23
carried `dist` (429 file changes between them); #663, #667, #669 and #670
were hand-merged that day, some twice, only to rebuild it, and the CI panel
was a column of red *Conflict*.

**Decision.**

- **A pull request never changes `internal/api/dist`.** `ci.yml`'s `no dist
  in the PR` job diffs the PR's merge commit against its first parent and
  fails with the command that drops the change (`make dist-reset`, or
  `git checkout origin/master -- internal/api/dist` after a rebase).
  `make check` runs the same test locally (`dist-untouched`, against the
  branch's merge base with `origin/master`).
- **Master rebuilds it.** `.github/workflows/dist.yml` runs on every push to
  `master` that touches `ui/`: `make ui`, and when the output differs, a
  `chore(dist): rebuild the dashboard for <sha>` commit pushed to `master`
  with `GITHUB_TOKEN`. A lost push race rebuilds from the new head (three
  tries). It cannot loop: the commit is outside the workflow's `paths`, a
  `GITHUB_TOKEN` push starts no workflow, and the job skips the Actions bot.
  `master` has no branch protection and no rulesets (checked 2026-10-15), and
  `contents: write` is granted per job, so the push is allowed as is.
- **Go CI keeps building against the committed copy.** It may be one merge
  behind `ui/`, but no Go test reads the dashboard's bytes; the `ui` job
  still proves the bundle builds, and `make build (windows-latest)` builds it
  on Windows. Adding `make ui` to the three go legs would cost an `npm ci` on
  each for nothing a Go test can see.
- **A tag holds its own UI, built.** Release `verify (ui)` and `make
  release-ready` run `dist-check` (fresh build equals the committed copy), so
  `go install …@vX.Y.Z` and `@latest`, which read the tag's tree, embed the
  tag's dashboard. The releaser tags after master's rebuild commit lands.
  goreleaser keeps building the UI from the tag's `ui/` before it compiles.

**Rules out:** carrying `dist` in PRs with a merge driver (`.gitattributes`
drivers are not run by GitHub's merge, so the panel stays red); not
committing `dist` at all (`go install` would embed the placeholder page);
letting a release build its UI and ship with a stale committed copy (the
release binaries would be right and `go install @latest` silently wrong);
a bot opening a rebuild PR per merge (a second queue to land, for a commit
nobody reviews).

**Revisit if:** `master` gets branch protection that blocks the Actions push
(then the rebuild needs a bypass allowance, or arrives as an auto-merged PR),
the Vite build stops being deterministic across machines (then `dist-check`
cannot gate a tag), or `go install` stops being a supported install path.

---

## ADR-069 — Hermes Agent is read from its own database, priced by Hermes, with its background runs shown apart; Caprock can start it

**Date:** 2026-10-15 · **Status:** accepted (owner, 2026-10-11, translated:
install Hermes, test it, and ship Hermes support in Caprock if it works; a
user asked for it). Details and the source lines it rests on:
[24-hermes.md](24-hermes.md).

**Context.** Hermes Agent (Nous Research) keeps every conversation — its CLI
and TUI, its cron jobs, chats through its gateway — in one SQLite database,
`<hermes home>/state.db`, with per-session token counters and its own cost.
It also has shell hooks and signed outbound webhooks, but cost is only in the
database. Read from Hermes 0.21.6's source and `--help`, not from a session
run against an API.

**Decisions.**

- **Observe by reading the database, read-only, as OpenCode's is.** Opened
  `mode=ro` with a busy timeout and one connection; never `immutable=1`, which
  in WAL mode misses the WAL. Polled every five seconds; a locked or missing
  database skips a pass and never fails startup. A column an older Hermes
  lacks reads as NULL. No hook or webhook is installed into Hermes.
- **Hermes's figure, never ours.** Its turns are not priced from Caprock's
  table (`event.SourceHermes`, like `SourceOpenCode`). The provider's figure
  when Hermes says it is real (`cost_status = 'actual'` or a provider billing
  `cost_source`), its estimate otherwise, $0 on a subscription route, and no
  cost — unpriced — when Hermes has none (rule 6). Each usage event says which
  in `cost_basis`, and the Cost screen labels the two kinds separately.
- **Usage is reconciled per session.** Hermes stores usage on the session
  row, not on messages, so each pass records the difference between Hermes's
  counters and what Caprock holds — on the newest new reply, or on a
  `usage_only` turn keyed by the counters — so totals equal Hermes's and a
  re-read adds nothing.
- **Subagents by Hermes's own markers.** A child with `_delegate_from` is a
  subagent filed in its parent (`agent_id`, `sidechain`); a branch, a reset
  and a compression continuation are sessions of their own. Rows are summed,
  not rolled up: Hermes folds a child's cost into its parent in memory only.
- **Background is Hermes's definition.** Every source outside Hermes's
  `ATTENDED_SOURCES` (`cli`, `tui`, `desktop`, `acp`) — cron, gateway chats,
  one-shot runs — is background, shown as its own figure, by source, inside
  the total.
- **Liveness.** Hermes records no process per session: an observed session
  goes by the clock, like the other imported agents, and ends when Hermes
  writes `ended_at`.
- **Launch.** `New agent → Hermes` runs `hermes chat` (`-m`, `--yolo` for
  Bypass, `-q` for the first message, `chat --resume <id>` to continue; no
  fork). Hermes cannot be told a session id, so the row is linked to the
  spawn by folder and the start time Hermes's id carries (`sessionlink`'s
  heuristic match, as Codex's). Caprock-started sessions are controllable;
  observed ones are not (rule 7). When no model is configured the catalog
  offers the user's own `hermes model` as the step, typed in a shell tab,
  never run; Caprock only checks whether the key is set and never enters a
  credential.
- **The mark is ours.** No Nous Research logo is licensed for use here, so
  Hermes gets a glyph drawn in the repo (a winged H) and a teal of our own.

**Rules out:** installing Hermes shell hooks or webhooks for cost (the
database is the only place it is); pricing Hermes's tokens with Caprock's
table; writing to `state.db` in any way; folding background runs out of the
total.

**Revisit if:** Hermes starts writing usage per message (the reconciliation
can go); Hermes gets a flag that names a session's id (the link becomes
exact); a user runs several Hermes profiles (read each profile's database); or
a figure is found where Caprock's and Hermes's own `insights` disagree.

## ADR-070: A Page tab — withdrawn (2026-10-16)

**Status: withdrawn.** 0.123.0 shipped a Page tab: a web page in a native
child webview of the main window, which needed Tauri's `unstable` feature.
On macOS 27 the app then crashed twice in eight minutes (0.124.0, the
owner's machine): a WebContent process was killed by WebKit's pasteboard
check (`WebPasteboardProxy::determineDataOwner`, an `EXC_GUARD` in namespace
WEBKIT) and the UI process faulted in `WebProcessProxy::shutDown`. Drops also
stopped arriving once the dashboard became a child webview, and ⌘-click
opened links inside instead of in the user's browser, which the owner
rejected: the default browser stays the default (owner, 2026-10-16). 0.124.1
removes the Page tab and the `unstable` feature. A return needs the crash
understood first, and links stay in the default browser unless the user
chooses otherwise.

