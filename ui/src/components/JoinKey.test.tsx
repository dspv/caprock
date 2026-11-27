import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AddWithKey, JOIN_POLL_MS, JoinWithKey, joinLine } from './JoinKey'
import { ApiError } from '@/lib/api'
import { INSTALL_COMMANDS, joinApi, joinError, type Machine } from '@/lib/machines'
import * as router from '@/lib/router'

const KEY = 'cj1-AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4_QEFCQ0RFRkdISUpLTE1OT1BR'
const pc: Machine = { id: 'f7kc4QaG4HRPYEjg19Pr-au-FeTljmKHkikFrAmRTzM', name: 'Home PC', relay: 'wss://relay.caprock.dev', added_at: 1, status: 'online', kind: 'machine', role: 'controller', streams: 0 }

describe('join keys (ADR-108)', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows the key once with the command, where to paste it, the install commands and what the relay sees', async () => {
    vi.spyOn(joinApi, 'make').mockResolvedValue({ state: 'waiting', expires_at: Date.now() + 15 * 60_000, relay: 'wss://relay.caprock.dev', relay_status: 'online', key: KEY })
    render(<AddWithKey />)
    fireEvent.click(screen.getByRole('button', { name: 'Add with a key' }))
    await screen.findByText(`$ caprock join ${KEY}`)
    expect(document.querySelector('[data-join-key-value]')!.textContent).toBe(KEY)
    const install = document.querySelector('[data-join-install]')!.textContent!
    for (const c of INSTALL_COMMANDS) expect(install).toContain(c.command)
    expect(document.body.textContent).toContain('Join with a key')
    expect(document.querySelector('[data-join-key-line]')!.textContent).toBe('Waiting for the new computer…')
    expect(document.querySelector('[data-join-key-left]')!.textContent).toContain('15 more min')
    expect(document.querySelector('[data-join-key-safe]')!.textContent).toContain('relay.caprock.dev')
    expect(document.querySelector('[data-join-key-safe]')!.textContent).toContain('no secrets')
  })

  it('opens the computer page once it joined, and nothing else', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const nav = vi.spyOn(router, 'navigate').mockImplementation(() => {})
    vi.spyOn(joinApi, 'make').mockResolvedValue({ state: 'waiting', expires_at: Date.now() + 60_000, relay_status: 'online', key: KEY })
    const state = vi.spyOn(joinApi, 'state').mockResolvedValue({ state: 'joined', machine: pc })
    render(<AddWithKey />)
    fireEvent.click(screen.getByRole('button', { name: 'Add with a key' }))
    await screen.findByText(`$ caprock join ${KEY}`)
    await act(async () => { await vi.advanceTimersByTimeAsync(JOIN_POLL_MS + 10) })
    expect(state).toHaveBeenCalled()
    await vi.waitFor(() => expect(nav).toHaveBeenCalledWith({ name: 'machine', id: pc.id, joined: true }))
    // The key is gone from the screen once it is spent.
    expect(document.querySelector('[data-join-key-value]')).toBeNull()
  })

  it('withdraws the key on Cancel', async () => {
    vi.spyOn(joinApi, 'make').mockResolvedValue({ state: 'waiting', expires_at: Date.now() + 60_000, relay_status: 'online', key: KEY })
    const withdraw = vi.spyOn(joinApi, 'withdraw').mockResolvedValue({ withdrawn: true })
    render(<AddWithKey />)
    fireEvent.click(screen.getByRole('button', { name: 'Add with a key' }))
    await screen.findByText(`$ caprock join ${KEY}`)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(withdraw).toHaveBeenCalled()
    await screen.findByRole('button', { name: 'Add with a key' })
    expect(document.body.textContent).not.toContain(KEY)
  })

  it('words each state', () => {
    expect(joinLine({ state: 'waiting', relay: 'wss://relay.example.org', relay_status: 'connecting' })).toBe('Connecting to relay.example.org…')
    expect(joinLine({ state: 'joining', joiner: 'Home PC' })).toContain('Home PC has the key')
    expect(joinLine({ state: 'expired' })).toContain('expired')
    expect(joinLine({ state: 'failed', error: 'too many wrong keys were tried: make a new one' })).toContain('too many wrong keys')
  })

  it('joins on the new computer and says what it did and what is next', async () => {
    const join = vi.spyOn(joinApi, 'join').mockResolvedValue({ controller: 'x', controller_name: 'MacBook', status: 'online', name: 'Home PC', turned_on_remote: true, relay: 'wss://relay.caprock.dev' })
    const onJoined = vi.fn()
    render(<JoinWithKey onJoined={onJoined} />)
    fireEvent.change(screen.getByLabelText(/Join with a key/), { target: { value: `  ${KEY}  ` } })
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    const done = await screen.findByRole('status')
    expect(join).toHaveBeenCalledWith(KEY)
    expect(onJoined).toHaveBeenCalled()
    expect(done.textContent).toContain('MacBook can now start and watch agents on this computer')
    expect(done.textContent).toContain('Access from anywhere is on now, through relay.caprock.dev')
    expect(done.textContent).toContain('no secret came with the key')
  })

  it('says what a failed join means', async () => {
    vi.spyOn(joinApi, 'join').mockRejectedValue(new ApiError(404, '404', { error: 'gone' }))
    render(<JoinWithKey onJoined={() => {}} />)
    fireEvent.change(screen.getByLabelText(/Join with a key/), { target: { value: KEY } })
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Make a new key there')
    expect(joinError(new ApiError(400, '400', { error: 'x' }))).toContain('not a join key')
    expect(joinError(new ApiError(403, '403', { error: 'that key was used already' }))).toContain('that key was used already')
  })
})
