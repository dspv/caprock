/**
 * The four palettes as swatches: hovering one shows it on the whole page,
 * leaving puts back what is kept, and a click keeps it (owner, 2026-10-11:
 * "not just poking — you open it, move across, it changes, and you pick what
 * you like"). Used by the theme buttons' popover and by Settings →
 * Appearance, larger there.
 */
import { useEffect, useRef, useState } from 'react'
import { THEME_MODES, THEME_MODE_NAME, THEME_SWATCH, endThemePreview, previewThemeMode, useThemeMode, type ThemeMode } from '@/lib/theme'

export function ThemePicker({ size = 'menu', onPicked }: { size?: 'menu' | 'cards'; onPicked?: () => void }) {
  const { mode, set } = useThemeMode()
  // A preview left behind by an unmount (the popover closing under the
  // pointer) would leave the page in a palette nobody chose.
  useEffect(() => () => endThemePreview(), [])
  const big = size === 'cards'
  return (
    <div role="radiogroup" aria-label="Theme" onMouseLeave={endThemePreview}
      className={`grid ${big ? 'grid-cols-2 gap-3 sm:grid-cols-4' : 'grid-cols-2 gap-2'}`}>
      {THEME_MODES.map((m) => (
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
  )
}

/** A tiny window in the palette: a sidebar, a panel with lines of text, and the accent. */
function Swatch({ m, big }: { m: ThemeMode; big: boolean }) {
  const c = THEME_SWATCH[m]
  return (
    <span aria-hidden className={`flex overflow-hidden rounded-[7px] border border-black/10 ${big ? 'h-[72px]' : 'h-[46px]'}`} style={{ background: c.bg }}>
      <span className="w-[26%]" style={{ background: c.panel }}>
        <span className="mx-1.5 mt-2 block h-[3px] rounded-full" style={{ background: c.accent }} />
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

/** The theme button's popover: the picker, opening up or down from the button. */
export function ThemeMenu({ children, label, placement = 'up', className = '' }: { children: React.ReactNode; label: string; placement?: 'up' | 'down'; className?: string }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  return (
    <span ref={box} className="relative inline-flex">
      <button type="button" aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={className}>
        {children}
      </button>
      {open && (
        <div role="dialog" aria-label="Theme" data-theme-menu
          className={`app-fade-in absolute z-50 w-[248px] rounded-[12px] border border-[var(--app-hairline-strong,var(--color-border-strong))] bg-panel p-2.5 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)] ${placement === 'up' ? 'bottom-[calc(100%+6px)] right-0' : 'top-[calc(100%+6px)] right-0'}`}>
          <div className="mb-2 px-0.5 text-[11px] uppercase tracking-[0.1em] text-fg-faint">Theme · hover to try</div>
          <ThemePicker onPicked={() => setOpen(false)} />
        </div>
      )}
    </span>
  )
}
