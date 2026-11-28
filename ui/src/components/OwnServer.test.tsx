import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OwnServer, checkTarget } from './OwnServer'
import { NewServer } from './NewServer'
import { SERVER_JOIN_POLL_MS, endServerJoin } from '@/lib/serverJoinWatch'
import { joinApi, serverApi, type ServerSSH } from '@/lib/machines'
import { SetupShellContext } from '@/lib/setupShell'
import * as router from '@/lib/router'

const CMD = "ssh -p 22 root@203.0.113.7 'sh -s' < '/data/server-scripts/caprock-setup-1.sh'"

function made(over: Partial<ServerSSH> = {}): ServerSSH {
  return { state: 'waiting', server: true, expires_at: Date.now() + 60 * 60_000, relay_status: 'online', command: CMD, home: '/home/me', os: 'linux', version: '0.201.0', signed: false, ...over }
}

function fill(address: string, user?: string, port?: string) {
  fireEvent.change(document.querySelector('[data-own-server-address]')!, { target: { value: address } })
  if (user !== undefined) fireEvent.change(document.querySelector('[data-own-server-user]')!, { target: { value: user } })
  if (port !== undefined) fireEvent.change(document.querySelector('[data-own-server-port]')!, { target: { value: port } })
}

describe('I already have a server (ADR-109)', () => {
  afterEach(() => {
    cleanup()
    endServerJoin()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('refuses an address, user or port a shell or ssh could read as something else', () => {
    for (const a of ['1.2.3.4; id', '-oProxyCommand=x', "a'b", 'a b', '$(id)', '`id`', 'root@host', 'a|b', '[::1]', 'fe80::1%eth0']) {
      expect(checkTarget(a, 'root', ''), a).not.toBe('')
    }
    for (const u of ['root; id', 'Root', '-x', '', 'a b']) expect(checkTarget('1.2.3.4', u, ''), u).not.toBe('')
    for (const p of ['0', '65536', '22;', 'x']) expect(checkTarget('1.2.3.4', 'root', p), p).not.toBe('')
    for (const [a, u, p] of [['1.2.3.4', 'root', ''], ['server.example.com', 'deploy', '2222'], ['2001:db8::1', 'ubuntu', '']] as const) {
      expect(checkTarget(a, u, p)).toBe('')
    }
  })

  it('types the ssh command into a terminal tab here, says ssh asks there, and that password login goes off', async () => {
    const ssh = vi.spyOn(serverApi, 'ssh').mockResolvedValue(made())
    const shell = vi.fn()
    render(<SetupShellContext.Provider value={shell}><OwnServer onClose={() => {}} /></SetupShellContext.Provider>)
    fill('203.0.113.7')
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    await screen.findByText(`$ ${CMD}`)
    expect(ssh).toHaveBeenCalledWith({ address: '203.0.113.7', user: 'root' })
    expect(shell).toHaveBeenCalledWith(CMD, '/home/me')
    expect(document.querySelector('[data-own-server-next]')!.textContent).toContain('Press Enter there')
    expect(document.querySelector('[data-own-server-ssh]')!.textContent).toContain('Caprock never sees either')
    expect(document.querySelector('[data-own-server-after]')!.textContent).toContain('password login to this server is off')
    expect(document.querySelector('[data-own-server-left]')!.textContent).toContain('60 more min')
  })

  it('in a browser, with no tabs to open, shows the command to run', async () => {
    const sudo = "scp -P 2222 '/s.sh' deploy@203.0.113.7:caprock-setup.sh && ssh -t -p 2222 deploy@203.0.113.7 'sudo sh caprock-setup.sh; rm -f caprock-setup.sh'"
    const ssh = vi.spyOn(serverApi, 'ssh').mockResolvedValue(made({ command: sudo }))
    render(<OwnServer onClose={() => {}} />)
    fill('203.0.113.7', 'deploy', '2222')
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    await screen.findByText(`$ ${sudo}`)
    expect(ssh).toHaveBeenCalledWith({ address: '203.0.113.7', user: 'deploy', port: 2222 })
    expect(document.querySelector('[data-own-server-next]')!.textContent).toContain('Run this in a terminal')
    expect(document.querySelector('[data-own-server-ssh]')!.textContent).toContain('sudo')
  })

  it('sends nothing for a refused address', () => {
    const ssh = vi.spyOn(serverApi, 'ssh')
    render(<OwnServer onClose={() => {}} />)
    fill('1.2.3.4; reboot')
    expect(screen.getByRole('alert').textContent).toContain('The address is')
    expect((screen.getByRole('button', { name: 'Set up' }) as HTMLButtonElement).disabled).toBe(true)
    expect(ssh).not.toHaveBeenCalled()
  })

  it('opens the server page once it joined, with the panel gone, and Cancel withdraws the key', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const nav = vi.spyOn(router, 'navigate').mockImplementation(() => {})
    vi.spyOn(serverApi, 'ssh').mockResolvedValue(made())
    const state = vi.spyOn(joinApi, 'state').mockResolvedValue({ state: 'joined', server: true, machine: { id: 'srv', name: 'box', relay: '', added_at: 1, status: 'online', kind: 'machine', role: 'controller', streams: 0 } })
    render(<OwnServer onClose={() => {}} />)
    fill('203.0.113.7')
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    await screen.findByText(`$ ${CMD}`)
    // The user is in the terminal tab now: the panel is gone, the wait is not.
    cleanup()
    await act(async () => { await vi.advanceTimersByTimeAsync(SERVER_JOIN_POLL_MS + 10) })
    expect(state).toHaveBeenCalled()
    await vi.waitFor(() => expect(nav).toHaveBeenCalledWith({ name: 'machine', id: 'srv', joined: true }))

    cleanup()
    endServerJoin()
    state.mockResolvedValue({ state: 'waiting', server: true, expires_at: Date.now() + 60_000 })
    const withdraw = vi.spyOn(joinApi, 'withdraw').mockResolvedValue({ withdrawn: true })
    const closed = vi.fn()
    render(<OwnServer onClose={closed} />)
    fill('203.0.113.7')
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    await screen.findByText(`$ ${CMD}`)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await vi.waitFor(() => expect(closed).toHaveBeenCalled())
    expect(withdraw).toHaveBeenCalled()
  })

  it('is the second path on New server', () => {
    render(<NewServer />)
    fireEvent.click(screen.getByRole('button', { name: 'New server' }))
    fireEvent.click(screen.getByLabelText('I already have a server'))
    expect(document.querySelector('[data-own-server="form"]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Make the script' })).toBeNull()
  })
})
