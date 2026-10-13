/**
 * Renaming a session where its name is: the tab or the sidebar row turns into
 * a field (double-click, or Rename… in the row's menu). Enter or leaving the
 * field saves, Escape keeps the old name; an emptied field gives the session
 * back the name Caprock made for it. Keys typed here go nowhere else: not to
 * the tab, the row or the app's shortcuts.
 */
import { useEffect, useRef, useState } from 'react'
import { renameSession } from '@/lib/sessionNames'

export function InlineRename({ sessionId, initial, current = '', onDone, className = '' }: {
  sessionId: string
  /** What the field opens with: the name shown now. */
  initial: string
  /** The user's name for it now, '' when it has none: a rename that changes nothing is not sent. */
  current?: string
  onDone: () => void
  className?: string
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    // Unchanged text keeps whatever names it now, the made-up name included.
    if (save && value.trim() !== initial.trim()) renameSession(sessionId, value, current).catch(() => { /* rolled back */ })
    onDone()
  }
  return (
    <input
      ref={ref}
      data-session-rename={sessionId}
      aria-label="Session name"
      placeholder="Name this session"
      value={value}
      maxLength={120}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') { e.preventDefault(); finish(true) }
        if (e.key === 'Escape') { e.preventDefault(); finish(false) }
      }}
      onBlur={() => finish(true)}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className={`input h-[24px] min-w-0 flex-1 px-1.5 text-[12.5px]${className}`}
    />
  )
}
