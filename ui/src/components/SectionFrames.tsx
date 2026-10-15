/**
 * The right panel's sections in the viewer's order, each with a small grip
 * in the gutter at its top left (owner, 2026-10-15, translated: "I want the
 * sections in the right panel to be reorderable by users … and to be able to
 * move all of it higher"):
 *
 * - **Drag the grip** — only the grip, never a heading, so a stray drag on a
 *   section never moves it (owner, 2026-10-14) — and drop it between two
 *   others; a line shows where it lands.
 * - **⌥⇧↑ ⌥⇧↓ on the focused grip** (Ctrl+Shift+↑ ↓ off macOS, through
 *   `keys()`): the sidebar's own move-a-row keys (lib/appkeys
 *   isRowMoveKey), which act only on a focused row and type nothing in a
 *   terminal.
 * - **Click the grip** for its menu: Move up, Move down, Move to top, Reset
 *   order — the way to find it all.
 *
 * Moves skip sections that show nothing for this session, so every press
 * visibly moves one. The order is kept per viewer (lib/cockpitorder).
 */
import { Fragment, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { DEFAULT_ORDER, SECTION_NAMES, dropIndex, dropSection, isDefaultOrder, moveSectionTo, setOrder, stepSection, type CockpitSection } from '@/lib/cockpitorder'
import { isRowMoveKey, keys } from '@/lib/appkeys'
import { isMacPlatform } from '@/lib/appmode'
import { MenuBox, MenuItem, MenuSeparator, type MenuAt } from './RowMenu'

/** How far the pointer travels on the grip before it is a drag rather than a click. */
const DRAG_PX = 4

export function SectionFrames({ order, sections }: { order: readonly CockpitSection[]; sections: Record<CockpitSection, ReactNode> }) {
  const shown = order.filter((id) => sections[id] != null && sections[id] !== false)
  const box = useRef<HTMLDivElement>(null)
  // The grip to focus again once a keyboard move has re-ordered the frames.
  const refocus = useRef<CockpitSection | null>(null)
  const [drag, setDrag] = useState<{ id: CockpitSection; k: number } | null>(null)
  const [menu, setMenu] = useState<{ id: CockpitSection; at: MenuAt } | null>(null)

  useLayoutEffect(() => {
    const id = refocus.current
    refocus.current = null
    if (id) box.current?.querySelector<HTMLButtonElement>(`[data-section-grip="${id}"]`)?.focus()
  }, [order])

  // A frame whose section drew nothing (a CI with no pull requests, a
  // repository with nothing to release) is hidden, and moves skip it.
  const drawn = () => shown.filter((x) => {
    const el = box.current?.querySelector(`[data-section-frame="${x}"]`)
    const fold = el?.querySelector(':scope > [data-fold]')
    return !!el && !(fold && fold.childElementCount === 0)
  })
  const others = (id: CockpitSection) => drawn().filter((x) => x !== id)
  const step = (id: CockpitSection, by: -1 | 1) => { refocus.current = id; setOrder(stepSection(order, id, drawn(), by)) }

  // Drag: where the pointer is among the other frames' middles.
  const target = (id: CockpitSection, y: number) => {
    const mids = others(id).map((x) => {
      const r = box.current?.querySelector(`[data-section-frame="${x}"]`)?.getBoundingClientRect()
      return r ? r.top + r.height / 2 : 0
    })
    return dropIndex(mids, y)
  }
  const start = useRef<{ id: CockpitSection; y: number; moved: boolean } | null>(null)
  const onDown = (id: CockpitSection) => (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    start.current = { id, y: e.clientY, moved: false }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* jsdom, an old webview */ }
  }
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    const s = start.current
    if (!s) return
    if (!s.moved && Math.abs(e.clientY - s.y) < DRAG_PX) return
    s.moved = true
    setDrag({ id: s.id, k: target(s.id, e.clientY) })
  }
  const onUp = (e: PointerEvent<HTMLButtonElement>) => {
    const s = start.current
    if (!s?.moved) return
    e.preventDefault()
    setOrder(dropSection(order, s.id, others(s.id), target(s.id, e.clientY)))
    setDrag(null)
    // The click that follows a drag opens no menu.
    setTimeout(() => { start.current = null }, 0)
  }
  const onCancel = () => { start.current = null; setDrag(null) }

  const onKey = (id: CockpitSection) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (isRowMoveKey(e, isMacPlatform())) {
      e.preventDefault()
      e.stopPropagation()
      step(id, e.key === 'ArrowUp' ? -1 : 1)
    } else if (e.key === 'Escape' && drag) {
      onCancel()
    }
  }

  // Where the section with its menu open stands among those drawn.
  const placed = menu ? drawn() : []
  const first = !!menu && placed[0] === menu.id
  const last = !!menu && placed[placed.length - 1] === menu.id

  // The drop line: above the frame the section would land before, or under the last.
  const rest = drag ? others(drag.id) : []
  const lineBefore = drag && drag.k < rest.length ? rest[drag.k] : undefined
  const lineAfter = drag && drag.k >= rest.length ? rest[rest.length - 1] : undefined

  return (
    <div ref={box} className="contents">
      {shown.map((id) => (
        <Fragment key={id}>
          <div data-section-frame={id} data-dragging={drag?.id === id ? '' : undefined}
            className={`group/section relative grid min-w-0 grid-cols-[minmax(0,1fr)] gap-[18px] has-[>[data-fold]:empty]:hidden ${drag?.id === id ? 'opacity-45' : ''}`}>
            {lineBefore === id && <DropLine edge="top" />}
            <button type="button" data-section-grip={id}
              aria-label={`Reorder ${SECTION_NAMES[id]}`} aria-haspopup="menu" aria-expanded={menu?.id === id}
              title={`Drag to move ${SECTION_NAMES[id]}; ${keys('⌥⇧↑')} ${keys('⌥⇧↓')} move it; click for Move to top and more`}
              onPointerDown={onDown(id)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel} onKeyDown={onKey(id)}
              onClick={(e) => {
                if (start.current?.moved) return
                start.current = null
                const r = e.currentTarget.getBoundingClientRect()
                setMenu(menu?.id === id ? null : { id, at: { x: r.left, y: r.bottom + 4 } })
              }}
              className={`absolute -left-[15px] top-[1px] z-10 grid h-[18px] w-[13px] cursor-grab touch-none place-items-center rounded-[4px] text-fg-faint outline-none transition-opacity hover:bg-panel-2 hover:text-fg-muted focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] active:cursor-grabbing motion-reduce:transition-none [@media(hover:none)]:opacity-60 ${menu?.id === id || drag?.id === id ? 'opacity-100' : 'opacity-0 group-hover/section:opacity-100'}`}>
              <svg aria-hidden width="6" height="10" viewBox="0 0 6 10">
                {[1, 5, 9].flatMap((y) => [1, 5].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1" fill="currentColor" />))}
              </svg>
            </button>
            {sections[id]}
            {lineAfter === id && <DropLine edge="bottom" />}
          </div>
          {menu?.id === id && (
            <MenuBox at={menu.at} label={`${SECTION_NAMES[id]} section`} width={208} onClose={() => setMenu(null)}>
              <MenuItem icon="↑" label="Move up" hint={keys('⌥⇧↑')} disabled={first} onClick={() => { setMenu(null); step(id, -1) }} />
              <MenuItem icon="↓" label="Move down" hint={keys('⌥⇧↓')} disabled={last} onClick={() => { setMenu(null); step(id, 1) }} />
              <MenuItem icon="⤒" label="Move to top" disabled={first} onClick={() => { setMenu(null); refocus.current = id; setOrder(moveSectionTo(order, id, 0)) }} />
              <MenuSeparator />
              <MenuItem icon="↺" label="Reset order" disabled={isDefaultOrder(order)} onClick={() => { setMenu(null); refocus.current = id; setOrder(DEFAULT_ORDER) }} />
            </MenuBox>
          )}
        </Fragment>
      ))}
    </div>
  )
}

function DropLine({ edge }: { edge: 'top' | 'bottom' }) {
  return <span data-drop-line aria-hidden className={`pointer-events-none absolute inset-x-0 h-[2px] rounded-full bg-accent ${edge === 'top' ? '-top-[10px]' : '-bottom-[10px]'}`} />
}
