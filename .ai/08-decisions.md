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

## ADR-019 — `caprock up` detaches by default; hook-install consent is a TTY prompt (or `--yes`); sessions end on `SessionEnd`, or after an hour of silence

**Date:** 2026-08-18 · **Status:** accepted · *repo-prep decision (made while building T1–T6; resolves OQ-08)*

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
inside a `0700` data dir. It is **write-only over HTTP** — accepted by
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
`--session-id`, `--model`, `--permission-mode`. Gemini CLI takes `-m` and has no
notion of a permission mode or a caller-assigned session id. Sending Claude's
argv to Gemini fails at the binary, so choosing the agent has to change the
request: the model list swaps to Gemini's, and Permissions greys out rather than
pretending to apply. The picker appears only when a `gemini` binary is on the
daemon's PATH — a choice that fails on click is worse than no choice.

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
