import { useEffect, useRef } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
/** Live terminal for an owned session over /v1/agents/:id/term (Phase 1). */
export function TerminalView({ sessionId, owned }: { sessionId: string; owned: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!host.current || !owned) return
    const term = new Xterm({
      convertEol: false, cursorBlink: true, fontFamily: 'var(--font-mono)', fontSize: 12,
      theme: { background: '#0b0e14', foreground: '#d3dae3', cursor: '#5ea1ff', selectionBackground: '#2b3646' },
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    try { fit.fit() } catch { /* not yet laid out */ }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/v1/agents/${encodeURIComponent(sessionId)}/term`)
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (e) => { term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data)) }
    ws.onclose = () => term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n')
    const dataSub = term.onData((d) => { if (ws.readyState === WebSocket.OPEN) ws.send(d) })
    const ro = new ResizeObserver(() => { try { fit.fit() } catch { /* */ } })
    ro.observe(host.current)
    return () => { ro.disconnect(); dataSub.dispose(); ws.close(); term.dispose() }
  }, [sessionId, owned])
  if (!owned) {
    return (
      <div className="px-4 py-8 text-center text-fg-muted text-[13px]">
        This is an externally started session — Caprock observes it but never writes into a terminal it does not own.
        <div className="text-fg-faint text-[12px] mt-1">Spawn a session from “New session” to get an interactive terminal.</div>
      </div>
    )
  }
  return <div ref={host} className="h-[70vh] bg-bg" />
}
