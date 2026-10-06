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
 * - **Find** (F16): ⌘F in the focused pane of the tab in front opens the bar
 *   (TerminalFind) over the official search addon.
 * - **Appearance** (F21): palette, font, size, line height and cursor come
 *   from lib/termprefs and change in place, in every pane, when Settings does.
 */
import { useEffect, useRef, useState } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { deviceToken } from '@/lib/api'
import { TermClient, type TermState } from '@/lib/termv2'
import { attachTerminalInput } from '@/lib/xtermInput'
import { FIND_EVENT, matchAppShortcut } from '@/lib/appkeys'
import { isMacPlatform } from '@/lib/appmode'
import { registerBenchTerminal } from '@/lib/benchhook'
import { WEBGL_QUIET_MS } from './Terminal'
import { NewPill } from './NewPill'
import { TerminalFind, type TermSearch } from './TerminalFind'
import { getTerminalPrefs, subscribeTerminalPrefs, xtermOptions, type TerminalPrefs } from '@/lib/termprefs'
import { searchColors, terminalTheme } from '@/lib/termthemes'

export { APP_TERMINAL_THEME } from '@/lib/termthemes'


/** A tab out of sight this long drops its socket. */
export const HIDDEN_DISCONNECT_MS = 30_000

export interface PaneStatus {
  status: TermState
  protocol?: 'v1' | 'v2'
  cols: number
  rows: number
}

export function TerminalPane({
  sessionId,
  active,
  focused = true,
  onStatus,
}: {
  sessionId: string
  /** The tab is in front and the workspace is showing. */
  active: boolean
  /** The pane the keyboard goes to, in a tab split into several (F15). */
  focused?: boolean
  onStatus?: (s: PaneStatus) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const api = useRef<{ show: () => void; hide: () => void; scrollToBottom: () => void; focus: () => void } | null>(null)
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  const [phase, setPhase] = useState<'waiting' | 'ready'>('waiting')
  const [status, setStatus] = useState<TermState>('connecting')
  const [newLines, setNewLines] = useState(0)
  const [foreground, setForeground] = useState(() => terminalTheme(getTerminalPrefs().theme).colors.foreground)
  // The find bar: open or not, the token that refocuses it, the addon's count.
  const [find, setFind] = useState<{ open: boolean; token: number }>({ open: false, token: 0 })
  const [results, setResults] = useState<{ index: number; count: number } | null>(null)
  const searchRef = useRef<TermSearch | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus

  useEffect(() => {
    const el = host.current
    if (!el) return
    const isMac = isMacPlatform()
    const css = getComputedStyle(document.documentElement)
    // The resolved stack, never var(): xterm hands this to a canvas, which
    // does not resolve custom properties (see Terminal.tsx).
    const monoStack = css.getPropertyValue('--font-mono').trim() || 'monospace'
    let prefs: TerminalPrefs = getTerminalPrefs()
    const term = new Xterm({
      ...xtermOptions(prefs, monoStack),
      cursorBlink: true,
      cursorWidth: 2,
      scrollback: 10000,
      macOptionIsMeta: true,
      // The search addon highlights matches with decorations, which xterm 6
      // still files under its proposed API.
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    const search = new SearchAddon({ highlightLimit: 1000 })
    term.loadAddon(search)
    term.open(el)
    const unbench = registerBenchTerminal(sessionId, term)
    const resultsSub = search.onDidChangeResults((r) => setResults({ index: r.resultIndex, count: r.resultCount }))
    const decorations = () => ({ decorations: searchColors(terminalTheme(prefs.theme)) })
    searchRef.current = {
      next: (q, o) => search.findNext(q, { ...o, ...decorations() }),
      prev: (q, o) => search.findPrevious(q, { ...o, ...decorations() }),
      clear: () => {
        search.clearDecorations()
        setResults(null)
      },
    }
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
      const geom = `${el.clientWidth}x${el.clientHeight}:${grid?.clientHeight ?? 0}`
      if (geom === lastGeom) return
      lastGeom = geom
      try { fit.fit() } catch { /* not laid out */ }
    }
    const ro = new ResizeObserver(() => {
      if (!fitRaf) fitRaf = requestAnimationFrame(refit)
    })
    ro.observe(el)
    // The grid too: the late WebGL swap changes the cell height but keeps the
    // row count, so the grid outgrows an unchanged box and its last rows are
    // cut off. Its new size is a reason to fit (as in Terminal.tsx).
    const grid = term.element?.querySelector('.xterm-screen')
    if (grid) ro.observe(grid)

    const onWake = () => {
      // A suspended background tab stays let go until it is shown.
      if (document.visibilityState === 'visible' && visible) conn.wake()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('online', onWake)

    const unprefs = subscribeTerminalPrefs((next) => {
      prefs = next
      Object.assign(term.options, xtermOptions(next, monoStack))
      setForeground(terminalTheme(next.theme).colors.foreground)
      // A new face or size is a new cell: fit again so the columns are right.
      lastGeom = ''
      if (visible) refit()
    })

    api.current = {
      show: () => {
        visible = true
        if (hideTimer) window.clearTimeout(hideTimer)
        hideTimer = 0
        conn.wake()
        lastGeom = ''
        refit()
        if (webglLost || !webgl) scheduleWebgl()
        if (focusedRef.current) term.focus()
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
      focus: () => term.focus(),
    }
    // ⌘F: only the pane the keyboard is in, in the tab in front.
    const onFind = () => {
      if (!activeRef.current || !focusedRef.current) return
      setFind((f) => ({ open: true, token: f.token + 1 }))
    }
    window.addEventListener(FIND_EVENT, onFind)
    conn.start()
    return () => {
      disposed = true
      api.current = null
      searchRef.current = null
      window.removeEventListener(FIND_EVENT, onFind)
      unprefs()
      resultsSub.dispose()
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
      unbench()
      term.dispose()
    }
  }, [sessionId])

  useEffect(() => {
    if (active) api.current?.show()
    else api.current?.hide()
  }, [active, sessionId])

  useEffect(() => {
    if (active && focused) api.current?.focus()
  }, [active, focused])

  return (
    <div className="relative h-full w-full bg-term-bg">
      {/* The padding is on a wrapper: FitAddon measures the host's parent box. */}
      <div className="absolute inset-0 pl-3 pt-2 pr-1 pb-1">
        <div ref={host} data-term-host className="h-full w-full" />
      </div>
      {phase === 'waiting' && status !== 'ended' && (
        <div role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="mono text-[12px]" style={{ color: foreground, opacity: 0.6 }}>
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
      {find.open && searchRef.current && (
        <TerminalFind
          search={searchRef.current}
          results={results}
          focusToken={find.token}
          onClose={() => {
            searchRef.current?.clear()
            setFind((f) => ({ ...f, open: false }))
            api.current?.focus()
          }}
        />
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
        <NewPill count={newLines} unit={newLines === 1 ? 'new line' : 'new lines'} onJump={() => api.current?.scrollToBottom()} />
      </div>
    </div>
  )
}
