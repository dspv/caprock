/**
 * A project's menu in the app's sidebar: its row's ⋯ button, a right-click
 * on the row, or Shift+F10 / the context-menu key on it. Hide it from the
 * list (or show it again), close every tab of it, open its folder in an
 * editor, or remove it from Caprock.
 *
 * Closing tabs never stops anything: the sessions and shells in them keep
 * running, as with ⌘W (rule 7: nothing here signals a process). Removing
 * unlists the project — `DELETE /v1/projects/{id}`, or this page's own list
 * when the daemon keeps none — after a confirmation, and never touches the
 * folder or its sessions.
 *
 * Keyboard: the first item takes focus; ↑ ↓ Home End move, Enter or Space
 * picks, Esc or Tab closes and gives focus back to what opened it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { errText, type EditorList } from '@/lib/api'
import { CloseIcon, ExternalIcon, EyeIcon, EyeOffIcon, TrashIcon } from './AppIcons'

export interface ProjectMenuAt {
  projectId: string
  x: number
  y: number
}

export interface ProjectMenuProps {
  at: ProjectMenuAt
  name: string
  root: string
  /** Hidden by hand: the menu offers to show it again. */
  hidden: boolean
  /** Tabs open for it, splits counted as one tab. */
  tabs: number
  editors: EditorList | null
  onHide?: (hide: boolean) => void
  onCloseTabs: () => void
  onOpenInEditor?: (editorId: string) => void
  /** Unlists it; absent where it cannot be removed (Other folders). */
  onRemove?: () => Promise<void> | void
  onClose: () => void
}

const WIDTH = 248

export function ProjectMenu(props: ProjectMenuProps) {
  const { at, name, root, hidden, tabs, editors, onClose } = props
  const box = useRef<HTMLDivElement>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pos, setPos] = useState({ left: at.x, top: at.y })

  // Kept inside the window: near the right or bottom edge it flips.
  useLayoutEffect(() => {
    const h = box.current?.offsetHeight ?? 0
    const left = Math.max(8, Math.min(at.x, window.innerWidth - WIDTH - 8))
    const top = Math.max(8, at.y + h > window.innerHeight - 8 ? at.y - h : at.y)
    setPos((cur) => (cur.left === left && cur.top === top ? cur : { left, top }))
  }, [at.x, at.y, confirm, error])

  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled]), button')?.focus()
  }, [confirm])

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose() }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    const items = Array.from(box.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    let next = -1
    if (e.key === 'ArrowDown') next = (at + 1) % items.length
    else if (e.key === 'ArrowUp') next = (at - 1 + items.length) % items.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    if (next < 0) return
    e.preventDefault()
    e.stopPropagation()
    items[next]!.focus()
  }

  const pick = (fn?: () => void) => () => { onClose(); fn?.() }
  const remove = async () => {
    if (!props.onRemove) return
    setBusy(true)
    setError('')
    try {
      await props.onRemove()
      onClose()
    } catch (e) {
      setBusy(false)
      setError(`Could not remove ${name}: ${errText(e)}`)
    }
  }

  const ordered = editors && root ? [...editors.editors].sort((a, b) => Number(b.id === editors.preferred) - Number(a.id === editors.preferred)) : []

  // On the page's body: the sidebar's backdrop filter makes it the containing
  // block of anything fixed inside it, so the menu would be cut at its edge.
  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label={`${name}: project actions`}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="app-fade-in fixed z-50 grid gap-px rounded-[10px] border border-[var(--app-hairline-strong)] bg-panel p-1 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]"
      style={{ left: pos.left, top: pos.top, width: WIDTH }}
    >
      <p className="truncate px-2 pb-1 pt-1 text-[12px] font-semibold text-fg" title={root || name}>{name}</p>
      {confirm ? (
        <div className="grid gap-2 px-2 pb-1.5 pt-0.5" role="group" aria-label={`Remove ${name} from Caprock`}>
          <p className="text-[12px] leading-snug text-fg-muted">
            Take <span className="font-medium text-fg">{name}</span> off Caprock's project list? Its folder and files stay where
            they are, its sessions keep running and their history stays. Its tabs close. <span className="text-fg-faint">Add project</span> lists it again.
          </p>
          {error && <p role="alert" className="text-[11.5px] leading-snug text-danger">{error}</p>}
          <div className="flex justify-end gap-1.5">
            <button type="button" onClick={() => { setConfirm(false); setError('') }} className="h-[26px] rounded-[6px] px-2.5 text-[12px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">
              Cancel
            </button>
            <button type="button" disabled={busy} onClick={() => void remove()} className="h-[26px] rounded-[6px] bg-danger px-2.5 text-[12px] font-semibold text-panel hover:brightness-110 disabled:opacity-60">
              {busy ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      ) : (
        <>
          {props.onHide && (hidden ? (
            <Item icon={<EyeIcon size={14} />} label="Show in the sidebar again" onClick={pick(() => props.onHide!(false))} />
          ) : (
            <Item icon={<EyeOffIcon size={14} />} label="Hide from the sidebar" hint="under Hidden" onClick={pick(() => props.onHide!(true))} />
          ))}
          <Item
            icon={<CloseIcon size={14} />}
            label={tabs > 1 ? `Close its ${tabs} tabs` : 'Close its tab'}
            hint={tabs === 0 ? 'none open' : 'they keep running'}
            disabled={tabs === 0}
            onClick={pick(props.onCloseTabs)}
          />
          {ordered.length > 0 && props.onOpenInEditor && (
            <>
              <Separator />
              {ordered.map((ed) => (
                <Item key={ed.id} icon={<ExternalIcon size={14} />} label={`Open in ${ed.name}`} hint={ed.id === editors?.preferred && ordered.length > 1 ? 'default' : undefined} onClick={pick(() => props.onOpenInEditor!(ed.id))} />
              ))}
            </>
          )}
          {props.onRemove && (
            <>
              <Separator />
              <Item icon={<TrashIcon size={14} />} label="Remove from Caprock…" hint="files stay" tone="danger" onClick={() => setConfirm(true)} />
            </>
          )}
        </>
      )}
    </div>,
    document.body,
  )
}

function Item({ icon, label, hint, onClick, disabled, tone }: {
  icon: ReactNode
  label: string
  hint?: string
  onClick: () => void
  disabled?: boolean
  tone?: 'danger'
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`app-row flex h-[28px] w-full min-w-0 items-center gap-2 rounded-[6px] px-2 text-left text-[12.5px] disabled:pointer-events-none ${disabled ? 'text-fg-faint' : tone === 'danger' ? 'text-danger' : 'text-fg'}`}
    >
      <span className={tone === 'danger' ? 'text-danger' : 'text-fg-muted'}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-[10.5px] text-fg-faint">{hint}</span>}
    </button>
  )
}

function Separator() {
  return <span role="separator" className="mx-2 my-0.5 h-px bg-[var(--app-hairline)]" />
}
