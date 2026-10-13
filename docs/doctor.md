# Is it Caprock? `caprock doctor`

When the machine feels slow, `caprock doctor` says what Caprock itself is
costing it, and whether anything of Caprock's is running that should not be.

```bash
caprock doctor          # readable report; exits 1 when something is flagged
caprock doctor --json   # the same as GET /v1/footprint
caprock doctor --data-dir <dir>   # check another data directory
```

## In the app: the status bar

The same report is one click away in the desktop app and the dashboard. At
the right of the status bar, *caprock 1.1 GB · 2.2 GB* is the memory every
Caprock process holds and the data directory's size on disk (in a narrow
window, memory alone; the disk figure is in its tooltip). It turns the
warning colour, with a small dot, when the doctor flags something. A click
opens the doctor as a panel: the verdict in one line (*All good*, or *3
things to look at*), each warning with the processes behind it, what the
memory and the disk are spent on, the daemon's disk reads and writes,
what Caprock did on its own, and:

- **Check now** asks again at once (the panel otherwise refreshes every 10
  seconds while the window is visible).
- **Stop N orphans** stops the orphaned terminals the sweep would stop, now
  (on the computer itself, not from a paired phone).
- **Copy report** copies the text `caprock doctor` prints, line for line —
  the thing to paste into an issue.
- **Storage settings →** goes to what fills the database and the retention
  period.

The command palette's *Caprock doctor* opens the same panel.

## What it reports

It reports:

- **Memory and CPU** of every Caprock process: the daemon, the desktop app,
  the app's window (on macOS the WebKit processes that draw it, which
  Activity Monitor lists under their own names, not under Caprock), the
  terminal holders that keep your sessions alive, and any other Caprock
  daemon. Memory is what Activity Monitor or Task Manager shows for each
  process, not the resident set.
- **Disk:** the data directory's size, split into the database (with its
  write-ahead log), pastes, logs, binaries and the rest.
- **The daemon's disk I/O:** what it read and wrote in the last minute and
  the last hour. It is read once a minute and kept in memory only.
- **Duplicates:** another daemon, more than one desktop app, and terminal
  holders started by another install or an older version (a Homebrew copy, a
  previous app bundle).
- **Done on its own:** what the daemon cleaned up without being asked since
  it started — orphaned terminals it stopped, a write-ahead log it folded
  back into the database — with the time of each.
- **Verdict:** one line per finding, `WARN` or `OK`.

## What Caprock fixes by itself

Nobody cleans up after Caprock but Caprock, so whatever is safe to fix
unattended is fixed unattended, and `caprock doctor` says when it was done:

- **Orphaned terminals.** A terminal holder no Caprock will ever reattach to,
  and that holds only an idle shell (or nothing at all), is stopped within
  ten minutes. A holder running an agent or a command is never touched. The
  Stop button in Settings does the same at once.
- **A large write-ahead log** (over 256 MB) is folded back into the
  database.
- **A second daemon on the same data directory** cannot start: it waits a
  few seconds for a restarting one, then exits naming the pid of the one that
  runs.

What it does not fix: another daemon or a second app (Caprock never stops a
process it did not start; quit the ones you do not use), and a large
database (deleting history is your call — set a retention period in
Settings).

## With no daemon running

`caprock doctor` still works: it reads the data directory and the process
table itself, says the daemon is not running, and lists every Caprock
process it finds with its memory. CPU is not measured then — that needs two
samples a few seconds apart.

The exact fields are in the HTTP contract,
[`.ai/03-contracts.md` § Footprint](../.ai/03-contracts.md#footprint).
