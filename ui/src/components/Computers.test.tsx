import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { addError, Computers, defaultRole, mainSteps, readRole, ROLE_KEY, secondarySteps } from './Computers'
import { api, ApiError, type PairedDevice, type PairState, type RemoteState } from '@/lib/api'
import { machinesApi, type Machine } from '@/lib/machines'

const ID = 'f7kc4QaG4HRPYEjg19Pr-au-FeTljmKHkikFrAmRTzM'
const mini: Machine = { id: ID, name: 'Mac mini', relay: 'wss://relay.example', added_at: 1, status: 'online', kind: 'machine', role: 'controller', version: '0.133.0', streams: 0, last_seen: Date.now() }
const relayOn: RemoteState = { enabled: true, status: 'online', phones: 0, relay: 'wss://relay.example', app: 'https://m.caprock.dev' }
const relayOff: RemoteState = { ...relayOn, enabled: false, status: 'off' }
const office: PairedDevice = { id: 'dev-office', name: 'Office PC', paired_at: Date.now() - 60_000, last_seen: Date.now() - 120_000, role: 'controller', kind: 'machine' }
const phone: PairedDevice = { id: 'dev-phone', name: 'iPhone · Safari', paired_at: 1, last_seen: 1, role: 'viewer' }

function pairState(remote: RemoteState | undefined, devices: PairedDevice[] = []): PairState {
  return { enabled: false, remote, devices }
}

const step = (n: number) => document.querySelector(`[data-step="${n}"]`)!

describe('Settings → Computers (ADR-067)', () => {
  beforeEach(() => {
    localStorage.removeItem(ROLE_KEY)
    vi.spyOn(api, 'pairState').mockResolvedValue(pairState(relayOff))
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    localStorage.removeItem(ROLE_KEY)
  })

  describe('the role cards', () => {
    it('defaults to the main one unless computers only reach this one', () => {
      expect(defaultRole(0, 0)).toBe('main')
      expect(defaultRole(2, 0)).toBe('main')
      expect(defaultRole(1, 1)).toBe('main')
      expect(defaultRole(0, 1)).toBe('secondary')
    })

    it('a pick switches the steps, names this computer in the list, and is kept in this browser', async () => {
      vi.spyOn(machinesApi, 'list').mockResolvedValue([])
      render(<Computers />)
      const main = await screen.findByRole('radio', { name: /The main one/ })
      expect(main.getAttribute('aria-checked')).toBe('true')
      expect(document.querySelector('[data-steps="main"]')).toBeTruthy()
      expect(document.querySelector('[data-this-role]')!.textContent).toContain('this one · main')

      fireEvent.click(screen.getByRole('radio', { name: /Connects to another/ }))
      expect(screen.getByRole('radio', { name: /Connects to another/ }).getAttribute('aria-checked')).toBe('true')
      expect(document.querySelector('[data-steps="secondary"]')).toBeTruthy()
      expect(document.querySelector('[data-steps="main"]')).toBeNull()
      expect(document.querySelector('[data-this-role]')!.textContent).toContain('this one · connects to another')
      expect(readRole()).toBe('secondary')
    })

    it('opens on Connects to another for a computer that others reach and that reaches none', async () => {
      vi.spyOn(machinesApi, 'list').mockResolvedValue([])
      vi.spyOn(api, 'pairState').mockResolvedValue(pairState(relayOn, [office, phone]))
      render(<Computers />)
      await screen.findByText('Office PC')
      expect(screen.getByRole('radio', { name: /Connects to another/ }).getAttribute('aria-checked')).toBe('true')
    })
  })

  describe('the steps', () => {
    it('on the main one: pasted, then allowed there', () => {
      expect(mainSteps([])).toEqual([false, false, false])
      expect(mainSteps([{ status: 'pending' }])).toEqual([true, true, false])
      expect(mainSteps([{ status: 'revoked' }])).toEqual([true, true, false])
      expect(mainSteps([{ status: 'idle' }])).toEqual([true, true, true])
      expect(mainSteps([{ status: 'pending' }, { status: 'online' }])).toEqual([true, true, true])
    })

    it('on the other one: access from anywhere, a computer arrived, it is allowed; a phone does not count', () => {
      expect(secondarySteps(undefined, [])).toEqual([false, false, false])
      expect(secondarySteps(relayOff, [phone])).toEqual([false, false, false])
      expect(secondarySteps(relayOn, [phone])).toEqual([true, false, false])
      expect(secondarySteps(relayOn, [{ ...office, pending: true }])).toEqual([true, true, false])
      expect(secondarySteps(relayOn, [office])).toEqual([true, true, true])
    })

    it('ticks the main one\'s steps from the list', async () => {
      vi.spyOn(machinesApi, 'list').mockResolvedValue([{ ...mini, status: 'pending' }])
      render(<Computers />)
      await screen.findByText('Mac mini')
      expect(step(1).getAttribute('data-done')).toBe('yes')
      expect(step(2).getAttribute('data-done')).toBe('yes')
      expect(step(3).getAttribute('data-done')).toBe('no')
      expect(within(step(3) as HTMLElement).getByLabelText('Step 3').textContent).toBe('3')
    })

    it('turns access from anywhere on in step 1 and ticks it', async () => {
      localStorage.setItem(ROLE_KEY, 'secondary')
      vi.spyOn(machinesApi, 'list').mockResolvedValue([])
      const state = vi.spyOn(api, 'pairState').mockResolvedValue(pairState(relayOff))
      const set = vi.spyOn(api, 'setRemote').mockImplementation(async () => {
        state.mockResolvedValue(pairState(relayOn))
        return relayOn
      })
      render(<Computers />)
      const on = await screen.findByRole('button', { name: 'Turn on' })
      expect(step(1).getAttribute('data-done')).toBe('no')
      fireEvent.click(on)
      await vi.waitFor(() => expect(set).toHaveBeenCalledWith(true))
      await vi.waitFor(() => expect(step(1).getAttribute('data-done')).toBe('yes'), { timeout: 3000 })
      expect(within(step(1) as HTMLElement).getByLabelText('Step 1, done').textContent).toBe('✓')
      expect(step(1).textContent).toContain('— on')
    })

    it('shows the link for the main one with its validity and Copy', async () => {
      localStorage.setItem(ROLE_KEY, 'secondary')
      vi.spyOn(machinesApi, 'list').mockResolvedValue([])
      const code = vi.spyOn(api, 'pairComputerCode').mockResolvedValue({ code: '123456', kind: 'machine', expires_in_sec: 300, url: 'http://192.168.1.2:22776', remote: { ...relayOn, link: 'https://m.caprock.dev/#/pair?c=123456' } })
      const write = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
      render(<Computers />)
      fireEvent.click(await screen.findByRole('button', { name: 'Show the link' }))
      await vi.waitFor(() => expect(code).toHaveBeenCalled())
      expect((await screen.findByText('https://m.caprock.dev/#/pair?c=123456')).tagName).toBe('CODE')
      expect(document.querySelector('[data-link-valid]')!.textContent).toContain('valid 5 more min, once')
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
      expect(write).toHaveBeenCalledWith('https://m.caprock.dev/#/pair?c=123456')
    })
  })

  it('keeps the relay text behind the (i): where it is switched on and what it sends', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([])
    vi.spyOn(api, 'pairState').mockResolvedValue(pairState(relayOn))
    render(<Computers />)
    await screen.findByRole('radio', { name: /The main one/ })
    expect(document.querySelector('[data-relay-info]')).toBeNull()
    const toggle = screen.getByRole('button', { name: /what goes through the relay/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const info = document.querySelector('[data-relay-info]')!
    expect(info.textContent).toContain('caprock remote on')
    expect(info.textContent).toContain('caprock remote off')
    expect(info.textContent).toContain('step 1')
    expect(info.textContent).toContain('relay.example')
    expect(info.querySelector('[data-relay-sends]')!.textContent).toContain('end-to-end encrypted: the relay sees that two machines talk, when and how much, never what')
  })

  it('lists this computer first, then each one it reaches and each one that reaches it', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([{ ...mini, status: 'offline', error: 'the computer is offline' }])
    vi.spyOn(api, 'pairState').mockResolvedValue(pairState(relayOn, [office, phone]))
    render(<Computers />)
    await screen.findByText('Office PC')
    const rows = [...document.querySelectorAll('[data-computers] > li')]
    expect(rows[0]!.hasAttribute('data-this-computer')).toBe(true)
    expect(rows[1]!.textContent).toContain('Mac mini')
    expect(rows[1]!.textContent).toContain('not at its relay')
    expect(rows[1]!.textContent).toContain('through relay.example')
    expect(rows[1]!.textContent).toContain('Caprock 0.133.0')
    expect(rows[2]!.textContent).toContain('Office PC')
    expect(rows[2]!.textContent).toContain('connected 2m ago')
    expect(screen.queryByText('iPhone · Safari')).toBeNull()
  })

  it('checks each computer on open', async () => {
    const list = vi.spyOn(machinesApi, 'list').mockResolvedValue([mini])
    render(<Computers />)
    await screen.findByText('Mac mini')
    expect(list).toHaveBeenCalledWith(true)
  })

  it('allows a computer that waits, and disconnects one after a confirm', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([])
    vi.spyOn(api, 'pairState').mockResolvedValue(pairState(relayOn, [{ ...office, pending: true }]))
    const allow = vi.spyOn(api, 'pairAllow').mockResolvedValue({ id: office.id, role: 'controller' })
    const revoke = vi.spyOn(api, 'pairRevoke').mockResolvedValue({ revoked: 1 })
    render(<Computers />)
    const row = (await screen.findByText('Office PC')).closest('li')!
    expect(row.textContent).toContain('waiting for Allow')
    fireEvent.click(within(row).getByRole('button', { name: 'Allow' }))
    await vi.waitFor(() => expect(allow).toHaveBeenCalledWith(office.id))
    fireEvent.click(within(row).getByRole('button', { name: 'Disconnect' }))
    expect(revoke).not.toHaveBeenCalled()
    fireEvent.click(within(row).getByRole('button', { name: 'Disconnect' }))
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith(office.id))
  })

  it('adds a computer by its link and says to allow it there', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([])
    const add = vi.spyOn(machinesApi, 'add').mockResolvedValue({ ...mini, status: 'pending' })
    render(<Computers />)
    fireEvent.change(await screen.findByPlaceholderText(/Paste the link/), { target: { value: '  https://m.caprock.dev/#/pair?r=wss://x&h=a&k=b&c=123456  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await vi.waitFor(() => expect(add).toHaveBeenCalledWith('https://m.caprock.dev/#/pair?r=wss://x&h=a&k=b&c=123456'))
    expect((await screen.findByRole('status')).textContent).toContain('Now allow it there')
  })

  it('says what a refused link means', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([])
    vi.spyOn(machinesApi, 'add').mockRejectedValue(new ApiError(400, '400', { error: 'the computer refused the code' }))
    render(<Computers />)
    fireEvent.change(await screen.findByPlaceholderText(/Paste the link/), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toContain('a link works once, for five minutes')
    expect(addError(new ApiError(503, '503', { error: 'offline' }))).toContain('could not be reached')
    expect(addError(new ApiError(409, '409', {}))).toContain('not taking a computer')
  })

  it('renames here and disconnects after a confirm', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(forget).not.toHaveBeenCalled()
    expect(screen.getByText('Disconnect Mac mini?')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' })[0]!)
    await vi.waitFor(() => expect(forget).toHaveBeenCalledWith(ID))
    expect(list.mock.calls.length).toBeGreaterThan(1)
  })

  it('lists the steps for the other computer, its terminal included', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([])
    render(<Computers />)
    await screen.findByRole('radio', { name: /The main one/ })
    const steps = document.querySelector('[data-computer-steps]')!
    expect(steps.textContent).toContain('caprock remote on')
    expect(steps.textContent).toContain('caprock pair --computer')
    expect(steps.textContent).toContain('caprock machines allow')
  })
})
