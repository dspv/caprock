/**
 * One terminal in the app workspace (WP-04): xterm.js on the v2 terminal
 * client, filling its pane, kept alive while its tab is in the background.
 *
 * Lean on purpose. The spike measured echo at 9–10 ms for a bare terminal and
 * 13–16 ms with the dashboard rendering beside it (.ai/21-app.md § Performance
 * budgets), so this component subscribes to nothing but its own socket: no
 * live frames, no polling, no React state touched per byte.
 *
 * - **Hidden tabs disconnect after 30 s** (`TermClient.suspend`) and catch up
 *   when shown: v2 from the byte last seen, v1 from the daemon's snapshot. The xterm instance and its
 *   scrollback stay, so switching back paints at once.
 * - **WebGL, late and recoverable.** Swapped in after the first output once
 *   typing pauses (as in the dashboard), dropped while hidden so ten tabs
 *   never hold ten GPU contexts, and re-created after a context loss — a
 *   sleep and wake — when the tab is next shown.
 * - **The scrolling rule.** xterm.js already keeps the viewport still while
 *   the reader is scrolled up; this adds the "↓ N new lines" pill.
 */
import { useEffect, useRef, useState } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { deviceToken } from '@/lib/api'
import { TermClient, type TermState } from '@/lib/termv2'
import { attachTerminalInput } from '@/lib/xtermInput'
import { matchAppShortcut } from '@/lib/appkeys'
import { isMacPlatform } from '@/lib/appmode'
import { TERMINAL_THEME, WEBGL_QUIET_MS } from './Terminal'
import { NewPill } from './NewPill'

/** A tab out of sight this long drops its socket. */
export const HIDDEN_DISCONNECT_MS = 30_000

/**
 * The app terminal's palette: the dashboard terminal's graphite ground and
 * ink, with a warm 16-colour set tuned against it — soft, low-glare hues in
 * the spirit of the palette the owner pointed at (Otty), not a copy of it.
 */
export const APP_TERMINAL_THEME = {
  ...TERMINAL_THEME,
  selectionBackground: '#4a4640',
  black: '#2b2926',
  red: '#e8786d',
  green: '#a3c77e',
  yellow: '#e7bb63',
  blue: '#82a9d9',
  magenta: '#c99ad0',
  cyan: '#7fc4b9',
  white: '#d8d3ca',
  brightBlack: '#6b665e',
  brightRed: '#f3958b',
  brightGreen: '#bad99a',
  brightYellow: '#f2cf86',
  brightBlue: '#a0c0e8',
  brightMagenta: '#dcb5e2',
  brightCyan: '#9dd8ce',
  brightWhite: '#f4f0e8',
} as const

export interface PaneStatus {
  status: TermState
  protocol?: 'v1' | 'v2'
  cols: number
  rows: number
}

export function TerminalPane({
  sessionId,
  active,
  onStatus,
}: {
  sessionId: string
  /** The tab is in front and the workspace is showing. */
  active: boolean
  onStatus?: (s: PaneStatus) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const api = useRef<{ show: () => void; hide: () => void; scrollToBottom: () => void } | null>(null)
  const [phase, setPhase] = useState<'waiting' | 'ready'>('waiting')
  const [status, setStatus] = useState<TermState>('connecting')
  const [newLines, setNewLines] = useState(0)
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus

  useEffect(() => {
    const el = host.current
    if (!el) return
    const isMac = isMacPlatform()
    const css = getComputedStyle(document.documentElement)
    const term = new Xterm({
      // The resolved stack, never var(): xterm hands this to a canvas, which
      // does not resolve custom properties (see Terminal.tsx).
      fontFamily: css.getPropertyValue('--font-mono').trim() || 'monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      theme: { ...APP_TERMINAL_THEME },
      scrollback: 10000,
      macOptionIsMeta: true,
      allowProposedApi: false,
      minimumContrastRatio: 1,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    // The same faces the dashboard's terminal asks for (see Terminal.tsx).
    document.fonts?.ready.then(() => { try { fit.fit() } catch { /* gone */ } })

    let disposed = false
    let visible = false
    let gotOutput = false
    let lastInput = 0
    let webgl: WebglAddon | undefined
    let webglLost = false
    let webglTimer = 0
    let hideTimer = 0

    const report = (s: TermState) => {
      setStatus(s)
      onStatusRef.current?.({ status: s, protocol: conn.protocol, cols: term.cols, rows: term.rows })
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const conn = new TermClient({
      url: `${proto}://${location.host}/v1/agents/${encodeURIComponent(sessionId)}/term`,
      deviceToken: deviceToken() || undefined,
      callbacks: {
        write: (d, done) => {
          if (!gotOutput) {
            gotOutput = true
            setPhase('ready')
            try { if (visible) fit.fit() } catch { /* not laid out */ }
            conn.resize(term.cols, term.rows)
          }
          term.write(d, done)
        },
        // Clears the screen and every mode a dead TUI left on (mouse tracking,
        // bracketed paste, the alternate screen) before a repaint.
        reset: () => term.reset(),
        state: report,
        open: () => {
          try { if (visible) fit.fit() } catch { /* not laid out */ }
          conn.resize(term.cols, term.rows)
          report(conn.state)
        },
      },
    })

    const loadWebgl = () => {
      webglTimer = 0
      if (disposed || webgl || !visible) return
      if (!gotOutput || Date.now() - lastInput < WEBGL_QUIET_MS) {
        webglTimer = window.setTimeout(loadWebgl, WEBGL_QUIET_MS)
        return
      }
      try {
        const addon = new WebglAddon()
        addon.onContextLoss(() => {
          // A sleep and wake, or a driver reset: back to the DOM renderer now,
          // and a fresh context the next time this tab is shown.
          addon.dispose()
          if (webgl === addon) webgl = undefined
          webglLost = true
          if (visible) scheduleWebgl()
        })
        term.loadAddon(addon)
        webgl = addon
        webglLost = false
      } catch {
        // No WebGL here: the DOM renderer keeps drawing.
      }
    }
    const scheduleWebgl = () => {
      if (!webglTimer) webglTimer = window.setTimeout(loadWebgl, WEBGL_QUIET_MS)
    }
    const dropWebgl = () => {
      if (webglTimer) window.clearTimeout(webglTimer)
      webglTimer = 0
      webgl?.dispose()
      webgl = undefined
    }

    const dataSub = term.onData((d) => {
      lastInput = Date.now()
      conn.send(d)
    })
    const sizeSub = term.onResize(({ cols, rows }) => conn.resize(cols, rows))
    const input = attachTerminalInput(term, el, (d) => conn.send(d), {
      isAppKey: (e) => matchAppShortcut(e, isMac) !== null,
    })

    // "↓ N new lines": counted from the buffer's growth while the viewport is
    // above the bottom, published at most once a frame.
    let lastBase = 0
    let pendingNew = 0
    let raf = 0
    const publish = () => {
      raf = 0
      setNewLines(pendingNew)
    }
    const atBottom = () => term.buffer.active.viewportY >= term.buffer.active.baseY
    const parsedSub = term.onWriteParsed(() => {
      const base = term.buffer.active.baseY
      if (!atBottom() && base > lastBase) {
        pendingNew += base - lastBase
        if (!raf) raf = requestAnimationFrame(publish)
      }
      lastBase = base
    })
    const scrollSub = term.onScroll(() => {
      if (atBottom() && pendingNew !== 0) {
        pendingNew = 0
        if (!raf) raf = requestAnimationFrame(publish)
      }
    })

    // One fit per frame, only when the size really changed, never while hidden.
    let fitRaf = 0
    let lastGeom = ''
    const refit = () => {
      fitRaf = 0
      if (!visible || el.clientWidth === 0) return
      const geom = `${el.clientWidth}x${el.clientHeight}`
      if (geom === lastGeom) return
      lastGeom = geom
      try { fit.fit() } catch { /* not laid out */ }
    }
    const ro = new ResizeObserver(() => {
      if (!fitRaf) fitRaf = requestAnimationFrame(refit)
    })
    ro.observe(el)

    const onWake = () => {
      // A suspended background tab stays let go until it is shown.
      if (document.visibilityState === 'visible' && visible) conn.wake()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('online', onWake)

    api.current = {
      show: () => {
        visible = true
        if (hideTimer) window.clearTimeout(hideTimer)
        hideTimer = 0
        conn.wake()
        lastGeom = ''
        refit()
        if (webglLost || !webgl) scheduleWebgl()
        term.focus()
      },
      hide: () => {
        visible = false
        if (hideTimer) window.clearTimeout(hideTimer)
        hideTimer = window.setTimeout(() => {
          conn.suspend()
          dropWebgl()
        }, HIDDEN_DISCONNECT_MS)
      },
      scrollToBottom: () => {
        term.scrollToBottom()
        term.focus()
      },
    }
    conn.start()
    return () => {
      disposed = true
      api.current = null
      if (hideTimer) window.clearTimeout(hideTimer)
      if (raf) cancelAnimationFrame(raf)
      if (fitRaf) cancelAnimationFrame(fitRaf)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('online', onWake)
      ro.disconnect()
      dropWebgl()
      input.dispose()
      dataSub.dispose()
      sizeSub.dispose()
      parsedSub.dispose()
      scrollSub.dispose()
      conn.dispose()
      term.dispose()
    }
  }, [sessionId])

  useEffect(() => {
    if (active) api.current?.show()
    else api.current?.hide()
  }, [active, sessionId])

  return (
    <div className="relative h-full w-full bg-term-bg">
      {/* The padding is on a wrapper: FitAddon measures the host's parent box. */}
      <div className="absolute inset-0 pl-3 pt-2 pr-1 pb-1">
        <div ref={host} data-term-host className="h-full w-full" />
      </div>
      {phase === 'waiting' && status !== 'ended' && (
        <div role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="mono text-[12px]" style={{ color: TERMINAL_THEME.foreground, opacity: 0.6 }}>
            {status === 'reconnecting' ? 'Connecting to the session…' : 'Starting…'}
          </p>
        </div>
      )}
      {(status === 'reconnecting' || status === 'revoked') && phase === 'ready' && (
        <div className="pointer-events-none absolute right-3 top-2 app-fade-in">
          <span className="mono rounded-full border border-white/10 bg-black/40 px-2.5 py-1 text-[11px] text-[#e7bb63] backdrop-blur-sm">
            {status === 'revoked' ? 'This device can no longer type here' : 'Reconnecting…'}
          </span>
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
        <NewPill count={newLines} unit={newLines === 1 ? 'new line' : 'new lines'} onJump={() => api.current?.scrollToBottom()} />
      </div>
    </div>
  )
}
