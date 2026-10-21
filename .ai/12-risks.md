# Caprock — Risks

Open risks, unverified assumptions, and unanswered questions. **Read before expanding scope.** Everything here is a thing that could be wrong; nothing here is a plan.

## Assumption register

Assumptions the plan rests on that have not been verified. Each names what would falsify it.

| ID                  | Assumption                                                                               | Falsified by                                                        |
| ------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `ASSUMPTION-01`     | The 8 core hook events stay stable across Claude Code releases                           | A release renaming/removing one of them (T3 tests break)            |
| `ASSUMPTION-02`     | Users accept a user-level hook in `~/.claude/settings.json`                              | Launch feedback asking for per-project-only registration            |
| `ASSUMPTION-03`     | K=5 in T=3 min catches real loops without noisy false positives                          | Fixture replays or dogfooding showing >1 false alert per session    |
| ~~`ASSUMPTION-04`~~ | Confirmed: `go-pty` green on `windows-latest` (T0 + full matrix, v0.1.0–v0.3.0)          | — (verified)                                                        |
| ~~`ASSUMPTION-05`~~ | Superseded: all phases shipped; actual pace is in the build-status log, not the estimate | —                                                                   |
| `ASSUMPTION-06`     | Munder Difflin numbers are order-of-magnitude right                                      | Re-verification before any public quote showing otherwise           |
| `ASSUMPTION-07`     | Transcript `usage` per assistant turn is the billing-relevant unit                       | A model/turn whose transcript usage disagrees with the Console bill |
| `ASSUMPTION-08`     | Hooks fire for sessions started by other tools (IDE, SDK) too                            | A session visible in transcripts but never in `events` from hooks   |

The assumption most likely to mislead is `ASSUMPTION-03`: a detector that fires "sometimes" will look correct on the synthetic fixture and still be wrong on real traffic, because real loops vary their input slightly (paths, retries). The normalizer's similarity rule is what decides this, and only dogfooding tests it.

Verified on 2026-08-18 and therefore *not* an assumption: a real Claude Code 2.1.221 transcript carries `message.usage` with input/output/cache-read/cache-write per assistant line, `sessionId`, `cwd`, `timestamp`, and `message.model` ([03-contracts.md § Transcript JSONL](03-contracts.md#transcript-jsonl-observed-shape)); the hooks reference lists the nine events we consume with the fields we read; native `type: "http"` hooks surface a transcript notice on connection failure ([ADR-009](08-decisions.md#adr-009--hook-transport-is-the-caprock-hook-shim-binary-not-claude-codes-native-http-hook-type)).

## Risks

**`RISK-01` — Hooks API churn.**
~30 events and growing; a rename or payload change silently blanks the Now screen. Mitigation: pin to the stable core set, tolerate unknown events, verify against the official hooks reference each release; unknown events/fields are logged and ignored, never fatal.

**`RISK-02` — Transcript format is not a public contract.**
A schema change breaks token accounting without any error. Mitigation: schema-version the parser, golden fixtures for known shapes, degrade gracefully to hooks-only mode (activity keeps working, cost goes stale and says so).

**`RISK-03` — Limit forecasting accuracy.** *Discharged 2026-08-19.*
A confident-looking wrong forecast is worse than none. Mitigation shipped exactly as planned (OQ-03): the Cost screen shows the throttle count (a fact) and, from the `caprock statusline` rate-limit feed, the live window state; an "at current pace" forecast appears **only** when the measured slope is rising and would hit the limit before the window resets — otherwise the fact alone, never a guess. The absolute plan threshold is not emitted by Claude Code and is deliberately not shown.

**`RISK-04` — Anthropic ships it themselves.**
A first-party dashboard would erase the observe-only wedge. Mitigation: multi-agent orchestration + the verification layer are further from their core; move fast on Phase 0; the event model is designed so a first-party activity stream would become another source, not a replacement ([ADR-008](08-decisions.md#adr-008--hooks-are-the-source-of-truth-for-activity-single-normalized-event-stream)).

**`RISK-05` — Attention.**
Munder Difflin won on story. Phase 0 needs its own hook: "I watched my Claude burn $X in a loop — this tool catches it." Mitigation: the loop detector ships in Phase 0 (cut line: v0.1.1 at the latest) and the launch GIF shows it.

**`RISK-06` — Windows regressions after T0.**
The spike proves the PTY once; a later dependency bump can break it silently. Mitigation: the three-OS smoke job on every PR and the "no red Windows job" rule; weak point is that GitHub's Windows runner is not every user's Windows.

**`RISK-07` — Cost math drift vs the real bill.**
Prices change; a stale table under-reports spend and users notice on their invoice. Mitigation: `meta.pricing_version` recorded and never applied retroactively, user override file, a dated `source` in `pricing.json`, and a release-checklist step to re-fetch the pricing page. Accepted residuals: partner platforms (Bedrock/Vertex) are not priced ([OQ-02](#open-questions)); the gpt-6 rows cannot apply OpenAI's cache-write rate because Codex reports no cache-write tokens, so those figures can be low by up to a quarter of that unreported share; and the gpt-6 surcharge above 272K input tokens is not modelled (no observed turn reached it).

**`RISK-08` — Queue estimates are rough.**
The Queue view says when a queued message starts and is done from how long the project's past Claude Code turns took ([03-contracts.md § Queue](03-contracts.md#queue)). A turn's length depends on what it was asked, which history cannot see, so the estimate is weak. Measured on a copy of the owner's database (2026-10-12): 2,227 finished Claude Code turns (prompt to Stop; 85 more were interrupted), median 48 s, p25 16 s, p75 216 s, p90 577 s. Backtest, each turn predicted from the newest 200 turns of its project that ended before it started (2,168 turns with at least five such):

- **Median absolute error 55 s**, mean 238 s, p75 144 s; median error relative to the turn's own length 86%.
- **Inside the predicted p25–p75: 49%** of turns (a calibrated range holds 50%); inside p10–p90: 78% (80%).
- **Other windows were no better.** Every past turn instead of the newest 200: median error 63 s, 44% inside p25–p75; the newest 20: 53 s, 43%; the session's own past turns instead of the project's: 62 s, 48%.
- **The running turn's remaining time**, for turns still running at 30 s, 2 min and 10 min: the median minus the elapsed time missed by 87 s, 211 s and 381 s; the median of what the past turns that ran at least that long still took missed by 111 s, 178 s and 319 s, and held the actual in its p25–p75 46–49% of the time. The view uses the first before the median and the second after it.

Mitigation: the ranges are calibrated, the points are not, so the view shows the p25–p75 range with the word "rough" and its basis ("middle half of the last 200 turns in caprock"), never a single time; under five finished turns in a project it shows the count, not a number; for agents whose turn end Caprock does not hear (everything but Claude Code with hooks) it shows none. Re-run the backtest over a database copy before presenting the estimate as anything better.

**`RISK-09` — A template operation is forgotten by a daemon restart.**
Making a project from a template (ADR-065) runs in the daemon, off the
request, and its state lives only in memory, as a clone's does. A restart
mid-way forgets it: the op is gone from `/v1/projects/ops`, Retry answers
`404`, and nothing cleans up — a half-cloned or half-copied folder stays in
the parent folder, and a repository already made on GitHub stays there (it
is never deleted, by design). Mitigation: each step is short (the slowest is
the clone), the folder is the one the user named, and making the project
again with another name, or adding the half-made folder by hand, is plain;
nothing on GitHub is lost. Persisting operations would need a state file and
a resume path for each step; revisit if users meet this in practice.

**`RISK-10` — A downgrade opens a database a newer Caprock migrated.**
Before the guard, an older binary read `meta.schema_version` above its last
migration, applied nothing, and ran its backfills, retention and cleanup
against tables of a shape it did not know: testing a storage-layout change
(PR #768) showed data lost this way with no error. Mitigation
([ADR-082](08-decisions.md)): `store.Open` refuses such a database before any
write, with a line naming both schema numbers, shown by `caprock up`, the
desktop app and `caprock doctor`. Residual: it protects only from binaries
that carry it, so it shipped in a release of its own before any migration
that changes the layout; a binary older than that release still opens a newer
database as before. A user who must go back has to keep the older database
(no down-migrations exist).

## Open questions

Anything the spec did not answer. Do not resolve these by inventing an answer. "Decided by" is a person, an event, or a task — never "later".

- ~~`OQ-01` — What does T5 "parity" compare?~~ Resolved 2026-08-18 (Dima): **parity with Caprock-python was never a project goal** — it was one AC phrasing in the spec, and the legacy repo has no `pricing.json`/fixtures anyway. Source of truth for prices is the Anthropic pricing page (versioned `pricing.json` with date+source); the cache formula from `_savings.py` is unit-tested on our own fixtures. T5's AC is reworded accordingly.
- ~~`OQ-02` — Bedrock/Vertex pricing in v0.1?~~ Resolved 2026-08-19: shipped first-party only across v0.1.0–v0.3.0. Partner pricing (regional endpoints carry a ~10% premium per the Anthropic pricing page) stays out until there is demand; re-open then.
- ~~`OQ-03` — Limit-forecast model.~~ Resolved 2026-08-19. Two data sources: (1) the `StopFailure` hook records each throttle into `throttle_observations` (post-hoc "a limit was hit" — count shown per range); (2) the `caprock statusline` command reads Claude Code's `rate_limits` (`used_percentage` + `resets_at` for the 5h/7d windows, Pro/Max only) and forwards them to the daemon. The Cost screen shows the current window state (a fact) and an "at current pace" forecast **only** when the measured usage slope is rising and would reach the limit before the window resets — otherwise no guess. The absolute plan threshold (tokens/requests) is never emitted by Claude Code and is deliberately not shown. See [03-contracts.md § Statusline](03-contracts.md#statusline).
- ~~`OQ-04` — caprock.dev cut-over.~~ Resolved 2026-08-19: the site (`caprock-web`, repo `cybrixcc/caprock-web`) was rewritten to the mission-control positioning and deployed to caprock.dev; the retired Python measurer's marketing was removed.
- ~~`OQ-05` — Brand accent hue~~ Resolved during T7: a single warm amber (`#feb157`), interactive elements only, per the shipped dashboard and site.
- ~~`OQ-06` — Stop-decision output shape.~~ Resolved 2026-10-04 (the 2026-08-19 resolution was wrong). The documented shape for Stop is the top-level `{"decision":"block","reason":…}` on exit 0; a decision nested in `hookSpecificOutput` is ignored. A live `claude -p` run on Claude Code 2.1.289 stopped on the nested form and continued on the top-level one. `board.StopDecision` emits the top-level form.
- ~~`OQ-07` — Context-window sizes per model~~ Resolved 2026-08-18 (Dima): kept in `pricing.json` (`context_window` per model), updated by hand alongside prices with a date — consistent with the local-first "no outbound calls from the daemon" rule.
- ~~`OQ-08` — Consent UX for the hook install on `caprock up`.~~ Decided 2026-08-18 in [ADR-019](08-decisions.md#adr-019--caprock-up-detaches-by-default-hook-install-consent-is-a-tty-prompt-or---yes-sessions-end-on-sessionend-or-after-an-hour-of-silence): TTY prompt when events are missing, `--yes` for scripts, non-TTY skips with a hint.
- ~~`OQ-09` — ConPTY on the CI Windows runner.~~ Resolved: `windows-latest` exposes ConPTY; the T0 spike and the full 3-OS matrix (including the `ptyspike` job) are green across all three releases. No self-hosted runner needed.

- ~~`OQ-10` — Should the tool→turn linkage backfill be widened to pathless tools?~~ Resolved 2026-08-23 (Dima): **widen it, and take it off the startup path.** The `touch_dir IS NOT NULL` filter is gone, so `ingest.BackfillToolMessageIDs` now recovers every unlinked tool call rather than only the ones naming a file. On the owner's database that is **53948 of 53967** links (99.96%); the 19 it leaves are rows whose transcripts have been pruned, and they stay NULL rather than being guessed. The 30-day breakdown went from **86.5%** unlinked to **0.004%** (2 calls of 49559), which put `command` at **59.1%** of spend where it had reported **0.0%** — the largest category had been structurally invisible. The withholding guard was left exactly as it is and simply stops firing.
  - **What it cost:** the pass grew from ~3 s to **~30 s** on a 490 MB database with 1560 transcripts (1 GB), too long to sit in front of the port opening — a first `caprock up` that appears to hang is worse than a breakdown that waits. It therefore runs detached after the daemon is serving (`Daemon.backfillToolLinks`), in id batches with a resume cursor committed after each, so a kill costs one batch instead of the whole scan. Batch size is a real trade-off measured, not guessed: each batch re-walks the project tree, so 2000 took 48 s and 10000 took 30 s.
  - **Why a retry cannot corrupt the linkage:** a `tool_use` id belongs to exactly one assistant message — checked across all 1560 transcripts, none of 69552 distinct ids appears under two message ids — and every one of the 53313 pathless links written was compared against transcript ground truth with zero mismatches. The backfill can therefore only find the right answer or none.
  - **What is deliberately unchanged:** the old `tool_link_backfilled` marker is not treated as completion (a database carrying it still has every pathless call unlinked), and the 1%/5% guards stay, because a fresh install or a machine with pruned transcripts still needs them.

- `OQ-11` — **Does the memory handoff help?** On the owner's database a session continuing the previous day's work reached its first edit no faster than one starting cold (17 vs 16 minutes, 24 vs 23 tool calls; 18 and 19 Claude Code sessions, 2026-09-30) with the handoff already on for most of them. Decided by: the Memory-screen comparison once each group has 5 sessions that reached an edit — the owner's machine runs the 25% holdout since 2026-09-30, and Vova has been asked to. If there is no difference, revisit [ADR-030](08-decisions.md) before building anything on context continuity.

- `OQ-12` — **Voice input on the phone needs https.** Browsers give speech
  recognition only to a secure context, and a paired phone opens Caprock at
  `http://<Wi-Fi or Tailscale address>`, so the chat's microphone button can
  only point at the keyboard's dictation key there (04-ui.md § From a
  phone). Serving the dashboard over https on the machine's Tailscale name
  would fix it: `tailscale cert` issues a certificate for `*.ts.net` names
  when HTTPS is on in the tailnet, or `tailscale serve` terminates TLS and
  forwards to loopback. Neither is built, and neither is simple: a
  `tailscale serve` request arrives from 127.0.0.1 carrying `Tailscale-*`
  headers, which `isLocal` already treats as a relayed device, and the
  Host and Origin checks, the pairing token per origin and the "nothing
  listens beyond loopback unless turned on" promise would each need
  re-deciding for a TLS listener. Decided by: the owner, after real-iPhone
  use of the keyboard-dictation path shows whether it is enough. The same
  origin keeps the manifest's New chat and Save shortcuts and its share
  target dormant (ADR-056): Android Chrome installs a web app with them
  only from `https`, and iOS supports neither.

- `OQ-13` — **DeepSeek's prices and the model name it reports.** Three
  things about Claude Code on DeepSeek are not yet measured.
  - **The model id in the transcript.** Claude Code writes the model the
    API answered with. Sessions start on `deepseek-flash`, and the
    `deepseek-flash` row prices any id that begins with it. If DeepSeek
    answers with another spelling, its turns show as unpriced and are named
    in `unpriced`, not mispriced. A live check on 2026-10-13 reached the
    endpoint and was authenticated, but the account had no balance, so no
    reply carried a model id.
  - **Peak hours.** DeepSeek bills double from 01:00 to 04:00 and 06:00 to
    10:00 UTC on weekdays. The table prices every turn at the off-peak rate,
    so a turn in those hours is under-reported by half. Pricing by the hour
    would need a time-of-day rule in `pricing.json`, which does not exist.
  - **deepseek-v4-pro.** DeepSeek's pricing page, read 2026-10-13, lists it
    at $0.66/$1.98 per 1M off-peak; its row still carries $0.435/$0.87
    (read 2026-08-27). The date the price changed is not on DeepSeek's page.
    A third-party note gives 2026-08-16, and another says requests to it
    have been served and billed as `deepseek-flash` since 2026-09-14.
    Neither is DeepSeek's own word, so the row is not dated from them.

  Decided by: one DeepSeek session's transcript (the model id), and
  DeepSeek's own changelog or a bill for the v4-pro date.
  use of the keyboard-dictation path shows whether it is enough. *2026-10-13:*
  the phone's page for access from anywhere (ADR-058) is served over https,
  so speech recognition is available there.
- `OQ-14` — **Does the hosted relay fit Cloudflare's free plan?** Each
  WebSocket message to a Durable Object counts toward the plan's request
  allowance, and a live terminal sends many. One person's phone is far inside
  it; how many people fit is unmeasured. Decided by: the relay's request
  count in the Cloudflare dashboard after the first month with users. The
  fallbacks are the paid Workers plan or a relay on a server of ours
  (`caprock remote relay`), with no change on any phone or machine beyond
  the relay address. Computers reaching computers (ADR-067) add a traffic
  pattern a phone does not have — an app left open all day — so both ends
  of the channel count relay messages and bytes (`remote.State`,
  `remote.ClientState`) and channels close after 90 s with nothing open.
- `OQ-15` — **Is a per-PR merge range calibrated?** The Work board
  (ADR-064) could say how long an open pull request has left until it
  merges, from the Pipeline's open → merge median. Nobody has checked that a
  repository-wide median says anything about one pull request: a typo fix
  and a migration share the median. Until a backtest on real repositories
  (open pull requests on a past date, the range the board would have shown,
  when each actually merged) shows the 25th–75th range holding about half
  of them, the board shows no per-PR countdown, only the medians with their
  basis. Decided by: that backtest.
- `OQ-16` — **Local release state is as fresh as the user's fetch.** The
  Work board reads the `[Unreleased]` section, the tags and the commits past
  the last tag from refs the clone already has, and Caprock never fetches
  (ADR-064). A user who has not fetched in a week sees a week-old release
  plan. The board labels it "as of your last fetch"; whether that is enough,
  or the board should show when the last fetch was, is open. Decided by:
  the first report of a stale release column being taken for current.
- `OQ-17` — **Round trip over the relay between two computers.** A
  request from one daemon to another goes out to the relay and back
  (ADR-067); how long that takes from one home network to the same home,
  and from abroad, is unmeasured. Decided by: `bench/peer.mjs` (PR3 of
  ADR-067) through the local `relaysrv` and through `relay.caprock.dev`,
  median and p95, recorded with a date in `.ai/21-app.md`. No latency figure
  is stated anywhere public before then (rule 6). *2026-10-18:* the local
  half only — both daemons and the relay on one busy Mac, the hop added
  0.33 ms at the median and 9 ms at p95 to a terminal echo
  ([21-app.md § A session on another computer](21-app.md)). Two real
  computers and `relay.caprock.dev` are still unmeasured, so this stays
  open.
- `OQ-18` — **Terminal echo through a link.** Keystroke-to-echo for a
  session on another computer, through the controller's `/v1/m/{id}/…`
  proxy and the relay, against the same session typed into locally. Decided
  by: the same bench, through `/v1/m/…`, with a date. Until then a remote
  terminal is not described as "instant" or "like local". *2026-10-18:*
  measured through `/v1/m/…` on loopback only (above, OQ-17); open until
  two computers are measured.
- `OQ-19` — **What running a task elsewhere frees on this machine.** The
  case for a second computer is that this Mac stays responsive and runs
  more agents (or works with the lid closed), not that anything is faster.
  How much memory and CPU one real agent task costs here, and so what
  moving it to another computer gives back, is unmeasured. Decided by: one
  real task run here and then on a linked computer, this machine's memory
  and CPU read from the footprint meter (`/v1/resources`) for both, with a
  date. *2026-10-18:* `/v1/resources` now reports the machine as a whole
  (`machine`: cores, one-minute load, total and available memory), which
  the measurement and the New-agent busy line need; the line stays off
  until this sets its thresholds.
- `OQ-20` — **Is another computer actually quicker at the work?** Whether a
  linked machine finishes the same work sooner depends on that machine, not
  on Caprock. Decided by: `go test ./...` and the UI build of this
  repository on both machines, timed, with a date. The pitch is "this Mac
  stays responsive / more agents / lid closed", never "faster", until this
  says otherwise for the machines named.
- `OQ-21` — **A session's spend across several repositories (plan, not
  built).** One agent session can work in more than one repository — it
  `cd`s into a sibling checkout, edits the site repo beside the app repo,
  opens pull requests in both. Today a session belongs to one repository
  (its `repo_root`), and `store.SpendByPR` cuts its cost only across the
  pull requests of that repository, so the release plan's cost column and
  the Work board give the whole session to one place and nothing to the
  other (owner, 2026-10-16). The plan: attribute a session's turns to the
  repository their tool calls touched (the files' paths against the known
  repository roots), then cut each repository's share across its pull
  requests as `SpendByPR` does now, so the release plan and costs say each
  repository's and pull request's part. Open: what a turn that touched two
  repositories, or none, counts toward (split evenly, or to the last one
  touched), and whether the paths recorded on tool events are enough to
  tell. Decided by: a measured sample of the owner's sessions — how many
  touch more than one repository and how much of their cost is at stake —
  before any code, then an ADR.
- `OQ-22` — **Syncing chats with Claude.ai and ChatGPT (import built, live
  sync not).** The owner wants Caprock's chats (ADR-071) and his Claude.ai
  and ChatGPT conversations in one place (2026-10-16 and 2026-10-17,
  translated: "try to build chat sync"). Read on 2026-10-17; three OpenAI
  pages refused the fetch, so their wording is from search-engine extracts
  and is marked so:
  - **No supported way to read a consumer account's history, from either.**
    Anthropic's Messages API "is stateless … you always send the full
    conversational history"
    (<https://platform.claude.com/docs/en/build-with-claude/working-with-messages>);
    no documented endpoint reads claude.ai conversations. The one
    open-source reader of them uses the web app's own endpoints and calls
    that API "private and undocumented"
    (<https://github.com/skillsynchq/txcript/blob/main/docs/formats/claude-chat.md>).
    OpenAI's Conversations API persists conversations made through its
    Responses API (<https://developers.openai.com/api/docs/guides/conversation-state>);
    nothing there reads ChatGPT's own chats, and no OpenAI page found says
    either way in so many words.
  - **The terms rule out a third-party client reading them.** Anthropic's
    Consumer Terms (effective 2025-10-08,
    <https://www.anthropic.com/legal/consumer-terms>) forbid accessing the
    services "through automated or non-human means, whether through a bot,
    script, or otherwise" except with an API key or explicit permission,
    and to "crawl, scrape, or otherwise harvest data". OpenAI's Terms of
    Use forbid to "automatically or programmatically extract data or
    Output" (<https://openai.com/policies/terms-of-use/>, from an extract;
    current effective date not confirmed).
  - **Both offer a self-service export, and that is the supported route.**
    Claude.ai: Settings → Privacy → *Export data*; a link by email, signed
    in to download, expiring after 24 hours; "conversation data and the
    user data for your account"; no file list or format given
    (<https://support.claude.com/en/articles/9450526-how-can-i-export-my-claude-data>).
    ChatGPT: Settings → Data controls → *Export data*; a ZIP by email, "can
    take up to 7 days", link valid 24 hours; Free, Go, Plus, Pro and some
    Edu, not Business or Enterprise
    (<https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data>,
    from an extract).
  - **Neither documents the file.** Observed by open-source readers: the
    Claude.ai zip holds `conversations.json` (an array of `{uuid, name,
    created_at, updated_at, current_leaf_message_uuid, chat_messages}`,
    messages `{uuid, parent_message_uuid, sender, text, content[],
    created_at, attachments[]}`, so a tree with branches) beside
    `users.json` and `projects.json`
    (<https://github.com/kenn-io/agentsview/blob/main/internal/parser/claude_ai.go>,
    <https://github.com/risaacr/claude-chats>). The ChatGPT zip holds
    `conversations.json` (an array of `{title, create_time, update_time,
    conversation_id|id, current_node, mapping}`, the mapping a tree of
    `{parent, children, message: {author.role, create_time, content:
    {content_type, parts}}}`, the visible thread read back from
    `current_node`), `chat.html`, `user.json`, `message_feedback.json` and
    `shared_conversations.json`; newer exports leave private-use citation
    markers in the prose
    (<https://github.com/garrytan/gbrain/blob/master/src/core/transcripts/chatgpt-export.ts>,
    <https://github.com/CherryHQ/cherry-studio/blob/main/src/renderer/services/import/importers/ChatgptImporter.ts>,
    <https://community.openai.com/t/decoding-exported-data-by-parsing-conversations-json-and-or-chat-html/403144>,
    2023-09-29: "Is this documented somewhere?").

  **Decided** ([ADR-074](08-decisions.md)): import the export the user
  downloaded, on the machine, sending nothing; no live sync. **Still open:**
  (1) a live sync needs a supported read API or written permission from
  either company, and neither exists as of 2026-10-17; (2) the export
  formats are undocumented and may change without notice, so the importer
  reads every field as optional and a fixture from a real export is still
  to be checked by the owner on his own machine (none is in the repo); (3)
  whether a ChatGPT export carries Codex cloud tasks is not known. Revisit
  when either company publishes a history API or a documented export
  format.
- `OQ-23` — **Phone mode's bar heights are estimates.** A browser tab's
  phone mode (ADR-075, amended 2026-10-21; `ui/src/lib/phonemode.ts`) sizes
  the page to the screen less the status bar, the browser's bars and the
  home indicator. The screens are sourced (Apple's published resolutions;
  the Android panels divided by the usual default DPR, which depends on the
  phone's display-size setting), but every bar height — 54/83/34 on an
  iPhone 16, 56 for Chrome's top bar, 32 for Safari's slim strip, the
  landscape 48 — is a guess from the approved mockup, and the UI marks the
  page height *est.* until they are measured. Decided by: a test page
  opened on each real phone reporting `innerHeight`, `visualViewport` and
  the safe-area insets, bars shown and scrolled away.

## What would falsify the whole plan

- Anthropic ships an equivalent first-party mission control before Phase 1 — observe-only loses its reason to exist and only the orchestration/verification layer remains defensible.
- Windows cannot be made reliable through the PTY layer after the spike and one honest retry — then Phase 1's "control" story is POSIX-only and the moat claim is void.
- Phase 0 launches (Reddit/HN) and produces neither users nor complaints — no signal means no traceability rows, and the rule says features without rows get cut.
