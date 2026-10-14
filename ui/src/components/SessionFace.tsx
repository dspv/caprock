/**
 * A session's portrait: Claude in the face this session wears (lib/faces.ts),
 * any other agent in its own mark. FacePicker is the small menu a click on
 * the hero's portrait opens: the eight faces, and a way back to the default.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { AgentCharacter, characterFor } from './Characters'
import { FACES, FACE_NAME, hasOwnFace, setSessionFace, useFaceDefault, useSessionFace, type Face, type FaceDefault } from '@/lib/faces'

/**
 * Settings → Appearance: which face a session wears unless you picked one
 * for it — a face per session (hashed from its id), or the same for all.
 */
export function FaceDefaultSetting() {
  const [d, setD] = useFaceDefault()
  const options: { value: FaceDefault; label: string }[] = [{ value: 'random', label: 'A face per session' }, ...FACES.map((f) => ({ value: f, label: FACE_NAME[f] }))]
  return (
    <div className="space-y-1.5" data-face-default>
      <p className="text-[13px] text-fg">Claude&rsquo;s face</p>
      <div role="radiogroup" aria-label="Claude's face" className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={d === o.value} title={o.label} aria-label={o.label}
            onClick={() => setD(o.value)}
            className={`grid h-[52px] min-w-[52px] place-items-center rounded-[10px] border px-1 outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${d === o.value ? 'border-accent bg-panel-2' : 'border-border hover:bg-panel-2'}`}>
            {o.value === 'random'
              ? <span className="flex -space-x-4"><AgentCharacter who="lead" face="beanie" size={30} /><AgentCharacter who="lead" face="crown" size={30} /><AgentCharacter who="lead" face="propeller" size={30} /></span>
              : <AgentCharacter who="lead" face={o.value} size={40} />}
          </button>
        ))}
      </div>
      <p className="text-[12px] text-fg-muted">
        Each session gets one of eight at random and keeps it everywhere; click the portrait in a session to give it another.
      </p>
    </div>
  )
}

export function SessionCharacter({ agent, sessionId, size, className }: { agent?: string; sessionId?: string; size?: number; className?: string }) {
  const who = characterFor(agent ?? 'claude')
  const face = useSessionFace(who === 'lead' ? sessionId : undefined)
  return <AgentCharacter who={who} face={who === 'lead' ? face : undefined} size={size} className={className} />
}

/**
 * The portrait as a button that opens the faces. Only Claude has faces to
 * pick from; another agent's portrait is the plain mark, not a button.
 */
export function PickableFace({ agent, sessionId, className, children, 'data-state': state }: { agent?: string; sessionId: string; className?: string; children: ReactNode; 'data-state'?: string }) {
  const claude = characterFor(agent ?? 'claude') === 'lead'
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<{ top: number; left: number }>()
  useLayoutEffect(() => {
    if (!open || !btn.current) return
    const r = btn.current.getBoundingClientRect()
    setAt({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 236)) })
  }, [open])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.code === 'Escape') { setOpen(false); btn.current?.focus() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    box.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open, at])
  if (!claude) return <div className={className} data-state={state}>{children}</div>
  return (
    <div ref={box} className={className} data-state={state}>
      <button ref={btn} type="button" data-face-button aria-haspopup="menu" aria-expanded={open}
        title="Change this session's face" aria-label="Change this session's face"
        onClick={() => setOpen((o) => !o)}
        className="grid h-full w-full place-items-center rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]">
        {children}
      </button>
      {open && <FacePicker sessionId={sessionId} at={at} onDone={() => { setOpen(false); btn.current?.focus() }} />}
    </div>
  )
}

export function FacePicker({ sessionId, at, onDone }: { sessionId: string; at?: { top: number; left: number }; onDone: () => void }) {
  const face = useSessionFace(sessionId)
  const own = hasOwnFace(sessionId)
  const pick = (f: Face | null) => { setSessionFace(sessionId, f); onDone() }
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const d = e.code === 'ArrowRight' ? 1 : e.code === 'ArrowLeft' ? -1 : e.code === 'ArrowDown' ? 4 : e.code === 'ArrowUp' ? -4 : 0
    if (!d) return
    e.preventDefault()
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    items[Math.max(0, Math.min(items.length - 1, i + d))]?.focus()
  }
  return (
    <div role="menu" aria-label="This session's face" data-face-picker onKeyDown={onKey}
      style={at ? { top: at.top, left: at.left } : undefined}
      className="fixed z-50 w-[228px] rounded-[10px] border border-border-strong bg-panel p-2 shadow-lg">
      <div className="grid grid-cols-4 gap-1">
        {FACES.map((f) => (
          <button key={f} type="button" role="menuitemradio" aria-checked={f === face} aria-label={FACE_NAME[f]} title={FACE_NAME[f]}
            onClick={() => pick(f)}
            className={`grid h-[50px] place-items-center rounded-[8px] outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${f === face ? 'bg-panel-2 ring-1 ring-[var(--color-border-strong)]' : ''}`}>
            <AgentCharacter who="lead" face={f} size={42} />
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 px-1 text-[11.5px]">
        <span className="text-fg-faint">{FACE_NAME[face]}</span>
        {own && <button type="button" onClick={() => pick(null)} className="text-fg-muted hover:text-accent">Use the default</button>}
      </div>
    </div>
  )
}
