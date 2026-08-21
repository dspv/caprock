# Testing — coverage, what it means, and where the gaps are

**Measured 2026-08-21** against master (after the bug-hunting pass) on macOS/arm64, Go 1.26.
Re-measure with `make test`; the per-package numbers below come from
`go test ./internal/... -cover`.

## The honest headline

**80.4% of `internal/` statements**, measured with the smoke tests included
(`go test -tags smoke ./internal/... -coverpkg=./internal/...`). A plain
`go test -cover` run reports lower, because the packages that need a running
daemon or a real subprocess are exercised by suites the default run skips.

## Per package

Numbers are from the default run. Where that understates a package, the "real"
column says what it is when the suite that actually covers it is included.

| Package            | Default | Real  | Notes                                                           |
| ------------------ | ------- | ----- | --------------------------------------------------------------- |
| `update`           | 91.4%   |       |                                                                 |
| `bus`              | 90.9%   |       |                                                                 |
| `cost`             | 88.9%   |       |                                                                 |
| `shim`             | 88.7%   |       | Failure paths pinned; see below                                 |
| `gitdiff`          | 84.6%   |       |                                                                 |
| `loop`             | 84.3%   |       |                                                                 |
| `rollup`           | 82.6%   |       |                                                                 |
| `hooks`            | 82.3%   |       |                                                                 |
| `hookd`            | 81.9%   |       |                                                                 |
| `ptyman`           | 81.4%   |       | Windows path covered by the `ptyspike` job, not here            |
| `hive`             | 81.2%   |       |                                                                 |
| `board`            | 81.0%   |       |                                                                 |
| `statusline`       | 80.6%   |       |                                                                 |
| `store`            | 80.3%   |       |                                                                 |
| `desktop`          | 78.9%   |       |                                                                 |
| `orchestrator`     | 78.1%   |       |                                                                 |
| `agents`           | 75.0%   |       |                                                                 |
| `narrate`          | 74.6%   |       |                                                                 |
| `api`              | 72.9%   |       |                                                                 |
| `config`           | 72.3%   |       |                                                                 |
| `ingest`           | 68.5%   |       |                                                                 |
| `daemon`           | 22.8%   | 58.7% | `Run`/`newDaemon` are driven by the smoke suite on three OSes   |
| `event`            | 0%      | —     | Type declarations only; no functions to test                    |
| `version`          | 0%      | —     | A single version string                                         |
| `cmd/caprock-hook` | 0%      | —     | Has its own suite that runs the built binary as a subprocess    |
| `cmd/caprock`      | 18.2%   |       | CLI wiring; the commands it calls are covered in their packages |

## What the number does not mean

**Coverage says a line executed, not that it was checked.** Six tests written
during the 2026-08-20 pass were green while proving nothing, and each was found
the same way — by breaking the production code on purpose and watching the suite
stay green:

- the shim's panic test passed with `recover()` deleted;
- the paused-write test asserted only the returned `(n, err)`, which a `Write`
  that forwards straight to the PTY also satisfies;
- the kill test waited on `Wait()`, but closing the PTY ends a POSIX child in
  ~100ms by itself;
- `TestRingSnapshotIsACopy` passed with the copy removed, because `write`
  rebuilds the slice with `append` rather than editing in place;
- the wildcard test searched for `100%`, where `100` already narrows the result
  to one note and the leak cannot show;
- the page-cap test ran at the endpoint with fewer rows than the cap, where
  every limit looks identical.

**The working rule: a test is finished when removing the code it covers turns it
red.** Not when it passes.

Two more ways the number misleads, both found on 2026-08-21.

**A linter can guard what no test can reach.** Three loops ignored `rows.Err()`, so a truncated scan passed for a complete one. `QueryContext` fails on the context before iteration begins, so the path is not reachable from a test at all; `rowserrcheck` in `.golangci.yml` is what keeps the check in place. Coverage of those lines was already 100%.

**Test setup can be weaker than the product.** In-memory databases ran with `foreign_keys` off while the on-disk one has always enforced them, so a test wrote `session_stats` for a session that did not exist and passed. Green tests were describing a database Caprock never ships.

The inverse also happens: a test can fail for a reason it creates itself. The
tailer's live-pickup test timed out for twenty seconds and read exactly like a
product bug, until a probe showed the cause was the test polling `GetStats`
every 10ms — `:memory:` SQLite has a single writer, and the read loop starved
the ingest it was waiting for. It now polls the tailer's own counter and passes
in 1.4s. Before reporting a red test as a defect, check that the test is not the
thing breaking it.

## Where a bug reaches the user, not just Caprock

Two packages carry a different class of risk, and their tests are written
accordingly — failure paths first, happy path left to the smoke suite.

- **`shim`** runs inside every hook of every Claude Code session on the machine.
  A panic or a stall here breaks the user's session, not a dashboard panel
  (rule 3). Covered: no daemon, a stale `runtime.json` pointing at a dead port,
  a corrupt one, malformed and oversized stdin, a hung daemon, a non-200, a
  non-JSON reply, and a panic inside `Run`. Two invariants are explicit —
  nothing but valid JSON ever reaches stdout, and an ordinary hook returns well
  inside its budget even when the daemon never answers.
- **`ptyman`** owns the processes Caprock spawns. Covering it found two real
  defects: a data race on `pty.Close()` between the `Wait` goroutine and an
  explicit `Close()` (four races per run under `-race`), and a clean exit
  reported as `file already closed`.

## Known gaps, and why they are open

- **`cmd/caprock` at 24.1%** is the largest remaining gap, and what is left is
  `main`, `detach` and `openBrowser` — functions that spawn processes and
  launch a browser. Testing those would be testing the operating system. What
  could be covered now is: `ensureShim` (the binary that runs inside every
  hook, so rule 3 depends on it being installed and current), `confirm` (which
  must never take a script for a yes), and `daemonAlive` (a false positive
  refuses to start, a false negative starts a second daemon on one data dir).
- **`daemon`'s uncovered remainder** is adapter plumbing: one-line methods
  forwarding to `board` and `agents`, already exercised through those packages.
  A test there would assert that a forwarding call forwards.
- **`event` and `version` at 0%** are type and constant declarations. There is
  nothing to execute.

## Platform boundaries, stated rather than implied

Some assertions cannot hold on every OS, and pretending otherwise produces
tests that pass by skipping the interesting case.

- **PTY tests are POSIX-only**, gated in `spawn()`. Under ConPTY a short-lived
  command races its own console teardown — `cmd.exe` paints a preamble, the
  process exits, the PTY closes — and on the Windows runner that took the test
  binary down rather than failing an assertion. Windows coverage of `ptyman`
  lives in the **`ptyspike`** job, which drives spawn → stream → write → resize →
  kill with a child kept alive for the duration, on all three OSes.
- **`WriteFileAtomic`'s torn-file test is POSIX-only.** Windows cannot rename
  over a file another process holds open, so the function degrades to
  remove-then-rename there — documented in the code as "not atomic but the best
  available". The test asserts the guarantee where it exists rather than
  lowering the bar everywhere.
- **Permission-bit assertions skip on Windows**, which does not model them.

## What runs, and when

| Suite                      | Command                        | Where                      |
| -------------------------- | ------------------------------ | -------------------------- |
| Unit                       | `go test ./...`                | `make test`, CI on 3 OSes  |
| Race detector              | `go test -race ./...`          | CI                         |
| Smoke (real daemon)        | `go test -tags smoke ./...`    | `make smoke`, `make check` |
| PTY spike (real processes) | `go test -tags ptyspike ./...` | CI, informational job      |
| UI                         | `npm test` in `ui/`            | `make test`, CI            |
| Everything (the gate)      | `make check`                   | Locally before every push  |
