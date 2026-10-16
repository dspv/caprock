# Installing Caprock with a coding agent

This page is for the agent a user asked to install Caprock, and for the user
who wants to know what that agent will do. It describes; it gives no
instructions beyond the user's own request.

Caprock is a desktop app and local dashboard for Claude Code, Codex, OpenCode
and Gemini CLI sessions: terminals per project, what each session is doing,
what it costs, plan limits. Open source, Apache-2.0
([LICENSE](../LICENSE)). It runs on the user's machine; there is no account
and no cloud service. Rule 4 of [CLAUDE.md](../CLAUDE.md) lists the only
outbound calls (the release check, and integrations the user turns on).

## What the install does

One script per system, the same one the site's install button shows. Each
downloads the newest release from this repository's
[Releases](https://github.com/dspv/caprock/releases) page and nothing else.
Read it before running it: `curl -fsSL <url>` prints it.

| System  | Command                                    |
| ------- | ------------------------------------------ |
| macOS   | `curl -fsSL https://caprock.dev/mac.sh \   |
| Windows | `irm https://caprock.dev/win.ps1 \         |
| Linux   | `curl -fsSL https://caprock.dev/linux.sh \ |

- **macOS:** downloads `Caprock-macOS.dmg`, copies `Caprock.app` into
  `/Applications` (or `~/Applications` when that is not writable) and opens it.
  No `sudo`.
- **Windows:** downloads `Caprock-Windows-setup.exe` and runs it: a per-user
  install, no administrator prompt.
- **Linux:** downloads `Caprock-Linux.AppImage` into `~/.local/share`, adds a
  menu entry. No `sudo`.

The script does **not** touch Claude Code's settings. On first launch the app
asks the user, in its own window, whether to keep Caprock running in the
background, and offers a button to connect Claude Code (which adds Caprock's
hook to `~/.claude/settings.json`, so it sees sessions live). Both are the
user's clicks, not the agent's.

## Where things live

- The app: `/Applications/Caprock.app` (macOS), the per-user install directory
  (Windows), `~/.local/share` (Linux AppImage).
- Data (sessions, history, settings): `~/Library/Application Support/caprock`
  on macOS, `%APPDATA%\caprock` on Windows, `~/.config/caprock` on Linux.
- The `caprock` command the app runs in the background: in the data
  directory's `bin/` (macOS), or the Homebrew or Scoop one if that was
  already installed.

## How to remove it

- If Claude Code was connected, remove Caprock's entries from its settings
  first: `caprock hooks uninstall` and `caprock statusline uninstall` (other
  hooks and a status line that is not Caprock's are left alone).
- Stop the background service: `caprock service uninstall`.
- Remove the app: move Caprock to the Trash (macOS), Settings → Apps → Caprock
  (Windows), delete the AppImage (Linux).
- Delete the data directory above to remove the history too.

More: [install-app.md](install-app.md) (every way to install, upgrade and
uninstall) and [app.md](app.md) (using the app).
