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
