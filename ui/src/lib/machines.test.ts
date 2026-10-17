import { afterEach, describe, expect, it, vi } from 'vitest'
import { machineLook, machinesApi, type Machine } from './machines'
import { installMachineProxy, machinePageId, machinePageURL, rewriteForMachine } from './machinepage'

const ID = 'f7kc4QaG4HRPYEjg19Pr-au-FeTljmKHkikFrAmRTzM'
const base: Machine = { id: ID, name: 'Mac mini', relay: 'wss://relay.example', added_at: 1, status: 'online', kind: 'machine', role: 'controller', streams: 0 }

describe('the machine page sends /v1/… to the other computer (ADR-067)', () => {
  const origin = 'http://127.0.0.1:22776'

  it('rewrites the daemon’s API, its sockets included, and nothing else', () => {
    expect(rewriteForMachine('/v1/sessions?active=true', ID, origin)).toBe(`${origin}/v1/m/${ID}/v1/sessions?active=true`)
    expect(rewriteForMachine(`${origin}/healthz`, ID, origin)).toBe(`${origin}/v1/m/${ID}/healthz`)
    expect(rewriteForMachine('ws://127.0.0.1:22776/v1/agents/s1/term', ID, origin)).toBe(`ws://127.0.0.1:22776/v1/m/${ID}/v1/agents/s1/term`)
    expect(rewriteForMachine('ws://127.0.0.1:22776/v1/live?since=4', ID, origin)).toBe(`ws://127.0.0.1:22776/v1/m/${ID}/v1/live?since=4`)
    // The page's own files, another host, and a path already a computer's.
    expect(rewriteForMachine('/assets/index.js', ID, origin)).toBeNull()
    expect(rewriteForMachine('https://caprock.dev/v1/x', ID, origin)).toBeNull()
    expect(rewriteForMachine(`/v1/m/${ID}/v1/sessions`, ID, origin)).toBeNull()
  })

  it('reads the computer from the address, and only a well-formed id', () => {
    expect(machinePageId(`?machine=${ID}`)).toBe(ID)
    expect(machinePageId('?machine=../../x')).toBe('')
    expect(machinePageId('')).toBe('')
    expect(machinePageURL(ID, 's 1', 'terminal')).toBe(`/?machine=${ID}#/session/s%201?tab=terminal`)
  })

  it('patches fetch and WebSocket of the page it is installed on', async () => {
    const seen: string[] = []
    const sockets: string[] = []
    class FakeWS { constructor(url: string | URL) { sockets.push(String(url)) } }
    const w = {
      location: { origin },
      fetch: (input: RequestInfo | URL) => { seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); return Promise.resolve(new Response('{}')) },
      WebSocket: FakeWS,
    } as unknown as Window & typeof globalThis
    installMachineProxy(ID, w)
    await w.fetch('/v1/sessions')
    await w.fetch('/index.html')
    new w.WebSocket('ws://127.0.0.1:22776/v1/agents/s1/term')
    expect(seen).toEqual([`${origin}/v1/m/${ID}/v1/sessions`, '/index.html'])
    expect(sockets).toEqual([`ws://127.0.0.1:22776/v1/m/${ID}/v1/agents/s1/term`])
  })
})

describe('machineLook says how a computer stands and what to do', () => {
  it('names each state', () => {
    expect(machineLook(base)).toMatchObject({ label: 'online', tone: 'ok', reachable: true })
    expect(machineLook({ ...base, status: 'idle' })).toMatchObject({ label: 'linked', reachable: true })
    expect(machineLook({ ...base, status: 'pending' })).toMatchObject({ label: 'waiting for Allow', reachable: false })
    expect(machineLook({ ...base, status: 'pending' }).detail).toContain('caprock machines allow')
    expect(machineLook({ ...base, status: 'revoked' })).toMatchObject({ label: 'removed there', tone: 'bad', reachable: false })
    expect(machineLook({ ...base, status: 'refused' })).toMatchObject({ label: 'refused', reachable: false })
    expect(machineLook({ ...base, status: 'offline', error: 'the computer is offline' }).detail).toContain('not at its relay')
    expect(machineLook({ ...base, status: 'offline', error: 'could not reach the relay: dial tcp 127.0.0.1:1: connection refused' }).detail).toBe('The relay could not be reached: this computer is off the internet, or the relay is down.')
  })

  it('says a computer from before PR2 needs an update for full control', () => {
    const look = machineLook({ ...base, kind: undefined, role: 'viewer' })
    expect(look.tone).toBe('warn')
    expect(look.detail).toContain('Update Caprock on Mac mini')
  })
})

describe('machinesApi', () => {
  afterEach(() => vi.restoreAllMocks())

  it('sends a JSON content type with every change, a DELETE included', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"forgotten":true,"released":true}'))
    await machinesApi.forget(ID)
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe(`/v1/machines/${ID}`)
    expect(init?.method).toBe('DELETE')
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('asks a computer’s sessions through the proxy', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]'))
    await machinesApi.sessions(ID)
    expect(f.mock.calls[0]![0]).toBe(`/v1/m/${ID}/v1/sessions?active=true&chats=exclude&limit=50`)
    expect((f.mock.calls[0]![1]?.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })
})
