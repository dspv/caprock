/**
 * How to update, per platform, as steps a person can follow.
 *
 * The dialog used to print one line — the command for however the daemon
 * guessed this copy was installed — and stop. That guess is right most of the
 * time and useless when it is wrong, and even when right it answered only the
 * first of three questions: run what, then what, and how do I know it worked.
 *
 * So the steps live here, keyed by platform, and the dialog renders them. The
 * daemon's guess still leads (it knows the binary's real path, which no
 * browser can), but it is now one tab among three rather than the only thing
 * on offer, and the choice is remembered.
 */

/** The platforms we ship binaries for. */
export type Platform = 'macos' | 'linux' | 'windows'

export const PLATFORMS: { id: Platform; label: string }[] = [
  { id: 'macos', label: 'macOS' },
  { id: 'linux', label: 'Linux' },
  { id: 'windows', label: 'Windows' },
]

/** One numbered step: what to run, and why it is there. */
export interface Step {
  /** The command to run, verbatim. */
  cmd: string
  /** One line saying what it does — never a restatement of the command. */
  note: string
}

/** A way of installing, and the steps that update it. */
export interface Route {
  /** How this copy was installed, in the words the user would use. */
  label: string
  steps: Step[]
}

const RESTART: Step = {
  cmd: 'caprock down && caprock up',
  note: 'The running daemon is the old binary until it restarts. Your database is untouched.',
}

const VERIFY: Step = {
  cmd: 'caprock status',
  note: 'Confirms the new version is the one running, and that hooks are still registered.',
}

/**
 * `brew update` before `brew upgrade`, and it is load-bearing.
 *
 * A tap is not served by the Homebrew API: it is read from a local git clone
 * that `brew upgrade` refreshes only through auto-update, which runs at most
 * once every 24 hours. A user who ran any brew command earlier the same day is
 * told `already installed` for a release that has been public for hours — and
 * the command Caprock gave them looks broken. Reported by a user on the day
 * v0.31.1 shipped.
 */
const BREW: Route = {
  label: 'Homebrew',
  steps: [
    {
      cmd: 'brew update && brew upgrade caprock',
      note: 'The update is not optional: without it Homebrew reads a cached copy of the tap, refreshed at most once a day, and reports "already installed" for a release that is already out.',
    },
    RESTART,
    VERIFY,
  ],
}

const SCOOP: Route = {
  label: 'Scoop',
  steps: [
    { cmd: 'scoop update caprock', note: 'Scoop refreshes its buckets as part of this, so no separate step.' },
    RESTART,
    VERIFY,
  ],
}

const GO: Route = {
  label: 'go install',
  steps: [
    {
      cmd: 'go install github.com/dspv/caprock/cmd/caprock@latest',
      note: 'Also install the hook shim: same command with cmd/caprock-hook.',
    },
    RESTART,
    VERIFY,
  ],
}

const DOWNLOAD: Route = {
  label: 'Downloaded binary',
  steps: [
    {
      cmd: '',
      note: 'Download the archive for your platform from the release page, and replace the caprock and caprock-hook binaries with the ones inside it.',
    },
    RESTART,
    VERIFY,
  ],
}

/** Every way of installing on a platform, most common first. */
export function routesFor(p: Platform): [Route, ...Route[]] {
  switch (p) {
    case 'macos':
      return [BREW, GO, DOWNLOAD]
    case 'linux':
      return [BREW, GO, DOWNLOAD]
    case 'windows':
      return [SCOOP, GO, DOWNLOAD]
  }
}

/**
 * Which platform this browser is on.
 *
 * A guess, and only the opening tab — the user can switch, and their choice is
 * what gets remembered. `userAgentData` where it exists, the user-agent string
 * otherwise; neither is reliable enough to be more than a default.
 */
export function guessPlatform(ua: string, uaPlatform?: string): Platform {
  const s = `${uaPlatform ?? ''} ${ua}`.toLowerCase()
  if (s.includes('win')) return 'windows'
  if (s.includes('mac') || s.includes('darwin') || s.includes('iphone') || s.includes('ipad')) return 'macos'
  return 'linux'
}

/**
 * Which platform the daemon's own command implies, if any.
 *
 * The browser's user-agent is a guess; the daemon read the binary's real path.
 * When the two disagree the daemon wins — a `brew` command means this is not a
 * Windows machine, whatever the user-agent claims. Without this the dialog
 * opened on Scoop for a Homebrew install whenever the user-agent was unusual,
 * which is to say it showed steps that could not possibly work.
 */
export function platformFromCommand(cmd: string | undefined): Platform | undefined {
  if (!cmd) return undefined
  if (cmd.startsWith('scoop')) return 'windows'
  // `brew` and `go install` run on both macOS and Linux, so they rule out
  // Windows without settling which of the two this is. Both offer the same
  // routes, so leaving the browser's guess to choose between them is safe.
  return undefined
}

/** True when this command cannot have come from the given platform. */
export function commandContradicts(cmd: string | undefined, p: Platform): boolean {
  if (!cmd) return false
  const routes = routesFor(p)
  return routeFromCommand(cmd, routes) === undefined
}

const KEY = 'caprock-update-platform'

/** The platform the user last chose, if they chose one. */
export function savedPlatform(): Platform | undefined {
  try {
    const v = localStorage.getItem(KEY)
    return PLATFORMS.some((p) => p.id === v) ? (v as Platform) : undefined
  } catch {
    // Private browsing, or storage disabled. A remembered tab is a
    // convenience, never a requirement.
    return undefined
  }
}

/** Remember the platform the user picked. */
export function savePlatform(p: Platform): void {
  try {
    localStorage.setItem(KEY, p)
  } catch {
    // As above: losing the preference is not worth an error.
  }
}

/**
 * Which route the daemon's own answer points at, if any.
 *
 * The daemon knows the binary's real path and derives a command from it
 * (`internal/update`). Matching that command back to a route lets the dialog
 * open on the way this copy was actually installed instead of guessing from a
 * browser string — the one thing the server knows and the client cannot.
 */
export function routeFromCommand(cmd: string | undefined, routes: readonly Route[]): Route | undefined {
  if (!cmd) return undefined
  const head = cmd.split(/\s+/)[0]
  if (!head) return undefined
  return routes.find((r) => r.steps.some((s) => s.cmd.startsWith(head)))
}
