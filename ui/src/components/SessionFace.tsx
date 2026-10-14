/**
 * A session's portrait: Claude in the face this session wears (lib/faces.ts),
 * any other agent in its own mark. FacePicker is the small menu a click on
 * the hero's portrait opens: the eight faces and the rubber ducks, on two
 * tabs, and a way back to the default. DuckHint is the quiet "try a duck?"
 * line that now and then points at the ducks.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { AgentCharacter, characterFor } from './Characters'
import {
  DUCKS, FACES, FACE_NAME, POOL_NAME, duckHintClosed, duckHintDone, duckHintDue, duckHintShown, hasOwnFace, isDuck,
  setSessionFace, useFaceDefault, useSessionFace, type Face, type FaceDefault, type FacePool,
} from '@/lib/faces'

type Group = 'faces' | 'ducks'

/** The three random choices, each drawn as three of what it picks from. */
const POOL_ART: Record<FacePool, [Face, Face, Face]> = {
  random: ['beanie', 'crown', 'propeller'],
  'random-ducks': ['duck', 'duck-party', 'duck-sleepy'],
  'random-all': ['beanie', 'duck', 'crown'],
}

/**
 * Settings → Appearance: which face a session wears unless you picked one
 * for it — one at random per session (hashed from its id) from the faces,
 * the ducks, or both, or the same for all.
 */
export function FaceDefaultSetting() {
  const [d, setD] = useFaceDefault()
  const tile = (value: FaceDefault, label: string, art: ReactNode) => (
    <button key={value} type="button" role="radio" aria-checked={d === value} title={label} aria-label={label}
      onClick={() => { setD(value); if (isDuck(value) || value === 'random-ducks' || value === 'random-all') duckHintDone() }}
      className={`grid h-[52px] min-w-[52px] place-items-center rounded-[10px] border px-1 outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${d === value ? 'border-accent bg-panel-2' : 'border-border hover:bg-panel-2'}`}>
      {art}
    </button>
  )
  const pool = (p: FacePool) => tile(p, POOL_NAME[p], <span className="flex -space-x-4">{POOL_ART[p].map((f, i) => <AgentCharacter key={i} who="lead" face={f} size={30} />)}</span>)
  const one = (f: Face) => tile(f, FACE_NAME[f], <AgentCharacter who="lead" face={f} size={40} />)
  return (
    <div className="space-y-1.5" data-face-default>
      <p className="text-[13px] text-fg">Claude&rsquo;s face</p>
      <div role="radiogroup" aria-label="Claude's face" className="space-y-1.5">
        <div className="flex flex-wrap gap-1.5">{pool('random')}{pool('random-ducks')}{pool('random-all')}</div>
        <div className="flex flex-wrap gap-1.5">{FACES.map(one)}</div>
        <div className="flex flex-wrap gap-1.5" data-face-default-ducks>{DUCKS.map(one)}</div>
      </div>
      <p className="text-[12px] text-fg-muted">
        Each session gets one at random and keeps it everywhere — from the eight faces, unless you pick the ducks or both; click the portrait in a session to give it another.
      </p>
    </div>
  )
}

export function SessionCharacter({ agent, sessionId, size, className }: { agent?: string; sessionId?: string; size?: number; className?: string }) {
  const who = characterFor(agent ?? 'claude')
  const face = useSessionFace(who === 'lead' ? sessionId : undefined)
  return <AgentCharacter who={who} face={who === 'lead' ? face : undefined} size={size} className={className} />
}

/** Quiet before the line may show: this long in an eligible state, and since the last key. */
export const DUCK_HINT_QUIET = 8000
/** How long the line stays when nobody answers it. */
export const DUCK_HINT_LINGER = 30_000

// The last key pressed anywhere on the page: the line never shows while you type.
let lastKey = 0
let listening = false
function listenForKeys() {
  if (listening || typeof document === 'undefined') return
  listening = true
  document.addEventListener('keydown', () => { lastKey = Date.now() }, true)
}

/**
 * Whether the "try a duck?" line is up. It waits for a quiet spell while
 * `eligible` holds (an idle or waiting Claude, no permission prompt, not in
 * a duck already), shows at most once a day, goes on the first key, after
 * LINGER, or when the session stops being eligible.
 */
export function useDuckHint(eligible: boolean): [boolean, () => void] {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    listenForKeys()
    if (!eligible) { setShown(false); return }
    if (shown) {
      const t = setTimeout(() => setShown(false), DUCK_HINT_LINGER)
      const onKey = () => setShown(false)
      document.addEventListener('keydown', onKey, true)
      return () => { clearTimeout(t); document.removeEventListener('keydown', onKey, true) }
    }
    // Done for good: no timer at all.
    if (!duckHintDue(Number.MAX_SAFE_INTEGER)) return
    const since = Date.now()
    const t = setInterval(() => {
      const now = Date.now()
      if (now - since < DUCK_HINT_QUIET || now - lastKey < DUCK_HINT_QUIET) return
      if (!duckHintDue(now)) return
      duckHintShown(now)
      setShown(true)
    }, 1000)
    return () => clearInterval(t)
  }, [eligible, shown])
  return [shown, () => setShown(false)]
}

/**
 * The portrait as a button that opens the faces. Only Claude has faces to
 * pick from; another agent's portrait is the plain mark, not a button.
 * `hint` says the session may show the "try a duck?" line now.
 */
export function PickableFace({ agent, sessionId, className, children, hint = false, 'data-state': state }: { agent?: string; sessionId: string; className?: string; children: ReactNode; hint?: boolean; 'data-state'?: string }) {
  const claude = characterFor(agent ?? 'claude') === 'lead'
  const face = useSessionFace(claude ? sessionId : undefined)
  const [open, setOpen] = useState<Group | null>(null)
  const [hinted, hideHint] = useDuckHint(claude && hint && !open && !isDuck(face))
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
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(null) }
    const onKey = (e: KeyboardEvent) => { if (e.code === 'Escape') { setOpen(null); btn.current?.focus() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  if (!claude) return <div className={className} data-state={state}>{children}</div>
  return (
    <div ref={box} className={className} data-state={state}>
      <button ref={btn} type="button" data-face-button aria-haspopup="menu" aria-expanded={!!open}
        title="Change this session's face" aria-label="Change this session's face"
        onClick={() => setOpen((o) => (o ? null : isDuck(face) ? 'ducks' : 'faces'))}
        className="grid h-full w-full place-items-center rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]">
        {children}
      </button>
      {hinted && (
        <DuckHint
          onOpen={() => { hideHint(); duckHintDone(); setOpen('ducks') }}
          onClose={() => { hideHint(); duckHintClosed() }} />
      )}
      {open && <FacePicker sessionId={sessionId} at={at} group={open} onDone={() => { setOpen(null); btn.current?.focus() }} />}
    </div>
  )
}

/** The small speech line beside the portrait: "try a duck?" opens the ducks, × closes it. */
function DuckHint({ onOpen, onClose }: { onOpen: () => void; onClose: () => void }) {
  return (
    <div data-duck-hint role="note" className="duck-hint absolute bottom-[3px] left-[calc(100%+9px)] z-10 flex items-center whitespace-nowrap rounded-[8px] border border-border bg-panel text-[11.5px] leading-[18px] text-fg-muted shadow-sm">
      <button type="button" onClick={onOpen} className="rounded-l-[8px] py-[1px] pl-2 pr-1 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]">
        <span className="flex items-center gap-1">try a duck? <AgentCharacter who="lead" face="duck" size={18} className="-my-[2px]" /></span>
      </button>
      <button type="button" onClick={onClose} aria-label="Not now" title="Not now"
        className="rounded-r-[8px] py-[1px] pl-0.5 pr-1.5 text-fg-faint outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]">×</button>
    </div>
  )
}

export function FacePicker({ sessionId, at, group: initial, onDone }: { sessionId: string; at?: { top: number; left: number }; group?: Group; onDone: () => void }) {
  const face = useSessionFace(sessionId)
  const own = hasOwnFace(sessionId)
  const [group, setGroup] = useState<Group>(initial ?? (isDuck(face) ? 'ducks' : 'faces'))
  const menu = useRef<HTMLDivElement>(null)
  const show = (g: Group) => { setGroup(g); if (g === 'ducks') duckHintDone() }
  const pick = (f: Face | null) => { setSessionFace(sessionId, f); if (isDuck(f)) duckHintDone(); onDone() }
  // Opening puts focus on the face worn, or the first of the tab shown.
  useEffect(() => {
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    ;(menu.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]') ?? items?.[0])?.focus()
    if (initial === 'ducks') duckHintDone()
  }, [])
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const tab = (e.target as HTMLElement).getAttribute?.('role') === 'tab'
    if (tab && (e.code === 'ArrowRight' || e.code === 'ArrowLeft')) {
      e.preventDefault()
      const next: Group = group === 'faces' ? 'ducks' : 'faces'
      show(next)
      menu.current?.querySelector<HTMLButtonElement>(`[role="tab"][data-group="${next}"]`)?.focus()
      return
    }
    if (tab && e.code === 'ArrowDown') {
      e.preventDefault()
      menu.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.focus()
      return
    }
    const d = e.code === 'ArrowRight' ? 1 : e.code === 'ArrowLeft' ? -1 : e.code === 'ArrowDown' ? 4 : e.code === 'ArrowUp' ? -4 : 0
    if (!d) return
    e.preventDefault()
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    // Up from the first row goes to the tabs.
    if (i >= 0 && i + d < 0 && d === -4) { menu.current?.querySelector<HTMLButtonElement>(`[role="tab"][data-group="${group}"]`)?.focus(); return }
    items[Math.max(0, Math.min(items.length - 1, i + d))]?.focus()
  }
  const list = group === 'ducks' ? DUCKS : FACES
  const tabClass = (g: Group) => `h-[24px] flex-1 rounded-[6px] text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${group === g ? 'bg-panel-2 font-medium text-fg' : 'text-fg-muted hover:text-fg'}`
  return (
    <div ref={menu} role="menu" aria-label="This session's face" data-face-picker data-group={group} onKeyDown={onKey}
      style={at ? { top: at.top, left: at.left } : undefined}
      className="fixed z-50 w-[228px] rounded-[10px] border border-border-strong bg-panel p-2 shadow-lg">
      <div role="tablist" aria-label="Kind" className="mb-1.5 flex gap-1 rounded-[8px] border border-border p-[2px]">
        <button type="button" role="tab" data-group="faces" aria-selected={group === 'faces'} tabIndex={group === 'faces' ? 0 : -1} onClick={() => show('faces')} className={tabClass('faces')}>Faces</button>
        <button type="button" role="tab" data-group="ducks" aria-selected={group === 'ducks'} tabIndex={group === 'ducks' ? 0 : -1} onClick={() => show('ducks')} className={tabClass('ducks')}>Ducks</button>
      </div>
      <div role="group" aria-label={group === 'ducks' ? 'Ducks' : 'Faces'} className="grid grid-cols-4 gap-1">
        {list.map((f) => (
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
