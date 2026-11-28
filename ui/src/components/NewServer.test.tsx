import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { NewServer, checkLine, ownServerState } from './NewServer'
import { JOIN_POLL_MS } from './JoinKey'
import { joinApi, MAC_SERVER_ISSUE, serverApi, SERVER_PROVIDERS, SERVER_SYSTEMS, type Machine, type ServerScript } from '@/lib/machines'
import * as router from '@/lib/router'

const SCRIPT = "#!/bin/sh\n# Caprock server setup (ADR-109)\nCAPROCK_JOIN_KEY='cj1-test'\n"
const server: Machine = { id: 'srv1', name: 'hetzner-1', relay: 'wss://relay.caprock.dev', added_at: 1, status: 'online', kind: 'machine', role: 'controller', streams: 0 }

function made(over: Partial<ServerScript> = {}): ServerScript {
  return { state: 'waiting', server: true, expires_at: Date.now() + 60 * 60_000, relay: 'wss://relay.caprock.dev', relay_status: 'online', script: SCRIPT, version: '0.201.0', signed: true, ...over }
}

async function openAndMake(sshKey = false) {
  render(<NewServer />)
  fireEvent.click(screen.getByRole('button', { name: 'New server' }))
  if (sshKey) fireEvent.click(document.querySelector('[data-new-server-ssh]')!)
  fireEvent.click(screen.getByRole('button', { name: 'Make the script' }))
  await screen.findByRole('button', { name: 'Copy script' })
}

describe('New server (ADR-109)', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows the script in full, where each provider takes it, the countdown and the SSH choice it was made with', async () => {
    const make = vi.spyOn(serverApi, 'make').mockResolvedValue(made())
    await openAndMake(true)
    expect(make).toHaveBeenCalledWith(true)
    expect(document.querySelector('[data-new-server-script]')!.textContent).toBe(SCRIPT)
    const providers = document.querySelector('[data-new-server-providers]')!.textContent!
    for (const p of SERVER_PROVIDERS) {
      expect(providers).toContain(p.name)
      expect(providers).toContain(p.field)
    }
    expect(providers).toContain('sudo sh caprock-setup.sh')
    expect(document.querySelector('[data-new-server-left]')!.textContent).toContain('60 more min')
    expect(document.querySelector('[data-new-server-line]')!.textContent).toContain('Waiting for the server')
    expect(document.body.textContent).toContain('checked by its signature and its SHA-256')
    // No price on the screen: the links go to the providers' own pages.
    expect(document.body.textContent).not.toMatch(/[€$]\s?\d/)
  })

  it('copies the whole script', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    vi.spyOn(serverApi, 'make').mockResolvedValue(made())
    await openAndMake()
    fireEvent.click(screen.getByRole('button', { name: 'Copy script' }))
    expect(writeText).toHaveBeenCalledWith(SCRIPT)
    await screen.findByRole('button', { name: 'Copied' })
  })

  it('opens the server page once it joined', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const nav = vi.spyOn(router, 'navigate').mockImplementation(() => {})
    vi.spyOn(serverApi, 'make').mockResolvedValue(made())
    vi.spyOn(joinApi, 'state').mockResolvedValue({ state: 'joined', server: true, machine: server })
    await openAndMake()
    await act(async () => { await vi.advanceTimersByTimeAsync(JOIN_POLL_MS + 10) })
    await vi.waitFor(() => expect(nav).toHaveBeenCalledWith({ name: 'machine', id: server.id, joined: true }))
  })

  it('withdraws the key on Cancel and forgets the script', async () => {
    vi.spyOn(serverApi, 'make').mockResolvedValue(made())
    const withdraw = vi.spyOn(joinApi, 'withdraw').mockResolvedValue({ withdrawn: true })
    await openAndMake()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(withdraw).toHaveBeenCalled()
    await screen.findByRole('button', { name: 'New server' })
    expect(document.body.textContent).not.toContain('cj1-test')
  })

  it('offers a filled-in GitHub issue for a Mac server, with nothing about the user in it', () => {
    render(<NewServer />)
    fireEvent.click(screen.getByRole('button', { name: 'New server' }))
    expect(document.body.textContent).toContain(SERVER_SYSTEMS)
    const link = screen.getByRole('link', { name: 'Ask for it' })
    const url = new URL(link.getAttribute('href')!)
    expect(url.origin + url.pathname).toBe('https://github.com/dspv/caprock/issues/new')
    expect(url.searchParams.get('title')).toBe('New server: set up a Mac server')
    expect(url.searchParams.get('body')).toContain('Mac')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('href')).toBe(MAC_SERVER_ISSUE)
  })

  it('says why no script was made', async () => {
    vi.spyOn(serverApi, 'make').mockRejectedValue(new Error('could not read the release to install: HTTP 503'))
    render(<NewServer />)
    fireEvent.click(screen.getByRole('button', { name: 'New server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Make the script' }))
    expect((await screen.findByRole('alert')).textContent).toContain('HTTP 503')
  })

  it('reads a key of the other kind as its own withdrawn, and words the archive check', () => {
    expect(ownServerState({ state: 'waiting' })).toEqual({ state: 'none' })
    expect(ownServerState({ state: 'waiting', server: true }).state).toBe('waiting')
    expect(checkLine({ version: '0.201.0', signed: false })).toContain('SHA-256 before anything runs (this release')
  })
})
