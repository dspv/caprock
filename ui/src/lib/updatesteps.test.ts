/**
 * The steps are what a person follows when the version chip says there is
 * something newer, so the two things that must hold are: every platform has a
 * complete route (update, restart, verify), and the Homebrew route refreshes
 * the tap before it upgrades.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  PLATFORMS,
  commandContradicts,
  guessPlatform,
  platformFromCommand,
  routeFromCommand,
  routesFor,
  savePlatform,
  savedPlatform,
} from './updatesteps'

describe('routesFor', () => {
  it('offers a way to update on every platform', () => {
    for (const p of PLATFORMS) {
      const routes = routesFor(p.id)
      expect(routes.length).toBeGreaterThan(0)
      for (const r of routes) expect(r.steps.length).toBeGreaterThan(0)
    }
  })

  it('always ends with restarting and checking', () => {
    // A new binary on disk is not a new daemon: the old process keeps running
    // until it is restarted, which is the step people skip and then report
    // that the update did nothing.
    for (const p of PLATFORMS) {
      for (const r of routesFor(p.id)) {
        const cmds = r.steps.map((s) => s.cmd)
        expect(cmds).toContain('caprock down && caprock up')
        expect(cmds).toContain('caprock status')
      }
    }
  })

  it('refreshes the Homebrew tap before upgrading', () => {
    // A tap is read from a local git clone that `brew upgrade` refreshes only
    // through auto-update — at most once every 24 hours. Without the update, a
    // user who ran brew earlier the same day is told "already installed" for a
    // release that has been public for hours. A real report, on the day
    // v0.31.1 shipped.
    const brew = routesFor('macos').find((r) => r.label === 'Homebrew')
    expect(brew?.steps[0]?.cmd).toBe('brew update && brew upgrade caprock')
  })

  it('gives Windows a route that is not Homebrew', () => {
    const labels = routesFor('windows').map((r) => r.label)
    expect(labels).toContain('Scoop')
    expect(labels).not.toContain('Homebrew')
  })
})

describe('guessPlatform', () => {
  it('reads the obvious cases', () => {
    expect(guessPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macos')
    expect(guessPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows')
    expect(guessPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux')
  })

  it('prefers userAgentData when the browser supplies it', () => {
    expect(guessPlatform('Mozilla/5.0 (X11; Linux x86_64)', 'Windows')).toBe('windows')
  })
})

describe('the remembered platform', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips a choice', () => {
    expect(savedPlatform()).toBeUndefined()
    savePlatform('windows')
    expect(savedPlatform()).toBe('windows')
  })

  it('ignores a value that is not a platform', () => {
    // Anything can end up in localStorage — another tool, an old build, a
    // person poking at devtools. A bad value must fall back to guessing, not
    // render a tab that has no steps behind it.
    localStorage.setItem('caprock-update-platform', 'solaris')
    expect(savedPlatform()).toBeUndefined()
  })
})

describe('routeFromCommand', () => {
  it('opens on the way this copy was actually installed', () => {
    // The daemon knows the binary's real path; the browser cannot. When it
    // says "brew", the dialog should not be showing the Scoop steps.
    const routes = routesFor('macos')
    expect(routeFromCommand('brew update && brew upgrade caprock', routes)?.label).toBe('Homebrew')
    expect(routeFromCommand('go install github.com/dspv/caprock/cmd/caprock@latest', routes)?.label).toBe('go install')
  })

  it('says nothing when the daemon had nothing to say', () => {
    expect(routeFromCommand(undefined, routesFor('macos'))).toBeUndefined()
    expect(routeFromCommand('', routesFor('macos'))).toBeUndefined()
  })
})

/**
 * The daemon read the binary's real path; the browser only guessed at the
 * platform. When they disagree the daemon has to win — a jsdom user-agent
 * resolved to Windows while the daemon reported a Homebrew install, and the
 * dialog cheerfully showed Scoop steps that could not possibly work. A browser
 * with an unusual user-agent hits the same thing.
 */
describe('when the daemon and the browser disagree', () => {
  it('notices that a brew command cannot come from Windows', () => {
    expect(commandContradicts('brew update && brew upgrade caprock', 'windows')).toBe(true)
    expect(commandContradicts('brew update && brew upgrade caprock', 'macos')).toBe(false)
    expect(commandContradicts('brew update && brew upgrade caprock', 'linux')).toBe(false)
  })

  it('notices that a scoop command cannot come from macOS', () => {
    expect(commandContradicts('scoop update caprock', 'macos')).toBe(true)
    expect(commandContradicts('scoop update caprock', 'windows')).toBe(false)
  })

  it('accepts go install anywhere, because it runs anywhere', () => {
    const go = 'go install github.com/dspv/caprock/cmd/caprock@latest'
    for (const p of PLATFORMS) expect(commandContradicts(go, p.id)).toBe(false)
  })

  it('reads the platform back out of a scoop command', () => {
    expect(platformFromCommand('scoop update caprock')).toBe('windows')
  })

  it('does not guess between macOS and Linux, which share every route', () => {
    // `brew` and `go install` run on both, so there is nothing to settle and
    // the browser's guess is as good as anything.
    expect(platformFromCommand('brew update && brew upgrade caprock')).toBeUndefined()
    expect(platformFromCommand(undefined)).toBeUndefined()
  })
})
