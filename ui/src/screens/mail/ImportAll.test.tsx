/**
 * Import everything: the merged scan, the one-at-a-time walk through each
 * account's sign-in (ready ones first, skip and come back, retry), the
 * fallback when a build cannot sign in with a provider, and the Full Disk
 * Access guidance with its look-again on return.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImportAll, notSetUp } from './ImportAll'
import { connected, finished, plan, step, type Flow } from './importFlow'
import { api, type FoundAccount, type ImportScan, type State } from './mailApi'

const base = { username: '', imap_port: 993, imap_tls: 'tls', smtp_host: 'smtp', smtp_port: 465, smtp_tls: 'tls', has_password: false }
const tb: FoundAccount = { ...base, name: 'Work', email: 'me@work.io', imap_host: 'mail.work.io', has_password: true, source: 'thunderbird', from: ['thunderbird'], signin: 'ready' }
const gmail: FoundAccount = { ...base, name: 'Me', email: 'me@gmail.com', imap_host: 'imap.gmail.com', provider: 'google', source: 'apple_mail', from: ['apple_mail'], signin: 'oauth' }
const icloud: FoundAccount = { ...base, name: '', email: 'me@icloud.com', imap_host: 'imap.mail.me.com', provider: 'icloud', source: 'apple_mail', from: ['apple_mail', 'thunderbird'], signin: 'app_password' }
const other: FoundAccount = { ...base, name: '', email: 'me@example.org', imap_host: 'mail.example.org', source: 'thunderbird', from: ['thunderbird'], signin: 'password' }

const empty: State = { accounts: [], folders: [], counts: { inbox: 0, unread: 0, flagged: 0 }, version: 0, sample: false }

describe('the import walk', () => {
  const all = [gmail, icloud, tb, other]
  const start = () => plan(all, () => true)

  it('puts accounts whose password came with them first, then the rest in order', () => {
    const f = start()
    expect(f.rows.map((r) => r.email)).toEqual(['me@work.io', 'me@gmail.com', 'me@icloud.com', 'me@example.org'])
    expect(f.active).toBe('me@work.io')
    expect(plan(all, (e) => e === 'me@icloud.com').rows).toHaveLength(1)
    expect(plan([], () => true).active).toBeNull()
  })

  it('moves on after each answer, keeps a failed sign-in on screen, and lets one be skipped and come back', () => {
    let f: Flow = start()
    f = step(f, { type: 'begin', email: 'me@work.io' })
    expect(f.rows[0]!.status).toBe('working')
    f = step(f, { type: 'ok', email: 'me@work.io' })
    expect(f.active).toBe('me@gmail.com')
    f = step(f, { type: 'fail', email: 'me@gmail.com', error: 'denied' })
    expect(f.active).toBe('me@gmail.com')
    expect(f.rows[1]).toMatchObject({ status: 'failed', error: 'denied' })
    f = step(f, { type: 'skip', email: 'me@gmail.com' })
    expect(f.active).toBe('me@icloud.com')
    f = step(f, { type: 'ok', email: 'me@icloud.com' })
    f = step(f, { type: 'skip', email: 'me@example.org' })
    expect(finished(f)).toBe(true)
    expect(connected(f)).toBe(2)
    f = step(f, { type: 'open', email: 'me@gmail.com' })
    expect(f.active).toBe('me@gmail.com')
    expect(f.rows[1]!.status).toBe('waiting')
    f = step(f, { type: 'need', email: 'me@gmail.com', need: 'app_password' })
    expect(f.rows[1]).toMatchObject({ need: 'app_password', status: 'waiting', error: undefined })
    f = step(f, { type: 'ok', email: 'me@gmail.com' })
    expect(finished(f)).toBe(true)
    // A connected row is never reopened.
    expect(step(f, { type: 'open', email: 'me@gmail.com' })).toBe(f)
  })

  it('asks for the password when a saved one is refused, without stopping the walk', () => {
    let f: Flow = step(start(), { type: 'begin', email: 'me@work.io' })
    f = step(f, { type: 'fail', email: 'me@work.io', error: 'login refused' })
    expect(f.rows[0]).toMatchObject({ status: 'failed', need: 'password' })
    expect(f.active).toBe('me@gmail.com')
  })

  it('puts a cancelled sign-in back to waiting', () => {
    let f: Flow = step(start(), { type: 'ok', email: 'me@work.io' })
    f = step(f, { type: 'begin', email: 'me@gmail.com' })
    f = step(f, { type: 'cancel', email: 'me@gmail.com' })
    expect(f.rows[1]!.status).toBe('waiting')
    expect(f.active).toBe('me@gmail.com')
  })
})

describe('Import everything', () => {
  const scan = (over: Partial<ImportScan> = {}): ImportScan => ({
    sources: [{ kind: 'thunderbird', label: 'Thunderbird', accounts: [] }],
    accounts: [tb, gmail, icloud],
    oauth: { google: true, microsoft: true },
    ...over,
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, 'state').mockResolvedValue(empty)
  })
  afterEach(() => vi.useRealTimers())

  it('walks each account through its one sign-in and lists the progress', async () => {
    vi.spyOn(api, 'importScan').mockResolvedValue(scan())
    const imp = vi.spyOn(api, 'importAccounts').mockImplementation(async (_s, emails) => ({ results: [{ email: emails[0] ?? '', ok: true }] }))
    const start = vi.spyOn(api, 'oauthStart').mockResolvedValue({ auth_url: 'https://accounts.example/auth', flow: 'f1' })
    const flowStatus = vi.spyOn(api, 'oauthFlow').mockResolvedValue({ status: 'pending' })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const busy = vi.fn()
    const done = vi.fn()
    render(<ImportAll onDone={done} onBusy={busy} />)

    expect(await screen.findByText('me@gmail.com')).toBeTruthy()
    expect(screen.getByText('Password saved')).toBeTruthy()
    expect(screen.getByText('Sign in with Google')).toBeTruthy()
    expect(screen.getByText('App-specific password')).toBeTruthy()
    expect(screen.getByText('Apple Mail · Thunderbird')).toBeTruthy()

    vi.useFakeTimers({ shouldAdvanceTime: true })
    await act(async () => { fireEvent.click(screen.getByText('Import 3 accounts')) })
    expect(busy).toHaveBeenCalledWith(true)
    // The Thunderbird account connects by itself, with no password sent.
    await waitFor(() => expect(imp).toHaveBeenCalledWith('thunderbird', ['me@work.io'], undefined))
    expect(await screen.findByText('1 of 3 connected — one sign-in at a time.')).toBeTruthy()

    // Google: in the browser, on that account.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' })) })
    expect(start).toHaveBeenCalledWith('google', 'me@gmail.com')
    expect(open).toHaveBeenCalledWith('https://accounts.example/auth', '_blank', 'noopener')
    expect(screen.getByText(/Waiting for you to approve in the browser/)).toBeTruthy()
    flowStatus.mockResolvedValue({ status: 'ok', email: 'me@gmail.com' })
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(flowStatus).toHaveBeenCalledWith('f1')

    // iCloud: an app-specific password, with where to make it.
    expect(await screen.findByText('appleid.apple.com')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Password for me@icloud.com'), { target: { value: 'abcd-efgh-ijkl-mnop' } })
    await act(async () => { fireEvent.click(screen.getByText('Connect')) })
    expect(imp).toHaveBeenLastCalledWith('apple_mail', ['me@icloud.com'], { 'me@icloud.com': 'abcd-efgh-ijkl-mnop' })
    expect(await screen.findByText('3 of 3 connected.')).toBeTruthy()
    expect(screen.getAllByText('Connected')).toHaveLength(3)

    fireEvent.click(screen.getByText('Open Mail'))
    expect(busy).toHaveBeenLastCalledWith(false)
    expect(done).toHaveBeenCalled()
  })

  it('says why a sign-in failed, and a skipped account can come back', async () => {
    vi.spyOn(api, 'importScan').mockResolvedValue(scan({ accounts: [gmail, other] }))
    const imp = vi.spyOn(api, 'importAccounts').mockResolvedValue({ results: [{ email: 'me@example.org', ok: false, error: 'login refused' }] })
    vi.spyOn(api, 'oauthStart').mockResolvedValue({ auth_url: 'https://accounts.example/auth', flow: 'f1' })
    vi.spyOn(api, 'oauthFlow').mockResolvedValue({ status: 'error', error: 'Google did not sign you in: access_denied' })
    vi.spyOn(window, 'open').mockReturnValue(null)
    render(<ImportAll onDone={() => {}} />)
    await screen.findByText('me@gmail.com')
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await act(async () => { fireEvent.click(screen.getByText('Import 2 accounts')) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(screen.getAllByText('Google did not sign you in: access_denied').length).toBeGreaterThan(0)
    expect(screen.getByText('Sign in again')).toBeTruthy()

    fireEvent.click(screen.getByText('Skip for now'))
    // The other server: its own password; refused, the reason stays on screen.
    fireEvent.change(screen.getByLabelText('Password for me@example.org'), { target: { value: 'nope' } })
    await act(async () => { fireEvent.click(screen.getByText('Connect')) })
    expect(imp).toHaveBeenCalledWith('thunderbird', ['me@example.org'], { 'me@example.org': 'nope' })
    expect(screen.getAllByText('login refused').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText('Skip for now'))
    expect(screen.getByText(/Done for now/)).toBeTruthy()
    expect(screen.getAllByText('Come back')).toHaveLength(2)
    fireEvent.click(screen.getAllByText('Come back')[0]!)
    expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeTruthy()
    expect(screen.getAllByText('Come back')).toHaveLength(1)
  })

  it('offers an app password, with the reason, where this build cannot sign in', async () => {
    vi.spyOn(api, 'importScan').mockResolvedValue(scan({ accounts: [{ ...gmail, signin: 'app_password' }], oauth: { google: false, microsoft: false } }))
    const start = vi.spyOn(api, 'oauthStart')
    render(<ImportAll onDone={() => {}} />)
    expect(await screen.findByText('App password')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByText('Import 1 account')) })
    expect(screen.getByText(notSetUp('google'))).toBeTruthy()
    expect(notSetUp('google')).toBe("Sign-in with Google isn't set up in this build — use an app password.")
    expect(screen.getByText('myaccount.google.com/apppasswords')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign in with Google' })).toBeNull()
    expect(start).not.toHaveBeenCalled()
  })

  it('says how to grant Full Disk Access, opens the pane, and looks again on return', async () => {
    const scanSpy = vi.spyOn(api, 'importScan').mockResolvedValue(scan({
      sources: [{ kind: 'apple_mail', label: 'Apple Mail', accounts: [], needs_permission: 'full_disk_access' }],
      accounts: [],
      full_disk_access: { name: 'caprock', path: '/opt/homebrew/bin/caprock', kind: 'binary' },
    }))
    const pane = vi.spyOn(api, 'openPrivacy').mockResolvedValue({ ok: true })
    render(<ImportAll onDone={() => {}} />)
    expect(await screen.findByText('Apple Mail needs Full Disk Access.')).toBeTruthy()
    expect(screen.getByText('System Settings → Privacy & Security → Full Disk Access')).toBeTruthy()
    expect(screen.getByText('/opt/homebrew/bin/caprock')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByText('Open Full Disk Access settings')) })
    expect(pane).toHaveBeenCalled()

    scanSpy.mockResolvedValue(scan({ accounts: [icloud] }))
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(await screen.findByText('me@icloud.com')).toBeTruthy()
    expect(screen.queryByText('Apple Mail needs Full Disk Access.')).toBeNull()
  })

  it('leaves an account Mail already has unticked', async () => {
    vi.spyOn(api, 'state').mockResolvedValue({ ...empty, accounts: [{ id: 1, name: '', email: 'ME@gmail.com', username: '', imap_host: '', imap_port: 0, imap_tls: '', smtp_host: '', smtp_port: 0, smtp_tls: '', color: '', signature: '', last_sync: 0, last_error: '' }] })
    vi.spyOn(api, 'importScan').mockResolvedValue(scan({ accounts: [gmail, icloud] }))
    render(<ImportAll onDone={() => {}} />)
    expect(await screen.findByText('Already in Mail')).toBeTruthy()
    expect((screen.getByLabelText('Import me@gmail.com') as HTMLInputElement).checked).toBe(false)
    expect(screen.getByText('Import 1 account')).toBeTruthy()
  })
})
