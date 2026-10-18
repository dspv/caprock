# Resource usage and performance audit

**Date:** 2026-10-18. **Source snapshot:** `72e44228fdf5cf3674b6c48f9f137f9b81efd788`.
**Scope:** daemon, ingestion, SQLite, event delivery, terminal hosts, React/xterm,
desktop supervision, background work, optional integrations and measurement coverage.
This is an investigation and implementation proposal; production behavior was not changed.

## Assessment

The architecture is appropriate for a local agent controller. Replacing Go,
SQLite, React or Tauri is not justified by the evidence collected here. The
strongest opportunities are in the amount of work repeated as histories grow,
transient allocations, and the resources retained by inactive views.

Start with three independently reviewable changes:

1. Enforce a real streaming limit on Claude transcript records. The configured
   limit currently does not bound allocation, and complete oversized lines bypass it.
2. Replace the terminal byte buffer's sliding slice with a circular buffer.
   Its retained length is bounded, but sustained output still produces avoidable
   backing-array allocations and copies in both the daemon and terminal holder.
3. Make Codex ingestion incremental, with explicit parser checkpoints and a
   replay fallback. Today a change near EOF causes the entire transcript to be
   parsed again and its historical records offered to the store again.

These are recommendations, not accepted design decisions or promised savings.
The measured allocations below establish costs worth addressing; they do not
establish the improvement of an implementation that has not been built.

## What the application does and where resources go

The authoritative architecture is [the architecture document](../.ai/02-architecture.md).
The following is a resource-oriented reading of the current implementation.

```text
Agent hooks / transcript files / agent databases
    -> Go readers and normalization
    -> Recorder.Record: pricing + event + session/statistics transaction
    -> SQLite WAL database
    -> live event bus -> WebSocket -> React observation screens

Owned agent process <-> PTY holder process
    -> holder byte buffer -> daemon byte buffer
    -> terminal WebSocket with offsets/acknowledgments -> xterm -> WebView/GPU

Tauri shell -> daemon discovery and supervision, tray, notifications
Housekeeping -> liveness, history repair, compaction, checkpoints, resource sampling
Optional services -> GitHub, mail, remote access, agent-backed extraction
```

- **Observation** captures sessions started outside Caprock as well as owned
  sessions. Saving resources cannot mean disabling observation when the window closes.
- **Control** adds owned PTYs. A separate holder survives daemon restarts. Its
  process overhead is deliberate reliability infrastructure.
- **Orchestration** adds task routing, worker sessions and verification. An
  agent, compiler or test process can dominate machine usage while Caprock's own
  controller remains cheap. Report those separately.
- **The desktop** serves the same dashboard through the system WebView. Measure
  the shell, WebContent, GPU and networking helpers together, while accounting
  for daemon and holder processes separately.
- **Persistence** trades disk space and write work for durable history, pricing,
  search and restart recovery. Optimizations must preserve those semantics.

## Investigation method and limits

Read the onboarding rules, product and architecture map, engineering rules,
relevant desktop budgets and performance history, benchmark documentation and
implementation paths cited below. Examined existing safeguards before proposing
replacements. Checked runtime guidance against the primary references at the end.

Performed these experiments against this checkout:

- Synthetic Codex parser scaling, using the real `codex.Parse` implementation.
- Sustained writes into the real `termbuf.Ring`, after filling its buffer.
- Complete and incomplete oversized records through the actual Claude tailer's
  `readFile`, using an in-memory store and synthetic malformed input.
- The repository's `BenchmarkBrainSearch`, including full graph loading.
- An isolated daemon build, HTTP probes, a CPU profile and a post-GC heap profile.
- Repository validation; final status is recorded under Verification.

**Environment:** MacBookPro18,3, 10 logical CPUs, 17,179,869,184 bytes physical
memory, macOS 27.0.1 build 26A434, Go 1.27.1, Node v22.22.0. The module declares
Go 1.26.0; these new measurements used the installed Go 1.27.1 toolchain.

**The host was busy.** One observed load-average sample was 20.53 / 18.60 /
19.80. Other development jobs and this audit's checks were running. Timings are
exploratory observations under contention, not release performance claims.
Allocation totals are more useful here, but runtime overhead and sampling still
introduce variation. Parser benchmarks are in-memory; they exclude disk I/O,
database writes, event fan-out and rendering.

The daemon used a temporary HOME, data directory, service label and dynamically
selected loopback ports, with hooks, browser opening and update checks disabled.
It had no sessions, user history or connected UI. Only this audit's child daemon
was stopped. No user sessions were signaled, and no live database was opened for
the experiments. The pre-existing untracked root `package.json` was left alone.

**Not measured afresh:** desktop physical footprint, GPU memory, actual battery
power, a long-running real-history workload, phone reconnect latency, Linux or
Windows runtime performance. This is broad source inspection plus targeted
experiments, not exhaustive execution of every feature.

### Earlier results are historical evidence

The committed [2026-10-06 benchmark results](../bench/results-2026-10-06-fixes/summary.md)
cover desktop footprint, terminal responsiveness, CPU and phone recovery.
They exclude daemon and session processes from the desktop memory rows.
They cannot establish the footprint or hidden-window CPU of this snapshot:
[the desktop performance history](../.ai/21-app.md#a-hidden-window-does-no-work-2026-10-13)
records subsequent changes to hidden work, clocks and event batching.
The original [benchmark methodology](../bench/README.md) also explains the
snapshot build's occlusion and App Nap differences. Re-run the release build
before declaring a current desktop budget passed or failed.

## New measurements

### Codex parser: work scales with the whole file

Input was the first `session_meta` line of the repository's basic Codex fixture,
followed by repeated valid `event_msg/user_message` records, each with a
1,024-byte ASCII message. This exercises parsing and prompt accumulation, not
the full mix of real tools and token accounting. `testing.Benchmark` selected
the iteration count; a sink kept results observable.

```text
records  input bytes  ns/op       B/op      allocs/op  iterations
1024       1154552     109882289   3803814       7218          40
8192       9232888    1159318042  30939760      57435           1
16384     18465272    1501659916  62426888     114790           1
```

The 18,465,272-byte synthetic transcript allocated about 62.4 MB cumulatively
per parse. This is **allocated bytes per operation**, not retained heap or peak
RSS. Combined with the whole-file read path, it establishes repeated allocation
work as an active transcript grows. It does not predict a real user's CPU rate.

### Terminal buffer: bounded retention still allocates during writes

The buffer was initialized at 256 KiB and filled before timing. Each operation
wrote one preallocated ASCII chunk; terminal-mode scanning and wake-channel
creation remained enabled, just as in the real implementation.

```text
chunk bytes  ns/op   B/op   allocs/op  iterations
1024         17482    5156          1      117327
16384       258798   77952          1        6111
```

Allocation bytes per write exceed the chunk size even though the retained
buffer length stays bounded. The sliding slice consumes backing-array capacity,
and later appends allocate and copy its retained tail. The displayed allocation
count is an integer average; it does not mean every write allocates exactly the
same objects. `wake()` also allocates a channel on every write.

### Claude tailer: a 16 MiB setting is not an allocation bound

Each operation read a new file state over 32 MiB of `x`, with or without a
newline. `lastSize: -1` intentionally disabled persisted-offset restoration so
every timed operation read the file. The input was allocated before timing.

```text
input                 bytes      ns/op      B/op      allocs/op
without newline       33554432   102306520  67379703          153
with trailing newline 33554433   218234138  67388542          155
```

Both cases allocated about 67.4 MB per operation before a meaningful record
could be accepted or rejected. The complete-line branch never checks `MaxLine`.
Malformed ASCII makes the parser reject quickly; a valid large JSON object can
require additional parsing allocations. This experiment establishes missing
bounded reading, not a production memory leak.

### Second Brain: graph materialization matters alongside search

Command, using the existing benchmark and its synthetic fixtures:

```sh
go test ./internal/store -run '^$' -bench '^BenchmarkBrainSearch$' \
  -benchmem -benchtime=3x -count=1
```

Selected raw results; `none` means no search filter and includes graph loading:

```text
case            ns/op      B/op      allocs/op
1000/word        69711625    877882        5704
1000/two-words   43700403    776384        4853
1000/none        79447278   2403928       25266
5000/word       176721042   4886381       32411
5000/two-words  373065847   4231397       26292
5000/none       567140181  15470837      134396
```

Only three timed iterations were requested per case. The timings are not stable
latency percentiles. The allocation growth supports measuring graph construction,
serialization and browser graph ingestion before choosing a search engine change.

### Empty daemon baseline

Built with `go build -o /tmp/caprock-resource-audit-daemon ./cmd/caprock`, using
the embedded UI already present in the checkout. No UI was opened.

- **Readiness:** first successful `/healthz` after 1.105 s, sampled at 100 ms
  intervals. Includes process launch and fresh-store setup; not desktop startup.
- **RSS:** `ps` reported 35,840 KiB before profiling and 34,688 KiB afterward.
  These are two samples, not a peak or macOS physical footprint.
- **CPU:** process CPU time increased from 0.15 s to 0.19 s across the profile
  operations. The 20.13 s CPU profile contained just one 10 ms sample, in
  `runtime.pthread_cond_wait`. Too little activity to rank application hotspots
  or certify an idle CPU budget.
- **Heap:** the post-GC sampled in-use profile totaled 7,193.29 kB. Its largest
  sampled site was `modernc.org/libc/honnef.co/go/netdb.init.0`, 3,522.37 kB.
  Sampled attribution is not an exact heap census, SQLite working set or RSS.
  The profiling listener itself also appears in the profile.
- **Fresh-store files:** main database 4,096 bytes, WAL 1,668,632 bytes, shared
  memory 32,768 bytes before shutdown. This reflects fresh migrations, not an
  idle daily write rate or a leaked WAL.

Ten sequential requests per endpoint produced these observed minimum/maximum
times, including Python loopback HTTP client overhead:

```text
endpoint                       minimum ms  maximum ms  response bytes
/healthz                            1.683      41.257              32
/v1/status                          4.755      57.635            1505
/v1/sessions                        0.798       3.307               3
/v1/stats/summary?range=today        0.868       2.512             448
```

An empty daemon is inexpensive in this experiment. It says little about an
eight-connection database cache after hours of ingestion or a busy WebView.

## Profile 2026-10-18 (post-0.134.0)

F1–F3 shipped in 0.134.0. Before choosing among F4–F12, the daemon was
profiled under a working load, as decision gate 4 asks. The result reorders the
list: the largest costs are two dashboard reads that no finding above named,
recorded below as F13 and F14.

**Stand.** A daemon built from `40b359cb` (0.134.0) in a throwaway directory:
`env -i` with a temp `HOME` and `TMPDIR`, its own data directory and port,
`CAPROCK_SECRET_STORE=file`, `CAPROCK_PPROF` on loopback, `--no-hooks
--no-open`, update checks and notifications off. The stand script is
`bench/busy-stand.sh` plus those settings and seeded history.

- **History:** 400 synthetic Claude transcripts (100 turns each, three records
  per turn, across 25 projects) and 120 Codex rollouts (75 turns each), dated
  over the last 120 days. After ingestion the database held 181,312 events,
  532 sessions and 235 MB.
- **Terminals:** the nine tabs of `busy-stand.sh` — six fake `claude`
  sessions under pty-hosts, one printing 20 lines a second, and three shells.
- **Live work:** four Claude transcripts each appending a turn (three records)
  every second, two Codex rollouts each appending a turn every two seconds, and
  a hook (`PreToolUse`/`PostToolUse`) posted every 200 ms — about 4 a second
  were accepted, 716–766 per run.
- **Viewers:** Playwright's headless shell (never the system Chrome) with two
  pages, each holding its live socket: the app workspace with the printing tab
  in front, and the dashboard's Now screen.

**Phases.** Backfill (until `/v1/status` reported it done; a 30 s CPU profile
at its start), idle (terminals only, no viewer, no writes; 110 s CPU profile),
and load (viewers and live work; 150 s CPU profile, allocation profiles at its
start and end, heap after GC). `ps` sampled RSS and CPU time of the daemon and
its pty-hosts every 5 s. The machine was an Apple M1 Pro (10 cores, 16 GB)
shared with other agents' builds and tests. Load averages are given per run;
they ranged from 4.7 to 79. Timings are therefore noise, and the shares of the
CPU profile and allocated bytes are the evidence. Raw profiles stay local.

**What the daemon did.** Two runs of 0.134.0 (load averages 4.7–6.5 and
7.6–14.1):

```text
phase     daemon CPU   daemon RSS (end / max)  pty-hosts (9)
idle      0.3–0.4%     47–96 / 113–124 MiB     0.4–0.6% CPU, 53–80 MiB
load      18.5–24.5%   90–117 / 179–201 MiB    0.5–0.8% CPU, 54–81 MiB
backfill  159–182 s to ingest the seeded history
```

The sampled Go heap in use after GC was 12–13 MB in every phase, so most of
the RSS is outside the Go heap (SQLite's page caches and mapped database pages,
runtime overhead); F8 is where that would be split.

**Where the load-phase CPU went.** Share of the daemon's CPU profile, by
`-focus` on the named function (a sample can fall under two names):

| Area                                         | Finding    | base1 | base2 |
| -------------------------------------------- | ---------- | ----- | ----- |
| `/v1/history?range=all` refresh              | F13        | 39.8% | 42.6% |
| `/v1/sessions` (per-session summaries)       | F14        | 17.7% | 17.8% |
| `/v1/work`                                   | —          | 3.1%  | 3.2%  |
| `/v1/stats/summary`                          | —          | 3.3%  | 2.5%  |
| `Recorder.Record` (live ingest, all sources) | F7         | 7.0%  | 7.0%  |
| Claude tailer                                | F4         | 5.2%  | 5.1%  |
| Codex ingester                               | F4         | 1.1%  | 1.4%  |
| Live socket `writeFrame`                     | F6         | 1.6%  | 1.9%  |
| Resource sampling                            | F10        | 0.4%  | 0.3%  |
| GC background marking                        | —          | 2.4%  | 2.4%  |
| Bus publish, terminal buffer, `passHot`      | F5, F2, F4 | 0     | 0     |

Allocated bytes during the load window, the same split: the history refresh
596 and 573 MB (31–32% of 1,871 and 1,846 MB), `/v1/sessions` 778 and 767 MB
(41–42%), `Recorder.Record` 43 and 54 MB, `writeFrame` 28 and 36 MB.

**Requests behind those figures.** The viewer counted every `/v1/` request
over about 210 s in the second run: `/v1/sessions` 544 times from the app
page and 385 from the Now screen (4.4 a second together), `/v1/window-stop`
408, `/v1/work` and today's summary 164 each, `/v1/history?range=all` 24 (one
every 9 s, the Now screen's `SLOW_LIVE_MS`). Each of those 24 recomputed the
all-time history, because with agents writing the data version always moves
and the history TTL is 3 s. On a copy of the stand's database one all-time
history computation allocated 38.2 MB and took 0.66–1.33 s (best of runs on
the loaded machine).

**Backfill.** `Recorder.Record` was 50–55% of the backfill profile and its
commits alone 36–37%; per-event transactions are the cost of a first import
(F7). A further 27–28% was the scheduler waking threads for new goroutines
(`runtime.newproc` → `wakep`), which F15 attributes to the SQLite driver.

**Ranking.** By measured share of daemon CPU and allocation under a working
load:

1. **F13 — all-time history recomputed on every poll:** 40–43% of CPU,
   31–32% of allocation; 76% of CPU on an 890k-event history. Fixed, see
   F13.
2. **F14 — `/v1/sessions` summarises every listed session per request:**
   18% of CPU before F13 and 22–33% after; 41–42% of allocation before, the
   largest single cost after F13. Implemented, see F14.
3. **F7 — per-event transactions:** 7% of CPU while working; 50–55% of CPU
   during a backfill, which took 159–182 s for this history. Implemented, see
   F7.
4. **F15 — a goroutine per SQLite statement:** about 8–11 µs of CPU per
   statement in a probe; 27–28% of backfill samples, 4% under load.
   Implemented for the recorder, see F15.
5. **F6 — live frames encoded per viewer:** 1.6–1.9% with two viewers.
   Not justified until there are more viewers.
6. **F10 — resource sampling:** 0.3–0.4%. Not justified.
7. **F4 — discovery and `passHot`:** no samples for the Claude tailer's
   discovery; the Codex sweep's directory listing was 80–100 ms in the 110 s idle
   profiles (the whole idle daemon was 0.24–0.32% of a core). Not justified at this
   history size; worth re-measuring on a machine with years of files.
8. **F5 — replay memory:** no bus samples; the whole sampled heap was 12–13 MB.
   Not justified.
9. **F8 — SQLite pool and caches:** RSS of 90–200 MiB against a 12–13 MB Go
   heap says the database side holds most of the memory, but this profile does
   not split page cache from mapped pages. It needs the comparison F8 proposes.
10. **F2 (shipped), F9, F11, F12:** the terminal buffer drew no samples at
    20 lines a second. Inactive tabs (F9), Second Brain (F11) and large imports
    and power (F12) were not exercised by this workload; nothing here argues for
    or against them.

**Reproduction.** The harness lived in a scratch directory and is not
committed; its parts are `bench/busy-stand.sh` with the settings above, a
Python generator for the history and the live appends, a CDP script that opens
the two pages and counts requests, and `go tool pprof -focus` over the saved
profiles. The probes for F13 and F15 are described in their sections.

## Findings and implementation proposals

Priorities below are audit recommendations: **P1** first focused changes,
**P2** workload-dependent next steps, **P3** measurement-led follow-up. They
describe urgency relative to this audit, not confirmed user incident severity.

### F1 — P1: bound transcript reading before allocating a record

**Evidence:** [Claude tailer](../internal/ingest/tailer.go), `readFile`.
`ReadBytes('\n')` accumulates the whole record. `MaxLine` is checked only after
an incomplete EOF read; the successful newline branch passes directly to
`handleLine`. See the 32 MiB experiment above.

**Proposal:** use bounded fragment reading, with a documented oversized-record
policy and discard state that survives a partial write. Count and report the
oversize record once, preserve accurate byte offsets, and continue after its
delimiter. A simple `LimitReader` that makes a mid-record offset look like a
new JSON record would be incorrect. Do not reduce accepted valid input silently.

**Expected effect:** bounds a single input record's temporary memory and limits
damage from malformed or unexpectedly large tool output. No steady-state saving
is claimed for ordinary small records.

**Acceptance:** complete and partial oversized records, a delimiter appended
later, the next valid line, truncation, cancellation and SQLite-busy retry all
work. Allocation remains bounded as the oversized record grows. Define any
acceptance-policy change in the transcript contract alongside implementation.

**Implemented (2026-10-18).** `readFile` reads a record through
`bufio.Reader.ReadSlice` and keeps it only while it is within `MaxLine`. A
longer record is dropped as it is read, counted once in `lines_malformed`,
logged once, and reading continues after its newline. Until the newline
arrives, a `skipTo` position in the file state lets the next read resume
inside the record, while the persisted offset stays on its first byte. The
policy is in the [transcript contract](../.ai/03-contracts.md#transcript-jsonl-observed-shape).
One acceptance change: a complete record over 16 MiB used to reach the parser
and is now skipped. The longest line in 4.0 GB of the owner's local
transcripts (702 files, 593,686 lines) was 2.1 MB, measured the same day.

Fixing it showed a second defect. A partial record over the limit was dropped
by moving the offset into its middle. On the next read the byte before that
offset was not a newline, so the replaced-file check sent the tailer back to
offset 0 to read the whole transcript again.

`BenchmarkReadFileOversize` and `BenchmarkReadFileSmallRecords` in
`internal/ingest/tailer_bench_test.go` measure one `readFile` from a fresh
file state, with `-benchmem -count=5` on an Apple M1 Pro. The machine was
loaded by other work (load average 7.7–13.5), so ns/op is noise and the
figures below are medians of five runs; B/op and allocs/op varied by less
than 0.01% between runs.

```text
input             before B/op  allocs  before ns/op  after B/op  allocs  after ns/op
32 MiB, partial      67379204     152      20714182    17045356      82     9522961
32 MiB, complete     67387420     152      20602737    17045702      93     9106473
64 MiB, partial     134496282     281      36840860    17045297      82    12833618
64 MiB, complete    134504452     281      29694816    17045585      93    15098826
4096 x 1 KiB lines    4457168    4112       3833069     4457167    4112     4595955
```

A read of an oversized record now allocates about 17 MB whatever its size,
which is the 16 MiB `MaxLine` held in fragments before it is rejected plus
one reader buffer. Before, it allocated twice the record's size. Ordinary
short records allocate the same bytes and objects as before. Their ns/op
difference is within the noise of the loaded machine.
`TestOversizedRecordAllocationIsBounded` asserts the bound for records four
and sixteen times a test limit. The audit's own 32 MiB run took 102 ms
(partial) and 218 ms (complete) per read. The before column above, on the
same code, measured about 20 ms for both. Timings on this machine are not
comparable between runs.

### F2 — P1: remove sliding-buffer allocation from terminal writes

**Evidence:** [terminal buffer](../internal/termbuf/ring.go), `Write`, `wake`,
`Since` and `SnapshotAt`; [PTY holder](../internal/ptyhost/host.go). The buffer
drops a slice prefix, then appends to the remaining backing array. Both the
holder and daemon keep a buffer, for different restart/reconnect boundaries.

**Proposal:** store bytes in a fixed backing array with a write cursor and held
length. Copy across wrap boundaries. Allocate a contiguous result when a caller
actually needs a snapshot or delta. Preserve mode tracking, offsets, restoration
and the missed-wakeup protection of `Changed()`.

**Expected effect:** fewer backing-array allocations and tail copies on sustained
output. The channel allocation and outbound copies remain separate costs; do
not promise allocation-free writes unless those are also addressed safely.

**Acceptance:** existing ring, mode and protocol tests pass; wraparound and
concurrent replay remain exact. Compare the same two chunk benchmarks before
and after, then measure terminal echo and total holder/daemon CPU under flood.

### F3 — P1: checkpoint Codex parsing instead of replaying growing history

**Evidence:** [Codex ingester](../internal/codex/ingest.go), `once`, skips
unchanged size/mtime pairs, but calls `ParseFile` after any change.
[The parser](../internal/codex/codex.go) starts from the beginning and builds a
session. The import path then revisits historical prompts, turns and tool calls;
store deduplication prevents duplicate rows but does not make parsing or SQL free.

**Proposal:** first add counters for bytes read, records decoded and duplicate
records offered per sweep. Then implement resumable parser state: byte boundary,
cumulative usage baseline, pending prose, current request/turn context, metadata,
and tool linkage. Persist enough state for restart, or deliberately replay once
on restart while remaining incremental within a run. Keep full replay for
rewrites, invalid checkpoints and compressed archival files.

**Expected effect:** appended data can cost work proportional to the append
rather than the entire history. A naive seek-to-EOF optimization would lose
context needed for pricing and message association.

**Acceptance:** compare incremental and full replay outputs for every supported
fixture, partial lines, late prose, parent/subagent linking, cumulative counters,
compressed moves, rewrites, restarts and failed DB writes. Measure growing
transcripts and append-one-record sweeps, not only initial import throughput.

### F4 — P2: extend incremental ingestion and prune stale discovery state

**Evidence:** [DeepSeek ingester](../internal/deepseek/ingest.go) follows the same
changed-file/full-parse pattern. [Claude discovery](../internal/ingest/tailer.go)
rescans every 30 s, and `passHot` still walks all known file states in memory
every 2 s to pick recent files. Its `files` map adds paths but does not remove
deleted ones. [Gemini ingestion](../internal/gemini/ingest.go) already uses
offsets, but opens/stats matching telemetry files on every sweep.

**Proposal:** measure directory entries, stats, opens and stale path count by
reader. Add reconciliation for removed paths, and separate discovery from
reading active files. Consider an explicit hot set after measurements justify
it. Apply incremental parsing to DeepSeek with its own record semantics.

**Expected effect:** reduces work as years of history and deleted paths
accumulate. This does not re-propose the already-shipped dirty-file fsnotify
optimization described in `tailer.go`; preserve the polling degradation path.

**Acceptance:** absent/overflowing watchers, new nested directories, moved files,
deletion/recreation and quiet files becoming active still converge correctly.
Do not introduce gaps by treating mtime alone as a permanent identity.

### F5 — P2: separate replay memory from frame count

**Evidence:** [event bus](../internal/bus/bus.go) retains at most 2,000 frames,
with age eviction performed on publish or replay access. That limits entries,
not total payload bytes. Expired data can stay referenced while the bus is idle.
Subscribers also retain frame references in channels. Existing
[tool-field caps](../internal/event/capfield.go) and assistant text limits
already reduce payloads and should be preserved.

**Proposal:** expose replay bytes and subscriber backlog before choosing a byte
budget. Add byte-aware eviction while preserving sequence/floor behavior. If
idle retention is material, expire it through existing housekeeping rather than
adding a frequent timer. Keep urgent control/permission delivery correct.

**Expected effect:** more predictable memory under a burst of large frames.
There is no demonstrated unbounded frame-count leak, and shared references must
not be counted as separate copies of their underlying payload.

**Acceptance:** reconnect replay, age/size eviction, slow subscribers, lag
recovery and reset-to-REST work under the byte budget. Measure retained bytes
after the burst ends as well as allocation during it.

### F6 — P2: encode live frames once when several viewers are connected

**Evidence:** [live WebSocket writer](../internal/api/ws.go), `writeFrame`,
calls `Frame.Marshal` for each delivery. [Frame.Marshal](../internal/bus/bus.go)
does not cache encoded bytes, despite its comment saying encoding happens once.
Desktop, browser and paired devices can request identical frame encodings.

**Proposal:** profile one, two and several viewers. If serialization is
material, attach a shared immutable encoding to the published frame or hub's
delivery representation. Keep typed data for in-process consumers and account
for retaining both typed and encoded forms.

**Expected effect:** reduces repeated serialization with multiple viewers;
could increase retained memory. A single-viewer installation may gain little.

**Acceptance:** replay bytes and wire format remain identical, client writes
stay independent, and slow clients cannot block publishers.

### F7 — P2: batch background history writes without delaying hooks

**Evidence:** [Recorder.Record](../internal/rollup/rollup.go) performs one event
transaction, with session/statistics work and two live publications after a
successful non-internal event. This is appropriate for live events, but a
historical import can repeat transaction and notification work for many rows.

**Proposal:** benchmark a synthetic large backfill concurrently with a live
hook before implementation. If transaction overhead dominates, add a bounded
background batch through the recorder, with count/time limits and explicit
yielding. Publish only committed results; coalesce session summaries where the
contract permits it. Keep live hook handling on its latency-bounded path.

**Expected effect:** fewer commits and redundant session summaries during
backfill. Larger batches can worsen write-lock latency, cancellation and
recovery, so maximum ingest throughput alone is the wrong success criterion.

**Acceptance:** live hook latency, SQLITE_BUSY retry, exact pricing/dedupe,
restart offsets and crash recovery remain correct under concurrent imports.
Do not move offsets past events whose transaction failed.

**Implemented (measured 2026-10-18).** The Claude transcript tailer and the
Codex importer write through `rollup.Batch`: the recorder's per-event work,
each event under its own savepoint, in one transaction of up to 512 events or
50 ms. The tailer commits a transcript's offset in that transaction, so it can
never run ahead of the events; a batch that fails rolls back whole and is read
again. Frames are published, and the spend cap checked, only after the commit,
with one session frame per session per batch. Hook events keep their own
transaction through `Record`; the recorder's writers share an in-process lock,
and an open batch commits as soon as a `Record` waits for it. OpenCode, Hermes,
Gemini and DeepSeek still record one event per transaction: none of them drew
samples in the profile.

Three things only the stand showed. Savepoints spill SQLite's statement journal
to a temporary file once an event changes more than 64 KiB of pages, and that
file is not truncated while the transaction lasts: the first batched build spent
46% of its import CPU writing to it, so a batch's connection runs with
`temp_store = MEMORY` while it is open. Two importers whose batches each yielded
to any waiting writer ended each other's batches after every event, which was
slower than before. And back-to-back batches starved writers outside the
recorder, which wait in SQLite's busy handler: a project could not be added for
five seconds and failed. A batch now yields only to `Record`, and leaves the
lock free for a quarter of the time the previous batch held it.

Same stand, history and settings as the profile above, base (`635b967b`) and
branch back to back, two pairs (load averages 4.4–7.7, 24.6 at the start of
one base run):

```text
                          base          batched
import wall time          149–150 s     101 s
import CPU                152–160 s     83–84 s
backfill: commits         35%           3.5–3.8%
load: daemon CPU          12.8%         11.6–11.9%
load: recorder share      6.6–6.9%      2.7–3.0%
```

The import is the time from the daemon's start to the event count settling
(178,000 events). Tests cover batch boundaries, a batch that never commits, an
event failing inside a batch, a read stopped mid-batch resuming with no loss or
duplicate and the offset matching the rows, SQLITE_BUSY, a hook landing within
the shim's one-second budget during an import, and another writer landing
during one.

### F8 — P2: measure the SQLite pool before reducing caches again

**Evidence:** [store configuration](../internal/store/store.go) uses WAL,
`synchronous=NORMAL`, an eight-connection pool, a 16 MiB suggested page-cache
budget per connection and a roughly 2 GiB mmap ceiling. Comments record prior
measurements and why single-connection serialization and smaller mappings hurt.

**Proposal:** compare the current setup against smaller read-pool/cache variants
on copied synthetic or explicitly sanitized databases, with concurrent writes.
Record `database/sql` waits, query duration, file reads, RSS/physical footprint
and Go heap separately. Also test histories larger than the mmap ceiling.

**Expected effect:** potentially less long-lived cache memory. Eight times
16 MiB is a nominal aggregate cache setting, not measured allocation, a hard
process limit or a statement about sort memory. Lowering it could increase
disk I/O and latency. mmap address-space reservation is not committed RAM.

**Acceptance:** aggregate queries after commits, cold reads, ingestion and
Windows behavior do not regress. Use the existing slow-query caller tally
in [slowlog.go](../internal/store/slowlog.go) to select SQL work; do not add
indexes without query plans and a measured benefit that exceeds write/storage cost.

### F9 — P2: cap inactive terminal memory while preserving fast switching

**Evidence:** [TerminalPane](../ui/src/components/TerminalPane.tsx) uses 10,000
scrollback lines, keeps terminal objects while hidden, holds bounded hidden
output, suspends sockets after 30 s, and retains a small number of recently
hidden WebGL renderers. These are intentional responsiveness tradeoffs.

**Proposal:** measure 1/5/10 tabs, then substantially larger tab counts, across
open/close cycles. Compare retained JS, GPU and physical footprint after hidden
tabs settle. Consider an optional lower scrollback setting or terminal-object
LRU only if the retained cost is material. A fully evicted terminal cannot
reconstruct 10,000 lines from a much smaller byte replay buffer without an
additional persisted source; disclose that tradeoff.

**Expected effect:** lower memory in large workspaces, at possible switch,
search and historical scrollback cost. Do not disable WebGL globally based on
an assumption that GPU rendering is always more expensive.

**Acceptance:** switch latency, search, split panes, fonts/glyph recovery,
selection, reconnect offsets and typed-input acknowledgments remain correct.
Measure app helpers and holders as well as the daemon heap.

### F10 — P2: gate monitoring by actual viewing demand

**Evidence:** [resourceLoop/someoneLooking](../internal/daemon/resources.go)
samples every 5 s while any live WebSocket exists or a recent resource request
was made. A hidden dashboard retaining its live socket still counts as viewing.
[Desktop supervision](../app/src-tauri/src/shell.rs) already slows its health
poll to 5 s when hidden; it is not an unconditional fast hidden poll.

**Proposal:** measure process-table scan cost with many machine processes and
hidden connected clients. If material, introduce explicit visible interest or
a slower hidden sampling cadence. Preserve notifications, remote viewers and
resource history expectations. Any new subscription meaning needs contract
documentation; socket existence alone cannot express foreground interest.

**Expected effect:** fewer background process scans and wakeups. Actual power
savings require an energy measurement, not a timer count.

**Acceptance:** several viewers with different visibility, phone lock/unlock,
client disappearance and urgent alerts remain correct. Avoid broad client
shutdown that accidentally disables permission notifications.

### F11 — P2: scale Second Brain reads before swapping search technology

**Evidence:** [searchBrain](../internal/store/brainsearch.go) scans documents
matching non-text filters and scores them in Go. Its comment records that SQL
LIKE narrowing was slower in earlier measurements. The new benchmark shows
allocation growth in both search and the unfiltered graph path.

**Proposal:** profile graph materialization, edges, JSON and browser layout at
larger graph sizes. First reduce unnecessary returned graph data or introduce
bounded neighborhoods/pagination with explicit navigation semantics. Evaluate a
candidate index only after checking substring, entity and typo behavior.

**Expected effect:** lower memory/CPU for large graphs. FTS is a candidate to
test, not a drop-in replacement for the current matcher. Do not assume the
database is the only cost when the entire graph is also serialized and drawn.

**Acceptance:** ranking, entity relationships, typo fallback, project filters
and navigation survive. Record response bytes and time to usable graph alongside
query duration; use the existing benchmark as the before/after baseline.

### F12 — P3: audit infrequent large operations and power policy separately

**Evidence:** [chat import](../internal/chatimport/parse.go) streams the export
array, but decodes each conversation into a `json.RawMessage` before parsing it.
[The upload handler](../internal/api/chats.go) spools the body to a temporary
file with a 4 GiB HTTP limit; that is not a bound on one decompressed conversation.
[Keep-awake policy](../internal/keepawake/keepawake.go) defaults to holding the
machine awake while sessions work, with a silence bound. That is an intentional
product policy under ADR-049, not a CPU leak.

**Proposal:** test a single very large conversation, compressed exports, disk
exhaustion and cancellation. Consider explicit per-conversation/decompressed
limits or a more granular decoder, with user-visible errors instead of partial
silent imports. For power, validate release of sleep assertions after dead or
finished sessions; document existing modes rather than changing defaults as
part of an optimization patch.

**Expected effect:** bounds occasional memory/disk spikes and detects stale
sleep assertions. No evidence here establishes an existing sleep-assertion bug.

**Acceptance:** partial import semantics and idempotency remain clear; temporary
files are cleaned up, normal large exports still work, and an active long-running
build is never mistaken for a reason to terminate or interrupt its process.

### F13 — P1: the all-time history is recomputed on every poll while agents work

**Evidence:** [the profile above](#profile-2026-10-18-post-01340). The Now
screen asks for `/v1/history?range=all` every 10 s (`SLOW_LIVE_MS`).
[The answer cache](../internal/api/answercache.go) keeps it for `historyTTL`
(3 s), then renews it without computing only when the events version has not
moved, and while anything is being written it always has. So every poll
recomputed an aggregate over the whole events table: 40–43% of the daemon's
CPU and 31–32% of its allocation under the working load, on a 181k-event
history. One computation's cost grows with the history; `.ai/03-contracts.md`
records 1.5 s for it on a 1 GB, 333k-event database and 4.7 s under a live
dashboard. [buildHistory](../internal/api/api.go) also scanned the same events
twice: `store.History` repeated `Summarize`'s per-kind aggregate and its
unpriced and background queries.

**Implemented (2026-10-18).** Two changes, both in the history path only:

- **Scan once.** `store.HistoryFrom` takes turns, tool calls, cost, unpriced
  and background volume from the `Summary` computed beside it. The per-kind
  scan is `sumKinds`, with the same filter and the same pinned index, so the
  figures are identical; `TestHistoryFromMatchesHistory` compares the two forms
  field by field at four ranges over data with internal turns, unpriced turns
  and events outside the range. `store.History` keeps its answer for other
  callers.
- **Refresh in proportion to cost.** The history cache keeps an answer for 20
  times what computing it took when that is longer than the 3 s TTL
  (`historyCostScale`), and never more than 2 minutes (`historyCostCeiling`).
  Keeping one answer current then takes at most a twentieth of one core,
  whatever the history's size. Today's history takes milliseconds and keeps
  the 3 s. An all-time history that takes 0.5 s is refreshed at most every
  10 s, about the Now screen's own pace, so on a quiet machine with this
  history the bound changes little; one that takes 4.7 s, the live-dashboard
  figure above, is refreshed at most every 94 s instead of on every 10 s poll.
  Stale answers are still served at once while one refresh runs, and an
  unchanged version still renews without computing. The cost carries over a
  renewal, and a refresh records its own
  (`TestAnswerCacheKeepsACostlyAnswerLonger`).

On a copy of the stand's database (181,312 events), one all-time history
(summary, totals and tool distribution) went from a best of 0.66–1.33 s to
0.49–0.92 s, in two probe sessions on the loaded machine: ms/op is noise, but
both show the same ordering. Allocation per computation is unchanged at
38.2 MB, because the dropped scans return a handful of grouped rows.

On the harness, each pair run back to back with the same request pattern
(22–25 all-time history requests per load window). Two histories: the
profile's 181,312 events (235 MB), and 890,000 events (1.1 GB) ingested once
by the same generator, 2,000 Claude transcripts and 600 Codex rollouts, and
copied into both stands. CPU is the daemon's share of one core over the load
window, from `ps`; "history" is the history refresh's samples in the 150 s
CPU profile and its allocated bytes in the load window:

```text
history   build    load avg   daemon CPU  history CPU  history alloc  RSS end/max
181k      0.134.0  13.5–5.2   14.6%       7.55 s       568 MB         87/203 MiB
181k      F13      5.2–6.1    14.7%       4.50 s       342 MB         93/165 MiB
890k      0.134.0  3.6–6.0    40.1%       44.76 s      2,839 MB       504/504 MiB
890k      F13      6.0–14.5   11.0%       2.61 s       182 MB         87/419 MiB
```

At 181k events the history's own cost fell by 40% (CPU) and its allocation
by 40%, and the daemon's total did not move beyond noise: one computation
took about half a second, so the bound let it refresh almost every poll, and
the saving was the second scan. At 890k events one computation took 5.8–8.9 s
on the probe, every 10 s poll had started another, and the refresh was 76% of
the daemon's CPU. Under the bound it refreshes at most every 2 minutes. The
daemon went from 40% of a core to 11%, the history's allocation fell 94%, and
RSS at the end of the window from 504 to 87 MiB. Two further F13 runs at
181k events on a heavily loaded machine (load averages 15.9–79) measured
2.49 s and 2.54 s of history CPU and 103–105 MB; a slower computation earns a
longer wait, so those overstate the gain at that size.

The all-time figures on the Now screen and History can now be up to about
twice the bound behind: an answer is shown until a poll finds it older than
the bound, and that poll still gets it while one refresh runs. Today's
figures, the cost meter and everything about live sessions are unaffected.

### F14 — P1: `/v1/sessions` summarises every listed session on every request

**Evidence:** [the profile above](#profile-2026-10-18-post-01340).
[handleSessions](../internal/api/api.go) calls `summarize` for each session
it lists. Each call reads the session's stats, `LastEvents(60)` with every
payload, the live-subagent count, the description's first prompts and the
newest main-thread turn. The app's workspace asks for `?active=true` on every
live tick (`useWorkspaceData.ts`, one request in flight at a time), and the
Now screen asks for its own list: 4.4 requests a second with two pages open
and 12 live sessions. That was 18% of daemon CPU before F13 and 22–33% after,
and 767–778 MB per load window, 41–42% of all allocation, most of it decoding
sixty events per session per request.

**Proposal:** do not cut the narration's inputs blindly; it reads payloads to
say what a session is doing. Candidates, in order of risk:

- **Share concurrent identical requests.** Requests for the same query that
  arrive while one is in flight would use its answer, so two windows ticking
  on the same live frame cost one computation. Measure how often they overlap
  before relying on it, and only share a computation that started after the
  write the request was prompted by: a live frame follows its commit, and an
  answer begun before that commit would miss it, leaving the sidebar a state
  behind until the next frame, which may never come once the session is
  quiet.
- **Cache each session's recent window.** Key it by something that changes on
  every insert into that session. `last_event_at` does not qualify:
  transcript lines arrive with timestamps older than the hook events already
  stored. A per-session insert counter kept by the recorder would.
- **Slow the workspace's live list** when no session changed state. This is a
  UI tradeoff and needs the owner's call.

**Acceptance:** narration (health, phrase, background, nudges, loops), context
fill and description are identical for every listed session, and a permission
prompt or a finished turn appears no later than today. Measure allocated bytes
per request and requests per second with one and two windows.

**Implemented (2026-10-18): the second candidate, per-session cache.** The
reads of a session's own events that a summary makes (the newest 60 events,
the main thread's newest event and turn, the first prompts) are kept per
session ([recentcache.go](../internal/api/recentcache.go)) and read again only
when the session's events change. Everything else (the session row, stats, live
subagents, loops, nudges, the clock) is still read on every request, and the
narration is still computed on every request from those inputs. Requests are
not shared, so a quiet session is never left a state behind.

- **The key.** A per-session insert counter kept by the recorder would have
  missed writes that are not inserts: Codex ingest rewrites stored payloads
  while a session runs, and repairs, price corrections and compaction update
  events in place. The key is `store.EventsGen`, read in one statement: the
  session's newest event id, which every insert raises because a new row takes
  a rowid above every existing one (one seek on `idx_events_session_id`), and
  a rewrite generation that triggers move with every update or delete of the
  session's events (migration 0063), whichever code writes them, in the same
  transaction. The key is read before the events, so a cached value is never
  older than its key.
- **No insert trigger.** The first version also counted inserts with a
  trigger. On a temporary on-disk database, 20,000 events in batches of 500,
  any trigger on inserts, even one that does nothing, took an insert from
  58 µs to 129–136 µs: the driver prepares every statement afresh and each
  prepare compiles the trigger. One single-row update went from 58–83 µs to
  85–98 µs with the update trigger, in the same probe.
- **Bound.** 256 sessions, least recently used dropped first; the Now screen
  lists 200 by default. On the stand that held about 9 MB of heap.
- **Correctness.** `TestSummaryCacheMatchesFresh` compares the cached summary
  and events with ones built from an empty cache, field by field (as JSON),
  after hook and out-of-order transcript inserts, a subagent burst that pushes
  the main thread out of the window, an in-place payload rewrite, `/clear`
  (a new session), the session ending, a rename, deleting the newest events
  and retention. `TestEventsGenMovesOnEveryChange` checks the key moves for
  inserts (including one older than everything stored), updates, a row moved
  between sessions and deletes, and only for the session changed; and
  `TestEventsGenTriggersExist` fails if a later migration rebuilds the events
  table and drops the triggers.

**Measured.** The harness of the profile above (181k-event history, same live
work, two viewers), each pair back to back: base is the F13 head (`6240cc10`).
Shares are of the 150 s load CPU profile and of bytes allocated in the load
window; per request divides by the `/v1/sessions` requests the viewers made in
the whole run. A first pair, at load averages of 196–233, never finished its
backfill before the load window and is left out.

```text
pair  build  load avg   daemon CPU  sessions CPU         sessions alloc          heap  RSS end/max
p2    base   7.2–14.4   15.2%       2.73 s 12.6% 3.2 ms  730 MB 19.4% 0.85 MB   12.7  94/153 MiB
p2    F14    13.5–4.1   11.3%       0.83 s  5.3% 0.8 ms  348 MB  9.4% 0.35 MB   22.5  132/278 MiB
p3    base   4.1–4.9    13.2%       1.66 s  9.1% 1.8 ms  783 MB 20.7% 0.87 MB   11.3  107/209 MiB
p3    F14    4.9–79.6   11.6%       1.07 s  6.6% 1.1 ms  353 MB  9.5% 0.36 MB   20.6  85/181 MiB
```

(`heap` is MB in use after GC at the end of the load window; requests per run:
base 858 and 902, F14 1,008 and 994.) The list's CPU per request fell by
39–75% and its allocation by 59%; `LastEvents` went from 4.7–5.0% of the
daemon's CPU to 1.0–1.5%. What remains is mostly re-reading the live sessions,
which change every second on this stand. The daemon's total fell from 13–15%
of a core to 11–12%. The cache holds about 9 MB of heap; RSS moved within the
run-to-run spread (85–132 MiB at the end against 94–107), so this profile
cannot say whether it costs RSS. No `SQLITE_BUSY` appeared in either F14 run.

### F15 — P2: the SQLite driver starts a goroutine for every statement

**Evidence:** `modernc.org/sqlite` (v1.60.1, `interruptOnDone` in its
`sqlite.go`) starts a watcher goroutine for every statement whose context can
be cancelled, so that cancelling can interrupt it; every context in the daemon
can be. A probe on a temporary database ran 200,000 single-row reads per
variant: 18.8–22.4 µs of process CPU per statement with a cancellable context,
10.9–11.3 µs with `context.Background()`. In the backfill profile 27–28% of
samples were the scheduler waking threads for new goroutines
(`runtime.newproc` → `wakep`). The profile cannot name their creator; the
driver is the likely one, since the ingest path starts no goroutines of its
own. Under the working load it was 4%.

**Proposal:** first count which statements dominate (the recorder's per-event
transactions do most). A recorder transaction lasts milliseconds and could run
on a context that cannot be cancelled, after checking the caller's; long reads
keep their interrupt. A single watcher per connection is a driver change and
belongs upstream.

**Acceptance:** shutdown still interrupts long reads and waits on nothing
longer than a short write. Measure backfill CPU and duration before and after
on the same history.

**Implemented for the recorder (measured 2026-10-18).** The driver was half of
it. database/sql gives a `*sql.Tx` a context it can always cancel, and starts a
goroutine to watch it for every query run inside the transaction. Counted with
`/sched/goroutines-created`: 5 goroutines per event through `Record`, 4 through
a batch, 2 per cancellable read outside a transaction, 0 per read on
`context.Background()`. The recorder now checks the caller's context, writes on
`context.WithoutCancel`, and spells its transaction out as `BEGIN IMMEDIATE` /
`COMMIT` on a `*sql.Conn`: 0 goroutines per event, held by a test. On the stand
of F7, the scheduler's thread wake-ups (`runtime.wakep`) fell from 32–34% of
the backfill profile to 1.4–1.5%, and from 9.4–9.5% to 6.7–7.8% under the
working load. Long reads keep their cancellable contexts; the other cancellable
reads outside the recorder are unchanged.

## Existing safeguards worth preserving

- Dirty-file fsnotify processing, hot-file fallback and persisted Claude offsets
  already avoid the worst all-history reread pattern for Claude.
- Gemini telemetry already reads from offsets. Hermes/OpenCode database readers
  have their own change tracking; do not force every source into the same parser.
- Tool payload clipping, binary stripping and idle payload compaction already
  reduce retained data. [Idle maintenance](../internal/daemon/compact.go) yields
  to incoming writes and has explicit vacuum limits.
- WAL limits/checkpointing and incremental vacuum address disk growth. A high
  watermark or an mmap reservation alone is not proof of a leak.
- Live replay and terminal offset/ack protocols recover after dropped links;
  arbitrary queue truncation or input dropping would undermine correctness.
- Hidden-page batching, shared debounce stores, visibility-aware timers,
  bounded terminal output holding and limited WebGL retention already exist.
- [Deck caching](../internal/api/deckcache.go) already bounds keys, shares
  refresh work and backs off failed refreshes. Replacing it with another cache
  is not a demonstrated optimization.
- Optional mail/GitHub/remote integrations should be measured when enabled,
  independently from the core baseline. Remote request/message/stream caps and
  mail's IDLE/retry design deserve preservation; this audit did not load-test them.

## Execution order and decision gates

1. **Establish a clean baseline.** Run the existing desktop and busy-agent
   harnesses on a quiet machine using this snapshot. Add daemon and holder
   measurements to the app figures. Record workload, duration, build flags and
   machine load. Keep visible idle, hidden idle, spinner and flood separate.
2. **Ship F1 and F2 separately.** They have narrow implementation boundaries and
   directly measured allocation problems. Compare allocation profiles and
   end-to-end terminal responsiveness; do not combine them with cache tuning.
3. **Instrument and implement F3, then F4.** Correct parser state is more complex
   than a buffer rewrite. Checkpoint equivalence and data-loss tests come before
   selecting the smallest allocation number.
4. **Choose the next change from workload profiles.** Large history favors
   F7/F8; many inactive tabs favors F9; hidden background work favors F10; large
   memory graphs favors F11. F5/F6 depend on payloads and viewer count.
   The first such profile, after 0.134.0, put two dashboard reads first:
   F13 then F14, both now implemented (see
   [Profile 2026-10-18](#profile-2026-10-18-post-01340)).
5. **Run soak and cross-platform checks.** Repeat open/close, reconnect and
   growth workloads for hours, checking retained-memory plateaus, WAL behavior
   and session continuity. Execute runtime scenarios on macOS, Windows and Linux.

Do not start with `GOGC`, a global memory limit, periodic forced GC, removal of
PTY-holder isolation, `synchronous=OFF`, fewer correctness checks or deleting
user history. Those either obscure allocation causes or change durability and
reliability. The cited Go GC guide describes the CPU/memory tradeoff and the
limits of what the runtime's memory limit covers.

### Measurements to keep with each optimization

- **Daemon:** CPU time over elapsed time, Go allocation rate and retained heap,
  process RSS/physical footprint, SQL waits, slow-query callers, WAL size,
  file reads/writes, bytes decoded and duplicate records offered.
- **Terminal holders:** total count, per-holder RSS and CPU, buffer allocation
  profile, output rate and detached/reconnected behavior. Attribute child agent
  and tool usage separately.
- **Desktop:** total shell/helper physical footprint, GPU and JS allocations,
  React commits, main-thread stalls, terminal echo p50/p95, switch latency and
  hidden-window wakeups. Record whether WebGL and snapshot instrumentation are on.
- **Power and storage:** sustained energy measurement on a controlled power
  source, sleep-assertion lifetime, temporary import growth, post-maintenance
  database/WAL size and whether disk-rate windows include startup migration.
- **Correctness:** event counts, historical pricing, dedupe, offsets, input
  acknowledgments, approvals and externally owned process boundaries.

## Reproduction notes

The benchmark commands that already exist in the repository are documented in
[bench/README.md](../bench/README.md). This audit did not run the full desktop
harness. It built and stopped its own headless daemon instead.

For the custom parser/buffer probe, place the following Go file in a temporary
directory **inside the repository** so Go permits its internal-package imports,
run `go run ./<temporary-directory>`, and remove only that directory afterward.
Run the probe on its own, after builds and tests finish, for trustworthy timings.

```go
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "os"
    "testing"

    "github.com/dspv/caprock/internal/codex"
    "github.com/dspv/caprock/internal/termbuf"
)

var sink any

func measure(name string, f func(*testing.B)) {
    r := testing.Benchmark(f)
    fmt.Printf("%s %d ns/op %d B/op %d allocs/op n=%d\n",
        name, r.NsPerOp(), r.AllocedBytesPerOp(), r.AllocsPerOp(), r.N)
}

func main() {
    fixture, err := os.ReadFile("testdata/codex/rollout-basic.jsonl")
    if err != nil { panic(err) }
    header := bytes.Split(fixture, []byte("\n"))[0]
    msg, err := json.Marshal(map[string]any{
        "timestamp": "2026-10-18T10:00:00Z", "type": "event_msg",
        "payload": map[string]any{"type": "user_message",
            "message": string(bytes.Repeat([]byte("x"), 1024))},
    })
    if err != nil { panic(err) }
    msg = append(msg, '\n')
    for _, n := range []int{1024, 8192, 16384} {
        data := append(append([]byte{}, header...), '\n')
        data = append(data, bytes.Repeat(msg, n)...)
        fmt.Printf("input=%d records=%d\n", len(data), n)
        measure(fmt.Sprintf("codex/%d", n), func(b *testing.B) {
            for i := 0; i < b.N; i++ {
                s, err := codex.Parse(bytes.NewReader(data), "synthetic.jsonl")
                if err != nil { panic(err) }
                sink = s
            }
        })
    }
    for _, size := range []int{1024, 16384} {
        p := bytes.Repeat([]byte("x"), size)
        measure(fmt.Sprintf("ring/%d", size), func(b *testing.B) {
            r := termbuf.NewRing(256 << 10)
            r.Write(bytes.Repeat([]byte("x"), 256 << 10))
            b.ResetTimer()
            for i := 0; i < b.N; i++ { r.Write(p) }
            sink = r
        })
    }
}
```

For the oversized-record probe, temporarily add this test to `internal/ingest`,
run it explicitly, then remove that probe file. It uses only synthetic input.
The original run used the same setup with an in-memory store opened once for
the two cases; the state reset below ensures persisted offsets cannot skip work.

```go
func TestResourceAuditOversize(t *testing.T) {
    st, err := store.Open(context.Background(), ":memory:", nil)
    if err != nil { t.Fatal(err) }
    defer st.Close()
    for _, complete := range []bool{false, true} {
        p := filepath.Join(t.TempDir(), "oversize.jsonl")
        text := strings.Repeat("x", 32<<20)
        if complete { text += "\n" }
        if err := os.WriteFile(p, []byte(text), 0600); err != nil { t.Fatal(err) }
        fi, err := os.Stat(p)
        if err != nil { t.Fatal(err) }
        tail := New(filepath.Dir(p), nil, st, nil)
        r := testing.Benchmark(func(b *testing.B) {
            for i := 0; i < b.N; i++ {
                tail.readFile(context.Background(),
                    &fileState{path: p, lastSize: -1}, fi)
            }
        })
        t.Logf("complete=%v bytes=%d ns/op=%d B/op=%d allocs/op=%d",
            complete, len(text), r.NsPerOp(), r.AllocedBytesPerOp(), r.AllocsPerOp())
    }
}
```

The test needs `context`, `os`, `path/filepath`, `strings`, `testing` and the
internal `store` package imports. Command:

```sh
go test ./internal/ingest -run '^TestResourceAuditOversize$' -count=1 -v
```

For profiling, use a throwaway stand with `CAPROCK_PPROF` set to a dedicated
loopback port; see [the profiling implementation](../internal/daemon/pprof.go)
and [developer infrastructure](../.ai/10-infrastructure.md). Fetch a CPU profile
and `heap?gc=1`, then inspect with `go tool pprof -top` and `-inuse_space`.
Keep raw profiles local: profiles can contain application data. The actual
empty-daemon run selected free ports, started with `--foreground --no-hooks
--no-open`, waited for `/healthz`, issued ten requests per endpoint, collected
20 s of CPU samples, fetched the heap and stopped its own child in a `finally`
block. It did not start PTYs or enable optional integrations.

## Verification

The new oversized-record diagnostic passed. The existing BrainSearch benchmark
completed successfully. The custom parser/buffer probe completed successfully.
The temporary probe sources were removed from the checkout after measurement.
The first repository-wide check passed the documentation gates and Go vet, then
failed lint because it observed the temporary, unformatted diagnostic test while
the experiment was running. That probe has been removed. A clean `make check`
rerun and a post-documentation `make docs-check docs-links lang-check` were
started; their final results were still pending when the implementation handoff
was requested. Do not interpret this audit as a green full-suite result.

When the audit was written, no optimization had been implemented or measured
after implementation; F1 has since been, see its **Implemented** note. A green
local check cannot substitute for Windows/Linux runtime performance or the
repository's three-OS CI requirement.

## Primary research references

Read on 2026-10-18; these support mechanisms and tradeoffs, not the local timings:

- [Go garbage collector guide](https://go.dev/doc/gc-guide): allocation, live
  heap, GC CPU/memory tradeoffs and memory-limit scope. A Go heap graph alone
  cannot explain all process or WebView memory.
- [SQLite cache_size pragma](https://www.sqlite.org/pragma.html#pragma_cache_size):
  the negative cache setting is expressed in KiB and is a suggested cache size,
  not an eager allocation or total process-memory cap.
- [SQLite memory-mapped I/O](https://www.sqlite.org/mmap.html): mapped reads
  and address-space versus physical-memory considerations. This supports
  measuring actual working set before shrinking mmap.
- [xterm flow control](https://xtermjs.org/docs/guides/flowcontrol/): output
  parsing is asynchronous and needs flow control. Preserve pacing and recovery
  when reducing queues, buffering or rendering work.
