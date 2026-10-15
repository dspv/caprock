/**
 * The file tab's toolbar (.ai/04-ui.md § The app workspace, File tabs):
 * quiet icons in the tab's header that hand the file on — its path, an
 * agent's `@` reference to it, its contents, a download, and a menu that
 * types the reference into one of the user's running sessions without
 * sending it, so the user adds words first.
 *
 * Every "link" is a path on this machine; nothing is uploaded (rule 4). The
 * menu lists only sessions Caprock started and that still run (rule 7), and
 * the daemon refuses input for any other id anyway.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { agentRef, copyText, downloadText, sendRef, SendRefError } from '@/lib/mdreader'
import { errText } from '@/lib/api'
import { AtIcon, CopyIcon, DownloadIcon, SendIcon } from './AppIcons'

/** A running session Caprock started, that a reference may be typed into. */
export interface SendTarget {
  id: string
  title: string
  /** Its project and branch, to tell two sessions of the same name apart. */
  where: string
}

const ICON_BUTTON = 'flex h-[24px] w-[26px] shrink-0 items-center justify-center rounded-[6px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted'

export function IconButton({ label, tip, onClick, disabled, pressed, children, buttonRef, popup }: {
  label: string
  tip?: string
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
  children: ReactNode
  buttonRef?: React.Ref<HTMLButtonElement>
  popup?: boolean
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      title={tip ?? label}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      aria-haspopup={popup ? 'menu' : undefined}
      className={`${ICON_BUTTON} ${pressed ? 'bg-[var(--app-row-active)] text-fg' : ''}`}
    >
      {children}
    </button>
  )
}

/**
 * A small menu under `anchor`, portalled to <body> so the header's overflow
 * never clips it. Esc or a click outside closes it and gives the focus back.
 */
export function Popover({ anchor, label, onClose, width = 280, children }: {
  anchor: HTMLElement | null
  label: string
  onClose: () => void
  width?: number
  children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!anchor) return
    const r = anchor.getBoundingClientRect()
    setPos({ left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)), top: r.bottom + 4 })
  }, [anchor, width])
  useEffect(() => {
    if (!pos) return
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', away, true)
    return () => window.removeEventListener('mousedown', away, true)
  }, [pos, anchor, onClose])
  const onKey = (e: React.KeyboardEvent) => {
    const items = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') { onClose(); anchor?.focus() }
    else if (e.key === 'ArrowDown') items[(at + 1) % items.length]?.focus()
    else if (e.key === 'ArrowUp') items[(at - 1 + items.length) % items.length]?.focus()
    else return
    e.preventDefault()
    e.stopPropagation()
  }
  if (!pos) return null
  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label={label}
      onKeyDown={onKey}
      style={{ left: pos.left, top: pos.top, width }}
      className="app-fade-in fixed z-50 max-h-[60vh] overflow-y-auto rounded-[9px] border border-[var(--app-hairline-strong)] bg-panel p-1 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]"
    >
      {children}
    </div>,
    document.body,
  )
}

export const MENU_ROW = 'flex w-full items-center gap-2.5 rounded-[6px] px-2.5 text-left text-[13px] text-fg outline-none hover:bg-[var(--app-row-active)] focus:bg-[var(--app-row-active)]'

export function FileToolbar({ path, absPath, text, truncated, md, targets, onSent }: {
  /** The path inside the worktree: the download's name. */
  path: string
  /** The path on this machine; absent when the folder is not known here. */
  absPath?: string
  /** The file's text; absent for a binary or before it is read. */
  text?: string
  /** Only the first megabyte came: copying or saving it would be a part. */
  truncated?: boolean
  md: boolean
  targets: readonly SendTarget[]
  /** A reference was typed into this session: bring it to the front. */
  onSent?: (sessionId: string) => void
}) {
  const [note, setNote] = useState('')
  const [menu, setMenu] = useState(false)
  const sendButton = useRef<HTMLButtonElement>(null)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const say = (s: string) => {
    setNote(s)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setNote(''), 2000)
  }
  const copy = async (s: string, done: string) => say((await copyText(s)) ? done : 'Could not reach the clipboard.')
  const name = path.slice(path.lastIndexOf('/') + 1)
  const whole = text !== undefined && !truncated
  const partTip = truncated ? 'Only the first megabyte is shown here; open the file in the editor for all of it' : undefined
  const send = async (t: SendTarget) => {
    setMenu(false)
    if (!absPath) return
    try {
      await sendRef(t.id, absPath)
      say(`Typed into ${t.title}; add your words and send.`)
      onSent?.(t.id)
    } catch (e) {
      say(e instanceof SendRefError ? e.message : `Could not type into ${t.title}: ${errText(e)}`)
    }
  }
  const what = md ? 'Markdown' : 'contents'
  return (
    <div className="flex shrink-0 items-center gap-0.5" role="toolbar" aria-label="File">
      <span aria-live="polite" className="mr-1.5 max-w-[260px] truncate text-[11.5px] text-fg-muted">{note}</span>
      <IconButton label="Copy path" tip={absPath ? `Copy path — ${absPath}` : 'The folder is not known here'} disabled={!absPath} onClick={() => absPath && void copy(absPath, 'Path copied.')}>
        <CopyIcon size={14} />
      </IconButton>
      <IconButton label="Copy for an agent" tip={absPath ? `Paste into any agent's prompt — ${agentRef(absPath)}` : 'The folder is not known here'} disabled={!absPath} onClick={() => absPath && void copy(agentRef(absPath), 'Copied — paste into any agent’s prompt.')}>
        <AtIcon size={14} />
      </IconButton>
      <IconButton label={`Copy ${what}`} tip={partTip ?? `Copy the ${what}`} disabled={!whole} onClick={() => whole && void copy(text, md ? 'Markdown copied.' : 'Contents copied.')}>
        <span aria-hidden className="mono text-[10.5px] font-semibold leading-none">{md ? 'MD' : 'TXT'}</span>
      </IconButton>
      <IconButton label="Download" tip={partTip ?? `Download ${name}`} disabled={!whole} onClick={() => { if (whole) { downloadText(text, name, md ? 'text/markdown' : 'text/plain'); say('Saved to your downloads.') } }}>
        <DownloadIcon size={14} />
      </IconButton>
      <IconButton label="Send to a session" tip={absPath ? 'Type the file’s reference into a running session, without sending' : 'The folder is not known here'} disabled={!absPath} popup pressed={menu} buttonRef={sendButton} onClick={() => setMenu((m) => !m)}>
        <SendIcon size={14} />
      </IconButton>
      {menu && (
        <Popover anchor={sendButton.current} label="Send to a session" onClose={() => setMenu(false)} width={300}>
          <p className="px-2.5 pb-1 pt-1.5 text-[11.5px] text-fg-faint">Types <span className="mono">@…/{name}</span> into the agent’s prompt; you add words and send.</p>
          {targets.length === 0 ? (
            <p className="px-2.5 pb-2 pt-1 text-[12.5px] text-fg-muted">No agent Caprock started is running. Start one, then send.</p>
          ) : targets.map((t) => (
            <button key={t.id} type="button" role="menuitem" tabIndex={-1} onClick={() => void send(t)} className={`${MENU_ROW} flex-col items-start gap-0.5 py-1.5 leading-tight`}>
              <span className="w-full truncate">{t.title}</span>
              <span className="w-full truncate text-[11px] text-fg-faint">{t.where}</span>
            </button>
          ))}
        </Popover>
      )}
    </div>
  )
}
