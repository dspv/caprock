/**
 * Mail's AI settings: the provider picker shows what this computer has, says
 * where the mail text goes, and keeps an API key write-only.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AddAccount, SettingsPanel } from './Setup'
import { PROVIDERS } from './Onboarding'
import { api, type AIProvider, type AIStatus } from './mailApi'

const row = (p: Partial<AIProvider> & { id: string; label: string; kind: AIProvider['kind'] }): AIProvider =>
  ({ sends_to: '', available: false, model: '', ...p })

const providers: AIProvider[] = [
  row({ id: 'claude', label: 'Claude Code', kind: 'cli', available: true, model_hint: 'haiku, sonnet or opus', sends_to: 'Anthropic, through your Claude Code login' }),
  row({ id: 'codex', label: 'Codex', kind: 'cli', why: '`codex` is not installed on this computer' }),
  row({ id: 'anthropic', label: 'Anthropic API', kind: 'api', why: 'no API key yet', sends_to: 'api.anthropic.com, with your API key' }),
  row({ id: 'local', label: 'Local model', kind: 'local', why: 'no local model server is running' }),
]

const auto: AIStatus = { chosen: '', provider: 'claude', label: 'Claude Code', sends_to: 'Anthropic, through your Claude Code login', available: true, models: [], providers }

beforeEach(() => {
  vi.restoreAllMocks()
})

function panel(settings: Record<string, string>) {
  const onSettings = vi.fn()
  vi.spyOn(api, 'putSettings').mockImplementation(async (s) => ({ ...settings, ...s }))
  render(<SettingsPanel accounts={[]} settings={settings} onSettings={onSettings} onClose={() => {}} onChanged={() => {}} />)
  return onSettings
}

describe('mail AI settings', () => {
  it('automatic uses the installed CLI and says where mail goes', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue(auto)
    panel({ ai_enabled: '1', ai_provider: '' })
    await screen.findByText(/Mail text goes to Anthropic, through your Claude Code login/)
    const sel = screen.getByLabelText('AI provider') as HTMLSelectElement
    expect(sel.value).toBe('')
    expect(screen.getByRole('option', { name: 'Automatic (Claude Code)' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Codex (not installed)' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Anthropic API (needs a key)' })).toBeTruthy()
    // A CLI takes a model but never a key.
    expect(screen.getByLabelText('AI model')).toBeTruthy()
    expect(screen.queryByLabelText('Claude Code key')).toBeNull()
  })

  it('an API provider takes a key that is saved and never shown again', async () => {
    const status = vi.spyOn(api, 'aiStatus').mockResolvedValue({ ...auto, chosen: 'anthropic', provider: 'anthropic', label: 'Anthropic API', available: false, error: 'no API key yet' })
    const put = vi.spyOn(api, 'aiKey').mockResolvedValue({ ok: true, key_set: true })
    panel({ ai_enabled: '1', ai_provider: 'anthropic' })
    await screen.findByText(/no API key yet/)
    const input = screen.getByLabelText('Anthropic API key') as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: ' sk-ant-1 ' } })
    status.mockResolvedValue({ ...auto, chosen: 'anthropic', provider: 'anthropic', label: 'Anthropic API', sends_to: 'api.anthropic.com, with your API key',
      providers: providers.map((p) => (p.id === 'anthropic' ? { ...p, available: true, key_set: true, key_where: { kind: 'keychain' } } : p)) })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).toHaveBeenCalledWith('anthropic', 'sk-ant-1'))
    await screen.findByText(/Mail text goes to api.anthropic.com/)
    expect((screen.getByLabelText('Anthropic API key') as HTMLInputElement).value).toBe('')
    expect(screen.getByPlaceholderText('Saved in your keychain')).toBeTruthy()
  })

  it('choosing a provider saves it', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue(auto)
    const onSettings = panel({ ai_enabled: '1', ai_provider: '' })
    await screen.findByText(/Mail text goes to/)
    fireEvent.change(screen.getByLabelText('AI provider'), { target: { value: 'local' } })
    await waitFor(() => expect(api.putSettings).toHaveBeenCalledWith({ ai_provider: 'local' }))
    await waitFor(() => expect(onSettings).toHaveBeenCalled())
  })

  it('an older daemon without providers still renders', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue({ ...auto, provider: '', label: '', available: false, error: 'no local model server is running', providers: [] })
    panel({ ai_enabled: '0' })
    await screen.findByText(/no local model server is running/)
  })
})


const oauthAccount = { id: 1, name: 'Alex', email: 'alex@gmail.com', username: 'alex@gmail.com', auth: 'oauth2:google', imap_host: 'imap.gmail.com', imap_port: 993, imap_tls: 'tls', smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_tls: 'tls', color: '', signature: '', last_sync: 1, last_error: 'Sign in again' }

describe('mail account recovery', () => {
  it('reconnects an existing Google account with its address as the login hint', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue(auto)
    vi.spyOn(api, 'oauthProviders').mockResolvedValue({ google: true })
    const account = { id: 1, name: 'Alex', email: 'alex@gmail.com', username: 'alex@gmail.com', auth: 'oauth2:google', imap_host: 'imap.gmail.com', imap_port: 993, imap_tls: 'tls', smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_tls: 'tls', color: '', signature: '', last_sync: 1, last_error: 'Sign in again' }
    vi.spyOn(api, 'state').mockResolvedValue({ accounts: [account], folders: [], counts: { inbox: 0, unread: 0, flagged: 0 }, version: 0 })
    const start = vi.spyOn(api, 'oauthStart').mockResolvedValue({ auth_url: 'https://accounts.example/auth', flow: 'reconnect' })
    vi.spyOn(window, 'open').mockReturnValue(null)
    render(<SettingsPanel accounts={[account]} settings={{}} onSettings={() => {}} onClose={() => {}} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.queryByPlaceholderText('unchanged')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    fireEvent.click(await screen.findByText('Sign in with Google'))
    await waitFor(() => expect(start).toHaveBeenCalledWith('google', account.email))
  })

  it('goes back to Settings, not the provider tiles, and offers no password', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue(auto)
    vi.spyOn(api, 'oauthProviders').mockResolvedValue({ google: true })
    render(<SettingsPanel accounts={[oauthAccount]} settings={{}} onSettings={() => {}} onClose={() => {}} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    expect(await screen.findByText(/Sign in again as alex@gmail.com/)).toBeTruthy()
    expect(screen.queryByText('Use an app password instead')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy()
    expect(screen.queryByText('Fastmail')).toBeNull()
  })

  it('says a build without sign-in cannot reconnect, and leaves the account alone', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue(auto)
    vi.spyOn(api, 'oauthProviders').mockResolvedValue({ google: false })
    render(<SettingsPanel accounts={[oauthAccount]} settings={{}} onSettings={() => {}} onClose={() => {}} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    expect(await screen.findByText(/isn't set up in this build, so alex@gmail.com cannot sign in again here/)).toBeTruthy()
    expect(document.querySelector('input[type="password"]')).toBeNull()
  })
})

describe('mail connection errors', () => {
  it('keeps known server settings folded after a timeout and offers a retry', async () => {
    vi.spyOn(api, 'guess').mockResolvedValue({ provider: 'Spacemail', known: true, imap_host: 'mail.spacemail.com', imap_port: 993, imap_tls: 'tls', smtp_host: 'mail.spacemail.com', smtp_port: 465, smtp_tls: 'tls', note: '', help_url: 'https://www.spaceship.com/knowledgebase/connect-spacemail-to-email-client/' })
    const add = vi.spyOn(api, 'addAccount').mockRejectedValueOnce(new Error('IMAP: mail.spacemail.com stopped answering after 30s. Check your connection or VPN, then try again')).mockResolvedValue({ id: 1, name: 'Alex', email: 'alex@example.com', username: 'alex@example.com', imap_host: 'mail.spacemail.com', imap_port: 993, imap_tls: 'tls', smtp_host: 'mail.spacemail.com', smtp_port: 465, smtp_tls: 'tls', color: '', signature: '', last_sync: 0, last_error: '' })
    const done = vi.fn()
    render(<AddAccount onDone={done} />)
    fireEvent.change(screen.getByPlaceholderText('you@company.com'), { target: { value: 'alex@example.com' } })
    const password = document.querySelector('input[type="password"]')!
    fireEvent.change(password, { target: { value: 'mailbox-password' } })
    await screen.findByText('Spacemail')
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('stopped answering after 30s')
    expect(screen.getByRole('link', { name: 'Spacemail connection help' })).toHaveAttribute('href', 'https://www.spaceship.com/knowledgebase/connect-spacemail-to-email-client/')
    const settings = screen.getByRole('button', { name: 'Server settings' })
    expect(settings).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(settings)
    expect(screen.getByRole('button', { name: 'Hide server settings' })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(done).toHaveBeenCalledOnce())
    expect(add).toHaveBeenCalledTimes(2)
  })
})

describe('iCloud sign-in guidance', () => {
  it('turns a credentials refusal into a clear next step, keeping the server response folded', async () => {
    vi.spyOn(api, 'guess').mockResolvedValue({ provider: 'iCloud', known: true, imap_host: 'imap.mail.me.com', imap_port: 993, imap_tls: 'tls', smtp_host: 'smtp.mail.me.com', smtp_port: 587, smtp_tls: 'starttls' })
    const raw = 'IMAP: login: imap: NO [AUTHENTICATIONFAILED] Authentication Failed — iCloud needs an app-specific password'
    vi.spyOn(api, 'addAccount').mockRejectedValue(new Error(raw))
    render(<AddAccount provider={PROVIDERS.find((p) => p.id === 'icloud')} onDone={() => {}} />)
    expect(screen.getByText(/not your Apple Account password/)).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('you@icloud.com'), { target: { value: 'alex@me.com' } })
    fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: 'app-specific-password' } })
    await screen.findByRole('button', { name: 'Server settings' })
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }))
    expect(await screen.findByText('iCloud rejected this sign-in')).toBeTruthy()
    expect(screen.getByText(/Check the email address and use/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Create a new app-specific password/ })).toHaveAttribute('href', 'https://account.apple.com')
    expect(screen.getByText(raw).closest('details')).not.toHaveAttribute('open')
    expect(screen.getByRole('button', { name: 'Server settings' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    // The steps give way to the error, which carries the same link.
    expect(screen.queryByText(/not your Apple Account password/)).toBeNull()
  })

  it('reads the daemon\'s iCloud hint on an SMTP refusal as a password refusal too', async () => {
    vi.spyOn(api, 'guess').mockResolvedValue({ provider: 'iCloud', known: true, imap_host: 'imap.mail.me.com', imap_port: 993, imap_tls: 'tls', smtp_host: 'smtp.mail.me.com', smtp_port: 587, smtp_tls: 'starttls' })
    vi.spyOn(api, 'addAccount').mockRejectedValue(new Error('SMTP: login: 535 5.7.8 Authentication credentials invalid — iCloud needs an app-specific password (account.apple.com → Sign-In and Security → App-Specific Passwords), not your Apple Account password'))
    render(<AddAccount provider={PROVIDERS.find((p) => p.id === 'icloud')} onDone={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('you@icloud.com'), { target: { value: 'alex@me.com' } })
    fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: 'app-specific-password' } })
    await screen.findByRole('button', { name: 'Server settings' })
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }))
    expect(await screen.findByText('iCloud rejected this sign-in')).toBeTruthy()
  })

  it('does not turn an iCloud network timeout into a password refusal', async () => {
    vi.spyOn(api, 'guess').mockResolvedValue({ provider: 'iCloud', known: true, imap_host: 'imap.mail.me.com', imap_port: 993, imap_tls: 'tls', smtp_host: 'smtp.mail.me.com', smtp_port: 587, smtp_tls: 'starttls' })
    vi.spyOn(api, 'addAccount').mockRejectedValue(new Error('IMAP: imap.mail.me.com stopped answering after 30s'))
    render(<AddAccount provider={PROVIDERS.find((p) => p.id === 'icloud')} onDone={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('you@icloud.com'), { target: { value: 'alex@me.com' } })
    fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: 'app-specific-password' } })
    await screen.findByRole('button', { name: 'Server settings' })
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('stopped answering')
    expect(screen.queryByText('iCloud rejected this sign-in')).toBeNull()
  })
})
