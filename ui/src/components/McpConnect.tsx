/**
 * Connect Caprock's MCP server to the user's agents with one click (ADR-078).
 *
 * The audit behind it: no agent called `caprock mcp` in a week, because the
 * only route was a command to copy from Settings. So the Second Brain screen
 * leads with a row — *Let your agents ask Second Brain* — and a button per
 * installed agent; Settings → Use Caprock from your agents shows the same.
 *
 * A click runs the agent's own CLI on this machine (`claude mcp add -s user
 * caprock -- <this caprock> mcp`, `codex mcp add …`) through the daemon, and
 * Disconnect runs its `mcp remove`. Nothing runs without the click, and a
 * paired device is not offered it (the daemon refuses one too). The row goes
 * away once every installed agent is connected — except right after a click
 * here, so the user sees it worked.
 */
import { useCallback, useEffect, useState } from 'react'
import { api, errText, isPairedDevice, type McpAgent, type McpAgents } from '@/lib/api'

/** GET /v1/mcp/agents, re-read on demand. Not on a paired device: it cannot change them. */
export function useMcpAgents() {
  const [data, setData] = useState<McpAgents | undefined>()
  const reload = useCallback(() => {
    if (isPairedDevice()) return
    api.mcpAgents().then(setData, () => setData(undefined))
  }, [])
  useEffect(reload, [reload])
  return { data, reload, setAgent: (a: McpAgent) => setData((d) => d && { ...d, agents: d.agents.map((x) => (x.agent === a.agent ? a : x)) }) }
}

/** What a Connect click does, said plainly next to the button. */
export function connectLine(names: string[]): string {
  const who = names.length ? names.join(' and ') : 'your agent'
  return `Connect adds Caprock to ${who}’s MCP servers for your user; Disconnect removes it. It changes a config file on this machine; Caprock sends nothing anywhere.`
}

/** The button, or the state, for one agent. */
export function McpAgentAction({ agent, onChange, compact = false }: { agent: McpAgent; onChange: (a: McpAgent) => void; compact?: boolean }) {
  const [busy, setBusy] = useState<'' | 'connect' | 'disconnect'>('')
  const [error, setError] = useState('')
  const run = (what: 'connect' | 'disconnect') => {
    setBusy(what)
    setError('')
    ;(what === 'connect' ? api.mcpConnect(agent.agent) : api.mcpDisconnect(agent.agent)).then(
      (a) => { setBusy(''); onChange(a) },
      (e) => { setBusy(''); setError(errText(e)) },
    )
  }
  const btn = 'h-[26px] rounded-[7px] border px-2 text-[12px] disabled:opacity-50'
  let action
  switch (agent.state) {
    case 'not_installed':
      action = <span className="text-[12px] text-fg-muted">not installed</span>
      break
    case 'connected':
      action = (
        <>
          <span className="text-[12px] text-ok" data-mcp-connected>Connected ✓</span>
          <button type="button" disabled={!!busy} onClick={() => run('disconnect')}
            className="text-[12px] text-fg-muted underline-offset-2 hover:text-fg hover:underline disabled:opacity-50">
            {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </>
      )
      break
    case 'different':
      action = (
        <button type="button" disabled={!!busy} onClick={() => run('connect')} title={agent.command ? `Now starts: ${agent.command}` : undefined}
          className={`${btn} border-warn text-fg hover:bg-panel-2`}>
          {busy ? 'Updating…' : 'Update path'}
        </button>
      )
      break
    default:
      action = (
        <button type="button" disabled={!!busy} onClick={() => run('connect')}
          className={`${btn} border-accent bg-accent text-panel hover:opacity-90`}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      )
  }
  return (
    <span className={`inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 ${compact ? '' : 'py-0.5'}`} data-mcp-agent={agent.agent} data-mcp-state={agent.state}>
      <span className="text-[13px] text-fg">{agent.name}</span>
      <span aria-hidden className="text-fg-muted">·</span>
      {action}
      {error && <span role="alert" className="basis-full break-words text-[12px] text-danger">{error}</span>}
    </span>
  )
}

/** Whether the Second Brain row has anything to offer: an installed agent not connected. */
export function needsConnect(agents: McpAgent[] | undefined): boolean {
  return (agents ?? []).some((a) => a.state === 'not_connected' || a.state === 'different')
}

/** The row on top of the Second Brain screen. */
export function McpConnectRow() {
  const { data, setAgent } = useMcpAgents()
  const [clicked, setClicked] = useState(false)
  if (!data || isPairedDevice()) return null
  if (!clicked && !needsConnect(data.agents)) return null
  const installed = data.agents.filter((a) => a.state !== 'not_installed')
  if (!installed.length) return null
  return (
    <section aria-label="Let your agents ask Second Brain" data-mcp-connect-row
      className="grid min-w-0 gap-1 rounded-[var(--radius-panel)] border border-border bg-panel px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-[13px] font-medium text-fg">Let your agents ask Second Brain</span>
        {installed.map((a) => (
          <McpAgentAction key={a.agent} agent={a} compact onChange={(x) => { setClicked(true); setAgent(x) }} />
        ))}
      </div>
      <p className="text-[12px] leading-relaxed text-fg-muted" data-mcp-connect-line>
        {connectLine(installed.map((a) => a.name))}
        {data.unstable && <> <span className="text-warn">{data.unstable}</span></>}
      </p>
    </section>
  )
}

/** The same status and buttons for Settings → Use Caprock from your agents. */
export function McpConnectList() {
  const { data, setAgent } = useMcpAgents()
  if (!data || isPairedDevice()) return null
  return (
    <div className="grid gap-1" data-mcp-connect-list>
      {data.agents.map((a) => <McpAgentAction key={a.agent} agent={a} onChange={setAgent} />)}
      <p data-keep className="text-[12px] leading-relaxed text-fg-muted">
        {connectLine(data.agents.filter((a) => a.state !== 'not_installed').map((a) => a.name))}
        {data.executable && <> It registers <span className="mono break-all">{data.executable}</span>.</>}
        {data.unstable && <> <span className="text-warn">{data.unstable}</span></>}
      </p>
    </div>
  )
}
