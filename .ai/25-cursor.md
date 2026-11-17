# Cursor support

Caprock observes Cursor — the editor's Agent and Composer chats and the
`cursor-agent` CLI's — on the same screens as every other agent, carries
Cursor's own cost by model, starts and continues `cursor-agent` sessions, and
estimates how much Cursor sends on each request beyond what the person typed
([ADR-095](08-decisions.md)). Code: `internal/cursor` (reader, hooks,
installer), `internal/agents/cursor.go` (launch), `internal/agentcat/cursor.go`
(picker), `internal/store/cursor.go` (cost and overhead queries),
`internal/modelclass/family.go`, `ui/src/components/CursorSpend.tsx` and
`CursorOverhead.tsx`. Contracts: [03-contracts.md](03-contracts.md) § Cursor
and the Cursor ingest under § HTTP API.

## Why

The owner's ask (2026-11-16, translated): people who work in Cursor should be
able to use Caprock instead, with every model Cursor offers counted, and — if
it can be caught — the size of the prompt Cursor adds on its own, because
Claude on Cursor felt slower and hungrier for tokens than Claude Code.

## What Cursor gives us

Read on the owner's machine on 2026-11-16 (Cursor 2.3.41, `cursor-agent`
2025.09.12-4852336), read-only, the database opened `immutable=1`.

- **The editor's global database**, `<user dir>/globalStorage/state.vscdb`,
  6.6 GB on the owner's machine. The `cursorDiskKV` table holds:
  - `composerData:<chat id>` — one row per chat: `name`,
    `modelConfig.modelName` and `maxMode`, `unifiedMode` (agent, chat, plan),
    `status`, `createdAt` / `lastUpdatedAt` (ms),
    `fullConversationHeadersOnly` (the ordered message ids and types),
    `usageData` (`{<model>: {costInCents, amount}}`, Cursor's cost and request
    count per model — present on 22 of 58 chats with messages),
    `contextTokensUsed` / `contextTokenLimit` (Cursor's latest reading of
    the chat's context window).
  - `bubbleId:<chat id>:<message id>` — one row per message: `type` (1 user,
    2 assistant), `text`, `thinking.text`, `modelInfo.modelName`,
    `tokenCount {inputTokens, outputTokens}` (only on the last reply of a
    turn, and it is that one request's size, not the turn's sum),
    `contextWindowStatusAtCreation {tokensUsed, tokenLimit,
    percentageRemaining}` on a prompt (3,002 of 3,956 prompts on 2026-11-17),
    `toolFormerData {name, rawArgs, result, status, error, userDecision,
    toolCallId, modelCallId}` — `result` is JSON text (`{output, exitCodeV2,
    rejected, outputRaw, …}` for a terminal command), `error` JSON text with
    `modelVisibleErrorMessage` — `lastTerminalCwd`, `createdAt`.
  - `ItemTable` holds the sign-in (`cursorAuth/accessToken`) among other
    settings. It is never read.
- **Per-window databases**, `workspaceStorage/<hash>/state.vscdb`, whose
  `composer.composerData` lists a window's chats, with `workspace.json`
  naming the folder. Only about 7 of 193 chats on the owner's machine were
  listed there, so the folder usually comes from `lastTerminalCwd` (42 of 55
  chats) or from the first absolute path a tool touched (45 of 55).
- **The CLI's chats**, `<config dir>/chats/<md5 of the folder>/<chat
  id>/store.db` (config dir: `$CURSOR_CONFIG_DIR`, else
  `$XDG_CONFIG_HOME/cursor`, else `~/.cursor`). Its `meta` row (hex of JSON:
  `agentId`, `name`, `createdAt`, `mode`, `lastUsedModel`) is read to list
  models and to tell whether a chat can be resumed; its `blobs` are
  content-addressed protobuf and are not read. The owner has no CLI chats.
- **Hooks**, `~/.cursor/hooks.json` (`{"version": 1, "hooks": {<event>:
  [{command, timeout}]}}`), documented at cursor.com/docs (read 2026-11-16).
  Every event has `conversation_id`, `generation_id`, `model`,
  `hook_event_name`, `cursor_version`, `workspace_roots`. None carries tokens.

## How it maps

- **Editor chats** are read every 10 s, skipped when the database and its WAL
  are unchanged. Messages become `turn.user`, `turn.assistant` and `tool.pre`
  with keys under `cu-`; Cursor's tool names map to Claude Code's (`run_terminal_cmd`
  → `Bash`, `edit_file` → `Edit`, …) so the loop detector, Files and the
  timeline read them as they read any session. A restart re-reads only chats
  updated after the session's last event: about 3 s on the owner's database,
  against 21 s for the first pass.
- **The model a turn ran on** is the prompt's `modelInfo.modelName`; when
  the prompt names none (2,672 of 3,956 prompts on 2026-11-17) or names
  Auto (`default`), it is the one model `usageData` billed the chat for.
  When the bill names several, the turn's model is empty
  (`model_source: "unknown"`): which of them ran it is recorded nowhere.
  Only a chat with no bill falls back to the model picked in it now
  (`modelConfig`, `model_source: "picker"`). The picker is never taken over
  the bill: in 11 of the owner's 22 priced chats it named a model the bill
  did not, and in 4 it said `claude-4-sonnet` while every request was
  billed to `claude-4.1-opus-thinking`. Every row of a turn — prompt, reply,
  tool call, result — carries that model; the session is named by its
  newest turn's, else by the model it was billed most for.
- **The Context meter** reads Cursor's own measure: each prompt carries its
  `contextWindowStatusAtCreation` as `context_tokens` / `context_window`, and
  the chat's last finished reply carries the composer's latest
  `contextTokensUsed` / `contextTokenLimit`. The meter shows the newest of
  them (a 1M window in max mode, 176k or 200k otherwise) and never the
  turn's tokens, which are reconciled totals, not one request's size. A
  chat with no reading says "no context reading yet". No next-call price is
  shown for it: that is the table's arithmetic, and Cursor bills its own
  way.
- **Tool results** are `tool.post` rows (`cu-post:<message>`) in Claude
  Code's shape: `tool_use_id` (Cursor's `toolCallId`, also on the call),
  `tool_input`, `tool_response` — `{stdout: output}` for a terminal command,
  Cursor's result object otherwise, without the terminal's raw copy — and
  `is_error`. A call failed when Cursor's status is `error` (its message is
  the response), when the person rejected it (`rejected: true`), or when a
  terminal command exited non-zero (`exit_code`), as Claude Code marks a
  failed Bash. A cancelled call is `interrupted`; a running one gets its
  result on the pass after it finishes. So a Cursor chat's timeline shows
  outcomes and failures, loop alerts and tool sizes count them, and the
  pull-request readers find a `gh pr create` URL in the output and the
  branch a `git push` sent (`gitremote.PushFromOutput` reads git's `To
  <remote>` block when no `gitOperation` is recorded) — so `session_prs`,
  `session_branches` and the PR and CI cells fill as for Claude Code.
- **Chats stored before** the three points above are read again once, on the
  first start that has them (meta `cursor_parity_repaired`): each stored
  row's model and payload are corrected in place, prompts gain their
  readings, calls their `tool_use_id`, and the results are added. When a
  chat's models change, its reconciled usage is taken back out of the rows,
  `session_stats` and `daily_stats` and recorded again from Cursor's totals
  under the right models, on rows dated the chat's last update — the chat's
  total tokens and cost do not move, only their split by model. On a copy
  of a store filled by the earlier reader from the owner's database
  (2026-11-17, 58 chats): tokens 194,039,241 and cost $882.16 before and
  after, in the rows, `session_stats` and `daily_stats` alike (equal to a
  direct sum of Cursor's `tokenCount` figures); `claude-4.1-opus-thinking`
  from 7 rows to 1,586 turns and `claude-4-sonnet` from 3,042 to 2,234; 729
  turns of chats billed to several models with no model; 17,196 results
  added, 1,382 of them failed; 913 prompts with a reading; 25 pull requests
  in 11 chats and 78 pushed branches. It took 2 min 19 s, once.
- **CLI chats** arrive through the hooks, when the user turns them on. A hook
  for a chat the editor database holds is dropped, so nothing is counted
  twice. A chat Caprock started is filed under its Caprock session through
  `CAPROCK_CURSOR_SESSION` in its environment.

## Cost

Cursor's own figure, never the table's.

- `usageData` is the only cost: per chat and model, carried as the difference
  between Cursor's totals and what Caprock holds, so a chat that gains usage
  later is reconciled (the Hermes pattern, [24-hermes.md](24-hermes.md)).
  On the owner's machine (2026-11-16) the imported total over 22 priced chats,
  eight models and 4,140 requests matched a direct sum of `usageData` to the
  cent.
- A chat without `usageData` is unpriced: its tokens are shown, with "Cursor
  recorded no cost", and stay outside every total. Pricing those tokens from
  the table was tried against the chats Cursor did price and was off by half
  to double: `tokenCount` is one request per turn and has no cache split.
- The CLI's hooks carry no tokens and no cost, so a CLI chat shows turns and
  tools and no spend. The UI says so on the session.
- `pricing.json` has `cursor-composer-2.5` and `cursor-composer-2.5-fast`
  (cursor.com/docs/models, read 2026-11-16) only to value the overhead below;
  Cursor's other models are third-party ones billed at their list price plus
  Cursor's Token Rate ($0.25 per 1M), which the table leaves out.

## Overhead

What Cursor sends that the person did not write — its system prompt, tool
definitions, rules and the context it attaches on its own. An estimate,
always labelled as one.

- **Cursor** (per chat, `context.overhead`): the first turn's measured request
  (`tokenCount.inputTokens`) minus everything readable before it in that turn
  — prompt, replies, thinking, tool arguments and results — at 4 bytes a
  token. The sample is *clean* when that readable part is at most a quarter
  of the request; only clean samples enter the medians.
- **Claude Code** (per session, computed on read): the first priced main-thread
  request's `tokens_in + cache_read + cache_write` — exact, from the API —
  minus the first prompt at 4 bytes a token.
- Both are grouped by `modelclass.Family`, so Cursor's `claude-4-sonnet` and
  Claude Code's `claude-sonnet-4-20250514` share a row.

Measured on the owner's machine, 2026-11-16 (Cursor chats from 2025, clean
samples only), while a chat whose prompts named no model was still filed
under the model its picker showed, so the claude-4-sonnet row includes chats
billed to another model:

| Cursor model               | Chats | Clean | Median  | Smallest |
| -------------------------- | ----- | ----- | ------- | -------- |
| claude-4-sonnet            | 14    | 7     | 88,458  | 13,395   |
| claude-4.5-sonnet-thinking | 5     | 3     | 84,984  | 60,256   |
| gpt-5, gpt-5-fast          | 3     | 1     | 65,901  | 65,901   |
| o3                         | 1     | 1     | 146,767 | 146,767  |
| code-supernova-1-million   | 1     | 1     | 11,600  | 11,600   |
| gpt-4.1                    | 1     | 1     | 9,715   | 9,715    |
| unnamed model              | 2     | 1     | 7,208   | 7,208    |

composer-1 (9 chats), default and claude-4-opus-thinking had no clean sample.
The claude-4-sonnet figures are bimodal: the smallest clean one, 13,395, is
closest to Cursor's fixed prompt; the median includes files Cursor attached
by itself. Claude Code on the same machine, last 30 days, claude-opus-5-5:
8,278 sessions, median 30,848 tokens beyond the typed prompt (quartiles
29,667 and 31,999, smallest 22,255). There is no model both agents ran in
the same period on this machine, so no same-model comparison exists yet; the
Cost screen shows one when there is.

## Launch

`cursor-agent` (`agent` counts only when it resolves to `cursor-agent`: Grok's
binary has the same name). Argv: `[--resume <chat id>] [--model <id>]
[--force] <prompt>`, every flag present in the 2025.09.12 `--help`
(`internal/agents/testdata`). *Bypass* is `--force`; plan and accept-edits
start Cursor as it is, because `--mode plan` is not in every CLI. Models are
typed: Cursor's list depends on the account and comes over the network
(`cursor-agent models`), so the picker offers the one in `cli-config.json`,
those recent CLI chats used, and the `--help` examples. **Continue** runs
`cursor-agent --resume <chat id>` when the CLI holds that chat for that
folder; an editor chat is continued in Cursor.

## Safety

- The editor database is opened `mode=ro` with a busy timeout and one
  connection; `ItemTable` is never queried.
- Hooks are installed only from the Cost screen's button, never by the
  daemon or `caprock hooks install`. The installer merges into the file,
  keeps every other tool's entry (the owner's holds Orca's), is idempotent,
  saves the original once, and uninstall restores it byte for byte.
- Only events that decide nothing are registered. Permission hooks block the
  action when their answer does not parse, so a broken shim there would stop
  the user's work.
- `caprock-hook cursor` prints Cursor's neutral answer before doing anything
  else and exits 0 on every path within the shim's budget (rule 3).

## Not read

- The CLI's `blobs` (protobuf), so a CLI chat started outside Caprock without
  hooks is not seen, and no CLI chat has tokens.
- `~/.cursor/projects/<slug>/agent-transcripts/*.txt`: the database has the
  same content with structure.
- Cursor's background agents, Bugbot and team usage, which live on Cursor's
  servers.
- Per-request tokens: Cursor keeps one request per turn locally.
- Which of several billed models ran a turn whose prompt names none.

## Verified on

- **Real data, read-only:** the editor reader, cost reconciliation, folders,
  the turn model, readings, tool results, pull requests and the repair of
  stored chats (into a throwaway store, 2026-11-17), and the overhead figures
  above (`TestLiveEditorDatabase`, gated by
  `CAPROCK_CURSOR_LIVE=1`); the hooks installer on a copy of the owner's
  `hooks.json`.
- **Fixtures only:** the CLI's hooks (shapes from Cursor's docs), its `meta`
  reader, `--resume`, and launch with a fake `cursor-agent`. The owner is not
  signed in to the CLI and has no CLI chats.
