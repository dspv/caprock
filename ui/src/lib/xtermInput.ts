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

/**
 * Files dropped on the desktop app's window (app/src-tauri/src/shell.rs).
 *
 * In the app a file dragged from Finder, Explorer or a file manager never
 * reaches the page as an HTML5 drop: the shell's native handler takes it, so
 * it has the file's real path, and hands the page that path and the point it
 * landed on as this event. The terminal under that point types the path
 * quoted, as a terminal does — nothing is uploaded, any file or folder goes,
 * and what Claude reads or edits is the original rather than a copy. In a
 * browser this event never fires and a drop uploads, as below.
 * .ai/21-app.md § Dropping a file.
 */
export const DROP_PATHS_EVENT = 'caprock:drop-paths'

export interface DroppedPaths {
  paths: string[]
  /** Where it landed, in CSS pixels from the viewport's top left. */
  x: number
  y: number
}

interface DropTarget {
  el: HTMLElement
  /** When the user last clicked or focused it, for a drop that lands on no terminal. */
  used: number
  deliver: (paths: string[]) => void
}

/** Every attached terminal; one window listener routes the app's drops among them. */
const dropTargets = new Set<DropTarget>()
let dropListening = false

/** A terminal with a box: a hidden tab has none, nor one taken off the page. */
function shown(el: Element): boolean {
  if (!el.isConnected) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

/** A dialog on screen: mounted and not display:none (checkVisibility where the engine has it). */
function onScreen(el: Element): boolean {
  if (!el.isConnected) return false
  const v = (el as Element & { checkVisibility?: () => boolean }).checkVisibility
  return v ? v.call(el) : true
}

/**
 * Where a native drop goes. A drop used to reach only the terminal whose box
 * held the point, and was dropped without a word otherwise — onto the tab
 * strip, the composer, a margin, or while any dialog was mounted at all —
 * which read as "drag and drop is broken again" (owner, 2026-10-16). Now: a
 * dialog that is actually on screen takes it (Feedback, a sheet: they listen
 * themselves); else the terminal under the point; else the terminal used
 * last that is on screen; else the one terminal on screen; else a short
 * note says where to drop. Never silent.
 */
export function routeDrop(d: DroppedPaths, targets: Iterable<DropTarget>, doc: Document = document): DropTarget | 'dialog' | null {
  const dialog = [...doc.querySelectorAll('[data-dialog-backdrop]')].some(onScreen)
  if (dialog) return 'dialog'
  const visible = [...targets].filter((t) => shown(t.el))
  const under = visible.find((t) => {
    const r = t.el.getBoundingClientRect()
    return d.x >= r.left && d.x < r.right && d.y >= r.top && d.y < r.bottom
  })
  if (under) return under
  const last = visible.filter((t) => t.used > 0).sort((a, b) => b.used - a.used)[0] ?? null
  if (last) return last
  return visible.length === 1 ? visible[0] ?? null : null
}

function dropNote(text: string) {
  const n = document.createElement('div')
  n.setAttribute('role', 'status')
  n.textContent = text
  n.style.cssText = 'position:fixed;left:50%;bottom:48px;transform:translateX(-50%);z-index:9999;padding:6px 12px;border-radius:8px;font-size:12px;background:var(--surface-2,#222);color:var(--text,#eee);border:1px solid var(--border,#444);pointer-events:none'
  document.body.appendChild(n)
  window.setTimeout(() => n.remove(), 2600)
}

function installDropListener() {
  if (dropListening) return
  dropListening = true
  window.addEventListener(DROP_PATHS_EVENT, (e: Event) => {
    const d = (e as CustomEvent<DroppedPaths | undefined>).detail
    if (!d || !Array.isArray(d.paths) || d.paths.length === 0) return
    const paths = d.paths.filter((p): p is string => typeof p === 'string' && p !== '')
    if (paths.length === 0) return
    const t = routeDrop(d, dropTargets)
    if (t === 'dialog') return
    if (t) t.deliver(paths)
    else dropNote('Drop a file onto a terminal to type its path')
  })
}

/**
 * A path as it is typed into a session: quoted, as the paste path is, so a
 * space is not two arguments. Not with JSON.stringify, which doubles every
 * backslash in a Windows path; a double quote — legal in a macOS or Linux
 * file name, never in a Windows one — is escaped.
 */
export function quotePath(p: string): string {
  return `"${p.replace(/"/g, '\\"')}"`
}

// An image goes in as a paste, so Claude Code shows `[Image #1]`.
//
// Claude Code turns an image path into an attachment only when the path
// arrives as a *paste* — that is how a file dragged into Terminal or iTerm
// becomes `[Image #N]` there. Typed, the same bytes stay a path in the
// prompt. Measured on 2026-10-11 against the real `claude` (2.1.296) in a
// PTY, nothing submitted:
//
//   bracketed paste of one path — raw, "double-quoted", 'single-quoted' or
//   with backslash-escaped spaces, a space in the folder and the name, an
//   inner `\"` escaped, .PNG in capitals, .jpg, .gif    →  [Image #1]
//   the same path written without the paste brackets, in one write or one
//   character at a time                                 →  the path, as text
//   a .txt path in a paste                              →  the path, as text
//   two "double-quoted" paths in ONE paste              →  both stay text
//   two pastes, one path each, even in one write        →  [Image #1] [Image #2]
//
// So each image is its own paste of the same quoted path a file gets, which
// holds for spaces ("Application Support") and Windows backslashes alike.
// Claude Code adds the space after `[Image #N]` itself, so none is sent.
// The extensions are the ones its image reader takes (png, jpeg, gif, webp).
//
// Only when the process asked for bracketed paste: a shell that did not
// would get `ESC [200~` typed into its line. A shell that did (zsh, bash's
// readline) inserts a paste as text, so it still gets the quoted path.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i

export function isImagePath(p: string): boolean {
  return IMAGE_EXT.test(p)
}

/**
 * What goes into the session for one file path: an image as its own
 * bracketed paste when the process accepts one, anything else typed, quoted
 * and followed by a space.
 */
export function pathInput(p: string, bracketedPaste: boolean): string {
  if (bracketedPaste && isImagePath(p)) return `\x1b[200~${quotePath(p)}\x1b[201~`
  return `${quotePath(p)} `
}

/**
 * How long to wait after an image paste before the next input. Claude Code
 * reads the image before it places `[Image #N]`, so text written straight
 * after it landed first: image, typed path, image in one write came out as
 * `"notes.txt" [Image #1] [Image #2]`. With 150 ms between them the order
 * held (measured in the same run as above).
 */
export const IMAGE_SETTLE_MS = 150

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
    void navigator.clipboard?.writeText(sel).then(() => flashCopied(term.element, sel.length), () => {})
    return true
  }
  // By the physical key: on a Russian layout Cmd+C reports a Cyrillic letter, so
  // matching the letter never copied, and the unhandled key made macOS beep
  // (owner, 2026-10-11).
  const letter = (e: KeyboardEvent) => (/^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase())
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
      if (letter(e) === 'c') {
        if (!copySelection()) return true  // nothing selected → let it through
        // Ours entirely: left to the browser too, its copy finds nothing
        // selected in xterm's textarea and the system beeps.
        e.preventDefault()
        return false
      }
      // Not ours: returning false only stops xterm *interpreting* the key,
      // and the browser's own paste still reaches xterm's textarea, which
      // brackets it. Pasting here as well sent every Cmd+V twice (FB-034).
      if (letter(e) === 'v') return false
    }
    // Ctrl+Shift+C / Ctrl+Shift+V elsewhere: the terminal convention,
    // deliberately distinct from Ctrl+C so SIGINT keeps its key.
    if (!isMac && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
      if (letter(e) === 'c') { if (copySelection()) e.preventDefault(); return false }
      // Returning false leaves the browser's paste to xterm, as with Cmd+V;
      // returning true would have xterm send ^V and cancel the event.
      if (letter(e) === 'v') return false
    }
    // Ctrl+C with a selection copies; without one it is SIGINT and belongs
    // to the process. This is what VS Code does, and it is what people
    // expect without being told.
    if (!isMac && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && letter(e) === 'c') {
      if (copySelection()) {
        e.preventDefault()
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
  const sendPath = async (p: string) => {
    const bracketed = term.modes?.bracketedPasteMode ?? false
    send(pathInput(p, bracketed))
    if (bracketed && isImagePath(p)) await new Promise((r) => setTimeout(r, IMAGE_SETTLE_MS))
  }
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
      // path in the prompt is what Claude Code reads. An image is the
      // exception — pasted, so it becomes `[Image #N]` (pathInput).
      await sendPath(path)
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
  // The app's native drop: paths, not bytes. One window listener for every
  // terminal (dropTargets below) picks the one the point is inside, or,
  // when the point is over none, the terminal last used. Queued with the
  // uploads, so the order holds across both.
  const target: DropTarget = {
    el,
    used: 0,
    deliver: (paths) => {
      queue = queue.then(async () => {
        for (const p of paths) await sendPath(p)
      })
      term.focus()
    },
  }
  const markUsed = () => { target.used = Date.now() }
  el.addEventListener('focusin', markUsed)
  el.addEventListener('pointerdown', markUsed)
  dropTargets.add(target)
  installDropListener()
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
      el.removeEventListener('focusin', markUsed)
      el.removeEventListener('pointerdown', markUsed)
      dropTargets.delete(target)
    },
  }
}

/**
 * "Copied · N chars" over the terminal for a moment: a copy that says
 * nothing reads as a copy that did not happen (owner, 2026-10-11: "I hear a
 * beep and cannot tell whether it copied"). Drawn in the terminal's corner,
 * not as an app toast, so it is where the eye already is.
 */
export function flashCopied(el: HTMLElement | undefined, chars: number): void {
  const host = el?.parentElement
  if (!host) return
  host.querySelector('[data-copied]')?.remove()
  const tip = document.createElement('div')
  tip.setAttribute('data-copied', '')
  tip.setAttribute('role', 'status')
  tip.textContent = `Copied · ${chars.toLocaleString('en-US')} ${chars === 1 ? 'char' : 'chars'}`
  tip.style.cssText = 'position:absolute;top:10px;right:14px;z-index:20;padding:5px 10px;border-radius:8px;font:600 12.5px var(--font-sans,system-ui);color:#1b1b1a;background:var(--color-accent,#feb157);box-shadow:0 6px 18px -8px rgba(0,0,0,.6);pointer-events:none;transition:opacity .25s;opacity:1'
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
  host.appendChild(tip)
  window.setTimeout(() => { tip.style.opacity = '0' }, 1100)
  window.setTimeout(() => tip.remove(), 1400)
}
