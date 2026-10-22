import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { McpAgent } from '@/lib/api'

const m = vi.hoisted(() => ({ list: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), paired: false }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    isPairedDevice: () => m.paired,
    api: { ...actual.api, mcpAgents: m.list, mcpConnect: m.connect, mcpDisconnect: m.disconnect },
  }
})
import { McpConnectList, McpConnectRow, connectLine, needsConnect } from './McpConnect'

const claude = (state: McpAgent['state'], command?: string): McpAgent => ({ agent: 'claude', name: 'Claude Code', state, command })
const codex = (state: McpAgent['state']): McpAgent => ({ agent: 'codex', name: 'Codex', state })
const list = (...agents: McpAgent[]) => ({ executable: '/opt/homebrew/bin/caprock', agents })

beforeEach(() => {
  vi.clearAllMocks()
  m.paired = false
})

describe('Connect your agents to Caprock (MCP)', () => {
  it('offers Connect per installed agent and says what the click does', async () => {
    m.list.mockResolvedValue(list(claude('not_connected'), codex('not_installed')))
    render(<McpConnectRow />)
    expect(await screen.findByText('Let your agents ask Second Brain')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
    expect(screen.queryByText('Codex')).toBeNull()
    expect(screen.getByText(/Connect adds Caprock to Claude Code’s MCP servers for your user; Disconnect removes it/)).toHaveTextContent(/Caprock sends nothing anywhere/)
  })

  it('connects on the click and shows it worked', async () => {
    m.list.mockResolvedValue(list(claude('not_connected')))
    m.connect.mockResolvedValue(claude('connected', '/opt/homebrew/bin/caprock mcp'))
    render(<McpConnectRow />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(m.connect).toHaveBeenCalledWith('claude'))
    expect(await screen.findByText('Connected ✓')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
  })

  it('offers Update path for a registration that starts another caprock', async () => {
    m.list.mockResolvedValue(list(claude('different', '/old/caprock mcp'), codex('connected')))
    render(<McpConnectRow />)
    const btn = await screen.findByRole('button', { name: 'Update path' })
    expect(btn).toHaveAttribute('title', 'Now starts: /old/caprock mcp')
    expect(screen.getByText('Connected ✓')).toBeInTheDocument()
  })

  it('shows the CLI’s message when it fails', async () => {
    const { ApiError } = await import('@/lib/api')
    m.list.mockResolvedValue(list(codex('not_connected')))
    m.connect.mockRejectedValue(new ApiError(502, '502 Bad Gateway', { error: 'Codex: Error: not logged in' }))
    render(<McpConnectRow />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Codex: Error: not logged in')
  })

  it('hides when every installed agent is connected, or none is installed', async () => {
    m.list.mockResolvedValue(list(claude('connected'), codex('not_installed')))
    const { container, unmount } = render(<McpConnectRow />)
    await waitFor(() => expect(m.list).toHaveBeenCalled())
    await Promise.resolve()
    expect(container.querySelector('[data-mcp-connect-row]')).toBeNull()
    unmount()
    m.list.mockResolvedValue(list(claude('not_installed'), codex('not_installed')))
    const again = render(<McpConnectRow />)
    await waitFor(() => expect(m.list).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    expect(again.container.querySelector('[data-mcp-connect-row]')).toBeNull()
    expect(needsConnect([claude('connected'), codex('not_installed')])).toBe(false)
    expect(needsConnect([claude('connected'), codex('different')])).toBe(true)
  })

  it('is not offered on a paired device', async () => {
    m.paired = true
    m.list.mockResolvedValue(list(claude('not_connected')))
    const { container } = render(<McpConnectRow />)
    await Promise.resolve()
    expect(m.list).not.toHaveBeenCalled()
    expect(container).toBeEmptyDOMElement()
  })

  it('in Settings lists every agent, connected ones with Disconnect', async () => {
    m.list.mockResolvedValue(list(claude('connected'), codex('not_installed')))
    m.disconnect.mockResolvedValue(claude('not_connected'))
    render(<McpConnectList />)
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(m.disconnect).toHaveBeenCalledWith('claude'))
    expect(await screen.findByRole('button', { name: 'Connect' })).toBeInTheDocument()
    expect(screen.getByText('not installed')).toBeInTheDocument()
    expect(screen.getByText('/opt/homebrew/bin/caprock')).toBeInTheDocument()
  })

  it('names both agents in the line when both are there', () => {
    expect(connectLine(['Claude Code', 'Codex'])).toMatch(/^Connect adds Caprock to Claude Code and Codex’s MCP servers for your user/)
  })
})
