# Caprock — Risks

Open risks, unverified assumptions, and unanswered questions. **Read before expanding scope.** Everything here is a thing that could be wrong; nothing here is a plan.

## Assumption register

Assumptions the plan rests on that have not been verified. Each names what would falsify it.

| ID              | Assumption                                                         | Falsified by                                                        |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `ASSUMPTION-01` | The 8 core hook events stay stable across Claude Code releases     | A release renaming/removing one of them (T3 tests break)            |
| `ASSUMPTION-02` | Users accept a user-level hook in `~/.claude/settings.json`        | Launch feedback asking for per-project-only registration            |
| `ASSUMPTION-03` | K=5 in T=3 min catches real loops without noisy false positives    | Fixture replays or dogfooding showing >1 false alert per session    |
| `ASSUMPTION-04` | `aymanbagabas/go-pty` passes the Windows smoke test                | T0 spike red on `windows-latest`                                    |
| `ASSUMPTION-05` | Phase 0 fits ~15–20 evenings                                       | Build-status log showing T10 not green after 30 evenings            |
| `ASSUMPTION-06` | Munder Difflin numbers are order-of-magnitude right                | Re-verification before any public quote showing otherwise           |
| `ASSUMPTION-07` | Transcript `usage` per assistant turn is the billing-relevant unit | A model/turn whose transcript usage disagrees with the Console bill |
| `ASSUMPTION-08` | Hooks fire for sessions started by other tools (IDE, SDK) too      | A session visible in transcripts but never in `events` from hooks   |

The assumption most likely to mislead is `ASSUMPTION-03`: a detector that fires "sometimes" will look correct on the synthetic fixture and still be wrong on real traffic, because real loops vary their input slightly (paths, retries). The normalizer's similarity rule is what decides this, and only dogfooding tests it.

Verified on 2026-08-18 and therefore *not* an assumption: a real Claude Code 2.1.221 transcript carries `message.usage` with input/output/cache-read/cache-write per assistant line, `sessionId`, `cwd`, `timestamp`, and `message.model` ([03-contracts.md § Transcript JSONL](03-contracts.md#transcript-jsonl-observed-shape)); the hooks reference lists the seven events we consume with the fields we read; native `type: "http"` hooks surface a transcript notice on connection failure ([ADR-009](08-decisions.md#adr-009--hook-transport-is-the-caprock-hook-shim-binary-not-claude-codes-native-http-hook-type)).

## Risks

**`RISK-01` — Hooks API churn.**
~30 events and growing; a rename or payload change silently blanks the Now screen. Mitigation: pin to the stable core set, tolerate unknown events, verify against the official hooks reference each release; unknown events/fields are logged and ignored, never fatal.

**`RISK-02` — Transcript format is not a public contract.**
A schema change breaks token accounting without any error. Mitigation: schema-version the parser, golden fixtures for known shapes, degrade gracefully to hooks-only mode (activity keeps working, cost goes stale and says so).

**`RISK-03` — Limit forecasting accuracy.**
Anthropic doesn't expose limit state; a confident-looking wrong forecast is worse than none. Mitigation: label forecasts as estimates, learn from observed throttles (`throttle_observations`, Phase 1), and ship the forecast only after there is data — not in Phase 0.

**`RISK-04` — Anthropic ships it themselves.**
A first-party dashboard would erase the observe-only wedge. Mitigation: multi-agent orchestration + the verification layer are further from their core; move fast on Phase 0; the event model is designed so a first-party activity stream would become another source, not a replacement ([ADR-008](08-decisions.md#adr-008--hooks-are-the-source-of-truth-for-activity-single-normalized-event-stream)).

**`RISK-05` — Attention.**
Munder Difflin won on story. Phase 0 needs its own hook: "I watched my Claude burn $X in a loop — this tool catches it." Mitigation: the loop detector ships in Phase 0 (cut line: v0.1.1 at the latest) and the launch GIF shows it.

**`RISK-06` — Windows regressions after T0.**
The spike proves the PTY once; a later dependency bump can break it silently. Mitigation: the three-OS smoke job on every PR and the "no red Windows job" rule; weak point is that GitHub's Windows runner is not every user's Windows.

**`RISK-07` — Cost math drift vs the real bill.**
Prices change; a stale table under-reports spend and users notice on their invoice. Mitigation: `meta.pricing_version` recorded and never applied retroactively, user override file, a dated `source` in `pricing.json`, and a release-checklist step to re-fetch the pricing page. Accepted residual: partner platforms (Bedrock/Vertex) are not priced in v0.1 ([OQ-02](#open-questions)).

## Open questions

Anything the spec did not answer. Do not resolve these by inventing an answer. "Decided by" is a person, an event, or a task — never "later".

- ~~`OQ-01` — What does T5 "parity" compare?~~ Resolved 2026-08-18 (Dima): **parity with Caprock-python was never a project goal** — it was one AC phrasing in the spec, and the legacy repo has no `pricing.json`/fixtures anyway. Source of truth for prices is the Anthropic pricing page (versioned `pricing.json` with date+source); the cache formula from `_savings.py` is unit-tested on our own fixtures. T5's AC is reworded accordingly.
- ~~`OQ-02` — Bedrock/Vertex pricing in v0.1?~~ Resolved 2026-08-19: shipped first-party only across v0.1.0–v0.3.0. Partner pricing (regional endpoints carry a ~10% premium per the Anthropic pricing page) stays out until there is demand; re-open then.
- **`OQ-03` — Limit-forecast model.** Partly answered 2026-08-19: the honest throttle signal is Claude Code's `StopFailure` hook (rate_limit / overloaded / billing) — the daemon now consumes it and records each into `throttle_observations`, and the Cost screen reports the *count* per range (a fact, not a forecast). Building an actual "time-to-limit" forecast still waits for enough real throttle data; until then Caprock never guesses. **Still open** — this is the one open question left, and it is not a shipping blocker (Caprock shows the count, never a guess).
- ~~`OQ-04` — caprock.dev cut-over.~~ Resolved 2026-08-19: the site (`caprock-web`, repo `cybrixcc/caprock-web`) was rewritten to the mission-control positioning and deployed to caprock.dev; the retired Python measurer's marketing was removed.
- ~~`OQ-05` — Brand accent hue~~ Resolved during T7: a single warm amber (`#feb157`), interactive elements only, per the shipped dashboard and site.
- ~~`OQ-06` — Stop-decision output shape.~~ Resolved 2026-08-19. The canonical, and only documented, shape for Claude Code 2.1.x is the nested `{"hookSpecificOutput":{"hookEventName":"Stop","decision":"block","reason":…}}` on exit 0; the spec's top-level `{"decision","reason"}` is undocumented. `board.StopDecision` emits the nested form, and the live unattended run (2026-08-19) confirmed Claude 2.1.235 continues on it — the orchestrator looped through its Stop hook and drove the task to `done`.
- ~~`OQ-07` — Context-window sizes per model~~ Resolved 2026-08-18 (Dima): kept in `pricing.json` (`context_window` per model), updated by hand alongside prices with a date — consistent with the local-first "no outbound calls from the daemon" rule.
- ~~`OQ-08` — Consent UX for the hook install on `caprock up`.~~ Decided 2026-08-18 in [ADR-019](08-decisions.md#adr-019--caprock-up-detaches-by-default-hook-install-consent-is-a-tty-prompt-or---yes-sessions-end-after-12h-of-silence): TTY prompt when events are missing, `--yes` for scripts, non-TTY skips with a hint.
- ~~`OQ-09` — ConPTY on the CI Windows runner.~~ Resolved: `windows-latest` exposes ConPTY; the T0 spike and the full 3-OS matrix (including the `ptyspike` job) are green across all three releases. No self-hosted runner needed.

Only `OQ-03` (limit-forecast model) remains open, and it is not a shipping blocker — Caprock reports the throttle count, never an invented forecast. Everything else (OQ-01, OQ-02, OQ-04, OQ-05, OQ-06, OQ-07, OQ-08, OQ-09) is resolved.

## What would falsify the whole plan

- Anthropic ships an equivalent first-party mission control before Phase 1 — observe-only loses its reason to exist and only the orchestration/verification layer remains defensible.
- Windows cannot be made reliable through the PTY layer after the spike and one honest retry — then Phase 1's "control" story is POSIX-only and the moat claim is void.
- Phase 0 launches (Reddit/HN) and produces neither users nor complaints — no signal means no traceability rows, and the rule says features without rows get cut.
