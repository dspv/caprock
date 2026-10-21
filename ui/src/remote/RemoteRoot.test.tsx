/**
 * The phone's page says what is wrong and what to do, never a bare
 * "Connecting…" (owner, 2026-10-14), and offers the app once.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listenForInstall } from './install'
import RemoteRoot, { barLabel, detailRows, EXPLAIN_AFTER_MS, explain } from './RemoteRoot'
import { BACKOFF_MS } from './transport'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('the words for each cause', () => {
  it('names the computer, the relay and the next step', () => {
    expect(explain('computer', 'machine-offline', 'Mac mini', 'wss://relay.caprock.dev').title).toBe('Your computer isn’t answering')
    expect(explain('computer', 'machine-offline', 'Mac mini', 'wss://relay.caprock.dev').body).toContain('Mac mini is not connected')
    expect(explain('computer', 'no-answer', 'Mac mini', '').body).toContain('asleep')
    expect(explain('offline', 'no-internet', 'Mac mini', '').title).toBe('No internet on this phone')
    expect(explain('offline', 'no-internet', 'Mac mini', '').body).toBe('Reconnects by itself when the network is back.')
    expect(explain('unpaired', 'removed', 'Mac mini', '').title).toBe('This phone was removed')
    expect(explain('unpaired', 'removed', 'Mac mini', '').body).toContain('Settings → Use on your phone')
    expect(explain('unpaired', 'wrong-machine', 'Mac mini', '').title).toBe('Pair this phone again')
  })
  it('never says pair again for a network problem', () => {
    for (const cause of ['offline', 'relay', 'computer', 'reconnecting'] as const) {
      const e = explain(cause, '', 'Mac mini', 'wss://relay.caprock.dev')
      expect(`${e.title} ${e.body}`.toLowerCase()).not.toContain('pair')
    }
  })
  it('keeps the bar short, and says "Connecting…" only while an attempt is under way', () => {
    expect(barLabel('open', '')).toBe('')
    expect(barLabel('connecting', 'machine-offline')).toBe('Connecting…')
    expect(barLabel('offline', 'machine-offline')).toBe('Computer offline')
    expect(barLabel('open', 'removed')).toBe('Removed: pair again')
    expect(barLabel('connecting', 'lost', false)).toBe('No internet')
  })
})

describe('the first screen', () => {
  it('offers to install the app when Chrome says it can be installed', async () => {
    listenForInstall(window)
    window.dispatchEvent(
      Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
        prompt: async () => {},
        userChoice: Promise.resolve({ outcome: 'dismissed' as const }),
      }),
    )
    render(<RemoteRoot />)
    expect(await screen.findByRole('button', { name: 'Install the Caprock app' })).toBeTruthy()
  })
})

// Vova, 2026-10-15 (translated): "the link doesn't load; maybe it's some
// restrictions, my VPN isn't working well right now". Each failure has its
// own fix, said in so many words.
describe('the failures a person can act on', () => {
  it('cannot reach the relay: names both addresses and the VPN', () => {
    const e = explain('relay', 'relay-unreachable', 'Mac mini', 'wss://relay.caprock.dev', 'm.caprock.dev')
    expect(e.title).toBe('Can’t reach the relay')
    expect(e.body).toContain('relay.caprock.dev / m.caprock.dev')
    expect(e.body).toContain('VPN')
  })
  it('the relay answers, the computer is not there', () => {
    const e = explain('computer', 'machine-offline', 'Mac mini', 'wss://relay.caprock.dev', 'm.caprock.dev')
    expect(e.body).toContain('The relay is reachable')
    expect(e.body).not.toContain('VPN')
  })
})

describe('Details', () => {
  it('lists the last error with its code and times, or dashes before anything happened', () => {
    const t = new Date(2026, 9, 15, 9, 30, 5).getTime()
    const rows = Object.fromEntries(
      detailRows({ lastError: { problem: 'machine-offline', reason: 'offline', code: 4404, at: t }, lastAttemptAt: t, lastOpenAt: null, attempt: 3 }, 'wss://relay.caprock.dev', 'm.caprock.dev', t),
    )
    expect(rows['Last error']).toBe('machine-offline: offline (code 4404)')
    expect(rows['Relay']).toBe('wss://relay.caprock.dev')
    expect(rows['Page']).toBe('m.caprock.dev')
    expect(rows['Last connected']).toBe('not since the page loaded')
    expect(rows['Tries since']).toBe('3')
    expect(rows['Error at']).toMatch(/30/)
    const none = Object.fromEntries(detailRows(null, '', '', t))
    expect(none['Last error']).toBe('—')
  })
})

const id = 'a'.repeat(43)
const key = 'b'.repeat(43)

/** A relay socket that closes as the test says, once the page dials it. */
function stubRelay(close: { code: number; open: boolean }) {
  class Sock {
    readyState = 0
    binaryType = 'blob'
    onopen: (() => void) | null = null
    onmessage: (() => void) | null = null
    onclose: ((e: { code: number; reason: string }) => void) | null = null
    onerror: (() => void) | null = null
    constructor() {
      setTimeout(() => {
        if (close.open) this.onopen?.()
        this.readyState = 3
        this.onclose?.({ code: close.code, reason: '' })
      }, 10)
    }
    send() {}
    close() {}
  }
  vi.stubGlobal('WebSocket', Sock)
}

function storeMachine(token: string) {
  localStorage.setItem('caprock.remote.machines', JSON.stringify([{ id, key, relay: 'wss://relay.caprock.dev', name: 'Mac mini', token }]))
  localStorage.setItem('caprock.remote.current', id)
  if (token) localStorage.setItem('caprock.device.token', token)
}

/** The page's own origin answers (a network) or not (none at all). */
function pageAnswers(ok: boolean) {
  vi.stubGlobal('fetch', () => (ok ? Promise.resolve(new Response(null)) : Promise.reject(new TypeError('Failed to fetch'))))
}

async function freshRoot() {
  vi.resetModules()
  return (await import('./RemoteRoot')).default
}

describe('the page, opened again', () => {
  it('with nothing stored, says this browser is not paired and where to pair, before the steps', () => {
    render(<RemoteRoot />)
    const note = screen.getByTestId('not-paired-here')
    expect(note.textContent).toContain('This browser isn’t paired')
    expect(note.textContent).toContain('Caprock → Settings → Use on your phone → Connect a phone')
  })

  it('knowing the machine but holding no token, says exactly that instead of an error', async () => {
    stubRelay({ code: 4404, open: true })
    storeMachine('')
    const Root = await freshRoot()
    render(<Root />)
    const box = screen.getByTestId('not-paired-here')
    expect(box.textContent).toContain('This browser isn’t paired')
    expect(box.textContent).toContain('Settings → Use on your phone → Connect a phone')
    expect(screen.queryByTestId('connection-problem')).toBeNull()
  })

  it('a relay it cannot reach is said so, with Details, once it has been down a while', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    stubRelay({ code: 1006, open: false })
    pageAnswers(true)
    storeMachine('tok')
    const Root = await freshRoot()
    render(<Root />)
    await act(async () => {
      vi.advanceTimersByTime(EXPLAIN_AFTER_MS + 1500)
    })
    const card = screen.getByTestId('connection-problem')
    expect(card.dataset.cause).toBe('relay')
    expect(card.textContent).toContain('Can’t reach the relay')
    expect(card.textContent).toContain('VPN')
    expect(screen.getByTestId('connection-details').textContent).toContain('relay-unreachable')
    expect(screen.queryByRole('button', { name: 'Pair again' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeTruthy()
  })

  it('a relay that answers without the computer says the computer is not answering, and never pair again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    stubRelay({ code: 4404, open: true })
    storeMachine('tok')
    const Root = await freshRoot()
    render(<Root />)
    await act(async () => {
      vi.advanceTimersByTime(EXPLAIN_AFTER_MS + 1500)
    })
    const card = screen.getByTestId('connection-problem')
    expect(card.dataset.cause).toBe('computer')
    expect(card.textContent).toContain('Your computer isn’t answering')
    expect(screen.getByTestId('retry-line').textContent).toMatch(/^(Trying now…|Next try in \d+ s · attempt \d+)$/)
    expect(screen.getByTestId('connection-details').textContent).toContain('code 4404')
    expect(screen.queryByRole('button', { name: 'Pair again' })).toBeNull()
  })

  it('a phone with no network says so at once, large, with the next try and no pair again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    stubRelay({ code: 1006, open: false })
    storeMachine('tok')
    const Root = await freshRoot()
    render(<Root />)
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    const card = screen.getByTestId('connection-problem')
    expect(card.dataset.cause).toBe('offline')
    expect(card.querySelector('h1')?.textContent).toBe('No internet on this phone')
    expect(card.textContent).toContain('Reconnects by itself when the network is back.')
    expect(screen.getByTestId('retry-line').textContent).toMatch(/Next try in \d+ s · attempt 2/)
    expect(screen.queryByRole('button', { name: 'Pair again' })).toBeNull()
  })

  it('a relay that is down while nothing else answers either is no internet, not the relay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    stubRelay({ code: 1006, open: false })
    pageAnswers(false)
    storeMachine('tok')
    const Root = await freshRoot()
    render(<Root />)
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    expect(screen.getByTestId('connection-problem').dataset.cause).toBe('offline')
  })

  it('offers Pair again only once the computer has refused this phone, with the reason', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    // The machine hangs up on the handshake: a computer whose keys changed.
    stubRelay({ code: 1000, open: true })
    storeMachine('tok')
    const Root = await freshRoot()
    render(<Root />)
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    // One refusal is a computer restarting, not a verdict.
    expect(screen.queryByRole('button', { name: 'Pair again' })).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]! + BACKOFF_MS[1]! + 500)
    })
    const card = screen.getByTestId('connection-problem')
    expect(card.dataset.cause).toBe('unpaired')
    expect(card.textContent).toContain('its keys are not the ones this phone paired with')
    expect(screen.getByRole('button', { name: 'Pair again' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry now' })).toBeNull()
  })
})
