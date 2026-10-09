/**
 * Settings → Terminal (F21): the app terminal's palette, font, size, line
 * height and cursor, with a preview drawn from the same values. Every open
 * pane follows each change at once (lib/termprefs). Kept in this browser,
 * like Appearance.
 */
import { useMemo } from 'react'
import { Choice, Section } from './SettingsParts'
import {
  DEFAULT_PREFS,
  FONT_SIZE_RANGE,
  LINE_HEIGHT_RANGE,
  detectMonoFonts,
  fontStack,
  useTerminalPrefs,
  type CursorStyle,
  type TerminalPrefs,
} from '@/lib/termprefs'
import { TERMINAL_CHOICES, terminalTheme } from '@/lib/termthemes'

export function TerminalSettings() {
  const [prefs, set] = useTerminalPrefs()
  // Measured once per visit: a font installed meanwhile shows on the next.
  const fonts = useMemo(() => detectMonoFonts(), [])
  const shown = fonts.some((f) => f.id === prefs.font) ? fonts : [...fonts, { id: prefs.font, name: prefs.font, family: '' }]
  return (
    <Section title="Terminal">
      <Choice label="Colours" value={prefs.theme} options={TERMINAL_CHOICES.map((t) => ({ value: t.id, label: t.name }))} onChange={(theme) => set({ theme })} />
      <Choice label="Font" value={prefs.font} options={shown.map((f) => ({ value: f.id, label: f.name }))} onChange={(font) => set({ font })} />
      <Slider
        label="Size"
        value={prefs.fontSize}
        min={FONT_SIZE_RANGE.min}
        max={FONT_SIZE_RANGE.max}
        step={1}
        format={(v) => `${v} px`}
        onChange={(fontSize) => set({ fontSize })}
      />
      <Slider
        label="Line height"
        value={prefs.lineHeight}
        min={LINE_HEIGHT_RANGE.min}
        max={LINE_HEIGHT_RANGE.max}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onChange={(lineHeight) => set({ lineHeight })}
      />
      <Choice<CursorStyle>
        label="Cursor"
        value={prefs.cursor}
        options={[
          { value: 'bar', label: 'Bar' },
          { value: 'block', label: 'Block' },
          { value: 'underline', label: 'Underline' },
        ]}
        onChange={(cursor) => set({ cursor })}
      />
      <TerminalPreview prefs={prefs} />
      <p className="flex flex-wrap items-center gap-x-3 text-[12px] text-fg-muted">
        Every open terminal changes as you choose. Saved in this browser only.
        <button type="button" onClick={() => set(DEFAULT_PREFS)} className="text-fg-muted underline-offset-2 hover:text-fg hover:underline">
          Reset to the defaults
        </button>
      </p>
    </Section>
  )
}

function Slider({ label, value, min, max, step, format, onChange }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <label className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="w-24 shrink-0 text-fg-muted">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-48 accent-[var(--color-accent)]"
      />
      <span className="num w-14 text-[12px] text-fg">{format(value)}</span>
    </label>
  )
}

/** A few lines of a shell and the 16 colours, in the chosen palette and face. */
export function TerminalPreview({ prefs }: { prefs: TerminalPrefs }) {
  const t = terminalTheme(prefs.theme).colors
  const mono = typeof document === 'undefined' ? 'monospace' : getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace'
  const cursor = prefs.cursor === 'block'
    ? { background: t.cursor, color: t.cursorAccent }
    : prefs.cursor === 'underline'
      ? { boxShadow: `inset 0 -2px 0 ${t.cursor}` }
      : { boxShadow: `inset 2px 0 0 ${t.cursor}` }
  const normal = [t.black, t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan, t.white]
  const bright = [t.brightBlack, t.brightRed, t.brightGreen, t.brightYellow, t.brightBlue, t.brightMagenta, t.brightCyan, t.brightWhite]
  return (
    <div
      aria-label="Preview"
      data-testid="terminal-preview"
      className="overflow-hidden rounded-[8px] border border-border px-3 py-2.5"
      style={{ background: t.background, color: t.foreground, fontFamily: fontStack(prefs.font, mono), fontSize: prefs.fontSize, lineHeight: prefs.lineHeight, fontVariantLigatures: 'none' }}
    >
      <div className="whitespace-pre">
        <span style={{ color: t.green }}>~/dev/caprock</span> <span style={{ color: t.blue }}>main</span> $ git status --short
      </div>
      <div className="whitespace-pre"><span style={{ color: t.red }}> M</span> ui/src/App.tsx</div>
      <div className="whitespace-pre"><span style={{ color: t.green }}>A </span> ui/src/lib/termprefs.ts</div>
      <div className="whitespace-pre" style={{ color: t.brightBlack }}># 0O 1lI {'{}'} [] =&gt; != ~ — dim text</div>
      <div className="my-1 flex gap-1" aria-hidden>
        {normal.map((c, i) => <span key={`n${i}`} className="h-3 w-5 rounded-[2px]" style={{ background: c }} />)}
      </div>
      <div className="mb-1 flex gap-1" aria-hidden>
        {bright.map((c, i) => <span key={`b${i}`} className="h-3 w-5 rounded-[2px]" style={{ background: c }} />)}
      </div>
      <div className="whitespace-pre">
        <span style={{ color: t.green }}>~/dev/caprock</span> $ <span style={{ ...cursor, display: 'inline-block', width: '0.6em' }}>&nbsp;</span>
      </div>
    </div>
  )
}
