/**
 * AI triage in the inbox: labels and one-liners on the rows, the filters and
 * their keys, Not spam, who does the work, and the offer while AI is off.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MailScreen, resetSampleLeft } from './MailScreen'
import { api, type AIStatus, type Message, type State } from './mailApi'
import { MAIL_KEYS } from './keymap'
import { resetPrompts } from '@/lib/prompts'

const acct = { id: 1, name: 'Alex', email: 'alex@northwind.io', username: '', imap_host: 'h', imap_port: 1, imap_tls: 'none', smtp_host: 'h', smtp_port: 2, smtp_tls: 'none', color: '', signature: '', last_sync: 1, last_error: '' }
const base: State = {
  accounts: [acct], folders: [{ id: 10, account_id: 1, name: 'INBOX', delim: '/', role: 'inbox', total: 3, unread: 0 }],
  counts: { inbox: 3, unread: 0, flagged: 0 }, version: 1, sample: false,
  triage: { running: false, pending: 0, by: '', counts: [{ account_id: 1, category: 'spam', n: 1 }, { account_id: 1, category: 'important', n: 1 }] },
}
const msg = (id: number, subject: string, ai?: Message['ai']): Message => ({
  id, account_id: 1, folder_id: 10, uid: id, message_id: '', in_reply_to: '', references: '', thread_key: 't' + id, subject,
  from_name: 'Sender ' + id, from_addr: `s${id}@example.com`, to: [], cc: [], reply_to: '', date: 1000 - id, size: 1,
  seen: true, flagged: false, answered: false, has_attach: false, snippet: 'raw snippet ' + id, structure: { parts: [] }, body_state: 1, ai,
})
const important = msg(1, 'Q4 budget', { category: 'important', reply: true, summary: 'Maya needs your numbers by Thursday.', model: 'claude/haiku', at: 1 })
const update = msg(2, 'PR merged', { category: 'updates', summary: 'PR #482 merged.', model: 'claude/haiku', at: 1 })
const junk = msg(3, 'Your mailbox will be closed', { category: 'spam', summary: 'Phishing.', model: 'claude/haiku', at: 1 })
const status: AIStatus = { chosen: '', provider: 'claude', label: 'Claude Code', model: 'haiku', sends_to: 'Anthropic, through your Claude Code login', available: true, models: [], providers: [] }

const press = (key: string) => act(() => { fireEvent.keyDown(document.body, { key }) })

beforeEach(() => {
  vi.restoreAllMocks()
  resetPrompts()
  resetSampleLeft()
  try { localStorage.clear() } catch { /* none */ }
  Element.prototype.scrollIntoView ??= () => {} // jsdom has none
  vi.spyOn(api, 'aiStatus').mockResolvedValue(status)
  vi.spyOn(api, 'thread').mockResolvedValue([])
  vi.spyOn(api, 'action').mockResolvedValue({})
})

describe('mail triage', () => {
  it('labels rows, filters by category with 1–5, and names who sorted', async () => {
    vi.spyOn(api, 'settings').mockResolvedValue({ ai_enabled: '1' })
    vi.spyOn(api, 'state').mockResolvedValue(base)
    const list = vi.spyOn(api, 'list').mockImplementation(async (p) => {
      if (p.cat === 'spam') return [junk]
      if (p.cat === 'updates') return [update]
      return [important, update]
    })
    render(<MailScreen />)
    expect(await screen.findByText('Maya needs your numbers by Thursday.')).toBeTruthy()
    expect(screen.queryByText('raw snippet 1')).toBeNull()
    expect(screen.getByText('Reply')).toBeTruthy() // waits on the user's answer
    expect(screen.getByText('Update')).toBeTruthy()
    // All asks for everything but spam; Spam carries its count.
    expect(list.mock.calls.at(-1)![0].cat).toBe('nospam')
    const tabs = screen.getByRole('tablist', { name: 'Sort with AI' })
    const spamTab = within(tabs).getByRole('tab', { name: /Spam/ })
    expect(spamTab.textContent).toContain('1')
    expect(spamTab.textContent).toContain(MAIL_KEYS.catSpam)
    expect(await screen.findByText(/Sorted by Claude Code · haiku/)).toBeTruthy()

    press('5')
    expect(await screen.findByText('Phishing.')).toBeTruthy()
    expect(list.mock.calls.at(-1)![0].cat).toBe('spam')
    press('3')
    await waitFor(() => expect(list.mock.calls.at(-1)![0].cat).toBe('updates'))
    press('1')
    await waitFor(() => expect(list.mock.calls.at(-1)![0].cat).toBe('nospam'))
  })

  it('n takes back a spam label, remembered by the daemon', async () => {
    vi.spyOn(api, 'settings').mockResolvedValue({ ai_enabled: '1' })
    vi.spyOn(api, 'state').mockResolvedValue(base)
    vi.spyOn(api, 'list').mockResolvedValue([junk])
    const label = vi.spyOn(api, 'label').mockResolvedValue({ ok: true })
    render(<MailScreen />)
    press('5')
    fireEvent.click(await screen.findByText('Your mailbox will be closed'))
    press(MAIL_KEYS.notSpam)
    await waitFor(() => expect(label).toHaveBeenCalledWith(3, 'important'))
  })

  it('shows the run while it sorts', async () => {
    vi.spyOn(api, 'settings').mockResolvedValue({ ai_enabled: '1' })
    vi.spyOn(api, 'state').mockResolvedValue({ ...base, triage: { ...base.triage!, running: true, pending: 37, by: 'Claude Code · haiku' } })
    vi.spyOn(api, 'list').mockResolvedValue([important])
    render(<MailScreen />)
    expect(await screen.findByText(/Sorting 37 conversations…/)).toBeTruthy()
  })

  it('offers sorting while AI is off, saying where the mail goes', async () => {
    vi.spyOn(api, 'settings').mockResolvedValue({ ai_enabled: '0' })
    vi.spyOn(api, 'state').mockResolvedValue({ ...base, triage: { ...base.triage!, counts: [] } })
    vi.spyOn(api, 'list').mockResolvedValue([msg(4, 'hello')])
    const put = vi.spyOn(api, 'putSettings').mockResolvedValue({ ai_enabled: '1' })
    render(<MailScreen />)
    expect(await screen.findByText(/Let AI sort your inbox into Important, Updates, Newsletters and Spam\. Sorting sends .* to Anthropic, through your Claude Code login/)).toBeTruthy()
    expect(screen.queryByRole('tablist', { name: 'Sort with AI' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(put).toHaveBeenCalledWith({ ai_enabled: '1' }))
    expect(await screen.findByRole('tablist', { name: 'Sort with AI' })).toBeTruthy()
  })
})
