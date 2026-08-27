import { useEffect, useRef } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
/** Live terminal for an owned session over /v1/agents/:id/term (Phase 1). */
export function TerminalView({ sessionId, owned }: { sessionId: string; owned: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!host.current || !owned) return
    // Pull the terminal palette from the theme tokens so it matches light/dark.
    const css = getComputedStyle(document.documentElement)
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
    const term = new Xterm({
      // The resolved stack, not `var(--font-mono)`. xterm renders glyphs onto a
      // canvas and hands this string to the 2D context, which does not resolve
      // CSS custom properties — it saw an invalid family and fell back to the
      // system monospace. On Cyrillic that fallback is a different face
      // entirely, which is what made the terminal unreadable for the one user
      // who moved onto it full-time.
      convertEol: false, cursorBlink: true, fontFamily: v('--font-mono', 'monospace'), fontSize: 12,
      theme: {
        background: v('--color-bg', '#0b0e14'),
        foreground: v('--color-fg', '#d3dae3'),
        cursor: v('--color-accent', '#5ea1ff'),
        selectionBackground: v('--color-border-strong', '#2b3646'),
      },
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    try { fit.fit() } catch { /* not yet laid out */ }
    // Ask for every subset the face ships, by name.
    //
    // Subsets load lazily, triggered by a matching character appearing in the
    // DOM — but the terminal paints to a canvas, so its text never enters the
    // DOM and the request is never made. The dashboard's own chrome is
    // English, so the first non-Latin line would render in the fallback face
    // forever. One character per range is enough to make the browser fetch it.
    //
    // These six are everything JetBrains Mono covers. CJK, Arabic, Hebrew and
    // Thai are NOT in the face at all and cannot be turned on here — they fall
    // through to the stack in --font-mono, which is why that stack has to keep
    // a real system monospace at the end rather than ending at the webfont.
    for (const sample of ['A', 'ā', 'Ы', 'Ѣ', 'Ω', 'ế']) {
      document.fonts?.load('12px "JetBrains Mono Variable"', sample)
        .catch(() => { /* face unavailable; the fallback still renders */ })
    }
    // xterm measures the cell from the font that is loaded WHEN IT OPENS. The
    // webfont usually is not yet, so it measures the fallback and keeps that
    // cell size after the real face arrives — every column lands slightly off.
    // Re-fitting once the faces are ready re-measures against them.
    document.fonts?.ready.then(() => { try { fit.fit() } catch { /* gone */ } })
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/v1/agents/${encodeURIComponent(sessionId)}/term`)
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (e) => { term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data)) }
    ws.onclose = () => term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n')
    const send = (d: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(d) }
    const dataSub = term.onData(send)

    // Shift+Enter, so a prompt can have more than one line.
    //
    // A terminal cannot tell Shift+Enter from Enter: both are carriage return,
    // ASCII 13, and have been since the teletype. Claude Code asks for the
    // modern encoding instead — CSI u, `ESC [ 13 ; 2 u` — which every terminal
    // that supports multi-line prompts is configured to send. xterm.js does not
    // send it by default, so a user typing a numbered list here got their first
    // line submitted and the rest of the thought lost.
    //
    // Intercepted before xterm turns the key into bytes: returning false stops
    // it emitting the plain carriage return it otherwise would.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || e.key !== 'Enter') return true
      if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return true
      send('\x1b[13;2u')
      return false
    })
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
