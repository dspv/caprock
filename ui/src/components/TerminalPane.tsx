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
 *   The window out of sight for PAGE_HIDDEN_SUSPEND_MS lets every socket go,
 *   so no output is sent to it at all, and resumes from the last byte held
 *   when shown (lib/visible suspendWhileHidden).
 * - **A flood is written ~30 times a second** (DESK_WRITE_MS): chunks that
 *   arrive meanwhile go to xterm in one write, in order; the first after a
 *   quiet spell goes at once.
 * - **WebGL, late and recoverable.** Swapped in after the first output once
 *   typing pauses (as in the dashboard). A lost context — a sleep and wake,
 *   a GPU reset, WebKit letting it go with or without the event — is dropped
 *   the moment it is heard or found (lib/termgl), the DOM renderer drawing
 *   that frame, and re-created after the quiet wait or when the tab is next
 *   shown: never a dead canvas holding the last screen.
 * - **Switching tabs shows the terminal as it was.** The owner saw the font
 *   "redrawn from scratch" for a moment on a switch (2026-10-14): a tab
 *   hidden for 30 s had dropped its WebGL renderer, so it came back drawn by
 *   the DOM renderer — another rasterisation, another cell height — and 1.5 s
 *   later (WEBGL_QUIET_MS) WebGL was swapped in and the grid refitted. Now
 *   the KEEP_WEBGL_HIDDEN most recently hidden panes keep their context, so
 *   going back and forth never swaps a renderer, and ten tabs still never
 *   hold ten GPU contexts: the pane hidden longest ago lets its go. A pane
 *   with output and no WebGL gets it in show() itself, before the first
 *   paint, and is drawn in that same frame (`paintNow`): the quiet wait is
 *   for first output and typing, not for coming back into view. The glyph
 *   atlas is not rasterised again on a plain switch (`repaintGlyphs`), but
 *   it is sent to the GPU again (`reuploadGlyphs`): WebKit can drop a hidden
 *   canvas's texture, and the tab came back garbled until a new glyph made
 *   the addon upload a page (owner, 2026-10-14). A pane whose box did not
 *   change is not refitted.
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
 * - **Quick replies** (components/QuickReplies.tsx): a row of one-click
 *   replies under the terminal of a session Caprock started, above the
 *   composer when it is on; a sibling after the terminal's box, so it never
 *   remounts the host.
 * - **Where you type** (lib/terminputbox): in a Claude Code session, the rows
 *   of its input box sit on a faint band, found again after each parsed
 *   write from the bottom rows alone; another agent or a shell gets none.
 * - **An agent's update command** (lib/termupdate): Codex's or Claude Code's
 *   "update available" notice gets a small bar near the bottom — Copy
 *   command, Open a terminal (a plain shell tab, nothing typed), × — and the
 *   printed command is never run.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { deviceToken } from '@/lib/api'
import { TermClient, type TermState } from '@/lib/termv2'
import { offersManualRetry, type LinkStatus } from '@/lib/reconnect'
import { useNow } from '@/lib/useNow'
import { readLink } from './ConnectionState'
import { attachTerminalInput } from '@/lib/xtermInput'
import { FIND_EVENT, INPUT_HIGHLIGHT_KEY, keys, ownsTerminalKey, watchChordArrows } from '@/lib/appkeys'
import { isMacPlatform } from '@/lib/appmode'
import { registerBenchTerminal } from '@/lib/benchhook'
import { coalescedWriter, DESK_WRITE_MS } from '@/lib/termwrite'
import { attachTerminalLinks } from '@/lib/termlinks'
import { requestOpenPath } from '@/lib/mdreader'
import { lineFor, markOf, saveScroll, takeScroll } from '@/lib/termresume'
import { APP_UPDATE_EVENT } from '@/lib/appupdate'
import { WEBGL_QUIET_MS } from './Terminal'
import { NewPill } from './NewPill'
import { Composer } from './Composer'
import { QuickReplies } from './QuickReplies'
import { TerminalFind, type TermSearch } from './TerminalFind'
import { getTerminalPrefs, subscribeTerminalPrefs, xtermOptions, type TerminalPrefs } from '@/lib/termprefs'
import { searchColors, terminalTheme } from '@/lib/termthemes'
import { checkTerminalCell, clearGlyphAtlas, loadTerminalFont, watchTerminalFont } from '@/lib/termfont'
import { healAtlasMerges, reuploadGlyphs } from '@/lib/termatlas'
import { contextGone, watchContextLoss } from '@/lib/termgl'
import { blinkWhileVisible, pageHidden, suspendWhileHidden } from '@/lib/visible'
import { attachInputBoxBand, type InputBoxBand } from '@/lib/terminputbox'
import { attachUpdateWatch, dismissNotice, requestShellBeside, type UpdateNotice } from '@/lib/termupdate'
import { UpdateNoticeBar } from './UpdateNoticeBar'
import { newShellCloseKey, newShellHintText, onlyPrompt } from '@/lib/newshellhint'

export { APP_TERMINAL_THEME } from '@/lib/termthemes'
export { reuploadGlyphs } from '@/lib/termatlas'


/** A tab out of sight this long drops its socket. */
export const HIDDEN_DISCONNECT_MS = 30_000

/** Output held for a hidden tab before its socket is let go and the daemon keeps the rest. */
export const HIDDEN_HOLD_BYTES = 256 * 1024

/**
 * How long a terminal's first output may run before what comes next is held
 * while hidden: the replay a tab opens with is drawn in the background once
 * the pane has been fitted, so a switch to it paints a finished screen. A
 * pane never yet laid out holds even that (see `fitted` below).
 */
export const SETTLE_MS = 3000

/**
 * Hidden panes that keep their WebGL renderer, the most recently hidden
 * first; the panes in front are not counted. A context per pane would run
 * into the browser's cap (about 16 a page) and each holds a drawing buffer
 * the size of its pane; three covers going back and forth between a few tabs.
 */
export const KEEP_WEBGL_HIDDEN = 3

/**
 * A pane hidden longer than this rasterises its glyphs again when shown.
 * WebKit can drop a WebGL texture of a page left alone without a contextlost
 * event (#541); a sleep and a pixel-ratio change are caught by their own
 * events, this covers the rest. Five minutes keeps every quick back-and-forth
 * free of the work; after a longer spell it costs a few milliseconds, once.
 */
export const LONG_HIDDEN_MS = 5 * 60_000

/**
 * The window back in focus after at least this long in the background
 * re-sends the pane's glyph atlas to the GPU (`reuploadGlyphs`): a cheap
 * self-heal for a texture WebKit let go, never on a quick switch of apps.
 */
export const FOCUS_HEAL_MS = 30_000

type Kept = { drop: () => void }
const keptWebgl: Kept[] = []
function releaseWebgl(p: Kept) {
  const i = keptWebgl.indexOf(p)
  if (i >= 0) keptWebgl.splice(i, 1)
}
/** `p` was just hidden with WebGL: keep it, and let the one hidden longest ago go past the cap. */
function keepWebgl(p: Kept) {
  releaseWebgl(p)
  keptWebgl.unshift(p)
  while (keptWebgl.length > KEEP_WEBGL_HIDDEN) keptWebgl.pop()!.drop()
}
/** How many hidden panes hold a WebGL context now. */
export function keptWebglCount(): number {
  return keptWebgl.length
}

/**
 * Draws a pane that has just come into view in the frame it appears in.
 * xterm stops rendering while its element is out of sight and starts again
 * from an IntersectionObserver callback, which arrives a frame after the
 * element is shown: a WebGL canvas created on show would be blank for that
 * frame. Told it is in view now (the callback it gets anyway, early), it draws
 * on the next animation frame, before the paint. Measured in headless
 * Chromium with xterm 6 (2026-10-14): without it, a pane given WebGL on show
 * drew one blank frame first; with it, none.
 *
 * `_handleIntersectionChange` is xterm's private API, so every step is
 * optional and the call is in a try: an xterm upgrade that renames or drops
 * it cannot throw here, and the pane falls back to waiting for the observer
 * (one blank frame, nothing worse).
 */
function paintNow(term: Xterm) {
  const rs = (term as unknown as { _core?: { _renderService?: { _handleIntersectionChange?: (e: { isIntersecting: boolean; intersectionRatio: number }) => void } } })._core?._renderService
  try { rs?._handleIntersectionChange?.({ isIntersecting: true, intersectionRatio: 1 }) } catch { /* another xterm */ }
  term.refresh(0, term.rows - 1)
}

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
  quickReplies = false,
  inputBox = false,
  shellHint = false,
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
  /** A session Caprock started: the quick replies under its terminal (rule 7; lib/quickReplies). */
  quickReplies?: boolean
  /** A Claude Code session: its input box gets the faint band (lib/terminputbox). */
  inputBox?: boolean
  /**
   * A shell tab: while it holds nothing but its prompt, one dim line under
   * the prompt says what to run and how to close the tab (lib/newshellhint).
   * An overlay; nothing is written into the PTY.
   */
  shellHint?: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const api = useRef<{ show: () => void; hide: () => void; scrollToBottom: () => void; focus: () => void } | null>(null)
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  const [phase, setPhase] = useState<'waiting' | 'ready'>('waiting')
  const [status, setStatus] = useState<TermState>('connecting')
  // The retry status behind `status`, for the honest badge (ReconnectBadge).
  const [link, setLink] = useState<LinkStatus>({ phase: 'connecting', attempt: 0, nextAt: null, downSince: null })
  const connRef = useRef<TermClient | null>(null)
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
  const bandRef = useRef<InputBoxBand | null>(null)
  const inputBoxRef = useRef(inputBox)
  inputBoxRef.current = inputBox
  // The highlight where you type, as the user set it (⌥⌘G), and the key's
  // hint on the box's top rule while the pointer is over the box.
  const [highlightOn, setHighlightOn] = useState(() => getTerminalPrefs().highlightInput)
  const [ground, setGround] = useState(() => terminalTheme(getTerminalPrefs().theme).colors.background)
  const [boxHint, setBoxHint] = useState<{ top: number; height: number } | null>(null)
  // An agent's "update available" notice, found in the output (lib/termupdate).
  const [update, setUpdate] = useState<UpdateNotice | null>(null)
  // The new shell's hint, where it sits (lib/newshellhint); null when not shown.
  const [shellLine, setShellLine] = useState<{ top: number; left: number } | null>(null)
  const shellHintRef = useRef(shellHint)
  shellHintRef.current = shellHint

  useEffect(() => {
    const el = host.current
    if (!el) return
    const isMac = isMacPlatform()
    watchChordArrows(isMac)
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
    // URLs and OSC 8 links open on Cmd/Ctrl+click (lib/termlinks); a `.md`
    // path opens in a file tab, resolved against this session's folder.
    const links = attachTerminalLinks(term, { onPath: (path) => requestOpenPath({ path, sessionId }) })
    const band = attachInputBoxBand(term)
    bandRef.current = band
    band.setLook({ shown: prefs.highlightInput, strength: prefs.highlightStrength })
    band.setEnabled(inputBoxRef.current)
    const updates = attachUpdateWatch(term, setUpdate)
    // Pointing at Claude Code's input box shows, on its top rule, the key
    // that hides or brings back its band: where the eye already is.
    let pointerY: number | null = null
    let hintRaf = 0
    let hintKey = ''
    const placeHint = () => {
      hintRaf = 0
      const box = pointerY === null ? null : band.boxRows()
      const screen = el.querySelector<HTMLElement>('.xterm-screen')
      let next: { top: number; height: number } | null = null
      if (box && screen && wrapRef.current && term.rows > 0) {
        const r = screen.getBoundingClientRect()
        const cell = r.height / term.rows
        const top = term.buffer.active.viewportY
        const line = top + Math.floor((pointerY! - r.top) / cell)
        if (cell > 0 && line >= box.first && line <= box.last) {
          const offset = r.top - wrapRef.current.getBoundingClientRect().top
          next = { top: Math.round(offset + Math.max(0, box.first - 1 - top) * cell), height: Math.round(cell) }
        }
      }
      const k = next ? `${next.top},${next.height}` : ''
      if (k !== hintKey) { hintKey = k; setBoxHint(next) }
    }
    const queueHint = () => { if (!hintRaf) hintRaf = requestAnimationFrame(placeHint) }
    const onPointerMove = (e: MouseEvent) => { pointerY = e.clientY; queueHint() }
    const onPointerLeave = () => { pointerY = null; queueHint() }
    el.addEventListener('mousemove', onPointerMove)
    el.addEventListener('mouseleave', onPointerLeave)
    // The new shell's hint: under the prompt while the shell holds nothing
    // else, gone for good at the first key typed or the first output that
    // moves the cursor past the prompt's rows. Placed once a frame at most.
    let shellGone = false
    let shellRaf = 0
    let shellKey = ''
    const placeShell = () => {
      shellRaf = 0
      let next: { top: number; left: number } | null = null
      const b = term.buffer.active
      if (!shellGone && !onlyPrompt(b)) shellGone = true
      if (!shellGone && shellHintRef.current && gotOutput && wrapRef.current && term.rows > 0) {
        const screen = el.querySelector<HTMLElement>('.xterm-screen')
        const r = (screen ?? el).getBoundingClientRect()
        const w = wrapRef.current.getBoundingClientRect()
        const cell = r.height / term.rows
        const row = b.baseY + (b.cursorY ?? 0) - b.viewportY + 1
        next = { top: Math.round(r.top - w.top + Math.max(0, row) * cell), left: Math.round(r.left - w.left) }
      }
      const k = next ? `${next.top},${next.left}` : ''
      if (k !== shellKey) { shellKey = k; setShellLine(next) }
    }
    const queueShell = () => { if (!shellRaf && !shellGone) shellRaf = requestAnimationFrame(placeShell) }
    const dropShell = () => {
      if (shellGone) return
      shellGone = true
      if (shellRaf) { cancelAnimationFrame(shellRaf); shellRaf = 0 }
      shellKey = ''
      setShellLine(null)
    }
    // A key typed into the terminal, or a paste; an app chord (⌘1, ⌘T…) is
    // not typing into this tab.
    const onShellKey = (e: KeyboardEvent) => {
      if (['Meta', 'Control', 'Shift', 'Alt', 'CapsLock'].includes(e.key) || e.metaKey) return
      if (ownsTerminalKey(e, isMac)) return
      dropShell()
    }
    el.addEventListener('keydown', onShellKey, true)
    el.addEventListener('paste', dropShell, true)
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
    // Fitted to its pane at least once. Until then xterm is at its default
    // 80×24 — a tab restored behind another has never been laid out, and a
    // `display: none` box measures nothing — and the replay it opens with
    // was drawn at the PTY's width. Claude Code draws its prompt and status
    // rows with cursor moves counted for that width, so the same bytes parsed
    // 80 columns wide wrap where they should not, the moves land on the
    // wrong rows, and the copies they leave behind are baked into the
    // scrollback: reflowing to the real width later cannot undo them. Rules
    // smeared across the screen, the status rows repeated, fragments at the
    // far right, seen on scrolling up (user report, 2026-10-13). So a pane
    // not yet fitted writes nothing and tells the daemon no size; what
    // arrives is held, and written once it has its real size.
    let fitted = false
    let gotOutput = false
    let lastInput = 0
    let webgl: WebglAddon | undefined
    // What drops `webgl` when its context is gone (loadWebgl), and the
    // listener that hears the loss at once (lib/termgl).
    let webglLost: (() => void) | undefined
    let unwatchGl = () => {}
    let webglTimer = 0
    let hideTimer = 0
    // The box last fitted to (refit, below).
    let lastGeom = ''
    // When the pane was last hidden, and whether its atlas is to be
    // rasterised again before it is next seen (a wake or a pixel-ratio change
    // came while it was hidden).
    let hiddenAt = 0
    let glyphsStale = false
    const kept: Kept = { drop: () => { if (!visible) dropWebgl() } }
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
    // Output reaches xterm at most every DESK_WRITE_MS, what came meanwhile
    // in one write, every byte in order (lib/termwrite coalescedWriter): a
    // session printing 20 lines a second under a 12 fps spinner was parsed
    // and painted on every chunk (docs/app-window-footprint-2026-10-19.md).
    // The first write after a quiet spell goes at once, so an echo is not
    // delayed.
    const out = coalescedWriter(term, DESK_WRITE_MS)
    const flushHeld = () => {
      if (!fitted) return
      const was = held
      held = []
      heldBytes = 0
      for (const h of was) {
        if ('reset' in h) { out.drop(); term.reset() }
        else out.write(h.data, h.done)
      }
      if (was.length) scheduleResume()
    }
    // The window out of sight holds the tab in front's output too (a hidden
    // window does no work): parsed and drawn at once when it is shown.
    const holding = () => !fitted || ((!visible || pageHidden()) && settled)

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
            if (fitNow()) conn.resize(term.cols, term.rows)
          }
          if (holding()) {
            held.push({ data: d, done })
            heldBytes += d.length
            // The daemon keeps the rest, and the tab resumes from here when shown.
            if (heldBytes > HIDDEN_HOLD_BYTES) conn.suspend()
            return
          }
          if (!settled) settle()
          out.write(d, done)
          scheduleResume()
        },
        // Clears the screen and every mode a dead TUI left on (mouse tracking,
        // bracketed paste, the alternate screen) before a repaint.
        reset: () => {
          if (!holding()) { out.drop(); term.reset(); return }
          // What was held is cleared by the reset: let it go, parsed as far
          // as the client's flow control is concerned, and keep the reset.
          for (const h of held) if (!('reset' in h)) h.done()
          held = [{ reset: true }]
          heldBytes = 0
        },
        state: report,
        status: setLink,
        open: () => {
          if (fitNow()) conn.resize(term.cols, term.rows)
          report(conn.state)
        },
        exit: (code) => onExitRef.current?.(code),
      },
    })

    // `now`: on show, with output already drawn — no quiet wait, so the DOM
    // renderer is never what the person sees first (the header).
    const loadWebgl = (now = false): boolean => {
      webglTimer = 0
      if (disposed || webgl || !visible) return false
      if (!now && (!gotOutput || Date.now() - lastInput < WEBGL_QUIET_MS)) {
        webglTimer = window.setTimeout(loadWebgl, WEBGL_QUIET_MS)
        return false
      }
      try {
        const addon = new WebglAddon()
        let gone = false
        // A sleep and wake, a driver reset, or WebKit letting the context go:
        // the DOM renderer draws from this frame on — never a dead canvas
        // holding the last screen while output goes on (lib/termgl) — and a
        // fresh context comes after the quiet wait, or the next time this
        // tab is shown.
        const lost = () => {
          if (gone) return
          gone = true
          if (webgl === addon) { webgl = undefined; webglLost = undefined; unwatchGl(); unwatchGl = () => {} }
          try { addon.dispose() } catch { /* already gone */ }
          releaseWebgl(kept)
          if (disposed || !visible) return
          lastGeom = ''
          refit()
          paintNow(term)
          scheduleWebgl()
        }
        addon.onContextLoss(lost)
        term.loadAddon(addon)
        unwatchGl = watchContextLoss(addon, lost)
        webglLost = lost
        // A page merge in the atlas this terminal shares with every other
        // tab left it drawing from a stale texture unit, for good (lib/termatlas).
        healAtlasMerges(addon, term, () => clearGlyphAtlas(term))
        webgl = addon
        // Another renderer, another cell: fit to it now, not a frame later.
        lastGeom = ''
        refit()
        return true
      } catch {
        // No WebGL here: the DOM renderer keeps drawing.
        return false
      }
    }
    const scheduleWebgl = () => {
      if (!webglTimer) webglTimer = window.setTimeout(loadWebgl, WEBGL_QUIET_MS)
    }
    const dropWebgl = () => {
      if (webglTimer) window.clearTimeout(webglTimer)
      webglTimer = 0
      releaseWebgl(kept)
      if (webgl) lastGeom = ''
      unwatchGl()
      unwatchGl = () => {}
      webglLost = undefined
      webgl?.dispose()
      webgl = undefined
    }
    // A context gone without a word (lib/termgl contextGone): dropped as a
    // loss is. Asked wherever the terminal is looked at again or writes —
    // one boolean, no timer.
    const checkGl = () => {
      if (webgl && webglLost && contextGone(webgl)) webglLost()
    }

    const dataSub = term.onData((d) => {
      lastInput = Date.now()
      conn.send(d)
    })
    const sizeSub = term.onResize(({ cols, rows }) => {
      conn.resize(cols, rows)
      band.update()
      queueShell()
    })
    const input = attachTerminalInput(term, el, (d) => conn.send(d), {
      isAppKey: (e) => ownsTerminalKey(e, isMac),
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
      band.update()
      if (pointerY !== null) queueHint()
      queueShell()
      // Output going to a canvas whose context is gone is output nobody sees.
      if (visible) checkGl()
    })
    const scrollSub = term.onScroll(() => {
      if (atBottom() && pendingNew !== 0) {
        pendingNew = 0
        if (!raf) raf = requestAnimationFrame(publish)
      }
    })

    // Fits the pane when it can be measured: shown, with a width, its cell
    // measured. The first time, the size goes to the daemon and what was held
    // is written, at that size. False while it is still xterm's default.
    const fitNow = (): boolean => {
      if (!visible || el.clientWidth === 0) return false
      try { fit.fit() } catch { return false }
      if (!fitted) {
        if (!fit.proposeDimensions()) return false
        fitted = true
        conn.resize(term.cols, term.rows)
        flushHeld()
        conn.wake()
      }
      return true
    }

    // One fit per frame, only when the size really changed, never while hidden.
    let fitRaf = 0
    const refit = () => {
      fitRaf = 0
      if (!visible || el.clientWidth === 0) return
      const geom = `${el.clientWidth}x${el.clientHeight}:${grid?.clientHeight ?? 0}`
      if (geom === lastGeom) return
      // Kept only once a fit took: a pane not measurable yet tries again on
      // its next show, which no longer forgets the last box (the header).
      if (fitNow()) lastGeom = geom
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

    // WebKit can drop the WebGL glyph atlas's texture on a sleep, a display
    // change or a long hidden spell without firing contextlost: the grid then
    // paints every glyph from a stale atlas — squashed, half-cut letters
    // (owner, 2026-10-13, #541). Rasterising again is cheap but not free to
    // the eye: run on every tab switch, it redrew each glyph of terminals
    // that had nothing wrong with them. So it runs when the window comes back
    // into view, when the pixel ratio changes, and on showing a pane that
    // missed one of those while hidden or was hidden past LONG_HIDDEN_MS.
    const repaintGlyphs = () => {
      glyphsStale = false
      if (!webgl) return
      // Every terminal's, not this one's: the atlas is shared (clearGlyphAtlas).
      clearGlyphAtlas(term)
    }
    let dprQuery: MediaQueryList | undefined
    const onDpr = () => {
      watchDpr()
      if (visible) repaintGlyphs()
      else if (webgl) glyphsStale = true
    }
    const watchDpr = () => {
      dprQuery?.removeEventListener('change', onDpr)
      dprQuery = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`)
      dprQuery?.addEventListener('change', onDpr)
    }
    watchDpr()

    connRef.current = conn
    // The window out of sight for PAGE_HIDDEN_SUSPEND_MS lets the socket go
    // (lib/termv2 suspendWhileHidden); onWake below resumes it from the last
    // byte held, after writing what was held.
    const unsuspend = suspendWhileHidden(conn)
    const onWake = (e: Event) => {
      if (document.visibilityState !== 'visible') return
      // A suspended background tab stays let go until it is shown; a window
      // back in view rasterises its glyphs then.
      if (!visible) {
        if (webgl && e.type === 'visibilitychange') glyphsStale = true
        return
      }
      // What the window held while out of sight, before anything newer.
      flushHeld()
      conn.wake()
      checkGl()
      repaintGlyphs()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('online', onWake)
    // The window clicked or restored after a sleep or a network change need
    // not change its visibility: the socket is checked (one ping) and a
    // waiting retry goes now. Nothing is redrawn for it.
    const onFocusWake = () => {
      if (visible && document.visibilityState === 'visible') conn.wake()
    }
    window.addEventListener('focus', onFocusWake)
    window.addEventListener('pageshow', onFocusWake)

    // The window back in front after a while in the background (another app
    // on top, never hidden, so no visibilitychange): the pane in front sends
    // its atlas to the GPU again and redraws — one upload per page, no
    // rasterising, never on a quick ⌘-Tab and never on a timer.
    //
    // Going, the input box's key hint goes too: it shows while the pointer is
    // over the box, and a pointer that leaves with the window (⌘-Tab, a
    // click in another app) sends no mouseleave, so it stayed over the box
    // and the quick replies under it until the pointer came back and left.
    let blurredAt = 0
    const onBlur = () => {
      blurredAt = Date.now()
      if (pointerY !== null) { pointerY = null; queueHint() }
    }
    const onFocusBack = () => {
      const away = blurredAt > 0 ? Date.now() - blurredAt : 0
      blurredAt = 0
      // Any time: a context that went while the window was behind (one
      // boolean read; nothing drawn when it is alive).
      if (visible) checkGl()
      if (!visible || !webgl || away < FOCUS_HEAL_MS) return
      if (!reuploadGlyphs(webgl)) { repaintGlyphs(); return }
      term.refresh(0, term.rows - 1)
    }
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocusBack)

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
    // Never with xterm's default size: a pane not yet fitted claims without one.
    const claim = () => {
      if (!visible || document.visibilityState !== 'visible') return
      if (fitted) conn.focus(term.cols, term.rows)
      else conn.focus()
    }
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
      setGround(terminalTheme(next.theme).colors.background)
      setHighlightOn(next.highlightInput)
      band.setLook({ shown: next.highlightInput, strength: next.highlightStrength })
      band.update()
      // A new face or size is a new cell: fit again so the columns are right.
      lastGeom = ''
      if (visible) refit()
    })

    api.current = {
      show: () => {
        if (visible) return
        visible = true
        releaseWebgl(kept)
        if (hideTimer) window.clearTimeout(hideTimer)
        hideTimer = 0
        // What was held goes to xterm before anything newer the socket brings.
        flushHeld()
        conn.wake()
        // A context lost while hidden — the addon's own report is held back
        // three seconds, and WebKit may send none — is replaced below, in
        // this frame, rather than shown frozen.
        checkGl()
        // The renderer first, so the fit below measures the cell it draws
        // with. A pane with output never shows the DOM renderer on its way
        // back (the header); one still waiting for its first output takes
        // the quiet path.
        if (!webgl) {
          if (!gotOutput || !loadWebgl(true)) scheduleWebgl()
        } else if (glyphsStale || (hiddenAt > 0 && Date.now() - hiddenAt > LONG_HIDDEN_MS)) {
          repaintGlyphs()
        } else if (!reuploadGlyphs(webgl)) {
          // Every other way back into view — a switch, the tab in front
          // closed, back from the dashboard or the chat — re-sends the atlas
          // to the GPU, rasterising nothing (owner, 2026-10-14: garbled
          // glyphs for about 2 s after closing a tab, and after the chat).
          // WebKit can let the texture of a hidden WebGL canvas go without
          // a contextlost; the atlas canvas it was uploaded from is intact
          // — the screen came right by itself as soon as a new glyph made
          // the addon upload a page again. A re-upload is that, at once.
          repaintGlyphs()
        }
        // A no-op unless the box, the cell or the renderer changed meanwhile:
        // the box hidden reads 0 wide and refit leaves lastGeom alone then.
        refit()
        if (el.clientWidth > 0) paintNow(term)
        // A cell measured while hidden or before the face settled is checked
        // once the pane is on screen (lib/termfont implausibleCell).
        checkTerminalCell(term)
        if (focusedRef.current) term.focus()
        claim()
      },
      hide: () => {
        visible = false
        hiddenAt = Date.now()
        conn.blur()
        // The WebGL context stays while this is among the few panes hidden
        // last (KEEP_WEBGL_HIDDEN); the socket goes after 30 s as before.
        if (webgl) keepWebgl(kept)
        if (hideTimer) window.clearTimeout(hideTimer)
        hideTimer = window.setTimeout(() => conn.suspend(), HIDDEN_DISCONNECT_MS)
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
    // The layout effect below ran first, before there was a terminal to show.
    if (activeRef.current) api.current.show()
    else api.current.hide()
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
      unsuspend()
      out.dispose()
      if (raf) cancelAnimationFrame(raf)
      if (fitRaf) cancelAnimationFrame(fitRaf)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocusBack)
      dprQuery?.removeEventListener('change', onDpr)
      window.removeEventListener('online', onWake)
      window.removeEventListener('focus', onFocusWake)
      window.removeEventListener('pageshow', onFocusWake)
      connRef.current = null
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
      el.removeEventListener('mousemove', onPointerMove)
      el.removeEventListener('mouseleave', onPointerLeave)
      el.removeEventListener('keydown', onShellKey, true)
      el.removeEventListener('paste', dropShell, true)
      if (hintRaf) cancelAnimationFrame(hintRaf)
      if (shellRaf) cancelAnimationFrame(shellRaf)
      band.dispose()
      bandRef.current = null
      updates.dispose()
      term.dispose()
    }
  }, [sessionId])

  // A layout effect: the tab's panel is un-hidden in the same commit, and the
  // terminal must have its renderer and its frame before the browser paints
  // (the header). On mount the effect above shows it.
  useLayoutEffect(() => {
    if (active) api.current?.show()
    else api.current?.hide()
  }, [active, sessionId])

  useEffect(() => {
    if (active && focused) api.current?.focus()
  }, [active, focused])

  useEffect(() => {
    bandRef.current?.setEnabled(inputBox)
  }, [inputBox, sessionId])

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
        <div role="status" className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2">
          <p className="mono text-[12px]" style={{ color: foreground, opacity: 0.6 }}>
            {status === 'reconnecting' ? 'Connecting to the session…' : 'Starting…'}
          </p>
          {status === 'reconnecting' && <ReconnectBadge link={link} onReconnect={() => connRef.current?.reconnectNow()} />}
        </div>
      )}
      {status === 'revoked' && phase === 'ready' && (
        <div className="pointer-events-none absolute right-3 top-2 z-20 app-fade-in">
          <span className="mono rounded-full border border-white/10 bg-black/40 px-2.5 py-1 text-[11px] text-[#e7bb63] backdrop-blur-sm">
            This device can no longer type here
          </span>
        </div>
      )}
      {status === 'reconnecting' && phase === 'ready' && (
        <div className="pointer-events-none absolute right-3 top-2 z-20 app-fade-in">
          <ReconnectBadge link={link} onReconnect={() => connRef.current?.reconnectNow()} />
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
      {boxHint && inputBox && (
        <div data-input-hint aria-hidden className="pointer-events-none absolute right-4 z-10 flex items-center" style={{ top: boxHint.top, height: boxHint.height }}>
          <span className="mono px-1.5 text-[10.5px] leading-none" style={{ background: ground }}>
            <span style={{ color: foreground, opacity: 0.55 }}>
              {keys(INPUT_HIGHLIGHT_KEY)} {highlightOn ? 'hides the highlight' : 'highlights where you type'}
            </span>
          </span>
        </div>
      )}
      {shellLine && shellHint && phase === 'ready' && (
        <div data-new-shell-hint role="note" aria-label={newShellHintText()} className="pointer-events-none absolute right-3 z-10 truncate" style={{ top: shellLine.top, left: shellLine.left }}>
          <span aria-hidden className="mono text-[11.5px]" style={{ color: foreground, opacity: 0.45 }}>
            Run <span style={{ opacity: 0.85 }}>claude</span>, <span style={{ opacity: 0.85 }}>codex</span> or any command · {newShellCloseKey()} closes this tab
          </span>
        </div>
      )}
      {update && (
        <div className="pointer-events-none absolute bottom-3 right-3 z-10 flex max-w-[calc(100%-1.5rem)] justify-end">
          <UpdateNoticeBar
            notice={update}
            onOpenShell={() => requestShellBeside(sessionId)}
            onDismiss={() => {
              dismissNotice(update)
              setUpdate(null)
              api.current?.focus()
            }}
          />
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
        <NewPill count={newLines} unit={newLines === 1 ? 'new line' : 'new lines'} onJump={() => api.current?.scrollToBottom()} />
      </div>
    </div>
    {quickReplies && <QuickReplies sessionId={sessionId} className={composer ? 'pb-0' : ''} />}
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

/**
 * The terminal's connection while it is down, as it is: the attempt, when the
 * next one goes, and — once it has failed a few times or for a while — a
 * "Reconnect now" that tries at once. The retries never stop by themselves
 * (lib/reconnect.ts); the button is for not waiting out the backoff, and it
 * reconnects the same session: no new process (Vova, 2026-10-15: after a
 * Wi-Fi drop every tab hung at "Reconnecting…" until it was closed). Mounted
 * only while reconnecting, so its one-second clock runs only then.
 */
function ReconnectBadge({ link, onReconnect }: { link: LinkStatus; onReconnect: () => void }) {
  const now = useNow(1000)
  const reading = readLink(link, 0, now)
  return (
    <span data-reconnect className="mono inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-2.5 py-1 text-[11px] text-[#e7bb63] backdrop-blur-sm" title={reading.title}>
      <span>{reading.label}</span>
      {offersManualRetry(link, now) && (
        <button type="button" className="pointer-events-auto rounded-full border border-current px-2 leading-[18px] hover:bg-white/10" onClick={onReconnect}>
          Reconnect now
        </button>
      )}
    </span>
  )
}
