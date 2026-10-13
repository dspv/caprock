import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '@/lib/api'
import type { AppUpdateInfo } from '@/lib/appupdate'
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
    expect(screen.getByRole('button', { name: 'Release notes →' })).toBeTruthy()
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

  it('says up to date when the latest is the one running', () => {
    render(<VersionPanel shown="0.105.0" title="" onStatus={() => {}} status={{ ...base, current: '0.105.0', latest: '0.105.0', checked_at: Date.now() }} />)
    fireEvent.click(screen.getByText('0.105.0'))
    expect(screen.getByRole('dialog').textContent).toMatch(/up to date/)
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
