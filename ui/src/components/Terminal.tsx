import { useEffect, useRef } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
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
      // 10k lines: a build log or a long `claude` session scrolls past 5k
      // easily, and losing the start of what you are reading is the moment a
      // terminal stops being one you can work in.
      scrollback: 10000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)

    // WebGL rendering, where the machine has it.
    //
    // The canvas renderer repaints the whole grid; the WebGL one uploads a
    // texture atlas once and draws from it, which is the difference between
    // a build log scrolling smoothly and the tab stuttering. Loaded after
    // `open` because it needs the canvas to exist.
    //
    // Every failure path falls back rather than throwing: a machine with no
    // WebGL, a driver that refuses, or a context lost when the GPU is reset
    // must all leave a working terminal behind. A slower terminal is a cost;
    // a blank one is a broken product.
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
      // No WebGL here. The canvas renderer is already what xterm falls back
      // to, so there is nothing to do and nothing worth telling the user.
    }
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
    // Input goes as binary, control as text.
    //
    // Everything used to go as text and the daemon treated all of it as
    // keystrokes, which left no way to tell it the window had changed size —
    // so the PTY kept the size it was born with, 120x40, forever. Claude Code
    // lays its menus out to that size, so on any other window the interface
    // was drawn for a screen that was not there: arrows moved a selection
    // nobody could see, which is what "only Enter works" looks like.
    const enc = new TextEncoder()
    const send = (d: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d)) }
    const dataSub = term.onData(send)

    // Tell the daemon the size, on connect and whenever it changes.
    //
    // `fit()` only resizes the canvas; without this the two disagree and every
    // line wraps in the wrong place. Sent on `onResize` rather than from the
    // ResizeObserver directly, because that is the point at which xterm has
    // settled on a column count — the observer fires mid-layout, sometimes
    // with a width of zero.
    const sendSize = (cols: number, rows: number) => {
      if (ws.readyState !== WebSocket.OPEN || cols <= 0 || rows <= 0) return
      ws.send(JSON.stringify({ resize: { cols, rows } }))
    }
    const sizeSub = term.onResize(({ cols, rows }) => sendSize(cols, rows))
    ws.onopen = () => {
      // The PTY was created before this socket existed, so the first thing it
      // hears has to be the size the window actually is.
      try { fit.fit() } catch { /* not laid out yet */ }
      sendSize(term.cols, term.rows)
    }

    // A newline in the prompt, however the user asks for one.
    //
    // A terminal cannot tell Shift+Enter from Enter: both are carriage return,
    // ASCII 13, and have been since the teletype. So every terminal that
    // supports multi-line prompts sends something else instead, and the
    // question is only which something.
    //
    // **Read out of a terminal that works.** `/terminal-setup` writes a
    // binding into iTerm2, and that binding is on disk and can simply be
    // read. It is Send Text, and the text is two bytes: `5c 6e` — a backslash
    // and the letter n. Not a line feed, not CSI u. Claude Code sees the
    // backslash at the end of the line and turns the pair into a newline,
    // which is the same `\` + Enter its documentation says works everywhere.
    //
    // Two earlier guesses were wrong, and both failed in a way nobody could
    // see from the code:
    //
    //   CSI u (`ESC [ 13 ; 2 u`) is what a terminal sends *after* negotiating
    //   the kitty keyboard protocol. We never negotiate, so it arrived as
    //   nothing at all.
    //
    //   A bare line feed (`0x0A`) is what Ctrl+J sends, and the documentation
    //   does say Ctrl+J works — but Claude Code reads a lone line feed as
    //   *submit*. The user who reported it saw exactly that: on an empty
    //   prompt it looked like a newline, because there was nothing to submit,
    //   and the moment he typed anything the same key sent his message.
    //
    // So all of these send the backslash pair, which is what a terminal
    // Claude Code itself configured sends.
    //
    //   Shift+Enter · Option+Enter · Ctrl+Enter · Ctrl+J  →  \n (5c 6e)
    //
    // Intercepted before xterm turns the key into bytes: returning false stops
    // it emitting the plain carriage return it otherwise would.
    // Two printable characters, `5c 6e` — a backslash and the letter n.
    // Read straight out of the iTerm2 binding `/terminal-setup` writes.
    const NEWLINE = '\\n'
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true

      // Cmd+C / Cmd+V on macOS: the platform's own keys, and they never
      // collide with anything the process wants.
      if (isMac && e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === 'c') return !copySelection()  // nothing selected → let it through
        if (e.key === 'v') { pasteFromClipboard(); return false }
      }
      // Ctrl+Shift+C / Ctrl+Shift+V elsewhere: the terminal convention,
      // deliberately distinct from Ctrl+C so SIGINT keeps its key.
      if (!isMac && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        if (e.key === 'C' || e.key === 'c') { copySelection(); return false }
        if (e.key === 'V' || e.key === 'v') { pasteFromClipboard(); return false }
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
        send(NEWLINE)
        return false
      }
      if (e.key !== 'Enter') return true
      // Exactly one modifier, or this is somebody else's binding — a window
      // manager, the browser, an OS shortcut — and not ours to eat.
      const mods = [e.shiftKey, e.altKey, e.ctrlKey, e.metaKey].filter(Boolean).length
      if (mods !== 1) return true
      // Cmd is the browser's and the OS's, never ours.
      if (e.metaKey) return true
      send(NEWLINE)
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
    const pasteFromClipboard = () => {
      // The paste goes through xterm rather than straight to the socket so
      // that bracketed paste is applied if the process asked for it — a
      // multi-line paste has to arrive as one paste, not as N submits.
      void navigator.clipboard?.readText().then((t) => { if (t) term.paste(t) }).catch(() => {
        // Denied or unavailable: the browser's own Cmd/Ctrl+V still works
        // through xterm's textarea, so there is nothing to report.
      })
    }

    const ro = new ResizeObserver(() => { try { fit.fit() } catch { /* */ } })
    ro.observe(host.current)
    return () => { ro.disconnect(); dataSub.dispose(); sizeSub.dispose(); ws.close(); term.dispose() }
  }, [sessionId, owned])
  if (!owned) {
    return (
      <div className="px-4 py-8 text-center text-fg-muted text-[13px]">
        This is an externally started session — Caprock observes it but never writes into a terminal it does not own.
        <div className="text-fg-faint text-[12px] mt-1">Spawn a session from “New session” to get an interactive terminal.</div>
      </div>
    )
  }
  return (
    <>
      <div ref={host} className="h-[70vh] bg-bg" />
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
      <div className="border-t border-border px-3 py-1.5 text-[11px] text-fg-faint">
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
