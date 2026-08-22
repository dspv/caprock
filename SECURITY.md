# Security Policy

## Reporting a vulnerability

Please report privately via GitHub's **Report a vulnerability** button
(the repo's **Security** tab → **Advisories**). Do not open a public issue for
security bugs.

Caprock is local-first — it binds `127.0.0.1` only and makes no outbound calls —
but it does parse untrusted transcripts and write to `~/.claude/settings.json`,
so reports are welcome. Include repro steps and your OS + version.

## What Caprock stores, and where

**Your prompts and Claude's responses are stored in cleartext** in the local
SQLite database at `<data_dir>/caprock.db`. That is what the product is: the
Answers screen searches Claude's prose across every session, which is only
possible because the text is on disk in readable form. Nothing is encrypted and
nothing is redacted.

The practical consequence: **anything that appears in a prompt, a tool result,
or a response is written to that file** — including secrets that happen to pass
through a session, such as an API key echoed by a command or pasted into a
prompt. Caprock does not scan for or strip credentials. Treat the database as
being as sensitive as the sessions it recorded.

Where `<data_dir>` is per OS is documented in
[`.ai/08-decisions.md` § ADR-013](.ai/08-decisions.md).

### File permissions

On macOS and Linux, Caprock restricts the files it owns to the current user:

- the data directory itself is `0700`
- `config.json`, `runtime.json` and the log are `0600`
- `caprock.db` and its `-wal` / `-shm` siblings are `0600`, applied on every
  daemon start — so a database created by an older version, which inherited the
  process umask (typically `0644`, world-readable), is tightened the next time
  the daemon opens it

On Windows there are no POSIX mode bits; access is governed by the ACL the files
inherit from the per-user data directory.

If Caprock cannot set these modes — a network share or a container volume that
does not support them — it logs a warning and keeps running rather than
refusing to start.

### Deleting your history

The database is a single file. Stop the daemon (`caprock down`) and delete
`caprock.db` along with its `-wal` and `-shm` siblings; Caprock recreates an
empty one on the next start.

## The local API

The daemon serves its REST API and dashboard on `127.0.0.1` with no login,
because reaching it requires being on the machine. That boundary does **not**
hold against a web browser: any page you visit while the daemon runs can send
requests to `127.0.0.1`, and the same-origin policy stops the page reading the
response — it does not stop the request being sent, or stop what the request
does.

Since several endpoints are genuinely dangerous (`POST /v1/agents` starts a
process, `/v1/agents/{id}/input` types into a live session), every
state-changing request to `/v1` must show it came from the dashboard or from a
local client. The layers are described in
[`.ai/03-contracts.md` § Cross-site request protection](.ai/03-contracts.md).
A missing `Origin` header is **not** treated as trusted.

## Supported versions

The latest release.
