# Is it Caprock? `caprock doctor`

When the machine feels slow, `caprock doctor` says what Caprock itself is
costing it, and whether anything of Caprock's is running that should not be.

```bash
caprock doctor          # readable report; exits 1 when something is flagged
caprock doctor --json   # the same as GET /v1/footprint
caprock doctor --data-dir <dir>   # check another data directory
caprock doctor --stop <pid>       # stop one process from the Orphans list (asks first; --yes skips)
caprock doctor --stop <pid> --force   # for one still running after that: SIGKILL
```

## In the app: the status bar

The same report is one click away in the desktop app and the dashboard. At
the right of the status bar, *caprock 1.1 GB · 2.2 GB* is the memory every
Caprock process holds and the data directory's size on disk (in a narrow
window, memory alone; the disk figure is in its tooltip). When the last
check found processes that look abandoned, *· 3 orphans* follows. It turns
the warning colour, with a small dot, when the doctor flags something. A
click opens the doctor as a panel: the verdict in one line (*All good*, or
*Caprock is using more than it should*), *Orphans: 3 · 410 MB* when there
are any, one row per kind of problem with its size, and, behind each row's
**Details**, every process with its pid, memory, CPU, age, command line and
why it is listed. Then:

- **Free up memory** (the same button sits in the memory popover) opens one
  list in two groups, each line with its own checkbox and size: the
  leftovers that are safe to stop, and the idle agents Caprock started that
  are safe to end — idle for 15 minutes, nothing running in the background
  under them, not the tab in front. Ending an agent keeps its conversation;
  Continue picks it up where it stopped. A test copy of Caprock whose agent
  is still running is never offered: its row says *its agent is still
  running*. Each row's **Stop** opens the same kind of list for that row
  alone; there the ones safe to stop are ticked and the rest shown unticked
  with why. Nothing is sent before you confirm, and only on the computer
  itself — a paired phone can read the list but never stop anything.
- **Force stop** appears only for a process that was asked to stop and is
  still running five seconds later. It lists each one again; nothing is
  killed without that second click.
- **Check now** asks again at once (the panel otherwise refreshes every 10
  seconds while the window is visible).
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
  back into the database, old images it replaced and the space it gave back
  to the disk — with the time of each.
- **Orphans:** processes that look abandoned, Caprock's or not (below).
- **Verdict:** one line per finding, `WARN` or `OK`.

## Orphans

The doctor looks for processes that outlived whatever they were for, and says
why each is listed:

- **Another Caprock daemon**, with its data directory and whether that still
  exists — a `caprock up` another tool started from a temporary directory, a
  preview stand nobody stopped.
- **A terminal holder no Caprock will reattach to**, from any install. The
  ones that hold nothing but an idle shell the daemon stops on its own; one
  where an agent or a command still runs is listed and left alone.
- **A terminal from an older Caprock install** — say a Homebrew
  `caprock pty-host` still holding a session days after you moved to the
  app. Caprock still lists that session, so this is shown, never warned
  about, never stopped on its own and never offered by Free up memory; stopping it
  ends that session.
- **Any other `caprock` command whose parent has exited.**
- **A `claude` or `codex` whose session ended** in Caprock's history (and
  which was already running when that session started, so a reused pid is
  not mistaken for it), **or whose parent has exited**, with no terminal.
  The Codex desktop app's own background service (`codex app-server`) is
  not a leftover and is never listed.
- **An MCP server whose parent has exited** — its command line names MCP —
  usually because the `claude` that started it is gone.
- **Something a Claude Code session started** (`CLAUDECODE` is in its
  environment) whose parent has exited: often a server left running on
  purpose, so it is said, not warned about.

Never listed: anything with a terminal (a window you are in), anything in a
live session's process tree, another user's processes, anything younger than
two minutes, and macOS apps and their helpers (the Claude desktop app is
launchd's child by design). Each process's command line is shown cut to
160 characters, with the value of anything named like a token, key, secret
or password replaced by `[hidden]`. The list is taken when you open the
doctor (the open panel reuses a list up to 30 seconds old; **Check now**
takes a new one) or run `caprock doctor`; the daemon's 10-minute sweep keeps only a count, which
turns the status figure the warning colour when a `claude`, an MCP server or
a Caprock command looks abandoned. On Windows, which does not reparent and
has no terminals to check, a process counts as parentless when its parent's
pid is not running or now names a younger process.

### Stopping one

Caprock never stops a process it did not start on its own. You can:

- **In the panel:** **Free up memory**, or **Stop** on one row, then confirm the
  list (untick anything you want to keep).
- **In a terminal:** `caprock doctor --stop <pid>` (repeatable). It shows the
  process and why it is listed, and asks; `--yes` skips the question.

Either way the process gets SIGTERM — a request to exit, so it can save and
clean up — and Caprock waits five seconds. One that is still running then
is reported as still running, and nothing more is sent: a SIGKILL is your
second, separate choice (**Force stop** in the panel, or
`caprock doctor --stop <pid> --force`). On Windows, which has no SIGTERM,
the first stop already terminates the process. Only a process on the list
can be stopped: the daemon takes the list again, and signals only a pid that
is still on it with the same start time — checked again before each signal,
so a pid the system has since given to another program is never touched.
Only that process is signalled, not its children; stopping a terminal
holder closes its terminal, which ends what runs in it. A paired phone can
read the list but cannot stop anything.

## What Caprock fixes by itself

Nobody cleans up after Caprock but Caprock, so whatever is safe to fix
unattended is fixed unattended, and `caprock doctor` says when it was done:

- **Orphaned terminals.** A terminal holder no Caprock will ever reattach to,
  and that holds only an idle shell (or nothing at all), is stopped within
  ten minutes. A holder running an agent or a command is never touched. The
  Stop button in Settings does the same at once.
- **A large write-ahead log** (over 256 MB) is folded back into the
  database.
- **A database bloated by old screenshots.** Versions before 2026-10-13
  stored the images tools handed back (screenshots, images Claude read) as
  base64 text. While Caprock is idle — nothing recorded for 30 minutes — it
  replaces them in older events with the marker new events get, *[image
  image/png 512 KB not stored]*, a few hundred events at a time; the text of
  every event is kept as it was. Then it compacts the database once, which
  gives the space back to the disk, and from then on returns free space as it
  appears. The compaction needs free disk of about twice the database's size
  for a moment; without it Caprock says so here and tries again the next
  day. Anything recorded meanwhile stops it at once, and an interrupted
  compaction leaves the database as it was. On a copy of the owner's 2.2 GB
  database (2026-10-13) replacing the images took 79 seconds, the compaction
  21, and the file was 1.4 GB after.
- **A second daemon on the same data directory** cannot start: it waits a
  few seconds for a restarting one, then exits naming the pid of the one that
  runs.

What it does not fix on its own: another daemon, a second app, or any other
process it did not start (it lists them under Orphans; stopping one is your
click — see above), and a database that
is large because of how much history it holds (deleting history is your call
— set a retention period in Settings; the space it frees goes back to the
disk on its own).

## With no daemon running

`caprock doctor` still works: it reads the data directory and the process
table itself, says the daemon is not running, and lists every Caprock
process it finds with its memory. CPU is not measured then — that needs two
samples a few seconds apart.

The exact fields are in the HTTP contract,
[`.ai/03-contracts.md` § Footprint](../.ai/03-contracts.md#footprint).
