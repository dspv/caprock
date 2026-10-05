import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { api, deviceToken, errText, isPairedDevice } from '@/lib/api'
import { SpawnDialog } from './SpawnDialog'
import { TerminalKeys } from './TerminalKeys'
import { takeDraft } from '@/lib/draft'
import { PermissionPrompt } from './PermissionPrompt'
import { downscalePhoto } from '@/lib/downscale'
import { TermClient, type TermState } from '@/lib/termv2'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

/**
 * The terminal's palette: graphite, in BOTH app themes, fixed at build time.
 *
 * It used to be read from the theme tokens when the terminal opened. Two
 * defects came out of that (owner reports, 2026-10-04). On paper, Claude Code's
 * dim text and status line — drawn for a dark background, as every TUI assumes —
 * were grey on cream and unreadable. And the colours were read ONCE, at mount:
 * switch the app to dark with a terminal open and it stayed paper, faint text
 * on a light ground, so either theme could end up wrong. A terminal is a dark
 * surface the way a code block is; the page around it stays paper.
 *
 * These are the dark palette's values (tokens.css), written out rather than
 * read from CSS so no theme switch can reach them. `--color-term-*` carries the
 * same two surface colours for the container around the canvas.
 */
export const TERMINAL_THEME = {
  background: '#1b1b1a',
  foreground: '#e8e6e2',
  cursor: '#feb157',
  cursorAccent: '#1b1b1a',
  selectionBackground: '#3a3835',
} as const
/** How long the terminal must have been quiet (no typing) before WebGL is set up. */
export const WEBGL_QUIET_MS = 1500

/** How long a terminal may stay silent before it is reported as not starting. */
export const START_TIMEOUT_MS = 30_000

/**
 * What the terminal area says before the session's first output: starting,
 * with the seconds counting, or — after START_TIMEOUT_MS or a closed socket —
 * that nothing came, with a retry. Drawn over the canvas, in the terminal's
 * own dark palette, and gone at the first byte.
 */
function TerminalStart({ phase, since, onRetry }: { phase: 'waiting' | 'silent' | 'closed'; since: number; onRetry: () => void }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (phase !== 'waiting') return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [phase])
  const secs = Math.max(0, Math.floor((now - since) / 1000))
  return (
    <div
      role="status"
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center pointer-events-none"
      style={{ color: TERMINAL_THEME.foreground }}
    >
      {phase === 'waiting' ? (
        <p className="mono text-[13px]">
          Starting the session… <span className="opacity-60">{secs} s</span>
        </p>
      ) : (
        <>
          <p className="mono text-[13px]">
            {phase === 'silent'
              ? `Nothing from the session in ${START_TIMEOUT_MS / 1000} s.`
              : 'The session closed before it printed anything.'}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="pointer-events-auto rounded-sm border px-3 py-1.5 text-[12px]"
            style={{ borderColor: TERMINAL_THEME.cursor, color: TERMINAL_THEME.cursor }}
          >
            Retry
          </button>
        </>
      )}
    </div>
  )
}

/** Live terminal for an owned session over /v1/agents/:id/term (Phase 1). */
export function TerminalView({
  sessionId,
  owned,
  // The directory this session runs in, so the offer to start one can be taken
  // in a single click rather than sending someone to another screen to retype
  // a path they can see.
  cwd,
  ended = false,
  detached = false,
  canContinue = true,
  resume,
}: {
  sessionId: string
  owned: boolean
  cwd?: string
  /** The session is over: there is no process, whoever started it. */
  ended?: boolean
  /** Caprock started it, and its terminal closed when Caprock restarted. */
  detached?: boolean
  /** Whether `resume` can actually continue it; when not, it carries the reason instead. */
  canContinue?: boolean
  /** What to offer instead of a terminal once it has ended — continuing it. */
  resume?: ReactNode
}) {
  const [spawning, setSpawning] = useState(false)
  const host = useRef<HTMLDivElement>(null)
  // Until the session's first output, the terminal is a black panel that
  // could be broken or could be a `claude --resume` still starting — the
  // owner waited on one for over half a minute (2026-10-04) with nothing to
  // say which. `start` says which: waiting (with the seconds), or failed.
  const [start, setStart] = useState<{ phase: 'waiting' | 'ready' | 'silent' | 'closed'; since: number }>({ phase: 'waiting', since: Date.now() })
  const [attempt, setAttempt] = useState(0)
  // The connection, for the pill over the terminal: while it is down, what is
  // typed waits and is sent on reconnect (protocol v2), so the pill says so.
  const [conn, setConn] = useState<TermState>('connecting')
  // Typed while offline past the queue's limit: those keys were not kept.
  const [refused, setRefused] = useState(false)
  // The keys bar types through the same socket as the keyboard. Set while a
  // socket exists; a no-op otherwise.
  const sendRef = useRef<(d: string) => void>(() => {})
  // The keys bar's photo button attaches through the same path as a drop.
  const attachRef = useRef<(files: File[]) => Promise<void>>(async () => {})
  // A phone types from the bar under the terminal, not into xterm: focusing
  // the canvas would raise the on-screen keyboard over the very output the
  // person is reading.
  const phone = isPairedDevice()
  // What the Changes tab left for the field ("In <file> around line N: ").
  const [draft] = useState(() => takeDraft(sessionId))
  useEffect(() => {
    if (!host.current || !owned) return
    setStart({ phase: 'waiting', since: Date.now() })
    let gotOutput = false
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
      // A copy: xterm keeps the object it is given.
      theme: { ...TERMINAL_THEME },
      // 10k lines: a build log or a long `claude` session scrolls past 5k
      // easily, and losing the start of what you are reading is the moment a
      // terminal stops being one you can work in.
      scrollback: 10000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)

    try { fit.fit() } catch { /* not yet laid out */ }
    // Input first: the keyboard goes to the terminal the moment it exists.
    if (!phone) term.focus()
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
    // The two Cyrillic samples (U+042B, U+0462) are built at run time, through
    // map so the minifier cannot fold them back: the repository and its
    // bundle hold no Cyrillic.
    const cyrillic = [0x42b, 0x462].map((code) => String.fromCharCode(code))
    for (const sample of ['A', 'ā', ...cyrillic, 'Ω', 'ế']) {
      document.fonts?.load('12px "JetBrains Mono Variable"', sample)
        .catch(() => { /* face unavailable; the fallback still renders */ })
    }
    // xterm measures the cell from the font that is loaded WHEN IT OPENS. The
    // webfont usually is not yet, so it measures the fallback and keeps that
    // cell size after the real face arrives — every column lands slightly off.
    // Re-fitting once the faces are ready re-measures against them.
    document.fonts?.ready.then(() => { try { fit.fit() } catch { /* gone */ } })
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${location.host}/v1/agents/${encodeURIComponent(sessionId)}/term`
    // Nothing in 30 s is not a slow start any more: say so, and offer a retry.
    const silentTimer = window.setTimeout(() => {
      if (!gotOutput) setStart((st) => (st.phase === 'waiting' ? { ...st, phase: 'silent' } : st))
    }, START_TIMEOUT_MS)

    // WebGL rendering, where the machine has it — but LATE.
    //
    // The canvas renderer repaints the whole grid; the WebGL one uploads a
    // texture atlas once and draws from it, which is the difference between a
    // build log scrolling smoothly and the tab stuttering. Setting it up is
    // synchronous GPU work on the main thread: creating the context took
    // 1.5 s in the owner's Chrome (2026-10-04) and compiling its shaders
    // another 0.4 s, and it used to run before the socket even opened — so
    // the page froze on open and the first keystrokes waited behind it. Now
    // the socket, the first output and the keyboard come first; WebGL is
    // swapped in once the terminal has shown something and the user has not
    // typed for a moment, when a short pause costs nothing.
    //
    // Every failure path falls back rather than throwing: a machine with no
    // WebGL, a driver that refuses, or a context lost when the GPU is reset
    // must all leave a working terminal behind. A slower terminal is a cost;
    // a blank one is a broken product.
    let disposed = false
    let lastInput = 0
    let webglTimer = 0
    const inputSub = term.onData(() => { lastInput = Date.now() })
    const loadWebgl = () => {
      if (disposed) return
      if (!gotOutput || Date.now() - lastInput < WEBGL_QUIET_MS) {
        webglTimer = window.setTimeout(loadWebgl, WEBGL_QUIET_MS)
        return
      }
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          // The GPU dropped the context — a sleep/wake or a driver reset.
          // Disposing the addon returns xterm to its canvas renderer rather
          // than leaving a terminal that has stopped painting.
          webgl.dispose()
        })
        term.loadAddon(webgl)
      } catch {
        // No WebGL here. The default renderer is already drawing, so there
        // is nothing to do and nothing worth telling the user.
      }
    }
    webglTimer = window.setTimeout(loadWebgl, WEBGL_QUIET_MS)
    // Terminal protocol v2 (lib/termv2): output arrives with its offsets and
    // input goes numbered, so a reconnect — Caprock restarting, a dropped
    // network, a phone waking — picks up from the last byte this terminal
    // has, without clearing it, and every key is typed exactly once.
    //
    // The session outlives the daemon (ADR-033), so a closed socket is not
    // the session ending: the client reconnects forever, with backoff. It
    // used to give up after 60 attempts and ask for a reload, and to write
    // "reconnecting" into the terminal itself, which then sat in the
    // scrollback; the pill over the terminal says it now.
    //
    // Input is binary and control is text. Everything used to go as text and
    // the daemon treated all of it as keystrokes, which left no way to tell
    // it the window had changed size — so the PTY kept the size it was born
    // with, 120x40, forever, and arrows moved a selection nobody could see.
    setConn('connecting')
    setRefused(false)
    const client = new TermClient({
      url,
      // A paired controller's token rides as a subprotocol, as on /v1/live:
      // a browser's WebSocket cannot set a header (ADR-034).
      deviceToken: deviceToken(),
      callbacks: {
        // Never a scroll to the bottom here: someone scrolled back to read
        // stays where they are while output arrives (the scrolling rule).
        write: (data, done) => {
          term.write(data, done)
          if (!gotOutput && data.length > 0) {
            gotOutput = true
            setStart((st) => ({ ...st, phase: 'ready' }))
            // One size after the first output: a TUI that drew before the
            // socket's first resize arrived redraws at the window's real size.
            try { fit.fit() } catch { /* not laid out yet */ }
            sendSize(term.cols, term.rows)
          }
        },
        reset: () => term.reset(),
        open: () => {
          // The PTY was created before this socket existed, so the first
          // thing it hears has to be the size the window actually is.
          try { fit.fit() } catch { /* not laid out yet */ }
          sendSize(term.cols, term.rows)
        },
        state: (st) => {
          setConn(st)
          if (st === 'live') setRefused(false)
          if (st === 'ended') {
            term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n')
            if (!gotOutput) setStart((s0) => ({ ...s0, phase: 'closed' }))
          }
          // The owner took control away from this phone. Reconnecting would
          // only be refused again.
          if (st === 'revoked') term.write('\r\n\x1b[33m[this device can no longer control sessions — ask on the machine Caprock runs on]\x1b[0m\r\n')
        },
      },
    })
    const send = (d: string) => { if (!client.send(d)) setRefused(true) }
    const dataSub = term.onData(send)
    sendRef.current = send

    // Tell the daemon the size, on connect and whenever it changes.
    //
    // `fit()` only resizes the canvas; without this the two disagree and every
    // line wraps in the wrong place. Sent on `onResize` rather than from the
    // ResizeObserver directly, because that is the point at which xterm has
    // settled on a column count — the observer fires mid-layout, sometimes
    // with a width of zero.
    const sendSize = (cols: number, rows: number) => client.resize(cols, rows)
    const sizeSub = term.onResize(({ cols, rows }) => sendSize(cols, rows))
    client.start()

    // Back from sleep, the network, or the back/forward cache: reconnect now
    // rather than at the end of a backoff.
    const wake = () => { if (document.visibilityState !== 'hidden') client.wake() }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    window.addEventListener('pageshow', wake)

    // A newline in the prompt, however the user asks for one.
    //
    // A terminal cannot tell Shift+Enter from Enter: both are carriage return,
    // ASCII 13, and have been since the teletype. So every terminal that
    // supports multi-line prompts sends something else instead, and the
    // question is only which something.
    //
    // **ESC then CR — Alt+Enter as a terminal actually encodes it.**
    //
    // Four attempts at this, and the only thing that settled it was sending
    // candidate bytes to a running Claude Code with text already in the prompt
    // and looking at what happened:
    //
    //   CSI u (`ESC [ 13 ; 2 u`) needs the kitty keyboard protocol negotiated.
    //   We never negotiate, so it arrived as nothing at all.
    //
    //   `5c 6e` — a backslash and the letter n — was read out of the iTerm2
    //   binding `/terminal-setup` writes. That misread the file: Send Text
    //   *interprets* the escape, so iTerm2 puts one byte on the wire, not two
    //   printable characters. Sending the pair literally typed `\n` into the
    //   prompt and submitted, so a message arrived as "first line\n".
    //
    //   A bare line feed (`0x0A`) looked right when written to an empty
    //   prompt — two lines appeared. With text already typed it submits, which
    //   is the exact symptom that was reported. **Testing on an empty prompt
    //   is what made two of these look correct.**
    //
    //   `ESC CR` (`1b 0d`) keeps the prompt and adds a line, with text in it.
    //   That is what a terminal sends for Alt+Enter, and it is what Claude
    //   Code's own macOS instructions tell people to bind Option+Enter to.
    //
    //   Shift+Enter · Option+Enter · Ctrl+Enter · Ctrl+J  →  ESC CR (1b 0d)
    //
    // Intercepted before xterm turns the key into bytes: returning false stops
    // it emitting the plain carriage return it otherwise would, which Claude
    // Code reads as submit.
    const NEWLINE = '\x1b\r'
    // Returning false from the handler is not enough.
    //
    // It stops xterm *interpreting* the key, but the browser still delivers it
    // to xterm's hidden textarea, which emits a carriage return through
    // onData — so the socket carried our sequence and then a bare `0d`, and
    // Claude Code submitted on the second one. On the wire it read as
    // `[27,13]` immediately followed by `[13]`, which is exactly what a user
    // sees as "it always sends".
    //
    // preventDefault stops the textarea ever seeing the key. This is the
    // fourth attempt at Shift+Enter and the first three were all about which
    // bytes to send; the bytes were only ever half of it.
    const newline = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      send(NEWLINE)
    }
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true

      // Cmd+C / Cmd+V on macOS: the platform's own keys, and they never
      // collide with anything the process wants.
      if (isMac && e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === 'c') return !copySelection()  // nothing selected → let it through
        // Not ours: returning false only stops xterm *interpreting* the key,
        // and the browser's own paste still reaches xterm's textarea, which
        // brackets it. Pasting here as well sent every Cmd+V twice (FB-034).
        if (e.key === 'v') return false
      }
      // Ctrl+Shift+C / Ctrl+Shift+V elsewhere: the terminal convention,
      // deliberately distinct from Ctrl+C so SIGINT keeps its key.
      if (!isMac && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        if (e.key === 'C' || e.key === 'c') { copySelection(); return false }
        // Returning false leaves the browser's paste to xterm, as with Cmd+V;
        // returning true would have xterm send ^V and cancel the event.
        if (e.key === 'V' || e.key === 'v') return false
      }
      // Ctrl+C with a selection copies; without one it is SIGINT and belongs
      // to the process. This is what VS Code does, and it is what people
      // expect without being told.
      if (!isMac && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === 'c' || e.key === 'C')) {
        if (copySelection()) {
          term.clearSelection()
          return false
        }
        return true
      }

      // Ctrl+J is not an Enter key at all, and is the combination Claude
      // Code's documentation names as working in every terminal.
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'j' || e.key === 'J')) {
        newline(e)
        return false
      }
      if (e.key !== 'Enter') return true
      // Exactly one modifier, or this is somebody else's binding — a window
      // manager, the browser, an OS shortcut — and not ours to eat.
      const mods = [e.shiftKey, e.altKey, e.ctrlKey, e.metaKey].filter(Boolean).length
      if (mods !== 1) return true
      // Cmd is the browser's and the OS's, never ours.
      if (e.metaKey) return true
      newline(e)
      return false
    })
    // Copy and paste, and who owns Ctrl+C.
    //
    // xterm.js gives you neither by default: every key goes to the process, so
    // Ctrl+C is always SIGINT and there is no way to copy what is on screen.
    // In a terminal you live in, that is missing rather than minimal.
    //
    // The rule is the one VS Code uses, because it is the one people already
    // have in their fingers: **Ctrl+C copies when there is a selection and
    // interrupts when there is not.** A person who has just dragged across
    // some output means copy; a person who has not means stop.
    //
    // On macOS the question does not arise — Cmd+C is copy and Ctrl+C is
    // interrupt, and they are different keys — so the rule only applies where
    // the platform overloaded them.
    const isMac = /Mac|iP(hone|ad)/.test(navigator.platform || navigator.userAgent)
    const copySelection = () => {
      const sel = term.getSelection()
      if (!sel) return false
      void navigator.clipboard?.writeText(sel)
      return true
    }
    // Paste is the browser's own event, handled by xterm, and never a
    // clipboard read of ours. xterm applies bracketed paste when the process
    // asked for it — a multi-line paste has to arrive as one paste, not as N
    // submits — and the native event needs no clipboard permission, which
    // Safari asks for on every read. The daemon restores the modes a late
    // terminal missed, so "asked for it" holds after a reconnect too.

    // Paste or drop a file, get a path.
    //
    // A browser hands over a file's bytes and never a path — there is no path
    // for something copied out of a screenshot tool, and a file dragged from
    // Finder arrives as a name and its contents — while Claude Code reads
    // files by path. So the bytes go to the daemon, which writes them into its
    // own data directory under the file's own (sanitised) name, and the path
    // it returns is typed into the session as if the user had typed it.
    //
    // The name travels with the bytes because the daemon decides what it
    // accepts by extension: a browser leaves `type` empty for Markdown, CSV,
    // JSON, YAML and every source file, and a type-only check refused them all.
    //
    // The path is quoted, because a data directory on macOS contains spaces
    // ("Application Support") and an unquoted path there is two arguments. Not
    // with JSON.stringify, which doubles every backslash in a Windows path.
    const sendFile = async (file: File) => {
      try {
        const buf = new Uint8Array(await file.arrayBuffer())
        // btoa over a large array in one call blows the argument limit, so the
        // string is built in chunks. 8k is well under any engine's cap.
        let bin = ''
        for (let i = 0; i < buf.length; i += 8192) {
          bin += String.fromCharCode(...buf.subarray(i, i + 8192))
        }
        const { path } = await api.paste({ name: file.name, type: file.type, data: btoa(bin) })
        // Typed, not pasted: the user is about to talk about this file, and a
        // path in the prompt is what Claude Code reads.
        send(`"${path}" `)
      } catch (err) {
        // The daemon's refusal says what it accepts; errText keeps that part.
        const what = file.name ? `${file.name}: ` : ''
        term.write(`\r\n\x1b[33m[caprock: ${what}${err instanceof Error ? errText(err) : 'could not save that file'}]\x1b[0m\r\n`)
      }
    }
    // Every file, one at a time and in order, so the paths land in the order
    // they were dropped and a second drop waits for the first rather than
    // interleaving with it. One refused file does not stop the rest.
    let queue = Promise.resolve()
    const sendFiles = (files: File[]) => {
      queue = queue.then(async () => {
        for (const f of files) await sendFile(f)
      })
      return queue
    }
    // A photo from the phone's camera or library: made small enough to send
    // first (downscalePhoto), then the same path as a dropped file.
    attachRef.current = async (files) => {
      const photos = await Promise.all(files.map((f) => downscalePhoto(f)))
      await sendFiles(photos)
    }

    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.items ?? [])]
        .filter((i) => i.kind === 'file')
        .map((i) => i.getAsFile())
        .filter((f): f is File => f !== null)
      if (files.length === 0) return  // ordinary text: xterm's own handling is correct
      e.preventDefault()
      // Or xterm's textarea handler pastes the (empty) text as well.
      e.stopPropagation()
      sendFiles(files)
    }
    const onDrop = (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length === 0) return
      e.preventDefault()
      sendFiles(files)
    }
    // preventDefault on dragover, or the browser navigates away to the file.
    const onDragOver = (e: DragEvent) => { e.preventDefault() }
    const el = host.current
    // Capture phase: xterm's textarea handler stops the paste from bubbling,
    // so a listener on the way up never saw a keyboard paste at all.
    el.addEventListener('paste', onPaste, true)
    el.addEventListener('drop', onDrop)
    el.addEventListener('dragover', onDragOver)

    // fit() writes to the DOM, and this observer watches the element it
    // writes to — so calling it straight from the callback lets a resize
    // trigger a resize. Idle that settles after a frame; under a TUI that
    // repaints on every keystroke (Gemini CLI does) it becomes a visible
    // flicker on every key. Coalesce into one fit per frame, and skip the
    // write entirely when the geometry has not actually changed.
    let raf = 0
    let last = ''
    const refit = () => {
      raf = 0
      const el = host.current
      if (!el) return
      const geom = `${el.clientWidth}x${el.clientHeight}`
      if (geom === last) return
      last = geom
      try { fit.fit() } catch { /* not laid out yet */ }
    }
    const ro = new ResizeObserver(() => {
      if (raf) return
      raf = requestAnimationFrame(refit)
    })
    ro.observe(host.current)
    return () => {
      el.removeEventListener('paste', onPaste, true)
      el.removeEventListener('drop', onDrop)
      el.removeEventListener('dragover', onDragOver)
      if (raf) cancelAnimationFrame(raf)
      disposed = true
      window.clearTimeout(silentTimer)
      window.clearTimeout(webglTimer)
      inputSub.dispose()
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      window.removeEventListener('pageshow', wake)
      sendRef.current = () => {}
      attachRef.current = async () => {}
      ro.disconnect(); dataSub.dispose(); sizeSub.dispose(); client.dispose(); term.dispose()
    }
  }, [sessionId, owned, attempt, phone])
  if (!owned && detached) {
    // Caprock started this session and its terminal closed when Caprock
    // restarted. Since ADR-033 a session's terminal is held outside the
    // daemon and outlives a restart, so what is left here is a session
    // started by an older release, or one whose terminal holder died.
    //
    // It used to say "Caprock restarted since this session began, and its
    // terminal went with that run" over a "branch here" button, and the owner
    // could not tell what had happened or what the button would do. Plain
    // words now: what happened, that nothing is lost, and the one thing to do.
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
        <p className="text-[14px] text-fg">This session’s terminal was closed when Caprock restarted.</p>
        {/* Only when there is a button to point at: with the transcript or
          * the folder gone, `resume` says why instead, and "the conversation
          * is saved" would be the one false sentence on the screen. */}
        {canContinue && (
          <p className="max-w-[52ch] text-[12px] leading-relaxed text-fg-muted">
            The conversation is saved — <span className="text-fg">Continue it here</span> resumes it in a new terminal.
          </p>
        )}
        {resume}
      </div>
    )
  }
  if (!owned && ended) {
    // An ended session has no process to attach to, and it used to get the
    // copy written for a live one: "You started this session yourself …
    // This one keeps running" — wrong on both counts for a session Caprock
    // started and that has stopped. What there is to do is carry it on.
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
        <p className="text-[14px] text-fg">This session has ended, so there is no terminal to attach to.</p>
        {resume}
      </div>
    )
  }
  if (!owned) {
    // Says what to do first, and why second.
    //
    // It used to open with "This is an externally started session — Caprock
    // observes it but never writes into a terminal it does not own", which is
    // an accurate sentence written for the people who built this. A reader saw
    // a wall of text where a terminal should be, could not tell what was being
    // asked of them, and had no idea whether they had done something wrong.
    // Nothing here is the reader's fault and nothing needs fixing — there is
    // simply one button that produces a terminal, so that button is the
    // message.
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
        <p className="text-[14px] text-fg">You started this session yourself, so it has no terminal here.</p>

        {/* The button names the thing it creates, and the line under it says
          * what happens to what is already running.
          *
          * Two passes at this were still too vague. "Start a session in
          * Caprock" was a link to the main screen. "Start one here" replaced it
          * with an action but left "one" undefined — a reader could reasonably
          * expect it to attach to, restart, or take over the session they were
          * looking at. It does none of those: it launches a second `claude`
          * process. Anything that runs a program and touches nothing else has
          * to say both halves. */}
        <button
          onClick={() => setSpawning(true)}
          className="rounded-sm bg-accent px-3.5 py-2 text-[13px] font-medium text-bg hover:brightness-110"
        >
          Start a session here →
        </button>
        {/* One paragraph, not three. The two that used to follow this both said
          * the same thing — your session is safe — and the second said it as an
          * apology for a policy the reader had not questioned. What they need
          * to know is what the button does. */}
        <p className="max-w-[52ch] text-[12px] leading-relaxed text-fg-faint">
          Opens a second <span className="mono">claude</span> in{' '}
          {cwd ? <span className="mono text-fg-muted">{cwd}</span> : 'this repository'}, with a
          terminal you can type in. This one keeps running.
        </p>
        {spawning && <SpawnDialog available onClose={() => setSpawning(false)} initialCwd={cwd ?? ''} />}
      </div>
    )
  }
  return (
    <>
      {/* The canvas's own ground, in both themes: see TERMINAL_THEME. The
        * padding is the same colour so the dark surface reads as one block
        * rather than a canvas floating on paper. */}
      <div className="relative bg-term-bg border border-term-border rounded-sm p-1.5">
        {/* Shorter on a narrow screen, so the keys bar under it stays in view. */}
        <div ref={host} data-term-host className="h-[52vh] sm:h-[70vh]" />
        {start.phase !== 'ready' && (
          <TerminalStart phase={start.phase} since={start.since} onRetry={() => setAttempt((n) => n + 1)} />
        )}
        {(conn === 'reconnecting' || refused) && (
          <div
            aria-live="polite"
            className="pointer-events-none absolute right-3 top-3 rounded-full border px-2.5 py-1 text-[11px]"
            style={{ background: TERMINAL_THEME.background, borderColor: TERMINAL_THEME.cursor, color: TERMINAL_THEME.cursor }}
          >
            {refused
              ? 'Offline — keys past the first 4 KB were not kept'
              : 'Reconnecting — your keys will be sent'}
          </div>
        )}
      </div>
      <PermissionPrompt sessionId={sessionId} />
      {/* Said once, under the terminal, because there is no way to discover it.
        *
        * A user who wants a second line presses Enter, watches half a thought
        * get submitted, and concludes multi-line prompts are not possible
        * here. Shift+Enter has worked since v0.30.1 and he still could not
        * find it — which is a discovery problem, not a missing feature.
        *
        * Shift+Enter leads because it is what people expect; Ctrl+J is named
        * because it is the one that works in every terminal with no setup, so
        * it is the answer when someone's keyboard or OS eats the others. */}
      {/* A keyboard without Esc, Tab, arrows or Ctrl: on a phone always, and
        * on any narrow window. */}
      <div className={phone ? '' : 'sm:hidden'}>
        <TerminalKeys send={(d) => sendRef.current(d)} attach={(files) => attachRef.current(files)} initial={draft} />
      </div>
      <div className="hidden border-t border-border px-3 py-1.5 text-[11px] text-fg-faint sm:block">
        <span className="mono text-fg-muted">Shift</span>+
        <span className="mono text-fg-muted">Enter</span> for a new line —{' '}
        <span className="mono text-fg-muted">Option</span>+
        <span className="mono text-fg-muted">Enter</span> and{' '}
        <span className="mono text-fg-muted">Ctrl</span>+
        <span className="mono text-fg-muted">J</span> do the same.
      </div>
    </>
  )
}
