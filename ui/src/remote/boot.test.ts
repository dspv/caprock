import { beforeEach, describe, expect, it } from 'vitest'
import { DEVICE_TOKEN_KEY, currentMachine, forDaemon, forgetMachine, machines, parsePairLink, prepare, relayAllowed, selectMachine } from './boot'

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
})
