import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ATTACH_ACCEPT, FILES_ACCEPT, PHOTOS_ACCEPT } from '@/lib/attach'
import { touchScreen } from '@/lib/phone'

/**
 * The attach button and its pickers, one for every place a phone attaches
 * (the phone's New chat and Save, the chat's Attach on the phone page and on
 * the Full dashboard).
 *
 * On a touch screen a tap opens a two-item menu, *Photos* and *Files*, each
 * its own `<input type=file>`: Photos takes `image/*`, which iOS answers with
 * Photo Library and Take Photo; Files takes the document extensions alone,
 * and with no image type in it iOS skips its media sheet and opens the Files
 * browser. One input with both (until 2026-11-06) left every choice to iOS's
 * own sheet ("Photo Library", "Take Photo or Video", "Choose File"), where
 * the owner could not find the gallery and his files (owner, 2026-11-06).
 *
 * With a mouse the button opens the one picker that takes everything the
 * daemon keeps (ATTACH_ACCEPT): a desktop file dialog already shows both.
 */
export function AttachPicker({ onFiles, disabled, className, label = 'Attach a photo or file', title, testId, up = false, children }: {
  onFiles: (files: File[]) => void
  disabled?: boolean
  /** The button's classes: each place keeps its own look. */
  className: string
  label?: string
  title?: string
  /** The files input's test id; the photos input's is `${testId}-photos`. */
  testId: string
  /** Open the menu above the button (a bar at the bottom of the screen). */
  up?: boolean
  children: ReactNode
}) {
  const files = useRef<HTMLInputElement>(null)
  const photos = useRef<HTMLInputElement>(null)
  const [menu, setMenu] = useState(false)
  // Read at the tap, not at render: a tablet with a keyboard case can switch.
  const [touch, setTouch] = useState(touchScreen)

  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])

  const picked = (el: HTMLInputElement) => {
    const list = [...(el.files ?? [])]
    el.value = ''
    if (list.length > 0) onFiles(list)
  }
  // The input's click stays inside the tap that chose it, which is what
  // lets iOS open its picker at all.
  const open = (which: 'photos' | 'files') => {
    setMenu(false)
    ;(which === 'photos' ? photos : files).current?.click()
  }
  const tap = () => {
    const t = touchScreen()
    setTouch(t)
    if (t) setMenu((m) => !m)
    else files.current?.click()
  }

  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={tap}
        aria-label={label}
        aria-haspopup={touch ? 'menu' : undefined}
        aria-expanded={touch ? menu : undefined}
        title={title}
        className={className}
      >
        {children}
      </button>
      <input
        ref={photos}
        type="file"
        accept={PHOTOS_ACCEPT}
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        data-testid={`${testId}-photos`}
        onChange={(e) => picked(e.currentTarget)}
      />
      {/* No `capture` on either: with it iOS opens the camera and nothing else. */}
      <input
        ref={files}
        type="file"
        accept={touch ? FILES_ACCEPT : ATTACH_ACCEPT}
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        data-testid={testId}
        onChange={(e) => picked(e.currentTarget)}
      />
      {menu && (
        <>
          <div className="fixed inset-0 z-40" aria-hidden onClick={() => setMenu(false)} />
          <div
            role="menu"
            aria-label="Attach from"
            className={`absolute left-0 z-50 w-56 rounded-md border border-border-strong bg-panel py-1 shadow-lg ${up ? 'bottom-full mb-2' : 'top-full mt-2'}`}
          >
            <MenuItem onClick={() => open('photos')} icon={<PhotoIcon />} title="Photos" note="Photo library or camera" />
            <MenuItem onClick={() => open('files')} icon={<DocIcon />} title="Files" note="PDF, text, office, code" />
          </div>
        </>
      )}
    </span>
  )
}

function MenuItem({ onClick, icon, title, note }: { onClick: () => void; icon: ReactNode; title: string; note: string }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="flex min-h-[48px] w-full items-center gap-3 px-3 py-2 text-left hover:bg-panel-2">
      {icon}
      <span className="grid">
        <span className="text-[15px] text-fg">{title}</span>
        <span className="text-[12.5px] text-fg-muted">{note}</span>
      </span>
    </button>
  )
}

const ICON = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }

function PhotoIcon() {
  return <svg {...ICON} className="shrink-0 text-fg-muted"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-8 8" /></svg>
}

function DocIcon() {
  return <svg {...ICON} className="shrink-0 text-fg-muted"><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h4" /></svg>
}
