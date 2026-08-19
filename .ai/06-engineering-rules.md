# Caprock — Engineering rules (binding for this repo)

These rules are binding. `CLAUDE.md` links here; an agent reads this file before touching code. Each rule names the failure it prevents. Tooling and versions are in [10-infrastructure.md](10-infrastructure.md).

## From the spec (Part II §5)

- **English everywhere:** code, comments, commits (Conventional Commits), PRs, docs.
- **Agent docs live in `.ai/`** — the `.ai/` corpus is the source of truth; Claude Code reads it before any task. (The spec's SPEC.md/PHASE0.md have been absorbed into `.ai/`; the spec is deleted after the loss audit — [docs/migration-audit.md](../docs/migration-audit.md).)
- **Every task = one PR;** the PR description references its task ID (`T0`…`T25`) and pastes its acceptance criteria as a checklist. Amendment for the bootstrap period: [ADR-014](08-decisions.md#adr-014--commit-to-master-directly-until-phase-0-t6-then-prs).
- **No task is done with a red Windows job. No exceptions** — this is the moat ([02-architecture.md § Cross-platform](02-architecture.md#cross-platform-do-it-right-on-day-one)).
- **Unknown hook events and unknown transcript fields are logged and ignored, never fatal** ([12-risks.md](12-risks.md) RISK-01, RISK-02).
- **The shim must never break a user's Claude session:** any error path = silent `exit 0`.

## Repo-level rules (added while preparing the repo, 2026-08-18)

- **Every task ends green:** `go vet ./...`, `go test ./...`, `golangci-lint`, `ui` typecheck + tests, and the docs gates — `make check` runs all of it — locally before push, and in CI on all three OS. A push that reddens CI is fixed or reverted in the next commit, never left for later; a red main branch hides the next regression.
- **Pure Go only** — no CGO anywhere. `modernc.org/sqlite`, no `mattn/go-sqlite3`. The reason is cross-compiling one static binary per OS from one runner; a single CGO dependency reintroduces the ABI-class install failures Munder Difflin suffers.
- **No outbound network calls from the daemon or shim.** The only sockets are `127.0.0.1` listeners and loopback POSTs from the shim. The only outbound-looking HTTP clients are the shim's loopback POST (`internal/shim`), the CLI's loopback calls to its own daemon (`cmd/caprock`), and the dashboard's same-origin fetches (`ui/`). Local-first is a promise, not a default.
- **Data dir writes go through `internal/store` and `internal/hive` only.** No `os.WriteFile` to the data dir from handlers. Atomic writes (`tmp` + rename) for every file that another process may read (`runtime.json`, task files, mailboxes).
- **All paths via `filepath`; no `sh -c` anywhere in production code.** Verification commands (Phase 2) run through a small cross-platform runner that spawns the platform shell explicitly (`cmd /C` on Windows, `/bin/sh -c` on POSIX) and is covered by the three-OS smoke test.
- **Contracts change with their docs in the same commit.** New endpoint → `03-contracts.md`; new table/column → DDL section + a migration; new hook event consumed → the shim table + installer. A contract that exists only in code is not a contract.
- **Cost math is data-driven.** No price literal in Go outside `pricing/pricing.json`. `meta.pricing_version` records the table version in force; cost rows are computed at write time with that version and never recomputed retroactively; a pricing update ships as a new version + changelog line, never as an in-place edit of an existing entry.
- **No invented numbers in UI copy or docs.** A forecast is labeled "estimate"; a stat that isn't measured is not shown.
- **Errors are values, and logs are structured.** `log/slog` with `session_id`, `component`, and `event` fields; no `fmt.Println` in library code; `panic` only for programmer errors at init.
- **Tests before hardening, fixtures before mocks.** Prefer golden-file tests on real transcript fixtures (`testdata/`) and `httptest` over mocks; the fake `claude` (T10) is a real subprocess emitting real hook calls.
- **UI: strict TypeScript, no `any`;** components derive every color/size from `ui/src/design/tokens.css` ([04-ui.md § Visual direction](04-ui.md#visual-direction-v0-tokens)); numbers render in monospace with tabular numerals.
- **Commits: Conventional Commits with scope** — `feat(hookd): …`, `fix(ingest): …`, `docs(ai): …`, `ci: …`, `chore(release): …`. Commit bodies explain *why* when the diff does not.
- **Docs discipline** — tight-aligned tables via `make docs-fmt`, one fact one home, ADRs for closed debates, absolute dates: see [00-index.md § Documentation rules](00-index.md#documentation-rules).

## Council quorum for decisions (agents deciding, not decorating)

When a design or correctness call is non-obvious and the agent is not sure, it convenes a **council** of independent sub-agents and decides by an escalating quorum — so the council actually forces a correct decision rather than rubber-stamping one:

- **Round 1 — ask 3.** Pose the same crisp choice to 3 independent agents. If **all 3 agree**, that is the decision — proceed.
- **Split → escalate.** If they do **not** all agree (e.g. 2-of-3), the split is a signal the question is genuinely hard: convene **5** agents on the same question. A clear majority of 5 decides.
- **Still split → escalate again** (7, then 9…), each round adding two agents, until a clear majority holds. If a small council keeps splitting, the question is under-specified — reformulate it or **escalate to the human**, don't force a coin-flip.

Rules that keep it honest:

- **Independent, then counted.** Agents must answer without seeing each other's answers; only then are votes tallied. A council where later agents read earlier ones is theatre.
- **Adversarial where it matters.** For a correctness or safety claim, at least one council member is tasked to *refute* it, not confirm it. Unanimous "looks fine" from confirmation-only agents is weak evidence.
- **The parent still owns the outcome.** The quorum informs the decision; it does not launder responsibility. If the majority is wrong on the merits and the parent can see why, the parent overrides and records why.
- **Scale to the stakes.** Trivial or reversible choices don't need a council at all — pick the obvious option and move. The council is for calls that are hard to reverse or that the docs leave genuinely open.

## Definition of "green" per task

1. Unit + integration tests pass on ubuntu / macos / windows.
2. `golangci-lint run` clean; `go vet` clean.
3. UI: `tsc --noEmit`, `vitest`, `vite build` clean.
4. `make docs-check docs-links` (tables + links + anchors) clean.
5. `14-build-status.md` and README progress updated in the same commit when a track moves.
