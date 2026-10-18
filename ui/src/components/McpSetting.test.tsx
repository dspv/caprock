import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { searchSections } from '@/lib/settingsSearch'
import { MCP_TOOLS, McpSetting, mcpCommands, shellWord, tomlString } from './McpSetting'

describe('Use Caprock from your agents (MCP)', () => {
  it('shows the Claude Code and Codex commands with caprock on the PATH, and says what a result reaches', () => {
    render(<McpSetting executable="/opt/homebrew/bin/caprock" />)
    expect(screen.getByText('$ claude mcp add caprock -- caprock mcp')).toBeInTheDocument()
    expect(screen.getByText('$ codex mcp add caprock -- caprock mcp')).toBeInTheDocument()
    expect(screen.getByText(/\[mcp_servers\.caprock\]/)).toHaveTextContent('command = "caprock" args = ["mcp"]')
    expect(screen.getByText(/Read-only: no tool can type into a session/)).toHaveTextContent(/so to the model it runs on/)
  })

  it('puts the full path in every command when asked', () => {
    render(<McpSetting executable="/Applications/Caprock App.app/Contents/MacOS/caprock" />)
    fireEvent.click(screen.getByRole('checkbox', { name: /Use the full path to caprock/ }))
    expect(screen.getByText('$ claude mcp add caprock -- "/Applications/Caprock App.app/Contents/MacOS/caprock" mcp')).toBeInTheDocument()
    expect(screen.getByText(/\[mcp_servers\.caprock\]/)).toHaveTextContent("command = '/Applications/Caprock App.app/Contents/MacOS/caprock'")
  })

  it('offers no path switch when the daemon did not say where it runs from', () => {
    render(<McpSetting />)
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('lists every tool the server offers', () => {
    render(<McpSetting />)
    for (const [name] of MCP_TOOLS) expect(screen.getByText(name)).toBeInTheDocument()
    expect(MCP_TOOLS).toHaveLength(11)
  })

  it('quotes a Windows path so a shell and TOML both read it as written', () => {
    const exe = 'C:\\Program Files\\Caprock\\caprock.exe'
    expect(shellWord(exe)).toBe('"C:\\Program Files\\Caprock\\caprock.exe"')
    expect(tomlString(exe)).toBe("'C:\\Program Files\\Caprock\\caprock.exe'")
    expect(tomlString("C:\\it's\\caprock.exe")).toBe('"C:\\\\it\'s\\\\caprock.exe"')
    expect(mcpCommands('C:\\caprock\\caprock.exe').claude).toBe('claude mcp add caprock -- C:\\caprock\\caprock.exe mcp')
  })

  it('is found by the words people type for it', () => {
    const page = [
      { id: 'agents', title: 'Add your own coding agents', entries: [] },
      { id: 'mcp', title: 'Use Caprock from your agents (MCP)', entries: [] },
      { id: 'appearance', title: 'Appearance', entries: [] },
    ]
    for (const q of ['mcp', 'tools', 'codex', 'agents']) {
      expect(searchSections(page, q).map((m) => m.id), q).toContain('mcp')
    }
  })
})
