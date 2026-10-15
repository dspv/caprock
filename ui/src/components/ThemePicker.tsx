/**
 * The nine palettes as swatches, in two groups — Dark, then Light: hovering
 * one shows it on the whole page, leaving puts back what is kept, and a click
 * keeps it (owner, 2026-10-11: "not just poking — you open it, move across,
 * it changes, and you pick what you like", translated). Used by the theme
 * buttons' popover and by Settings → Appearance, larger there.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { THEME_MODE_NAME, THEME_SWATCH, endThemePreview, previewThemeMode, useThemeMode, type ThemeMode } from '@/lib/theme'
import { THEMES } from '@/lib/themes'

const GROUPS = [
  { label: 'Dark', modes: THEMES.filter((t) => t.theme === 'dark').map((t) => t.id) },
  { label: 'Light', modes: THEMES.filter((t) => t.theme === 'light').map((t) => t.id) },
] as const

export function ThemePicker({ size = 'menu', onPicked }: { size?: 'menu' | 'cards'; onPicked?: () => void }) {
  const { mode, set } = useThemeMode()
  // A preview left behind by an unmount (the popover closing under the
  // pointer) would leave the page in a palette nobody chose.
  useEffect(() => () => endThemePreview(), [])
  const big = size === 'cards'
  return (
    <div role="radiogroup" aria-label="Theme" onMouseLeave={endThemePreview} className={`grid ${big ? 'gap-4' : 'gap-2.5'}`}>
      {GROUPS.map((g) => (
        <div key={g.label} role="group" aria-label={g.label} className="grid gap-1.5">
          <div className={`px-0.5 uppercase tracking-[0.1em] text-fg-faint ${big ? 'text-[11.5px]' : 'text-[10.5px]'}`}>{g.label}</div>
          <div className={`grid ${big ? 'grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4' : 'grid-cols-2 gap-2'}`}>
            {g.modes.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} data-theme-option={m}
                onMouseEnter={() => previewThemeMode(m)} onFocus={() => previewThemeMode(m)} onBlur={endThemePreview}
                onClick={() => { set(m); onPicked?.() }}
                className={`group grid gap-1.5 rounded-[10px] p-1.5 text-left outline-none transition-colors ${mode === m ? 'ring-2 ring-accent' : 'ring-1 ring-[var(--app-hairline-strong,var(--color-border-strong))] hover:ring-fg-faint'} focus-visible:ring-2 focus-visible:ring-accent`}>
                <Swatch m={m} big={big} />
                <span className={`flex items-center justify-between px-0.5 ${big ? 'text-[14px]' : 'text-[12.5px]'} ${mode === m ? 'font-semibold text-fg' : 'text-fg-muted'}`}>
                  {THEME_MODE_NAME[m]}
                  {mode === m && <span aria-hidden className="text-accent">✓</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/** A tiny window in the palette: a sidebar, a panel with lines of text, and the accent. */
function Swatch({ m, big }: { m: ThemeMode; big: boolean }) {
  const c = THEME_SWATCH[m]
  return (
    <span aria-hidden className={`flex overflow-hidden rounded-[7px] border border-black/10 ${big ? 'h-[72px]' : 'h-[46px]'}`} style={{ background: c.bg }}>
      <span className="w-[26%]" style={{ background: c.panel }}>
        <span className="mx-1.5 mt-2 block h-[3px] rounded-full" style={{ background: c.accent2 ?? c.accent }} />
        <span className="mx-1.5 mt-1.5 block h-[3px] w-2/3 rounded-full" style={{ background: c.muted }} />
      </span>
      <span className="flex-1 p-1.5">
        <span className="block h-[4px] w-3/4 rounded-full" style={{ background: c.fg }} />
        <span className="mt-1.5 block h-[3px] w-1/2 rounded-full" style={{ background: c.muted }} />
        <span className="mt-1.5 block h-[3px] w-2/3 rounded-full" style={{ background: c.muted }} />
        <span className={`mt-2 block rounded-[3px] ${big ? 'h-[10px] w-[40%]' : 'h-[7px] w-[45%]'}`} style={{ background: c.accent }} />
      </span>
    </span>
  )
}

/** The popover's width: two columns of swatches with their names. */
export const THEME_MENU_W = 248
/** The least room kept between the popover and any edge of the window. */
const EDGE = 8
/** The gap between the button and the popover. */
const GAP = 6

export interface MenuRect { left: number; top: number; right: number; bottom: number }

/**
 * Where the popover goes, in window coordinates: beside the button on the
 * preferred side (`up` or `down`) when it fits there, else on the side with
 * more room; its `align` edge on the button's; then held inside the window
 * on every edge, `EDGE` px in. Taller than the window, it is capped at the
 * window less the margins and scrolls (`maxHeight`). Pure, for the tests.
 */
export function placeThemeMenu(btn: MenuRect, height: number, view: { w: number; h: number }, placement: 'up' | 'down', align: 'left' | 'right'): { left: number; top: number; width: number; maxHeight: number } {
  const width = Math.max(0, Math.min(THEME_MENU_W, view.w - 2 * EDGE))
  const maxHeight = Math.max(0, view.h - 2 * EDGE)
  const h = Math.min(height, maxHeight)
  const above = btn.top - GAP - EDGE
  const below = view.h - btn.bottom - GAP - EDGE
  const up = placement === 'up' ? h <= above || above >= below : !(h <= below || below >= above)
  let top = up ? btn.top - GAP - h : btn.bottom + GAP
  top = Math.max(EDGE, Math.min(top, view.h - EDGE - h))
  let left = align === 'left' ? btn.left : btn.right - width
  left = Math.max(EDGE, Math.min(left, view.w - EDGE - width))
  return { left, top, width, maxHeight }
}

/**
 * The theme button's popover: the picker, opening up or down from the button.
 * `align`: which edge of the button the picker lines up with — `right` (it
 * opens leftwards) by default, `left` where the button sits near the
 * window's left edge.
 *
 * Portalled to <body> and placed in window coordinates (owner, 2026-10-15,
 * translated: "look how it appears!!"): inside the sidebar it was cut at the
 * sidebar's edge — the sidebar's backdrop filter makes it the containing
 * block of anything positioned inside it — and the terminal drew over the
 * rest. It now sits above everything and is kept inside the window on every
 * edge, whatever the sidebar's width or fold.
 *
 * Keyboard: opening it puts the focus on the palette in use; Tab and ⇧Tab
 * walk the palettes, and past either end, or Esc, close it and give the
 * focus back to the button.
 */
export function ThemeMenu({ children, label, placement = 'up', align = 'right', className = '', boxClassName = '' }: { children: React.ReactNode; label: string; placement?: 'up' | 'down'; align?: 'left' | 'right'; className?: string; /** The wrapper's classes, e.g. to let the button fill a grid cell. */ boxClassName?: string }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<ReturnType<typeof placeThemeMenu> | null>(null)
  const box = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = (focusBack: boolean) => {
    setOpen(false)
    setPos(null)
    if (focusBack) button.current?.focus()
  }
  const place = () => {
    if (!button.current || !menu.current) return
    const next = placeThemeMenu(button.current.getBoundingClientRect(), menu.current.scrollHeight, { w: window.innerWidth, h: window.innerHeight }, placement, align)
    setPos((cur) => (cur && cur.left === next.left && cur.top === next.top && cur.width === next.width && cur.maxHeight === next.maxHeight ? cur : next))
  }
  // Measured before paint, so it never shows in the wrong place.
  useLayoutEffect(() => { if (open) place() })
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!box.current?.contains(t) && !menu.current?.contains(t)) close(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(true) }
    const onResize = () => place()
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])
  // Once placed, the palette in use takes the focus.
  const placed = !!pos
  useEffect(() => {
    if (!open || !placed) return
    const on = menu.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? menu.current?.querySelector<HTMLElement>('[role="radio"]')
    on?.focus({ preventScroll: true })
  }, [open, placed])
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return
    const radios = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])
    const i = radios.indexOf(document.activeElement as HTMLElement)
    if ((e.shiftKey && i === 0) || (!e.shiftKey && i === radios.length - 1)) {
      e.preventDefault()
      close(true)
    }
  }
  return (
    <span ref={box} className={`relative inline-flex ${boxClassName}`}>
      <button ref={button} type="button" aria-label={label} title={open ? undefined : label} aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close(false) : setOpen(true))} className={className}>
        {children}
      </button>
      {open && createPortal(
        <div ref={menu} role="dialog" aria-label="Theme" data-theme-menu onKeyDown={onMenuKey}
          style={pos ? { left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight } : { left: 0, top: 0, width: THEME_MENU_W, visibility: 'hidden' }}
          className="app-fade-in fixed z-[100] overflow-y-auto overscroll-contain rounded-[12px] border border-[var(--app-hairline-strong,var(--color-border-strong))] bg-panel p-2.5 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]">
          <div className="mb-2 px-0.5 text-[11px] uppercase tracking-[0.1em] text-fg-faint">Theme · hover to try</div>
          <ThemePicker onPicked={() => close(true)} />
        </div>,
        document.body,
      )}
    </span>
  )
}
