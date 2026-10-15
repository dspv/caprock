/**
 * Second Brain's settings on its own screen: one small gear, *Settings*, and
 * a popover with the three things there are — on or off, the model, the
 * daily limit. The same PUT /v1/brain/settings as Settings → Second Brain;
 * Escape or a click outside closes it.
 */
import { BrainWhere } from '@/components/BrainWhere'
import { useEffect, useRef, useState } from 'react'
import { api, errText, type BrainAutoStatus } from '@/lib/api'
import { tokensShort } from '@/lib/brain'
import { SettingsIcon } from '@/components/AppIcons'

const LIMITS = [100_000, 300_000, 1_000_000]
const MODELS: [string, string][] = [['haiku', 'Haiku'], ['sonnet', 'Sonnet']]

function Seg<T extends string | number>({ label, value, options, onPick }: { label: string; value: T; options: [T, string][]; onPick: (v: T) => void }) {
  return (
    <div className="grid gap-1">
      <span className="text-[12.5px] text-fg-muted">{label}</span>
      <div role="radiogroup" aria-label={label} className="inline-flex h-[30px] items-center rounded-[7px] border border-border p-[2px]">
        {options.map(([v, l]) => (
          <button key={String(v)} type="button" role="radio" aria-checked={value === v} onClick={() => onPick(v)}
            className={`h-full flex-1 rounded-[5px] px-2.5 text-[13px] ${value === v ? 'bg-panel-2 font-medium text-fg' : 'text-fg-muted hover:text-fg'}`}>
            {l}
          </button>
        ))}
      </div>
    </div>
  )
}

export function BrainSettings({ auto, dbPath, onChanged }: { auto: BrainAutoStatus; dbPath?: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState('')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [open])
  const save = (b: Parameters<typeof api.brainSettings>[0]) => {
    setErr('')
    api.brainSettings(b).then(onChanged, (e: unknown) => setErr(errText(e)))
  }
  const limit = LIMITS.includes(auto.daily_tokens) ? auto.daily_tokens : 300_000
  const model = auto.model === 'sonnet' ? 'sonnet' : 'haiku'
  return (
    <div ref={box} className="relative">
      <button type="button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)} data-brain-settings
        className="inline-flex h-[30px] items-center gap-1.5 rounded-[7px] border border-border px-2.5 text-[12.5px] text-fg-muted hover:border-border-strong hover:text-fg">
        <SettingsIcon size={13} /> Settings
      </button>
      {open && (
        <div role="dialog" aria-label="Second Brain settings"
          className="absolute right-0 top-[36px] z-20 grid w-[300px] gap-3 rounded-[10px] border border-border-strong bg-panel p-3 shadow-[var(--shadow-panel)]">
          <label className="flex items-center justify-between gap-2 text-[13.5px] text-fg">
            Build automatically
            <input type="checkbox" role="switch" checked={auto.on} onChange={(e) => save({ auto: e.target.checked })} className="h-4 w-4 accent-[var(--color-accent)]" />
          </label>
          <Seg label="Model" value={model} options={MODELS} onPick={(v) => save({ model: v })} />
          <Seg label="Daily limit" value={limit} options={LIMITS.map((v) => [v, tokensShort(v)] as [number, string])} onPick={(v) => save({ daily_tokens: v })} />
          {err && <p className="text-[12.5px] text-danger">{err}</p>}
          <BrainWhere dbPath={dbPath ?? ''} className="border-t border-[var(--app-hairline)] pt-2.5" />
        </div>
      )}
    </div>
  )
}
