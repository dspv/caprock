# Spec migration audit (M0)

Record of task M0: migrating `CaprockV2-SPEC.md` (v1.0, handed off 2026-08-18) into the `.ai/` corpus with zero information loss, and the loss audit that allowed deleting the spec. Kept for the record; may be pruned after Phase 0 ships (per the spec's own instruction).

## Target repository convention (spec Part IV §1)

The repo is pre-created from Dima's standard template (github.com/dspv/kit conventions): the **root holds only README.md, LICENSE, CLAUDE.md** (plus one optional extra file when the template has it — here `AGENTS.md`); **all product and engineering documentation lives in `.ai/`**. The SPEC was a hand-off document, not a permanent resident of the root: its content was migrated into `.ai/` and then the SPEC was deleted.

## Mapping (spec Part IV §2, adjusted to the template's numbering — see ADR-016)

The spec's proposed mapping, verbatim ("adjust file names to the template's existing conventions, never the other way around"):

```
.ai/product.md            ← Part I §1–4   (one-liner, prior art, problems, users, traceability, principles)
.ai/architecture.md       ← Part I §5–7   (architecture, platform rules, data sources, event model)
.ai/ui.md                 ← Part I §8     (five screens + §8.6 visual direction)
.ai/orchestration.md      ← Part I §9     (+ Part III §2.2 contracts: hive layout, task/mailbox formats, Stop protocol)
.ai/decisions.md          ← Part I §10–14 (non-goals, Caprock history, roadmap, risks, resolved decisions)
.ai/phase-0.md            ← Part II       (DoD, contracts §3.1–3.3, tasks T1–T10; T0 spike note)
.ai/phase-1.md            ← Part III Phase 1
.ai/phase-2.md            ← Part III Phase 2 (minus contracts moved to orchestration.md — leave a link)
.ai/engineering-rules.md  ← Part II §5    (binding rules; referenced from CLAUDE.md)
```

The spec proposed unnumbered names; the template fixes `00/01/08/12/14` and leaves the rest free, so names were adjusted "to the template's existing conventions, never the other way around":

| Spec section                                                                  | Landed in                                                                    |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Part I §1–4 (one-liner, prior art, problems, users, traceability, principles) | `.ai/01-product.md`                                                          |
| Part I §5–7 (architecture, platform rules, data sources, event model)         | `.ai/02-architecture.md`                                                     |
| Part I §8 (five screens + visual direction)                                   | `.ai/04-ui.md`                                                               |
| Part I §9 + Part III §2.2 hive/task/mailbox/Stop                              | `.ai/05-orchestration.md`                                                    |
| Part I §10 (skip list), §11 (Caprock relationship)                            | `.ai/01-product.md`                                                          |
| Part I §12 (roadmap), Part II §6 (launch checklist)                           | `.ai/09-execution-plan.md`                                                   |
| Part I §13 (risks)                                                            | `.ai/12-risks.md`                                                            |
| Part I §14 (decisions)                                                        | `.ai/08-decisions.md` ADR-001…ADR-011                                        |
| Part II §1–2 (Phase 0 DoD, slice), §4 (T0–T10)                                | `.ai/09-execution-plan.md`, `.ai/02-architecture.md`                         |
| Part II §3 (shim, API, DDL contracts)                                         | `.ai/03-contracts.md`                                                        |
| Part II §5 (engineering rules)                                                | `.ai/06-engineering-rules.md`                                                |
| Part III Phase 1 (DoD, contracts, T11–T16)                                    | `.ai/09-execution-plan.md`, `.ai/03-contracts.md`                            |
| Part III Phase 2 (DoD, contracts, T17–T25, cumulative)                        | `.ai/09-execution-plan.md`, `.ai/05-orchestration.md`, `.ai/03-contracts.md` |
| Part IV (repo integration, M0, verification protocol, kickoff prompt)         | this file + ADR-016                                                          |

Rules applied: zero information loss (every sentence, table row, code block, DDL statement, AC item, default value, and number lands in exactly one `.ai/` file; rewording for flow allowed, dropping or summarizing not); cross-references replace duplication; `CLAUDE.md` carries the index and the instruction to read the relevant file(s) before any task.

## Verification protocol (spec Part IV §3)

1. Spawn **3 reviewer subagents in parallel**, splitting the spec between them (Part I / Part II / Part III+IV).
2. Each reviewer walks its part **section by section** and, for every section, locates the content in `.ai/` and verifies nothing is missing or silently altered: every table row, every code/DDL block byte-comparable or explicitly noted as moved, every numeric default (ports, timeouts, K/T/N/R values, prices, estimates) present.
3. Each reviewer outputs a checklist: `section → target file → OK | MISSING: <what> | CHANGED: <what>`.
4. Any MISSING/CHANGED item is fixed and the affected part re-audited. Only a fully green audit allows `git rm` of the spec.
5. The checklists are committed here, and the file may be pruned after Phase 0 ships.

## Original kickoff prompt (spec Part IV §4, executed 2026-08-18)

```
Read SPEC.md in full. Execute task M0 from Part IV: migrate the entire
document into the existing .ai/ structure per the mapping in Part IV §2,
with zero information loss. Then run the verification protocol from
Part IV §3 with 3 parallel reviewer subagents; fix every finding and
re-audit until fully green. Commit .ai/migration-audit.md, delete
SPEC.md, and stop for my review.

After I approve M0, proceed to task T0 (Part II §4 / .ai/phase-0.md):
the ConPTY spike — a spike branch with a GitHub Actions matrix
(ubuntu/macos/windows) proving the candidate PTY wrapper can spawn a
process, stream output, and kill cleanly on all three OS, plus a
go/no-go note in the PR description.

Binding for everything: .ai/engineering-rules.md — English only,
Conventional Commits, no task is done with a red Windows CI job.
```

(Dima's actual instruction on 2026-08-18 superseded the "stop for my review" step: build the corpus, audit, delete the spec, commit-push to master, then proceed straight into development.)

## Audit results (2026-08-18)

Five reviewer subagents ran in parallel: four loss-audit reviewers over spec slices (Part I §1–8 · Part I §9–14 · Part II · Part III+IV) and one corpus-consistency reviewer over the resulting `.ai/` files. Every finding was fixed and the affected checks re-run before the spec was deleted.

### Loss audit — Part I §1–8 → GREEN

Header, §1 one-liner, §2 prior art (both URLs; 1,040 / 180 / 3 days; ~2,000 / ~677 / ~40 / v0.0.1→v0.4.x / 1,200+; why it landed; where it went), §2.1 five problems, §3 users ($20/$100/$200; 2–10 sessions), §3.1 seven traceability rows (converted to a numbered list per the no-wide-tables rule; every complaint / evidence / feature / phase preserved), §4 five principles, §5 diagram (byte-identical) + two planes + why-not-Electron, §5.1 five cross-platform bullets, §6 three sources + degradation ladder, §7 Event struct (byte-identical) + rollup names, §8.1–8.5 every screen bullet, §8.6 visual tokens (#0B0E14, ≤150ms, 300ms, tokens.css) → `01-product.md`, `02-architecture.md`, `04-ui.md`, ADR-003/006. Zero MISSING, zero CHANGED.

### Loss audit — Part I §9–14 → GREEN

§9 six orchestration bullets, §10 four skip items (LimeZu, `command` configurable), §11 in full (today / assessment / RESOLVED / Option B bullets / rejected), §12 four phases + gates sentence, §13 five risks with mitigations, §14 six decisions (fortem.dev reasons, patent grant, go:embed, PHASE0.md → T0, monetization wording) → `05-orchestration.md`, `01-product.md`, `09-execution-plan.md`, `12-risks.md`, ADR-001…007. Zero MISSING, zero CHANGED.

### Loss audit — Part II → GREEN

Preamble (scope, outcome, interaction model), DoD 1–8 + non-goals (byte-identical), slice diagram (byte-identical), components + no-ptyman note, §3.1 shim bullets, §3.2 API block (byte-identical) + casing/money/tokens/versioning, §3.3 DDL (byte-identical except the `SPEC §7` comment → `02-architecture.md § Event model`) + migrations + pricing sentence, T0–T10 with every estimate and AC verbatim, total + cut line, §5 six engineering rules (repointed cross-refs disclosed inline; ADR-014 amendment disclosed), §6 launch checklist (byte-identical) → `09-execution-plan.md`, `02-architecture.md`, `03-contracts.md`, `06-engineering-rules.md`. Zero MISSING, zero CHANGED.

### Loss audit — Part III + IV → GREEN after 2 fixes

All Phase 1 / Phase 2 outcomes, DoDs (byte-identical), API + SQL blocks (byte-identical), hive layout / task YAML (byte-identical), mailbox + Stop-protocol paragraphs, T11–T25 with estimates and ACs, estimates, cut lines, cumulative table, Phase 3, Part IV §1/§3/§4 (kickoff prompt byte-identical) → `09-execution-plan.md`, `03-contracts.md`, `05-orchestration.md`, this file, ADR-016.

- CHANGED → fixed: cumulative-table row 3 had dropped "with the" ("…use case, with the trust gap closed") — restored verbatim.
- CHANGED → fixed: Part IV §2 proposed-mapping code block was summarized — restored verbatim above under § Mapping.

### Corpus consistency review → 18 findings, all fixed

- Dangling anchor to ADR-009 (heading contained `type: "http"`, which slugs differently) — heading reworded; **`scripts/check-links.py` now resolves anchors** with GitHub slug rules, so CI catches this class from now on.
- ADR preamble mis-stated which ADRs are spec-derived vs repo-prep (ADR-009 is repo-prep, ADR-012 is spec/T2) — reworded.
- Orchestrator prompt path `.ai/orchestrator.md` contradicted ADR-016's "no unnumbered files" — becomes `.ai/07-orchestrator.md`; ADR-016, 05, 09 updated.
- `internal/shim` named in a rule but absent from the layout — rule now says `cmd/caprock-hook`.
- 10-infrastructure described a `docs` job inside `ci.yml` and a `ui/dist` artifact; the actual workflows are `docs.yml` + `ci.yml` (+ `release.yml`) and the UI builds into `internal/api/dist` — doc rewritten to match the files; embed path settled in one place.
- `make check` meant two different things — Makefile target now runs docs gates + lint + test; `docs.yml` calls `make docs-check docs-links`; wording aligned in CLAUDE.md / 06 / 10.
- `pricing_version` granularity claimed three ways (per row / per run / meta) — settled as `meta.pricing_version`, costs computed at write time, never recomputed; 01, 06, 12 aligned with 03.
- Four places still said `pricing.json` is "ported from Caprock-python" without the ADR-015 caveat — 02 and 03 now carry the caveat; T5's AC marked pending `OQ-01`.
- "Session Detail: terminal read-only in Phase 0" contradicted "no ptyman in Phase 0" — Phase 0 = timeline + diff, terminal in Phase 1; spec sentence kept verbatim with the clarification appended (09, 04, README).
- Placeholder in this section + spec still present while docs claimed "audit green / spec deleted" — resolved by this section and the deletion in the same commit.
- "Documentation is complete" vs 90% — reworded to "corpus built (90%)" in CLAUDE.md, AGENTS.md, README.
- "no CI beyond the docs check" vs workflows present — 14-build-status now says workflows are written but never run against code.
- Data-dir resolution restated in 03 and ADR-013 — 03 now links to ADR-013.
- Loop-detector rule restated in 02 and T9; auto-pause / N=10 / R=3 restated in 05 and the Phase 1–2 DoDs — accepted: 09 quotes the spec's DoD/task text verbatim (a loss-audit requirement) and now says so explicitly, with 05/02 named as owners.
- "+10%" for regional partner endpoints in OQ-02 lacked a source — sourced to the Anthropic pricing page, fetched 2026-08-18.
- Phase 0 total "~15–20 evenings" vs per-task ranges summing to 15–23 — annotated as the spec's rounded figure.
- Open-questions table had sentence-length cells — converted to a bulleted list; the cumulative-picture table is kept as the spec wrote it.

Final state: `make docs-check docs-links` green (tables, links, anchors); `CaprockV2-SPEC.md` removed with `git rm` in the same commit.
