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
 * The menu's frame, placement and keys are components/RowMenu.tsx.
 */
import { useState } from 'react'
import { errText, type EditorList } from '@/lib/api'
import { CloseIcon, ExternalIcon, EyeIcon, EyeOffIcon, TrashIcon } from './AppIcons'
import { MenuBox, MenuItem as Item, MenuSeparator as Separator } from './RowMenu'

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
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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

  return (
    <MenuBox at={at} label={`${name}: project actions`} width={WIDTH} refocusKey={confirm} onClose={onClose}>
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
    </MenuBox>
  )
}

