import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '@/lib/api'
import { appUpdate, resetAppUpdate, type AppUpdateInfo } from '@/lib/appupdate'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VersionPanel } from './VersionPanel'

const app: { info?: AppUpdateInfo } = {}
vi.mock('@/lib/appupdate', async (orig) => ({ ...(await orig<typeof import('@/lib/appupdate')>()), useAppUpdate: () => app.info }))

afterEach(() => { vi.unstubAllGlobals(); app.info = undefined })

const base: UpdateStatus = { enabled: true, current: '0.104.0', update_available: false }

describe('the version panel', () => {
  it('says an update is out and when it last looked, and leaves the notes to a link', () => {
    const now = Date.now()
    render(<VersionPanel shown="0.104.0" title="" onStatus={() => {}}
      status={{ ...base, latest: 'v0.105.0', update_available: true, checked_at: now - 37 * 60_000, notes: '## Added\n- **The session deck.** Under the terminal.', notes_for: 'v0.105.0' }} />)
    fireEvent.click(screen.getByText('0.104.0'))
    const dlg = screen.getByRole('dialog', { name: 'Caprock version' })
    expect(dlg.textContent).toMatch(/0\.105\.0 is out/)
    expect(dlg.querySelector('[data-checked]')?.textContent).toMatch(/Checked 37m ago/)
    expect(dlg.textContent).not.toMatch(/The session deck/)
    expect(screen.getByRole('button', { name: 'Release notes' })).toBeTruthy()
  })

  it('marks the page while open, so the update card in the same corner steps aside', () => {
    render(<VersionPanel shown="0.104.0" title="" onStatus={() => {}} status={{ ...base, latest: 'v0.105.0', update_available: true }} />)
    expect(document.documentElement.hasAttribute('data-version-open')).toBe(false)
    const toggle = document.querySelector('[data-version]')!
    fireEvent.click(toggle)
    expect(document.documentElement.hasAttribute('data-version-open')).toBe(true)
    fireEvent.click(toggle)
    expect(document.documentElement.hasAttribute('data-version-open')).toBe(false)
  })

  // Owner, 2026-11-12: "Updated to 0.175.1 · What's new" sat over the open
  // panel, which says the same. jsdom applies no stylesheet: read the rule.
  it('hides the update card and the updated line in its corner while open', () => {
    const tokens = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'design', 'tokens.css'), 'utf8')
    const rule = /html\[data-version-open\][^{]*\{\s*display:\s*none/.exec(tokens)
    expect(rule?.[0]).toContain('[data-update-toast]')
    expect(rule?.[0]).toContain('[data-auto-updated]')
  })

  it('says up to date when the latest is the one running', () => {
    render(<VersionPanel shown="0.105.0" title="" onStatus={() => {}} status={{ ...base, current: '0.105.0', latest: '0.105.0', checked_at: Date.now() }} />)
    fireEvent.click(screen.getByText('0.105.0'))
    expect(screen.getByRole('dialog').textContent).toMatch(/You’re on the latest version/)
    // The button checks again; what is new is a link on the checked line.
    expect(screen.getByRole('button', { name: 'Check again' }).className).toMatch(/border/)
    expect(screen.getByRole('button', { name: /What’s new in 0\.105\.0/ }).closest('[data-checked]')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull()
  })

  it('checks again from the button when just checked', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ...base, current: '0.105.0', latest: '0.105.0', checked_at: Date.now() }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)
    const onStatus = vi.fn()
    render(<VersionPanel shown="0.105.0" title="" onStatus={onStatus} status={{ ...base, current: '0.105.0', latest: '0.105.0', checked_at: Date.now() - 4 * 60_000 }} />)
    fireEvent.click(screen.getByText('0.105.0'))
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(onStatus).toHaveBeenCalled())
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/\/v1\/update\/check/)
  })

  it('offers Check now instead once the last check is old', () => {
    render(<VersionPanel shown="0.105.0" title="" onStatus={() => {}} status={{ ...base, current: '0.105.0', latest: '0.105.0', checked_at: Date.now() - 60 * 60_000 }} />)
    fireEvent.click(screen.getByText('0.105.0'))
    expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /What’s new/ })).toBeNull()
  })

  it('asks the daemon to look on Check now', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ...base, latest: '0.105.0', update_available: true, checked_at: Date.now() }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)
    const onStatus = vi.fn()
    render(<VersionPanel shown="0.104.0" title="" onStatus={onStatus} status={base} />)
    fireEvent.click(screen.getByText('0.104.0'))
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(onStatus).toHaveBeenCalled())
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/\/v1\/update\/check/)
  })

  it('warns when the daemon runs another version than the app', () => {
    app.info = { version: '0.106.0', supported: true, asked: true, phase: 'idle' }
    render(<VersionPanel shown="0.106.0" title="" onStatus={() => {}} status={{ ...base, current: '0.97.8', latest: '0.106.0', checked_at: Date.now() }} />)
    expect(document.querySelector('[data-version-apart]')).not.toBeNull()
    fireEvent.click(screen.getByText('0.106.0'))
    expect(screen.getByRole('dialog').querySelector('[data-apart]')?.textContent).toMatch(/app is v0\.106\.0, its daemon v0\.97\.8/)
  })

  it('says nothing when the app and its daemon agree', () => {
    app.info = { version: '0.106.0', supported: true, asked: true, phase: 'idle' }
    render(<VersionPanel shown="0.106.0" title="" onStatus={() => {}} status={{ ...base, current: 'v0.106.0' }} />)
    expect(document.querySelector('[data-version-apart]')).toBeNull()
  })

  it('closes from its own button, not only from outside or Esc', () => {
    render(<VersionPanel shown="0.105.0" title="" onStatus={() => {}} status={{ ...base, current: '0.105.0', latest: '0.105.0', checked_at: Date.now() }} />)
    fireEvent.click(screen.getByRole('button', { name: /0\.105\.0/ }))
    expect(screen.getByRole('dialog', { name: 'Caprock version' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'Caprock version' })).toBeNull()
  })
})

// Owner, 2026-11-23: "Caprock 0.189.0 · v0.190.0 is out" over "Update to
// v0.189.1", and it never looked again. The daemon had seen the release;
// latest.json, the app's updater's source, came minutes later.
describe('the version panel between a release and its app update', () => {
  const out: UpdateStatus = { ...base, current: 'v0.189.0', latest: 'v0.190.0', update_available: true, checked_at: Date.now() - 5 * 60_000 }
  const on = (over: Partial<AppUpdateInfo>) => ({ version: '0.189.0', supported: true, asked: true, phase: 'idle', ...over } as AppUpdateInfo)
  afterEach(() => { resetAppUpdate(); vi.restoreAllMocks() })

  it('never offers the older update under the newer heading, says it is being prepared, and asks again on opening', () => {
    const recheck = vi.spyOn(appUpdate, 'recheck').mockResolvedValue(undefined)
    app.info = on({ phase: 'available', next: '0.189.1' })
    render(<VersionPanel shown="0.189.0" title="" onStatus={() => {}} status={out} />)
    fireEvent.click(screen.getByText('0.189.0'))
    const dlg = screen.getByRole('dialog', { name: 'Caprock version' })
    expect(dlg.textContent).toMatch(/v0\.190\.0 is out/)
    expect(dlg.textContent).not.toMatch(/0\.189\.1/)
    expect(screen.queryByRole('button', { name: /Update to/ })).toBeNull()
    expect(dlg.querySelector('[data-preparing]')?.textContent).toMatch(/v0\.190\.0 is being prepared — the app update is usually ready within 5 minutes/)
    expect(recheck).toHaveBeenCalledWith('v0.190.0')
  })

  it('offers the newest in one jump once the updater has it', () => {
    vi.spyOn(appUpdate, 'recheck').mockResolvedValue(undefined)
    app.info = on({ phase: 'available', next: '0.190.0' })
    render(<VersionPanel shown="0.189.0" title="" onStatus={() => {}} status={out} />)
    fireEvent.click(screen.getByText('0.189.0'))
    expect(screen.getByRole('button', { name: 'Update to v0.190.0' })).toBeTruthy()
    expect(document.querySelector('[data-preparing]')).toBeNull()
  })

  it('looks for the app update on opening when the updater never asked', () => {
    const check = vi.spyOn(appUpdate, 'check').mockResolvedValue(undefined)
    app.info = on({ phase: 'idle' })
    render(<VersionPanel shown="0.189.0" title="" onStatus={() => {}} status={out} />)
    fireEvent.click(screen.getByText('0.189.0'))
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('says so while that check runs, with nothing to install', () => {
    app.info = on({ phase: 'checking' })
    render(<VersionPanel shown="0.189.0" title="" onStatus={() => {}} status={out} />)
    fireEvent.click(screen.getByText('0.189.0'))
    expect(document.querySelector('[data-app-update-state="checking"]')?.textContent).toBe('Checking for the app update…')
    expect(screen.queryByRole('button', { name: /Update to/ })).toBeNull()
  })
})

// Owner, 2026-11-23: "v0.190.1 is out · Run in a terminal: brew update &&
// brew upgrade --cask caprock-app" while the app was downloading it itself.
describe('the version panel while the app updates itself', () => {
  const out: UpdateStatus = { ...base, current: 'v0.189.1', latest: 'v0.190.1', update_available: true, checked_at: Date.now() - 6000, app_command: 'brew update && brew upgrade --cask caprock-app' }
  const on = (over: Partial<AppUpdateInfo>) => ({ version: '0.189.1', supported: true, asked: true, phase: 'idle', ...over } as AppUpdateInfo)
  const openPanel = (info: AppUpdateInfo | undefined, st: UpdateStatus = out) => {
    app.info = info
    render(<VersionPanel shown="0.189.1" title="" onStatus={() => {}} status={st} />)
    fireEvent.click(screen.getByText('0.189.1'))
    return screen.getByRole('dialog', { name: 'Caprock version' })
  }
  afterEach(() => { resetAppUpdate(); vi.restoreAllMocks() })

  it('checking: says so, no commands', () => {
    vi.spyOn(appUpdate, 'check').mockResolvedValue(undefined)
    const dlg = openPanel(on({ phase: 'checking' }))
    expect(dlg.querySelector('[data-app-update-state="checking"]')?.textContent).toBe('Checking for the app update…')
    expect(dlg.textContent).not.toMatch(/terminal|brew/)
  })

  it('downloading: the version, the percentage and a bar, no commands', () => {
    const dlg = openPanel(on({ phase: 'downloading', next: '0.190.1', downloaded: 42, total: 100 }))
    const st = dlg.querySelector('[data-app-update-state="progress"]')!
    expect(st.textContent).toBe('Downloading v0.190.1… 42%')
    expect((st.querySelector('[style]') as HTMLElement).style.width).toBe('42%')
    expect(dlg.textContent).not.toMatch(/terminal|brew/)
  })

  it('downloading with no size known: no number', () => {
    const dlg = openPanel(on({ phase: 'downloading', next: '0.190.1', downloaded: 42, total: null }))
    expect(dlg.querySelector('[data-app-update-state="progress"]')?.textContent).toBe('Downloading v0.190.1…')
  })

  it('installing: the app restarts, sessions keep running; no commands', () => {
    const dlg = openPanel(on({ phase: 'installing', next: '0.190.1' }))
    expect(dlg.querySelector('[data-app-update-state="installing"]')?.textContent).toBe('Installing v0.190.1 — the app restarts, sessions keep running')
    expect(dlg.textContent).not.toMatch(/terminal|brew/)
  })

  it('being prepared: no commands either', () => {
    vi.spyOn(appUpdate, 'recheck').mockResolvedValue(undefined)
    const dlg = openPanel(on({ phase: 'available', next: '0.189.2' }))
    expect(dlg.querySelector('[data-preparing]')).not.toBeNull()
    expect(dlg.textContent).not.toMatch(/terminal|brew/)
  })

  it('failed: the error, Try again, and the terminal as the other way', () => {
    const dlg = openPanel(on({ phase: 'failed', error: 'Could not reach GitHub: timed out' }))
    expect(dlg.querySelector('[data-update-failed]')?.textContent).toMatch(/did not install.*Could not reach GitHub: timed out/)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    const cmds = dlg.querySelector('[data-update-commands="fallback"]')!
    expect(cmds.textContent).toMatch(/^Or update from a terminal:/)
    expect(cmds.textContent).toMatch(/brew upgrade --cask caprock-app/)
  })

  it('an install that cannot replace itself: Run in a terminal', () => {
    const dlg = openPanel(on({ supported: false, blocked: 'Installed from the .deb package: …' }))
    expect(dlg.querySelector('[data-update-commands="primary"]')?.textContent).toMatch(/^Run in a terminal:.*brew upgrade/)
  })
})
