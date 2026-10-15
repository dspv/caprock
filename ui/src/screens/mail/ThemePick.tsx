import { useEffect, useState } from 'react'
import { THEMES } from '@/lib/themes'
import { endThemePreview, previewThemeMode, useThemeMode } from '@/lib/theme'
import { K } from './keymap'

/**
 * The theme from the keyboard (t): the same palettes as Caprock's, one press
 * away — Sunlight outdoors, Dark Pastel at night (owner, 2026-10-15). Moving
 * through the list shows each palette at once; Enter keeps it, Esc puts the
 * old one back, a digit picks directly.
 */
export function ThemePick({ onClose }: { onClose: () => void }) {
  const { mode, set } = useThemeMode()
  const [at, setAt] = useState(Math.max(0, THEMES.findIndex((t) => t.id === mode)))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      let i = at
      if (e.key === 'j' || e.key === 'ArrowDown') i = Math.min(at + 1, THEMES.length - 1)
      else if (e.key === 'k' || e.key === 'ArrowUp') i = Math.max(at - 1, 0)
      else if (/^[1-9]$/.test(e.key) && Number(e.key) <= THEMES.length) { set(THEMES[Number(e.key) - 1]!.id); onClose() }
      else if (e.key === 'Enter') { set(THEMES[at]!.id); onClose() }
      else if (e.key === 'Escape' || e.key === 't') { endThemePreview(); onClose() }
      else return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (i !== at) { setAt(i); previewThemeMode(THEMES[i]!.id) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  return (
    <div className="themepick" role="listbox" aria-label="Theme">
      <div className="keyhead">Theme <span className="grow" /><K k="close" /></div>
      {THEMES.map((t, i) => (
        <div key={t.id} role="option" aria-selected={i === at} className={'themerow' + (i === at ? ' on' : '')}
          onMouseEnter={() => { setAt(i); previewThemeMode(t.id) }}
          onClick={() => { set(t.id); onClose() }}>
          <span className="swatch" style={{ background: t.swatch.bg, borderColor: t.swatch.panel }}>
            <i style={{ background: t.swatch.accent }} />
          </span>
          <span>{t.name}</span>
          {t.id === mode && <span className="muted small">current</span>}
          <span className="grow" />
          {i < 9 && <kbd className="k">{i + 1}</kbd>}
        </div>
      ))}
    </div>
  )
}

/** The button under the folders: the palette in use and its key. */
export function ThemeButton({ onOpen }: { onOpen: () => void }) {
  const { mode } = useThemeMode()
  const t = THEMES.find((r) => r.id === mode)
  return (
    <button className="icon withkey themebtn" title="Theme" onClick={onOpen}>
      <span className="swatch" style={{ background: t?.swatch.bg, borderColor: t?.swatch.panel }}><i style={{ background: t?.swatch.accent }} /></span>
      <K k="theme" />
    </button>
  )
}
