import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEVICE_TOKEN_KEY, abandonPairing, currentMachine, forDaemon, forgetMachine, keepStorage, machines, notPairedHere, parsePairLink, prepare, relayAllowed, selectMachine } from './boot'

const id = 'a'.repeat(43)
const key = 'b'.repeat(43)
const link = (extra = '') => `#/pair?r=${encodeURIComponent('wss://relay.example')}&h=${id}&k=${key}&c=123456&n=Mac%20mini${extra}`

function fakeLocation(hash: string) {
  const loc = { hash, pathname: '/' } as Location
  const hist = {
    replaceState: (_s: unknown, _t: string, url: string) => {
      loc.hash = url.slice(url.indexOf('#'))
    },
  } as unknown as History
  return { loc, hist }
}

describe('the pairing link', () => {
  it('names the relay, the machine, its key, the code and the name', () => {
    expect(parsePairLink(link())).toEqual({
      machine: { id, key, relay: 'wss://relay.example', name: 'Mac mini', token: '' },
      code: '123456',
    })
  })
  it('refuses anything that is not a machine id and key', () => {
    expect(parsePairLink(`#/pair?r=wss://x&h=short&k=${key}`)).toBeNull()
    expect(parsePairLink('#/pair?code=123456')).toBeNull()
    expect(parsePairLink('#/now')).toBeNull()
  })
  it('refuses a relay in clear text off this device', () => {
    expect(relayAllowed('wss://relay.example')).toBe(true)
    expect(relayAllowed('ws://127.0.0.1:8787')).toBe(true)
    expect(relayAllowed('ws://relay.example')).toBe(false)
    expect(relayAllowed('https://relay.example')).toBe(false)
    expect(parsePairLink(`#/pair?r=${encodeURIComponent('ws://relay.example')}&h=${id}&k=${key}`)).toBeNull()
  })
})

describe('what goes through the channel', () => {
  const origin = 'https://m.caprock.dev'
  it('is the daemon API and nothing else', () => {
    expect(forDaemon('/v1/sessions', origin)).toBe(true)
    expect(forDaemon('https://m.caprock.dev/v1/live', origin)).toBe(true)
    expect(forDaemon('/healthz', origin)).toBe(true)
    expect(forDaemon('/x/alpha/index.js', origin)).toBe(true) // a private module's file, for its frame
    expect(forDaemon('https://example.com/x/alpha/', origin)).toBe(false)
    expect(forDaemon('/assets/index.js', origin)).toBe(false)
    expect(forDaemon('https://example.com/v1/sessions', origin)).toBe(false)
  })
})

describe('machines on this phone', () => {
  beforeEach(() => localStorage.clear())

  it('a pairing link adds the machine, clears any token, and hands the code to the pairing screen', () => {
    localStorage.setItem(DEVICE_TOKEN_KEY, 'old')
    const { loc, hist } = fakeLocation(link())
    const m = prepare(loc, hist)
    expect(m?.name).toBe('Mac mini')
    expect(loc.hash).toBe('#/pair?code=123456')
    expect(localStorage.getItem(DEVICE_TOKEN_KEY)).toBeNull()
  })

  it('keeps the token the pairing screen stored, for that machine', () => {
    const first = fakeLocation(link())
    prepare(first.loc, first.hist)
    localStorage.setItem(DEVICE_TOKEN_KEY, 'tok-1') // what Pair.tsx does, then reloads
    const again = fakeLocation('#/')
    prepare(again.loc, again.hist)
    expect(currentMachine()?.token).toBe('tok-1')
  })

  it('switching machines swaps the token the dashboard sends', () => {
    const a = fakeLocation(link())
    prepare(a.loc, a.hist)
    localStorage.setItem(DEVICE_TOKEN_KEY, 'tok-a')
    prepare(fakeLocation('#/').loc, fakeLocation('#/').hist)
    const otherId = 'c'.repeat(43)
    const b = fakeLocation(`#/pair?r=${encodeURIComponent('wss://relay.example')}&h=${otherId}&k=${key}&c=654321&n=Laptop`)
    prepare(b.loc, b.hist)
    localStorage.setItem(DEVICE_TOKEN_KEY, 'tok-b')
    prepare(fakeLocation('#/').loc, fakeLocation('#/').hist)
    expect(machines().map((m) => [m.name, m.token])).toEqual([
      ['Mac mini', 'tok-a'],
      ['Laptop', 'tok-b'],
    ])
    selectMachine(id)
    expect(localStorage.getItem(DEVICE_TOKEN_KEY)).toBe('tok-a')
    forgetMachine(id)
    expect(machines().map((m) => m.name)).toEqual(['Laptop'])
    expect(localStorage.getItem(DEVICE_TOKEN_KEY)).toBe('tok-b')
  })

  it('a pairing link opened again (its code already spent) does not cost the pairing that worked', () => {
    const a = fakeLocation(link())
    prepare(a.loc, a.hist)
    localStorage.setItem(DEVICE_TOKEN_KEY, 'tok-1')
    prepare(fakeLocation('#/').loc, fakeLocation('#/').hist)
    // The same QR, opened a second time: the dashboard sends no token while
    // it redeems the code…
    const again = fakeLocation(link())
    prepare(again.loc, again.hist)
    expect(localStorage.getItem(DEVICE_TOKEN_KEY)).toBeNull()
    // …the code is refused and the page is opened again: the old token is back.
    prepare(fakeLocation('#/').loc, fakeLocation('#/').hist)
    expect(localStorage.getItem(DEVICE_TOKEN_KEY)).toBe('tok-1')
    expect(currentMachine()?.token).toBe('tok-1')
  })

  it('pairing again that succeeds replaces the token', () => {
    const a = fakeLocation(link())
    prepare(a.loc, a.hist)
    localStorage.setItem(DEVICE_TOKEN_KEY, 'tok-1')
    prepare(fakeLocation('#/').loc, fakeLocation('#/').hist)
    const again = fakeLocation(link())
    prepare(again.loc, again.hist)
    localStorage.setItem(DEVICE_TOKEN_KEY, 'tok-2')
    prepare(fakeLocation('#/').loc, fakeLocation('#/').hist)
    expect(currentMachine()?.token).toBe('tok-2')
    prepare(fakeLocation('#/').loc, fakeLocation('#/').hist)
    expect(localStorage.getItem(DEVICE_TOKEN_KEY)).toBe('tok-2')
  })

  /** The page as it is after a pairing that worked: a record with the token, the token where the dashboard reads it. */
  function paired(token = 'tok-1') {
    const a = fakeLocation(link())
    prepare(a.loc, a.hist)
    localStorage.setItem(DEVICE_TOKEN_KEY, token)
    prepare(fakeLocation('#/').loc, fakeLocation('#/').hist)
  }

  it('reloads, a page opened with no hash, and a home-screen start keep the pairing', () => {
    paired()
    for (const hash of ['#/', '', '#/?open=chat', '#/pair?code=123456']) {
      const l = fakeLocation(hash)
      prepare(l.loc, l.hist)
      expect(localStorage.getItem(DEVICE_TOKEN_KEY)).toBe('tok-1')
      expect(currentMachine()?.token).toBe('tok-1')
    }
  })

  it('a record from an older page, with the token only where the dashboard reads it, takes the token', () => {
    localStorage.setItem('caprock.remote.machines', JSON.stringify([{ id, key, relay: 'wss://relay.example', name: 'Mac mini' }]))
    localStorage.setItem('caprock.remote.current', id)
    localStorage.setItem(DEVICE_TOKEN_KEY, 'tok-old')
    prepare(fakeLocation('#/').loc, fakeLocation('#/').hist)
    expect(currentMachine()?.token).toBe('tok-old')
    expect(localStorage.getItem(DEVICE_TOKEN_KEY)).toBe('tok-old')
    // …and keeps it once the dashboard's copy is gone.
    localStorage.removeItem(DEVICE_TOKEN_KEY)
    prepare(fakeLocation('#/').loc, fakeLocation('#/').hist)
    expect(localStorage.getItem(DEVICE_TOKEN_KEY)).toBe('tok-old')
  })

  it('a link with no code to redeem leaves a paired phone paired', () => {
    paired()
    const l = fakeLocation(link().replace('&c=123456', ''))
    prepare(l.loc, l.hist)
    expect(l.loc.hash).toBe('#/')
    expect(localStorage.getItem(DEVICE_TOKEN_KEY)).toBe('tok-1')
    expect(localStorage.getItem('caprock.remote.pairing')).toBeNull()
  })

  it('a code the machine refuses goes back to the pairing that worked, at once', () => {
    paired()
    const again = fakeLocation(link())
    prepare(again.loc, again.hist)
    expect(localStorage.getItem(DEVICE_TOKEN_KEY)).toBeNull()
    expect(abandonPairing()).toBe(true)
    expect(localStorage.getItem(DEVICE_TOKEN_KEY)).toBe('tok-1')
    expect(abandonPairing()).toBe(false)
  })

  it('a first pairing whose code is refused has nothing to go back to', () => {
    const a = fakeLocation(link())
    prepare(a.loc, a.hist)
    expect(abandonPairing()).toBe(false)
  })

  // Vova, 2026-10-15 (translated): "yesterday I opened the phone app, then
  // closed the tab … today I want to open the app again but I don't remember
  // the link". The address alone is the way back: the token is on this
  // origin, on the machine's record, and nothing in the address is needed.
  it('the next day, the plain address reconnects without pairing again', () => {
    paired()
    localStorage.removeItem(DEVICE_TOKEN_KEY) // whatever the dashboard's copy did
    const l = fakeLocation('')
    const m = prepare(l.loc, l.hist)
    expect(m?.id).toBe(id)
    expect(localStorage.getItem(DEVICE_TOKEN_KEY)).toBe('tok-1')
    expect(notPairedHere(m)).toBe(false)
  })

  it('a machine with no token here, and no pairing under way, is "not paired here"', () => {
    localStorage.setItem('caprock.remote.machines', JSON.stringify([{ id, key, relay: 'wss://relay.example', name: 'Mac mini', token: '' }]))
    localStorage.setItem('caprock.remote.current', id)
    const m = prepare(fakeLocation('').loc, fakeLocation('').hist)
    expect(notPairedHere(m)).toBe(true)
    expect(notPairedHere(undefined)).toBe(false)
  })

  it('a phone redeeming a code is not "not paired here"', () => {
    const a = fakeLocation(link())
    const m = prepare(a.loc, a.hist)
    expect(m?.token).toBe('')
    expect(notPairedHere(m)).toBe(false)
  })
})

describe('keepStorage', () => {
  it('asks the browser to keep this origin\'s storage, and survives a browser without it', () => {
    const persist = vi.fn(() => Promise.resolve(true))
    keepStorage({ storage: { persist } } as unknown as Navigator)
    expect(persist).toHaveBeenCalledOnce()
    expect(() => keepStorage({} as Navigator)).not.toThrow()
    expect(() => keepStorage(undefined)).not.toThrow()
  })

  it('is asked once a pairing completes', () => {
    localStorage.clear()
    const persist = vi.fn(() => Promise.resolve(true))
    vi.stubGlobal('navigator', { ...navigator, storage: { persist } })
    try {
      const a = fakeLocation(link())
      prepare(a.loc, a.hist)
      localStorage.setItem(DEVICE_TOKEN_KEY, 'tok-1')
      prepare(fakeLocation('#/').loc, fakeLocation('#/').hist)
      expect(persist).toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
