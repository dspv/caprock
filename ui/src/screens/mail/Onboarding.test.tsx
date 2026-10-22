/**
 * Mail's first run: three ways in (sample mail, import, add by hand), the
 * sample banner's way out, the import list, and sign-in shown only where the
 * daemon offers it.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AddFlow, FirstRun, providerForHost } from './Onboarding'
import { MailScreen, resetSampleLeft } from './MailScreen'
import { api, HttpError, type ImportSource, type State } from './mailApi'
import { resetPrompts } from '@/lib/prompts'

const empty: State = { accounts: [], folders: [], counts: { inbox: 0, unread: 0, flagged: 0 }, version: 0, sample: false }
const acct = { id: 1, name: 'Alex', email: 'alex@northwind.io', username: '', imap_host: '127.0.0.1', imap_port: 1, imap_tls: 'none', smtp_host: '127.0.0.1', smtp_port: 2, smtp_tls: 'none', color: '', signature: '', last_sync: 1, last_error: '' }
const sampleState: State = { ...empty, accounts: [acct], sample: true, version: 3 }

const sources: ImportSource[] = [
  { kind: 'apple_mail', label: 'Apple Mail', accounts: [], needs_permission: 'full_disk_access' },
  { kind: 'thunderbird', label: 'Thunderbird', accounts: [
    { name: 'Alex', email: 'alex@gmail.com', username: 'alex@gmail.com', imap_host: 'imap.gmail.com', imap_port: 993, imap_tls: 'tls', smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_tls: 'tls', has_password: false },
    { name: 'Alex', email: 'alex@work.io', username: 'alex', imap_host: 'mail.work.io', imap_port: 993, imap_tls: 'tls', smtp_host: 'mail.work.io', smtp_port: 465, smtp_tls: 'tls', has_password: true },
  ] },
]

beforeEach(() => {
  vi.restoreAllMocks()
  resetPrompts()
  resetSampleLeft()
  vi.spyOn(api, 'settings').mockResolvedValue({})
  vi.spyOn(api, 'list').mockResolvedValue([])
  vi.spyOn(api, 'oauthProviders').mockResolvedValue({})
})

describe('mail first run', () => {
  it('offers three ways in, import only when the daemon has it', async () => {
    vi.spyOn(api, 'importSources').mockResolvedValue({ sources })
    const r = render(<FirstRun onDone={() => {}} onSample={async () => {}} />)
    expect(screen.getByText('Try it with sample mail')).toBeTruthy()
    expect(screen.getByText('Add an account')).toBeTruthy()
    // Apple Mail read no account (Full Disk Access): it is not named.
    expect(await screen.findByText(/2 accounts found in Thunderbird\./)).toBeTruthy()
    r.unmount()

    vi.spyOn(api, 'importSources').mockRejectedValue(new HttpError('not found', 404))
    render(<FirstRun onDone={() => {}} onSample={async () => {}} />)
    await waitFor(() => expect(screen.queryByText('Looking for other mail apps…')).toBeNull())
    expect(screen.queryByText('Import everything')).toBeNull()
    expect(screen.getByText('Try it with sample mail')).toBeTruthy()
  })

  // Owner, 2026-10-14 (translated): "button → something opens at once".
  it('opens on the sample inbox when no account exists, and Add account leaves it for that provider', async () => {
    vi.spyOn(api, 'importSources').mockResolvedValue({ sources: [] })
    const state = vi.spyOn(api, 'state').mockResolvedValueOnce(empty).mockResolvedValue(sampleState)
    const sample = vi.spyOn(api, 'sample').mockResolvedValue({ sample: true })
    render(<MailScreen />)
    expect(await screen.findByText(/This is a sample inbox — add your account to see your own mail/)).toBeTruthy()
    expect(sample).toHaveBeenCalledWith(true)
    expect(screen.queryByText('Try it with sample mail')).toBeNull()

    state.mockResolvedValue(empty)
    sample.mockResolvedValue({ sample: false })
    fireEvent.click(screen.getByText('Add account'))
    for (const name of ['Google', 'Microsoft', 'iCloud', 'Other', 'Import from this computer']) expect(screen.getByText(name)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByText('iCloud')) })
    expect(sample).toHaveBeenLastCalledWith(false)
    // Straight to iCloud's form, not the tiles.
    expect(await screen.findByText(/not your Apple Account password/)).toBeTruthy()
    // Cancel reaches the tiles, every provider on them.
    fireEvent.click(screen.getByText('Cancel'))
    expect(await screen.findByText('Fastmail')).toBeTruthy()
  })

  it('keeps the first run reachable: Exit sample goes there and the sample does not start again', async () => {
    vi.spyOn(api, 'importSources').mockResolvedValue({ sources: [] })
    const state = vi.spyOn(api, 'state').mockResolvedValue(sampleState)
    const sample = vi.spyOn(api, 'sample').mockResolvedValue({ sample: false })
    const r = render(<MailScreen />)
    await screen.findByText(/This is a sample inbox/)
    state.mockResolvedValue(empty)
    await act(async () => { fireEvent.click(screen.getByText('Exit sample')) })
    expect(sample).toHaveBeenLastCalledWith(false)
    expect(await screen.findByText('Try it with sample mail')).toBeTruthy()
    r.unmount()
    // Opened again in this window: the first run, not the sample.
    sample.mockClear()
    render(<MailScreen />)
    expect(await screen.findByText('Try it with sample mail')).toBeTruthy()
    expect(sample).not.toHaveBeenCalled()
  })

  it('shows sign-in only where the daemon offers it, and falls back to the password form', async () => {
    vi.spyOn(api, 'oauthProviders').mockResolvedValue({ google: true, microsoft: false })
    const r = render(<AddFlow onDone={() => {}} />)
    await act(async () => {})
    fireEvent.click(screen.getByText('Google'))
    expect(screen.getByText('Sign in with Google')).toBeTruthy()
    r.unmount()

    render(<AddFlow onDone={() => {}} />)
    await act(async () => {})
    fireEvent.click(screen.getByText('Outlook'))
    expect(screen.queryByText('Sign in with Microsoft')).toBeNull()
    expect(screen.getByText('App password')).toBeTruthy()
  })

  it('falls back to the password form when the sign-in routes are missing', async () => {
    vi.spyOn(api, 'oauthProviders').mockRejectedValue(new HttpError('not found', 404))
    render(<AddFlow onDone={() => {}} />)
    await act(async () => {})
    fireEvent.click(screen.getByText('Google'))
    expect(screen.queryByText('Sign in with Google')).toBeNull()
    expect(screen.getByText(/2-Step Verification/)).toBeTruthy()
  })

  it('gives iCloud the app-specific password form with the reason', async () => {
    vi.spyOn(api, 'oauthProviders').mockResolvedValue({ google: true, microsoft: true })
    render(<AddFlow onDone={() => {}} />)
    await act(async () => {})
    fireEvent.click(screen.getByText('iCloud'))
    expect(screen.getByText(/not your Apple Account password/)).toBeTruthy()
    expect(screen.getByText('App-specific password')).toBeTruthy()
  })

  it('opens the sign-in page and waits for the account', async () => {
    vi.spyOn(api, 'oauthProviders').mockResolvedValue({ google: true })
    vi.spyOn(api, 'state').mockResolvedValue(empty)
    const start = vi.spyOn(api, 'oauthStart').mockResolvedValue({ auth_url: 'https://accounts.example/auth' })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<AddFlow onDone={() => {}} />)
    await act(async () => {})
    fireEvent.click(screen.getByText('Google'))
    await act(async () => { fireEvent.click(screen.getByText('Sign in with Google')) })
    expect(start).toHaveBeenCalledWith('google', undefined)
    expect(open).toHaveBeenCalledWith('https://accounts.example/auth', '_blank', 'noopener')
    expect(screen.getByText(/Waiting for you to approve in the browser/)).toBeTruthy()
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.getByText('Sign in with Google')).toBeTruthy()
  })

  it('reports the flow error and allows another attempt', async () => {
    vi.spyOn(api, 'oauthProviders').mockResolvedValue({ google: true })
    vi.spyOn(api, 'state').mockResolvedValue(empty)
    vi.spyOn(api, 'oauthStart').mockResolvedValue({ auth_url: 'https://accounts.example/auth', flow: 'attempt-1' })
    vi.spyOn(window, 'open').mockReturnValue(null)
    const status = vi.spyOn(api, 'oauthFlow').mockResolvedValue({ status: 'error', error: 'Google refused access to mail.' })
    const done = vi.fn()
    render(<AddFlow initial="google" onDone={done} />)
    fireEvent.click(await screen.findByText('Sign in with Google'))
    await screen.findByText(/Waiting for you to approve/)
    await screen.findByText('Google refused access to mail.', {}, { timeout: 3000 })
    expect(status).toHaveBeenCalledWith('attempt-1')
    expect(screen.getByText('Sign in with Google')).toBeTruthy()
    expect(done).not.toHaveBeenCalled()
  })

  it('finishes reauthentication even when the account id stays the same', async () => {
    vi.spyOn(api, 'oauthProviders').mockResolvedValue({ google: true })
    vi.spyOn(api, 'state').mockResolvedValue({ ...empty, accounts: [acct] })
    const start = vi.spyOn(api, 'oauthStart').mockResolvedValue({ auth_url: 'https://accounts.example/auth', flow: 'reconnect' })
    vi.spyOn(window, 'open').mockReturnValue(null)
    vi.spyOn(api, 'oauthFlow').mockResolvedValue({ status: 'ok', email: acct.email })
    const done = vi.fn()
    render(<AddFlow initial="google" loginHint={acct.email} onDone={done} />)
    fireEvent.click(await screen.findByText('Sign in with Google'))
    await waitFor(() => expect(done).toHaveBeenCalledOnce(), { timeout: 3000 })
    expect(start).toHaveBeenCalledWith('google', acct.email)
  })

  it('explains why Google offers an app password instead of sign-in', async () => {
    render(<AddFlow initial="google" onDone={() => {}} />)
    expect(screen.getByRole('status')).toHaveTextContent('Checking sign-in options')
    expect(await screen.findByText(/Sign-in with Google isn't set up in this build/)).toBeTruthy()
  })

  it('ignores a sign-in start that completes after cancellation', async () => {
    vi.spyOn(api, 'oauthProviders').mockResolvedValue({ google: true })
    let resolve!: (r: { auth_url: string; flow: string }) => void
    vi.spyOn(api, 'state').mockResolvedValue(empty)
    vi.spyOn(api, 'oauthStart').mockReturnValue(new Promise((r) => { resolve = r }))
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<AddFlow initial="google" onDone={() => {}} />)
    fireEvent.click(await screen.findByText('Sign in with Google'))
    await waitFor(() => expect(api.oauthStart).toHaveBeenCalled())
    fireEvent.click(screen.getByText('Use an app password instead'))
    await act(async () => { resolve({ auth_url: 'https://accounts.example/auth', flow: 'cancelled' }) })
    expect(open).not.toHaveBeenCalled()
    expect(screen.queryByText(/Waiting for you to approve/)).toBeNull()
  })

  it('retries a failed availability check instead of asking for a password', async () => {
    vi.spyOn(api, 'oauthProviders').mockRejectedValueOnce(new Error('Daemon disconnected')).mockResolvedValue({ google: true })
    render(<AddFlow initial="google" onDone={() => {}} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Daemon disconnected')
    expect(screen.queryByText('App password')).toBeNull()
    fireEvent.click(screen.getByText('Try again'))
    expect(await screen.findByText('Sign in with Google')).toBeTruthy()
  })

  it('knows an imported server by its host', () => {
    expect(providerForHost('imap.gmail.com')?.id).toBe('google')
    expect(providerForHost('imap.mail.me.com')?.id).toBe('icloud')
    expect(providerForHost('outlook.office365.com')?.id).toBe('microsoft')
    expect(providerForHost('mail.work.io')).toBeUndefined()
  })
})
