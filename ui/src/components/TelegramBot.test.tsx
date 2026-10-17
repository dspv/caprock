/**
 * The guided Telegram setup (ADR-047): a token checked with Telegram, then a
 * pairing code, then the paired chat by name. The token never comes back.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TelegramBotFields } from './TelegramBot'
import type { TelegramStatus } from '@/lib/api'

const tg = vi.hoisted(() => ({
  state: { bot_set: false, chat_set: false, polling: false } as TelegramStatus,
  tokens: [] as string[],
  refuse: '',
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      telegram: async () => tg.state,
      telegramToken: async (token: string) => {
        tg.tokens.push(token)
        if (tg.refuse) throw new Error(tg.refuse)
        tg.state = { bot_set: true, bot_username: 'my_bot', token_masked: '••••••x9Zq', chat_set: false, polling: false }
        return tg.state
      },
      telegramPair: async () => {
        tg.state = { ...tg.state, pairing: { code: '482913', link: 'https://t.me/my_bot?start=482913', expires_ms: Date.now() + 600_000 } }
        return tg.state
      },
    },
  }
})

describe('TelegramBotFields', () => {
  it('shows Telegram’s refusal of a token and keeps nothing', async () => {
    tg.refuse = 'Telegram does not recognise this token. Copy it again from @BotFather'
    tg.state = { bot_set: false, chat_set: false, polling: false }
    render(<TelegramBotFields onSaved={() => {}} />)
    fireEvent.change(await screen.findByLabelText('Bot token'), { target: { value: '1:bad' } })
    fireEvent.click(screen.getByText('Connect'))
    await waitFor(() => expect(screen.getByText(/does not recognise this token/)).toBeInTheDocument())
    expect(tg.tokens).toEqual(['1:bad'])
  })

  it('goes from a checked token straight to a pairing code with a one-tap link', async () => {
    tg.refuse = ''
    tg.tokens = []
    tg.state = { bot_set: false, chat_set: false, polling: false }
    const saved = vi.fn()
    render(<TelegramBotFields onSaved={saved} />)
    fireEvent.change(await screen.findByLabelText('Bot token'), { target: { value: ' 123:ok ' } })
    fireEvent.click(screen.getByText('Connect'))
    expect(await screen.findByLabelText('Pairing code')).toHaveTextContent('482913')
    expect(screen.getByText('Open @my_bot').closest('a')).toHaveAttribute('href', 'https://t.me/my_bot?start=482913')
    expect(screen.getByText('/start 482913')).toBeInTheDocument()
    // Steps 1 and 2 have ticked; 3 waits for the code.
    expect(screen.getByLabelText('Step 1, done')).toBeInTheDocument()
    expect(screen.getByLabelText('Step 2, done')).toBeInTheDocument()
    expect(screen.getByLabelText('Step 3')).toBeInTheDocument()
    expect(tg.tokens).toEqual(['123:ok'])
    expect(saved).toHaveBeenCalled()
    // The token is gone from the page; only its mask is shown.
    expect(screen.queryByDisplayValue(/123:ok/)).toBeNull()
    expect(screen.getByText('••••••x9Zq')).toBeInTheDocument()
  })

  it('Paste reads the clipboard and connects a whole token at once', async () => {
    tg.refuse = ''
    tg.tokens = []
    tg.state = { bot_set: false, chat_set: false, polling: false }
    // A made-up token of the right shape, never a real one.
    const fake = '1234567:FAKEfakeFAKEfakeFAKEfakeFAKEfake_-12'
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => fake } })
    try {
      render(<TelegramBotFields onSaved={() => {}} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Paste' }))
      expect(await screen.findByLabelText('Pairing code')).toHaveTextContent('482913')
      expect(tg.tokens).toEqual([fake])
    } finally {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    }
  })

  it('names the paired chat, and says a hand-typed one cannot answer back', async () => {
    tg.state = { bot_set: true, bot_username: 'my_bot', chat_set: true, chat_name: 'Dima', polling: true }
    const { unmount } = render(<TelegramBotFields onSaved={() => {}} />)
    expect(await screen.findByText('Dima')).toBeInTheDocument()
    expect(screen.getByText('@my_bot')).toBeInTheDocument()
    // One line, real buttons; the keychain paragraph is behind the (i).
    for (const name of ['Change bot', 'Pair again', 'Disconnect']) expect(screen.getByRole('button', { name })).toBeInTheDocument()
    expect(screen.queryByText(/keychain/i)).toBeNull()
    expect(screen.getByRole('button', { name: 'How the bot token is kept' })).toBeInTheDocument()
    // Change bot opens the card with the paste field.
    fireEvent.click(screen.getByRole('button', { name: 'Change bot' }))
    expect(screen.getByText('Change the bot')).toBeInTheDocument()
    expect(screen.getByLabelText('Bot token')).toBeInTheDocument()
    unmount()
    tg.state = { bot_set: true, chat_set: true, manual_chat: true, polling: false }
    render(<TelegramBotFields onSaved={() => {}} />)
    expect(await screen.findByText(/typed in by hand/)).toBeInTheDocument()
  })
})
