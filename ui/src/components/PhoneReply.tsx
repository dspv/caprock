/**
 * An agent's reply in the phone's chat (.ai/04-ui.md § From a phone,
 * *Replies as Markdown* and *Hold a reply*): the Markdown rendered as a
 * document — code blocks that scroll sideways with Copy, lists, headings,
 * tables with their header — and a press-and-hold menu with what can be done
 * with it: **Copy text**, **Copy code** (each block when there are several)
 * and **Drop into 2nd Brain**.
 *
 * The menu replaced an invisible button: on a computer *Drop into 2nd Brain*
 * shows under a reply on hover, and a phone has no hover, so the button sat
 * under every reply at opacity 0 — a 120×16 target that a tap found by
 * accident and nothing showed (audit, 2026-11-26). The hold is the
 * messenger's: half a second still, the callout and the text selection iOS
 * would start held off for the reply alone, a right click (or Android's long
 * press, a `contextmenu`) the same.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { isPairedDevice } from '@/lib/api'
import { dropIntoBrain } from '@/lib/brain'
import { copyText } from '@/lib/mdreader'
import { codeBlocksOf, ProseDoc } from './Prose'
import { ChatSheet } from './ChatStart'
import { BrainGlyph } from './BrainDrop'

/** How long a finger rests on a reply before its menu opens. */
export const HOLD_MS = 450
/** How far it may wander meanwhile and still be a hold, in px. */
const HOLD_SLOP_PX = 10

/**
 * Press and hold, for touch: `onHold` after HOLD_MS with the finger still,
 * and the tap that the release would have made is swallowed. A move (the
 * reader scrolling) or a second finger is not a hold. The `contextmenu` a
 * mouse's right button or an Android hold sends opens it too.
 */
export function useHold(onHold: () => void, ms = HOLD_MS) {
  const timer = useRef(0)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  const fn = useRef(onHold)
  fn.current = onHold
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const cancel = () => {
    window.clearTimeout(timer.current)
    start.current = null
  }
  return {
    onTouchStart: (e: React.TouchEvent) => {
      fired.current = false
      if (e.touches.length !== 1) { cancel(); return }
      const t = e.touches[0]!
      start.current = { x: t.clientX, y: t.clientY }
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        start.current = null
        fired.current = true
        fn.current()
      }, ms)
    },
    onTouchMove: (e: React.TouchEvent) => {
      const s = start.current
      const t = e.touches[0]
      if (!s || !t) return
      if (Math.abs(t.clientX - s.x) > HOLD_SLOP_PX || Math.abs(t.clientY - s.y) > HOLD_SLOP_PX) cancel()
    },
    onTouchEnd: (e: React.TouchEvent) => {
      cancel()
      // The release after a hold is not a tap on a link under the finger.
      if (fired.current) e.preventDefault()
    },
    onTouchCancel: cancel,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      cancel()
      fn.current()
    },
  }
}

export function PhoneReply({ id, text, onPath, className = 'text-[16px] leading-[1.5]' }: {
  id: number
  text: string
  onPath?: (path: string) => void
  /** The reply's text size and line height. */
  className?: string
}) {
  const [menu, setMenu] = useState(false)
  const hold = useHold(() => setMenu(true))
  return (
    <>
      <div
        data-msg-id={id}
        data-phone-reply
        {...hold}
        // No callout and no selection to start on a hold: the menu is the
        // hold's, and Copy text is in it.
        className="py-1.5 select-none [-webkit-touch-callout:none]"
      >
        <ProseDoc text={text} size="chat" onPath={onPath} className={className} />
      </div>
      {/* Beside the reply, not in it: a portal's touches would reach the hold. */}
      {menu && <ReplyMenu eventId={id} text={text} onClose={() => setMenu(false)} />}
    </>
  )
}

type Drop = { at: 'idle' } | { at: 'busy' } | { at: 'done' } | { at: 'error'; message: string }

/** What can be done with a reply: copy it, copy its code, keep it in 2nd Brain. */
export function ReplyMenu({ eventId, text, onClose }: { eventId: number; text: string; onClose: () => void }) {
  const blocks = codeBlocksOf(text)
  const [copied, setCopied] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [drop, setDrop] = useState<Drop>({ at: 'idle' })
  const closeTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(closeTimer.current), [])
  // Writing the brain is the machine's: a paired device has no drop (BrainDrop).
  const brain = !isPairedDevice()
  const copy = async (what: string, value: string) => {
    const ok = await copyText(value)
    setFailed(!ok)
    if (!ok) return
    setCopied(what)
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(onClose, 700)
  }
  const keep = async () => {
    if (drop.at === 'busy' || drop.at === 'done') return
    setDrop({ at: 'busy' })
    const r = await dropIntoBrain({ event_id: eventId })
    setDrop(r.ok ? { at: 'done' } : { at: 'error', message: r.message })
  }
  return (
    <ChatSheet title="Reply" onClose={onClose}>
      <div role="menu" aria-label="Reply" data-reply-menu className="grid gap-2 pb-[env(safe-area-inset-bottom)] select-text">
        <Item label={copied === 'text' ? 'Copied' : 'Copy text'} onClick={() => void copy('text', text)} />
        {blocks.length === 1 && <Item label={copied === 'code-0' ? 'Copied' : 'Copy code'} onClick={() => void copy('code-0', blocks[0]!.text)} />}
        {blocks.length > 1 && blocks.map((b, i) => (
          <Item key={i} label={copied === `code-${i}` ? 'Copied' : `Copy code ${i + 1}`} note={b.lang || firstLine(b.text)} onClick={() => void copy(`code-${i}`, b.text)} />
        ))}
        {brain && (
          <Item
            label={drop.at === 'done' ? 'In 2nd Brain' : drop.at === 'busy' ? 'Dropping…' : 'Drop into 2nd Brain'}
            icon={<BrainGlyph size={16} />}
            disabled={drop.at === 'busy'}
            onClick={() => void keep()}
            data-brain-drop=""
          />
        )}
        {drop.at === 'error' && <p role="alert" className="text-[13px] text-danger">Could not drop — {drop.message}</p>}
        {failed && <p role="alert" className="text-[13px] text-danger">This page may not use the clipboard.</p>}
      </div>
    </ChatSheet>
  )
}

function firstLine(t: string): string {
  const l = t.split('\n').find((x) => x.trim()) ?? ''
  return l.length > 32 ? `${l.slice(0, 32)}…` : l
}

function Item({ label, note, icon, onClick, disabled, ...rest }: { label: string; note?: string; icon?: ReactNode; onClick: () => void; disabled?: boolean; 'data-brain-drop'?: string }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      {...rest}
      className="flex min-h-12 w-full min-w-0 items-center gap-2.5 rounded-[12px] border border-border-strong bg-bg px-4 text-left text-[16px] text-fg active:bg-panel-2 disabled:opacity-60"
    >
      {icon}
      <span className="shrink-0">{label}</span>
      {note && <span className="mono min-w-0 flex-1 truncate text-right text-[12.5px] text-fg-faint">{note}</span>}
    </button>
  )
}
