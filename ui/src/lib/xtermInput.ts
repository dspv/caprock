/**
 * Keyboard, clipboard and file input for an xterm.js terminal, shared by the
 * dashboard's terminal (components/Terminal.tsx) and the app's tabs
 * (components/TerminalPane.tsx), so the two can never type differently.
 * Moved here from Terminal.tsx unchanged; the history of each rule is below.
 */
import type { Terminal as Xterm } from '@xterm/xterm'
import { api, errText } from '@/lib/api'

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
export const NEWLINE = '\x1b\r'

export interface TerminalInputOptions {
  /** Keys the app owns (its shortcuts): xterm ignores them and they bubble to the window. */
  isAppKey?: (e: KeyboardEvent) => boolean
}

/**
 * Wires keys, copy, paste and dropped files to `send`. Returns a disposer and
 * `sendFiles`, which the phone's photo button uses as well.
 */
export function attachTerminalInput(
  term: Xterm,
  el: HTMLElement,
  send: (d: string) => void,
  opts: TerminalInputOptions = {},
): { dispose: () => void; sendFiles: (files: File[]) => Promise<void> } {
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
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    // The app's own shortcuts are never the terminal's: xterm leaves them
    // alone and the window's listener acts on them.
    if (opts.isAppKey?.(e)) return false

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

  const onPaste = (e: ClipboardEvent) => {
    const files = [...(e.clipboardData?.items ?? [])]
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null)
    if (files.length === 0) return  // ordinary text: xterm's own handling is correct
    e.preventDefault()
    // Or xterm's textarea handler pastes the (empty) text as well.
    e.stopPropagation()
    void sendFiles(files)
  }
  const onDrop = (e: DragEvent) => {
    const files = [...(e.dataTransfer?.files ?? [])]
    if (files.length === 0) return
    e.preventDefault()
    void sendFiles(files)
  }
  // preventDefault on dragover, or the browser navigates away to the file.
  const onDragOver = (e: DragEvent) => { e.preventDefault() }
  // Capture phase: xterm's textarea handler stops the paste from bubbling,
  // so a listener on the way up never saw a keyboard paste at all.
  el.addEventListener('paste', onPaste, true)
  el.addEventListener('drop', onDrop)
  el.addEventListener('dragover', onDragOver)
  return {
    sendFiles,
    dispose: () => {
      el.removeEventListener('paste', onPaste, true)
      el.removeEventListener('drop', onDrop)
      el.removeEventListener('dragover', onDragOver)
    },
  }
}
