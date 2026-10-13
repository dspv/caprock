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
 * - **A hidden tab does no terminal work** — nor does the tab in front while
 *   the window is out of sight, and no cursor blinks then. Once its first output has been
 *   drawn, what arrives while it is out of sight is held and handed to xterm
 *   when it is shown (past HIDDEN_HOLD_BYTES the socket is let go and the
 *   daemon keeps the rest). xterm redraws every row of a hidden DOM-rendered
 *   terminal on each scroll and re-measures each glyph in a `display: none`
 *   box, so one background tab printing 20 lines a second cost 12% of the
 *   page's main thread while the person typed in another (bench, 2026-10-09).
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
 * - **The face** (lib/termfont): every subset of JetBrains Mono is asked for
 *   before the terminal opens, and a face finishing its load re-measures the
 *   cell and rebuilds the WebGL atlas.
 * - **The composer** (components/Composer.tsx), when switched on and the
 *   session is an agent Caprock started: a box under the terminal, inside the
 *   pane. The tree has the same shape with it or without it, so switching it
 *   never remounts the terminal's host.
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
import { writeSliced } from '@/lib/termwrite'
import { attachTerminalLinks } from '@/lib/termlinks'
import { lineFor, markOf, saveScroll, takeScroll } from '@/lib/termresume'
import { APP_UPDATE_EVENT } from '@/lib/appupdate'
import { WEBGL_QUIET_MS } from './Terminal'
import { NewPill } from './NewPill'
import { Composer } from './Composer'
import { TerminalFind, type TermSearch } from './TerminalFind'
import { getTerminalPrefs, subscribeTerminalPrefs, xtermOptions, type TerminalPrefs } from '@/lib/termprefs'
import { searchColors, terminalTheme } from '@/lib/termthemes'
import { loadTerminalFont, watchTerminalFont } from '@/lib/termfont'
import { blinkWhileVisible, pageHidden } from '@/lib/visible'

export { APP_TERMINAL_THEME } from '@/lib/termthemes'


/** A tab out of sight this long drops its socket. */
export const HIDDEN_DISCONNECT_MS = 30_000

/** Output held for a hidden tab before its socket is let go and the daemon keeps the rest. */
export const HIDDEN_HOLD_BYTES = 256 * 1024

/**
 * How long a terminal's first output may run before what comes next is held
 * while hidden: the replay a tab opens with is drawn in the background, as it
 * always was, so the first switch to it paints a finished screen.
 */
export const SETTLE_MS = 3000

/** The composer under the terminal: absent, there is none (.ai/21-app.md § Composer). */
export interface PaneComposer {
  agent?: string
  /** A permission prompt is open in the terminal. */
  asking: boolean
}

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
  onExit,
  composer,
}: {
  sessionId: string
  /** The tab is in front and the workspace is showing. */
  active: boolean
  /** The pane the keyboard goes to, in a tab split into several (F15). */
  focused?: boolean
  onStatus?: (s: PaneStatus) => void
  /**
   * The session's program exited (`/exit`, a crash, `exit` in a shell). The
   * tab is the user's place to work, not a record of a dead process, so the
   * workspace puts a shell in the same folder here.
   */
  onExit?: (code: number) => void
  composer?: PaneComposer
}) {
  const host = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
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
  const filesRef = useRef<((files: File[]) => Promise<void>) | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit

  useEffect(() => {
    const el = host.current
    if (!el) return
    const isMac = isMacPlatform()
    const css = getComputedStyle(document.documentElement)
    // The resolved stack, never var(): xterm hands this to a canvas, which
    // does not resolve custom properties (see Terminal.tsx).
    const monoStack = css.getPropertyValue('--font-mono').trim() || 'monospace'
    let prefs: TerminalPrefs = getTerminalPrefs()
    // Every subset of the face, asked for before the terminal opens and
    // measures its cell (lib/termfont). It used to wait on document.fonts.ready
    // alone, which resolves at once when nothing was asked for: the cell was
    // measured on the fallback and glyphs rasterised mid-load stayed in the
    // WebGL atlas in the wrong weight.
    loadTerminalFont()
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
    const unblink = blinkWhileVisible(term, true)
    const unbench = registerBenchTerminal(sessionId, term)
    // URLs and OSC 8 links open on Cmd/Ctrl+click (lib/termlinks).
    const links = attachTerminalLinks(term)
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

    let disposed = false
    let visible = false
    let gotOutput = false
    let lastInput = 0
    let webgl: WebglAddon | undefined
    let webglLost = false
    let webglTimer = 0
    let hideTimer = 0
    // Output that arrived while hidden, after the first burst (see the header),
    // and a reset among it, in the order they came.
    let held: ({ data: Uint8Array | string; done: () => void } | { reset: true })[] = []
    let heldBytes = 0
    let settled = false
    let settleTimer = 0
    let settleBy = 0
    const settle = () => {
      const now = Date.now()
      if (!settleBy) settleBy = now + SETTLE_MS
      if (settleTimer) window.clearTimeout(settleTimer)
      // Settled when the output pauses, or SETTLE_MS after it began.
      settleTimer = window.setTimeout(() => { settleTimer = 0; settled = true }, Math.max(0, Math.min(400, settleBy - now)))
    }
    const flushHeld = () => {
      const out = held
      held = []
      heldBytes = 0
      for (const h of out) {
        if ('reset' in h) term.reset()
        else writeSliced(term, h.data, h.done)
      }
      if (out.length) scheduleResume()
    }
    // The window out of sight holds the tab in front's output too (a hidden
    // window does no work): parsed and drawn at once when it is shown.
    const holding = () => (!visible || pageHidden()) && settled

    const report = (s: TermState) => {
      setStatus(s)
      onStatusRef.current?.({ status: s, protocol: conn.protocol, cols: term.cols, rows: term.rows })
    }
    // F20: where this terminal was scrolled when the app restarted into an
    // update, given back once its scrollback has been replayed — when the
    // output pauses, or 3 s after it began, whichever is first.
    let resume = takeScroll(sessionId)
    let resumeTimer = 0
    let resumeBy = 0
    const applyResume = () => {
      resumeTimer = 0
      const mark = resume
      resume = undefined
      if (!mark || disposed) return
      term.write('', () => {
        const b = term.buffer.active
        if (b.viewportY < b.baseY) return // scrolled by hand meanwhile
        term.scrollToLine(lineFor(mark, b.baseY, term.rows))
      })
    }
    const scheduleResume = () => {
      if (!resume) return
      const now = Date.now()
      if (!resumeBy) resumeBy = now + 3000
      if (resumeTimer) window.clearTimeout(resumeTimer)
      resumeTimer = window.setTimeout(applyResume, Math.max(0, Math.min(400, resumeBy - now)))
    }
    const onAppUpdate = (e: Event) => {
      if ((e as CustomEvent<{ phase?: string }>).detail?.phase !== 'installing') return
      const b = term.buffer.active
      saveScroll(sessionId, markOf(b.viewportY, b.baseY, term.rows))
    }
    window.addEventListener(APP_UPDATE_EVENT, onAppUpdate)

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
          if (holding()) {
            held.push({ data: d, done })
            heldBytes += d.length
            // The daemon keeps the rest, and the tab resumes from here when shown.
            if (heldBytes > HIDDEN_HOLD_BYTES) conn.suspend()
            return
          }
          if (!settled) settle()
          writeSliced(term, d, done)
          scheduleResume()
        },
        // Clears the screen and every mode a dead TUI left on (mouse tracking,
        // bracketed paste, the alternate screen) before a repaint.
        reset: () => {
          if (!holding()) { term.reset(); return }
          // What was held is cleared by the reset: let it go, parsed as far
          // as the client's flow control is concerned, and keep the reset.
          for (const h of held) if (!('reset' in h)) h.done()
          held = [{ reset: true }]
          heldBytes = 0
        },
        state: report,
        open: () => {
          try { if (visible) fit.fit() } catch { /* not laid out */ }
          conn.resize(term.cols, term.rows)
          report(conn.state)
        },
        exit: (code) => onExitRef.current?.(code),
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
    filesRef.current = input.sendFiles

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
      if (document.visibilityState !== 'visible' || !visible) return
      // What the window held while out of sight, before anything newer.
      flushHeld()
      conn.wake()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('online', onWake)

    // One PTY, several terminals (this app, a phone): it is the size of the
    // one in use (internal/api/termsize.go). Typing claims it on the daemon's
    // side; looking claims it here — the window gaining focus or coming back
    // into view, this tab coming to the front (show), a click in the pane.
    // Without it a phone that typed into the session left the agent drawn
    // 45 columns wide in this pane until its box next changed (Vova,
    // 2026-10-12).
    //
    // The claim carries the pane's size now, so a PTY left at a phone's size
    // by a detach the daemon never heard of is put right by looking. Focus
    // anywhere in the pane counts — the composer too, which types over HTTP
    // and so never claims on the daemon's side. And out of sight (this tab
    // behind another, the window hidden, the page going away) gives the PTY
    // back to a terminal still in sight at once (Vova, 2026-10-13).
    const claim = () => { if (visible && document.visibilityState === 'visible') conn.focus(term.cols, term.rows) }
    const away = () => { if (document.visibilityState === 'hidden') conn.blur() }
    const gone = () => conn.blur()
    window.addEventListener('focus', claim)
    document.addEventListener('visibilitychange', claim)
    document.addEventListener('visibilitychange', away)
    window.addEventListener('pagehide', gone)
    el.addEventListener('pointerdown', claim)
    const wrap = wrapRef.current
    wrap?.addEventListener('focusin', claim)

    // A face finishing its load: measure the cell again, drop the atlas,
    // repaint, and fit to the new cell.
    const unfont = watchTerminalFont(term, () => {
      lastGeom = ''
      if (visible) refit()
    })

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
        // What was held goes to xterm before anything newer the socket brings.
        flushHeld()
        conn.wake()
        lastGeom = ''
        refit()
        if (webglLost || !webgl) scheduleWebgl()
        if (focusedRef.current) term.focus()
        claim()
      },
      hide: () => {
        visible = false
        conn.blur()
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
      filesRef.current = null
      window.removeEventListener(FIND_EVENT, onFind)
      window.removeEventListener(APP_UPDATE_EVENT, onAppUpdate)
      if (resumeTimer) window.clearTimeout(resumeTimer)
      if (settleTimer) window.clearTimeout(settleTimer)
      held = []
      unprefs()
      unblink()
      unfont()
      resultsSub.dispose()
      if (hideTimer) window.clearTimeout(hideTimer)
      if (raf) cancelAnimationFrame(raf)
      if (fitRaf) cancelAnimationFrame(fitRaf)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('online', onWake)
      window.removeEventListener('focus', claim)
      document.removeEventListener('visibilitychange', claim)
      el.removeEventListener('pointerdown', claim)
      document.removeEventListener('visibilitychange', away)
      window.removeEventListener('pagehide', gone)
      wrap?.removeEventListener('focusin', claim)
      ro.disconnect()
      dropWebgl()
      input.dispose()
      dataSub.dispose()
      sizeSub.dispose()
      parsedSub.dispose()
      scrollSub.dispose()
      conn.dispose()
      unbench()
      links.dispose()
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
    // One shape with the composer or without it (the header): the inner box
    // fills the outer exactly when there is none.
    <div ref={wrapRef} className="relative flex h-full w-full flex-col bg-term-bg">
    <div className="relative min-h-0 w-full flex-1">
      {/* The padding is on a wrapper: FitAddon measures the host's parent box. */}
      <div className="absolute inset-0 pl-3 pt-2 pr-1 pb-1">
        <div ref={host} data-term-host data-term-session={sessionId} className="h-full w-full" />
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
    {composer && (
      <Composer
        sessionId={sessionId}
        agent={composer.agent}
        asking={composer.asking}
        onFiles={(files) => { void filesRef.current?.(files) }}
        onBack={() => api.current?.focus()}
      />
    )}
    </div>
  )
}
