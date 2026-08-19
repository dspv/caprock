# Security Policy

## Reporting a vulnerability

Please report privately via GitHub's **Report a vulnerability** button
(the repo's **Security** tab → **Advisories**). Do not open a public issue for
security bugs.

Caprock is local-first — it binds `127.0.0.1` only and makes no outbound calls —
but it does parse untrusted transcripts and write to `~/.claude/settings.json`,
so reports are welcome. Include repro steps and your OS + version.

## Supported versions

The latest release.
