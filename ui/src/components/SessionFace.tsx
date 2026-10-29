/**
 * A session's portrait: Claude in the face this session wears (lib/faces.ts),
 * any other agent in its own mark. FacePicker is the small menu a click on
 * the hero's portrait opens: the eight faces, the rubber ducks and the
 * Halloween pumpkins, on three tabs, and a way back to the default. DuckHint is the quiet "try a duck?"
 * line that now and then points at the ducks.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { AgentCharacter, characterFor } from './Characters'
import {
  DUCKS, FACES, FACE_NAME, POOL_NAME, PUMPKINS, duckHintClosed, duckHintDone, duckHintDue, duckHintShown, hasOwnFace, hintKindAt, isDuck,
  isPumpkin, setSessionFace, useFaceDefault, useSessionFace, type Face, type FaceDefault, type FacePool, type HintKind,
} from '@/lib/faces'

type Group = 'faces' | 'ducks' | 'pumpkins'
/** The tabs, in order; arrow keys go round them. */
const GROUPS: readonly Group[] = ['faces', 'ducks', 'pumpkins']
const GROUP_NAME: Record<Group, string> = { faces: 'Faces', ducks: 'Ducks', pumpkins: 'Pumpkins' }
const GROUP_LIST: Record<Group, readonly Face[]> = { faces: FACES, ducks: DUCKS, pumpkins: PUMPKINS }

/** The tab a face is on. */
function groupOf(face: Face): Group {
  return isDuck(face) ? 'ducks' : isPumpkin(face) ? 'pumpkins' : 'faces'
}

/** The three random choices, each drawn as three of what it picks from. */
const POOL_ART: Record<FacePool, [Face, Face, Face]> = {
  random: ['beanie', 'crown', 'propeller'],
  'random-ducks': ['duck', 'duck-party', 'duck-sleepy'],
  'random-pumpkins': ['pumpkin', 'pumpkin-witch', 'pumpkin-ghost'],
  'random-all': ['beanie', 'duck', 'crown'],
}

/**
 * Settings → Appearance: which face a session wears unless you picked one
 * for it — one at random per session (hashed from its id) from the faces,
 * the ducks, the pumpkins, or faces and ducks, or the same for all.
 */
export function FaceDefaultSetting() {
  const [d, setD] = useFaceDefault()
  const tile = (value: FaceDefault, label: string, art: ReactNode) => (
    <button key={value} type="button" role="radio" aria-checked={d === value} title={label} aria-label={label}
      onClick={() => {
        setD(value)
        if (isDuck(value) || value === 'random-ducks' || value === 'random-all') duckHintDone()
        if (isPumpkin(value) || value === 'random-pumpkins') duckHintDone('pumpkins')
      }}
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
        <div className="flex flex-wrap gap-1.5">{pool('random')}{pool('random-ducks')}{pool('random-pumpkins')}{pool('random-all')}</div>
        <div className="flex flex-wrap gap-1.5">{FACES.map(one)}</div>
        <div className="flex flex-wrap gap-1.5" data-face-default-ducks>{DUCKS.map(one)}</div>
        <div className="flex flex-wrap gap-1.5" data-face-default-pumpkins>{PUMPKINS.map(one)}</div>
      </div>
      <p className="text-[12px] text-fg-muted">
        Each session gets one at random and keeps it everywhere — from the eight faces, unless you pick the ducks, the pumpkins, or faces and ducks; click the portrait in a session to give it another.
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
export function useDuckHint(eligible: boolean, kind: HintKind = 'ducks'): [boolean, () => void] {
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
    if (!duckHintDue(Number.MAX_SAFE_INTEGER, kind)) return
    const since = Date.now()
    const t = setInterval(() => {
      const now = Date.now()
      if (now - since < DUCK_HINT_QUIET || now - lastKey < DUCK_HINT_QUIET) return
      if (!duckHintDue(now, kind)) return
      duckHintShown(now, kind)
      setShown(true)
    }, 1000)
    return () => clearInterval(t)
  }, [eligible, shown, kind])
  return [shown, () => setShown(false)]
}

/**
 * The portrait as a button that opens the faces. Only Claude has faces to
 * pick from; another agent's portrait is the plain mark, not a button.
 * `hint` says the session may show the "try a duck?" line now.
 */
export function PickableFace({ agent, sessionId, className, children, hint = false, title, 'data-state': state }: { agent?: string; sessionId: string; className?: string; children: ReactNode; hint?: boolean; title?: string; 'data-state'?: string }) {
  const claude = characterFor(agent ?? 'claude') === 'lead'
  const face = useSessionFace(claude ? sessionId : undefined)
  const [open, setOpen] = useState<Group | null>(null)
  // October offers the pumpkins; the rest of the year, the ducks.
  const kind = hintKindAt(Date.now())
  const inIt = kind === 'pumpkins' ? isPumpkin(face) : isDuck(face)
  const [hinted, hideHint] = useDuckHint(claude && hint && !open && !inIt, kind)
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
  if (!claude) return <div className={className} data-state={state} title={title}>{children}</div>
  return (
    <div ref={box} className={className} data-state={state}>
      <button ref={btn} type="button" data-face-button aria-haspopup="menu" aria-expanded={!!open}
        title={title ? `${title} · change this session's face` : "Change this session's face"} aria-label="Change this session's face"
        onClick={() => setOpen((o) => (o ? null : groupOf(face)))}
        className="grid h-full w-full place-items-center rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]">
        {children}
      </button>
      {hinted && (
        <DuckHint kind={kind}
          onOpen={() => { hideHint(); duckHintDone(kind); setOpen(kind) }}
          onClose={() => { hideHint(); duckHintClosed(kind) }} />
      )}
      {open && <FacePicker sessionId={sessionId} at={at} group={open} onDone={() => { setOpen(null); btn.current?.focus() }} />}
    </div>
  )
}

/** The small speech line beside the portrait: "try a duck?" (in October "try a pumpkin?") opens that tab, × closes it. */
function DuckHint({ kind, onOpen, onClose }: { kind: HintKind; onOpen: () => void; onClose: () => void }) {
  return (
    <div data-duck-hint role="note" className="duck-hint absolute bottom-[3px] left-[calc(100%+9px)] z-10 flex items-center whitespace-nowrap rounded-[8px] border border-border bg-panel text-[11.5px] leading-[18px] text-fg-muted shadow-sm">
      <button type="button" onClick={onOpen} className="rounded-l-[8px] py-[1px] pl-2 pr-1 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]">
        <span className="flex items-center gap-1">{kind === 'pumpkins' ? 'try a pumpkin?' : 'try a duck?'} <AgentCharacter who="lead" face={kind === 'pumpkins' ? 'pumpkin' : 'duck'} size={18} className="-my-[2px]" /></span>
      </button>
      <button type="button" onClick={onClose} aria-label="Not now" title="Not now"
        className="rounded-r-[8px] py-[1px] pl-0.5 pr-1.5 text-fg-faint outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]">×</button>
    </div>
  )
}

export function FacePicker({ sessionId, at, group: initial, onDone }: { sessionId: string; at?: { top: number; left: number }; group?: Group; onDone: () => void }) {
  const face = useSessionFace(sessionId)
  const own = hasOwnFace(sessionId)
  const [group, setGroup] = useState<Group>(initial ?? groupOf(face))
  const menu = useRef<HTMLDivElement>(null)
  const show = (g: Group) => { setGroup(g); if (g !== 'faces') duckHintDone(g) }
  const pick = (f: Face | null) => {
    setSessionFace(sessionId, f)
    if (isDuck(f)) duckHintDone()
    if (isPumpkin(f)) duckHintDone('pumpkins')
    onDone()
  }
  // Opening puts focus on the face worn, or the first of the tab shown.
  useEffect(() => {
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    ;(menu.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]') ?? items?.[0])?.focus()
    if (initial && initial !== 'faces') duckHintDone(initial)
  }, [])
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const tab = (e.target as HTMLElement).getAttribute?.('role') === 'tab'
    if (tab && (e.code === 'ArrowRight' || e.code === 'ArrowLeft')) {
      e.preventDefault()
      const next = GROUPS[(GROUPS.indexOf(group) + (e.code === 'ArrowRight' ? 1 : GROUPS.length - 1)) % GROUPS.length]!
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
  const list = GROUP_LIST[group]
  const tabClass = (g: Group) => `h-[24px] flex-1 rounded-[6px] text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${group === g ? 'bg-panel-2 font-medium text-fg' : 'text-fg-muted hover:text-fg'}`
  return (
    <div ref={menu} role="menu" aria-label="This session's face" data-face-picker data-group={group} onKeyDown={onKey}
      style={at ? { top: at.top, left: at.left } : undefined}
      className="fixed z-50 w-[228px] rounded-[10px] border border-border-strong bg-panel p-2 shadow-lg">
      <div role="tablist" aria-label="Kind" className="mb-1.5 flex gap-1 rounded-[8px] border border-border p-[2px]">
        {GROUPS.map((g) => (
          <button key={g} type="button" role="tab" data-group={g} aria-selected={group === g} tabIndex={group === g ? 0 : -1} onClick={() => show(g)} className={tabClass(g)}>{GROUP_NAME[g]}</button>
        ))}
      </div>
      <div role="group" aria-label={GROUP_NAME[group]} className="grid grid-cols-4 gap-1">
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
