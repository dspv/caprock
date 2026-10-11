/**
 * Keep the computer awake while agents work (ADR-049).
 *
 * `KeepAwakeSetting` is the Settings row: three modes and one line saying
 * what the chosen one does. The daemon stores the mode (`keep_awake` in
 * /v1/settings) and holds the OS's "no idle sleep" assertion itself; this
 * screen never asks the OS anything.
 *
 * `KeepAwakeIndicator` is the status strip's mark, drawn only while the
 * daemon is actually holding the machine awake.
 */
import { useEffect, useState } from 'react'
import { api, errText, isPairedDevice, type KeepAwakeMode, type KeepAwakeStatus, type Settings } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { Choice, Section } from './SettingsParts'
import { CloseIcon, CoffeeIcon } from './AppIcons'

const OPTIONS: { value: KeepAwakeMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'working', label: 'While agents work' },
  { value: 'always', label: 'Always' },
]

const HINT: Record<KeepAwakeMode, string> = {
  off: 'Your computer sleeps on its usual schedule, even mid-task.',
  working: 'Your computer does not fall asleep while an agent is working or waiting for approval. The screen can still turn off.',
  always: 'Your computer does not fall asleep while Caprock runs. The screen can still turn off.',
}

/** The popover's one line per mode: the settings page keeps the longer HINT. */
const SHORT: Record<KeepAwakeMode, string> = {
  off: 'Sleeps as usual.',
  working: 'Stays awake while agents work.',
  always: 'Stays awake while Caprock runs.',
}

/** What is happening now, in a few words, for the popover's headline. */
function nowLine(st: KeepAwakeStatus | undefined, mode: KeepAwakeMode): { text: string; awake: boolean } {
  if (st?.error) return { text: 'Could not keep it awake', awake: false }
  if (mode === 'off') return { text: 'Off', awake: false }
  if (st?.holding) {
    if (mode === 'always' || !st.working) return { text: 'Awake now', awake: true }
    return { text: `Awake now · ${st.working} ${st.working === 1 ? 'agent' : 'agents'} working`, awake: true }
  }
  return { text: 'May sleep · no agent working', awake: false }
}

/** A status line for the setting: what is happening now, or why it cannot. */
export function keepAwakeLine(st: KeepAwakeStatus | undefined): string {
  if (!st) return ''
  if (!st.available) return st.reason || 'This computer offers no way to stay awake.'
  if (st.error) return `Could not keep the computer awake: ${st.error}`
  if (st.holding) {
    if (st.mode === 'always') return 'Keeping this computer awake now.'
    return `Keeping this computer awake now · ${st.working} ${st.working === 1 ? 'agent' : 'agents'} working`
  }
  if (st.mode === 'working') return 'No agent is working, so your computer may sleep.'
  return ''
}

export function KeepAwakeSetting() {
  const settings = useApi(() => api.settings(), [], { live: false })
  const status = useApi(() => api.keepAwake(), [], { live: false, intervalMs: 10_000 })
  const [picked, setPicked] = useState<KeepAwakeMode | null>(null)
  const [error, setError] = useState('')
  const refresh = status.refresh
  // The daemon acts on a change at once; ask again a moment later so the line
  // below says what it did, not what it was doing.
  useEffect(() => {
    if (!picked) return
    const t = window.setTimeout(refresh, 900)
    return () => window.clearTimeout(t)
  }, [picked, refresh])
  if (!settings.data) return null
  const value: KeepAwakeMode = picked ?? settings.data.keep_awake ?? 'working'
  const save = async (mode: KeepAwakeMode) => {
    setError('')
    setPicked(mode)
    try {
      await api.saveSettings({ keep_awake: mode } as Partial<Settings> as Settings)
    } catch (e) {
      setError(errText(e))
    }
  }
  const line = keepAwakeLine(status.data && { ...status.data, mode: value })
  const holding = status.data?.holding && value !== 'off'
  return (
    <Section
      id="settings-keep-awake"
      title="Keep awake"
      aside={holding ? <span className="inline-flex items-center gap-1 text-[12px] text-accent"><CoffeeIcon size={13} />awake now</span> : undefined}
    >
      <Choice label="Stay awake" value={value} options={OPTIONS} onChange={(m) => void save(m)} />
      <p className="text-[12px] leading-relaxed text-fg-muted">
        {HINT[value]} Closing a laptop&apos;s lid still puts it to sleep.
      </p>
      {line && value !== 'off' && <p className="text-[12px] text-fg-muted" data-keep-awake-line>{line}</p>}
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </Section>
  )
}

/**
 * The status strip's mark. Its colour says whether the computer is held awake
 * this moment: accent with a live dot while it is, faint while it may sleep.
 * A click opens what it means and the three modes, so the mode changes where
 * it is noticed (owner, 2026-10-11, translated: "it is not clear whether it
 * is active right now or not, and a click should explain or set it").
 * Hidden when the mode is off or the OS offers no way to stay awake.
 */
export function KeepAwakeIndicator() {
  const owner = !isPairedDevice()
  const [open, setOpen] = useState(false)
  const st = useApi(() => (owner ? api.keepAwake() : Promise.resolve(undefined)), [owner], { live: false, intervalMs: open ? 3_000 : 15_000, keepUnchanged: true })
  const s = st.data
  // Always drawn, off included, so the status and the way back are one click
  // away (owner, 2026-10-11: turning it off made the indicator vanish).
  if (!s) return null
  const off = s.mode === 'off' || !s.available
  const holding = !off && s.holding
  const why = !s.available
    ? `Cannot keep this computer awake: ${s.reason || 'nothing here offers it'}.`
    : off
    ? 'Keep awake is off: this computer sleeps on its usual schedule.'
    : holding
    ? s.mode === 'always'
      ? 'Awake now: Caprock is keeping this computer awake while it runs.'
      : `Awake now: ${s.working} ${s.working === 1 ? 'agent is' : 'agents are'} working.`
    : 'May sleep: no agent is working.'
  return (
    <span className="relative">
      <button
        type="button"
        data-keep-awake
        data-holding={holding ? 'true' : 'false'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={`${why} Click for what this means.`}
        className={`inline-flex items-center gap-1 rounded-[5px] px-1 hover:bg-[var(--app-row-hover)] ${holding ? 'text-accent' : 'text-fg-faint'}`}
      >
        <span className="relative inline-flex">
          <CoffeeIcon size={12} />
          {holding && <span aria-hidden className="absolute -right-0.5 -top-0.5 h-[5px] w-[5px] rounded-full bg-ok" />}
        </span>
        {off ? 'awake off' : holding ? 'awake' : 'may sleep'}
      </button>
      {open && <KeepAwakePopover status={s} onClose={() => setOpen(false)} onChanged={st.refresh} />}
    </span>
  )
}

/** What keep-awake is doing and the three modes, above the status strip. */
function KeepAwakePopover({ status, onClose, onChanged }: { status?: KeepAwakeStatus; onClose: () => void; onChanged: () => void }) {
  const [mode, setMode] = useState<KeepAwakeMode>(status?.mode ?? 'working')
  const [error, setError] = useState('')
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  const save = async (m: KeepAwakeMode) => {
    setError('')
    setMode(m)
    try {
      await api.saveSettings({ keep_awake: m } as Partial<Settings> as Settings)
      window.setTimeout(onChanged, 900)
    } catch (e) {
      setError(errText(e))
    }
  }
  const now = nowLine(status, mode)
  return (
    <>
      <span aria-hidden className="fixed inset-0 z-40" onClick={onClose} />
      <div role="dialog" aria-label="Keep awake" data-keep-awake-popover
        className="absolute bottom-[calc(100%+8px)] right-0 z-50 grid w-[300px] gap-3 rounded-[10px] border border-border-strong bg-panel p-3.5 text-left text-fg shadow-lg">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-[15px] font-semibold"><CoffeeIcon size={15} />Keep awake</span>
          <button type="button" aria-label="Close" title="Close (Esc)" onClick={onClose}
            className="-mr-1 grid h-7 w-7 place-items-center rounded-md text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">
            <CloseIcon size={14} />
          </button>
        </div>
        <p data-keep-awake-now className={`flex items-center gap-2 text-[16px] font-medium ${now.awake ? 'text-fg' : 'text-fg-muted'}`}>
          <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${now.awake ? 'bg-ok' : 'bg-fg-faint'}`} />
          {now.text}
        </p>
        <span className="flex gap-1 rounded-md bg-panel-2 p-1" role="radiogroup" aria-label="Stay awake">
          {OPTIONS.map((o) => (
            <button key={o.value} type="button" role="radio" aria-checked={mode === o.value} onClick={() => void save(o.value)}
              className={`flex-auto whitespace-nowrap rounded-[5px] px-2 py-1.5 text-[13px] ${mode === o.value ? 'bg-accent font-medium text-panel' : 'text-fg-muted hover:text-fg'}`}>
              {o.label}
            </button>
          ))}
        </span>
        <p className="text-[14px] text-fg">{SHORT[mode]}</p>
        {error && <p className="text-[13px] text-danger">{error}</p>}
      </div>
    </>
  )
}
