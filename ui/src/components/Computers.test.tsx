import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { addError, Computers } from './Computers'
import { api, ApiError } from '@/lib/api'
import { machinesApi, type Machine } from '@/lib/machines'

const ID = 'f7kc4QaG4HRPYEjg19Pr-au-FeTljmKHkikFrAmRTzM'
const mini: Machine = { id: ID, name: 'Mac mini', relay: 'wss://relay.example', added_at: 1, status: 'online', kind: 'machine', role: 'controller', version: '0.133.0', streams: 0, last_seen: Date.now() }

describe('Settings → Computers (ADR-067)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('checks each computer on open and lists it with its state, the relay and the version', async () => {
    const list = vi.spyOn(machinesApi, 'list').mockResolvedValue([{ ...mini, status: 'offline', error: 'the computer is offline' }])
    render(<Computers />)
    const row = await screen.findByText('Mac mini')
    expect(list).toHaveBeenCalledWith(true)
    const li = row.closest('li')!
    expect(li.textContent).toContain('offline')
    expect(li.textContent).toContain('not at its relay')
    expect(li.textContent).toContain('through relay.example')
    expect(li.textContent).toContain('Caprock 0.133.0')
  })

  it('adds a computer by its link and says to allow it there', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([])
    const add = vi.spyOn(machinesApi, 'add').mockResolvedValue({ ...mini, status: 'pending' })
    render(<Computers />)
    fireEvent.change(screen.getByPlaceholderText(/Paste the link/), { target: { value: '  https://m.caprock.dev/#/pair?r=wss://x&h=a&k=b&c=123456  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await vi.waitFor(() => expect(add).toHaveBeenCalledWith('https://m.caprock.dev/#/pair?r=wss://x&h=a&k=b&c=123456'))
    expect((await screen.findByRole('status')).textContent).toContain('Now allow it there')
  })

  it('says what a refused link means', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([])
    vi.spyOn(machinesApi, 'add').mockRejectedValue(new ApiError(400, '400', { error: 'the computer refused the code' }))
    render(<Computers />)
    fireEvent.change(screen.getByPlaceholderText(/Paste the link/), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toContain('a link works once, for five minutes')
    expect(addError(new ApiError(503, '503', { error: 'offline' }))).toContain('could not be reached')
    expect(addError(new ApiError(409, '409', {}))).toContain('not taking a computer')
  })

  it('renames here and forgets after a confirm', async () => {
    const list = vi.spyOn(machinesApi, 'list').mockResolvedValue([mini])
    const rename = vi.spyOn(machinesApi, 'rename').mockResolvedValue({ ...mini, name: 'Cupboard' })
    const forget = vi.spyOn(machinesApi, 'forget').mockResolvedValue({ forgotten: true, released: true })
    render(<Computers />)
    await screen.findByText('Mac mini')
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    const field = screen.getByLabelText('Computer name')
    fireEvent.change(field, { target: { value: 'Cupboard' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await vi.waitFor(() => expect(rename).toHaveBeenCalledWith(ID, 'Cupboard'))
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }))
    expect(forget).not.toHaveBeenCalled()
    expect(screen.getByText('Forget Mac mini here?')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Forget' })[0]!)
    await vi.waitFor(() => expect(forget).toHaveBeenCalledWith(ID))
    expect(list.mock.calls.length).toBeGreaterThan(1)
  })

  it('shows a link for another computer to reach this one', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([])
    const code = vi.spyOn(api, 'pairComputerCode').mockResolvedValue({ code: '123456', kind: 'machine', expires_in_sec: 300, url: 'http://192.168.1.2:22776', remote: { enabled: true, status: 'online', phones: 0, relay: 'wss://relay.example', app: 'https://m.caprock.dev', link: 'https://m.caprock.dev/#/pair?c=123456' } })
    render(<Computers />)
    fireEvent.click(screen.getByRole('button', { name: 'Show a link for another computer' }))
    await vi.waitFor(() => expect(code).toHaveBeenCalled())
    expect((await screen.findByText('https://m.caprock.dev/#/pair?c=123456')).tagName).toBe('CODE')
  })

  it('lists the steps for the other computer, its terminal included', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([])
    render(<Computers />)
    const steps = document.querySelector('[data-computer-steps]')!
    expect(steps.textContent).toContain('caprock remote on')
    expect(steps.textContent).toContain('caprock pair --computer')
    expect(steps.textContent).toContain('caprock machines allow')
  })
})
