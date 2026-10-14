/**
 * Mail's first run: three ways in (sample mail, import, add by hand), the
 * sample banner's way out, the import list, and sign-in shown only where the
 * daemon offers it.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AddFlow, FirstRun, ImportPanel, providerForHost } from './Onboarding'
import { MailScreen } from './MailScreen'
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
    expect(await screen.findByText(/2 accounts found in Apple Mail, Thunderbird/)).toBeTruthy()
    r.unmount()

    vi.spyOn(api, 'importSources').mockRejectedValue(new HttpError('not found', 404))
    render(<FirstRun onDone={() => {}} onSample={async () => {}} />)
    await waitFor(() => expect(screen.queryByText('Looking for other mail apps…')).toBeNull())
    expect(screen.queryByText('Import my accounts')).toBeNull()
    expect(screen.getByText('Try it with sample mail')).toBeTruthy()
  })

  it('turns sample mode on from the first run and off from the banner', async () => {
    vi.spyOn(api, 'importSources').mockResolvedValue({ sources: [] })
    const state = vi.spyOn(api, 'state').mockResolvedValue(empty)
    const sample = vi.spyOn(api, 'sample').mockResolvedValue({ sample: true })
    render(<MailScreen />)
    fireEvent.click(await screen.findByText('Try it with sample mail'))
    state.mockResolvedValue(sampleState)
    await waitFor(() => expect(sample).toHaveBeenCalledWith(true))
    expect(await screen.findByText('Sample mail')).toBeTruthy()

    state.mockResolvedValue(empty)
    sample.mockResolvedValue({ sample: false })
    await act(async () => { fireEvent.click(screen.getByText('Add my account')) })
    expect(sample).toHaveBeenLastCalledWith(false)
    // "Add my account" lands on the provider tiles.
    expect(await screen.findByText('iCloud')).toBeTruthy()
    expect(screen.getByText('Fastmail')).toBeTruthy()
  })

  it('lists accounts to import, asks for a missing password and says how to grant access', async () => {
    const imp = vi.spyOn(api, 'importAccounts').mockResolvedValue({ results: [{ email: 'alex@gmail.com', ok: true }, { email: 'alex@work.io', ok: false, error: 'login refused' }] })
    const done = vi.fn()
    render(<ImportPanel initial={sources} onDone={done} onBack={() => {}} />)
    expect(screen.getByText(/Privacy & Security → Full Disk Access/)).toBeTruthy()
    expect(screen.getByText('Retry')).toBeTruthy()
    expect(screen.getByText('alex@work.io')).toBeTruthy()
    const go = screen.getByText('Import 2 accounts') as HTMLButtonElement
    expect(go.disabled).toBe(true) // the Gmail account has no saved password yet
    expect(screen.getByText('myaccount.google.com/apppasswords')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Password for alex@gmail.com'), { target: { value: 'app-pw' } })
    expect(go.disabled).toBe(false)
    await act(async () => { fireEvent.click(go) })
    expect(imp).toHaveBeenCalledWith('thunderbird', ['alex@gmail.com', 'alex@work.io'], { 'alex@gmail.com': 'app-pw' })
    expect(screen.getByText('Added')).toBeTruthy()
    expect(screen.getByText('login refused')).toBeTruthy()
    expect(done).not.toHaveBeenCalled()
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
    expect(screen.getByText(/Apple has no sign-in for other mail apps/)).toBeTruthy()
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
    expect(start).toHaveBeenCalledWith('google')
    expect(open).toHaveBeenCalledWith('https://accounts.example/auth', '_blank', 'noopener')
    expect(screen.getByText(/Waiting for you to approve in the browser/)).toBeTruthy()
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.getByText('Sign in with Google')).toBeTruthy()
  })

  it('knows an imported server by its host', () => {
    expect(providerForHost('imap.gmail.com')?.id).toBe('google')
    expect(providerForHost('imap.mail.me.com')?.id).toBe('icloud')
    expect(providerForHost('outlook.office365.com')?.id).toBe('microsoft')
    expect(providerForHost('mail.work.io')).toBeUndefined()
  })
})
