/**
 * Phone mode's device bar, under a browser tab's toolbar (lib/phonemode.ts):
 * the device, a custom size, the browser's bars shown or scrolled away,
 * rotate, touch, the honest list behind ?, and what the page reads.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CUSTOM_MAX, CUSTOM_MIN, DEVICES, TRUTH, clampSide, hostOs, type Device, type Fit, type HostOs, type Layout, type PhonePrefs } from '@/lib/phonemode'
import { QuestionIcon, RotateIcon, TouchIcon } from './AppIcons'

export interface DeviceBarProps {
  prefs: PhonePrefs
  onChange: (next: Partial<PhonePrefs>) => void
  device: Device
  layout: Layout
  fit: Fit
  /** Tests: the host OS the list opens on. */
  os?: HostOs
}

const OS_NAMES: Record<HostOs, string> = { mac: 'macOS', win: 'Windows', lin: 'Linux' }
const MARK: Record<string, string> = { real: '✓', approx: '≈', no: '×' }

export function DeviceBar({ prefs, onChange, device, layout, fit, os = hostOs() }: DeviceBarProps) {
  const [help, setHelp] = useState(false)
  const [listOs, setListOs] = useState<HostOs>(os)
  const helpRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!help) return
    const onDown = (e: MouseEvent) => { if (!helpRef.current?.contains(e.target as Node)) setHelp(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setHelp(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [help])
  const custom = device.id === 'custom'
  const tbtn = (on: boolean) => `flex h-[24px] shrink-0 items-center gap-1 rounded-[6px] border px-2 text-[12px] ${on ? 'border-accent bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-fg' : 'border-[var(--app-hairline)] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg'}`
  const here = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const estTitle = 'An estimate of what the status bar and the browser’s bars leave; not measured on a phone yet'
  return (
    <div data-phone-bar className="relative flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--app-hairline)] px-2 py-1 text-[12px]">
      <select
        aria-label="Device"
        value={prefs.device}
        onChange={(e) => onChange({ device: e.target.value as PhonePrefs['device'] })}
        className="h-[24px] rounded-[6px] border border-[var(--app-hairline)] bg-panel px-1 text-[12px] text-fg"
      >
        {DEVICES.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.browser}</option>)}
        <option value="custom">Custom W×H</option>
      </select>
      {custom && <CustomSize w={prefs.customW} h={prefs.customH} onChange={(customW, customH) => onChange({ customW, customH })} />}
      {!custom && (
        <div role="group" aria-label="Browser bars" className="flex overflow-hidden rounded-[6px] border border-[var(--app-hairline)]">
          {(['shown', 'hidden'] as const).map((b) => (
            <button
              key={b}
              type="button"
              aria-pressed={prefs.bars === b}
              onClick={() => onChange({ bars: b })}
              title={b === 'hidden' ? 'A second size, picked by hand: the bars do not collapse as you scroll' : 'The browser’s bars as a page first loads'}
              className={`h-[22px] px-2 text-[12px] ${prefs.bars === b ? 'bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-fg' : 'text-fg-muted hover:text-fg'}`}
            >
              {b === 'shown' ? 'Bars shown' : 'Bars scrolled away'}
            </button>
          ))}
        </div>
      )}
      <button type="button" aria-pressed={prefs.rotate} onClick={() => onChange({ rotate: !prefs.rotate })} className={tbtn(prefs.rotate)} title="Rotate: swap the sides"><RotateIcon size={13} />Rotate</button>
      <button type="button" aria-pressed={prefs.touch} onClick={() => onChange({ touch: !prefs.touch })} className={tbtn(prefs.touch)} title="Touch (approximate): the mouse acts as one finger — drag to scroll, swipe, pull a sheet"><TouchIcon size={13} />Touch</button>
      <div ref={helpRef} className="relative">
        <button type="button" aria-expanded={help} aria-label="How true phone mode is" title="How true phone mode is" onClick={() => setHelp((h) => !h)} className="flex h-[24px] w-[24px] items-center justify-center rounded-[6px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"><QuestionIcon size={14} /></button>
        {help && (
          <div role="dialog" aria-label="How true phone mode is" data-phone-truth className="absolute left-0 top-[28px] z-50 w-[min(420px,calc(100vw-32px))] rounded-[8px] border border-[var(--app-hairline)] bg-panel p-3 text-[12.5px] text-fg-muted shadow-lg">
            <div className="mb-2 flex items-center justify-between gap-2">
              <b className="text-[12px] font-semibold uppercase tracking-[.06em] text-fg-faint">How true this is</b>
              <div role="group" aria-label="Host OS" className="flex overflow-hidden rounded-[6px] border border-[var(--app-hairline)]">
                {(['mac', 'win', 'lin'] as const).map((o) => (
                  <button key={o} type="button" aria-pressed={listOs === o} onClick={() => setListOs(o)} className={`px-2 py-0.5 text-[11.5px] ${listOs === o ? 'bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-fg' : 'hover:text-fg'}`}>{OS_NAMES[o]}</button>
                ))}
              </div>
            </div>
            <p className="mb-1 text-[11.5px] text-fg-faint">✓ real · ≈ approximate · × not emulated</p>
            <ul className="m-0 list-none p-0">
              {TRUTH[listOs].map(([kind, lead, rest]) => (
                <li key={lead} data-truth={kind} className="flex gap-2 border-b border-[var(--app-hairline)] py-1 last:border-0">
                  <span aria-hidden className={`mono w-3 shrink-0 ${kind === 'real' ? 'text-ok' : kind === 'approx' ? 'text-warn' : 'text-danger'}`}>{MARK[kind]}</span>
                  <span><b className="font-semibold text-fg">{lead}</b>{rest ? `: ${rest}` : ''}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11.5px]">Screen sizes from the makers’ published resolutions; the Android ones depend on the phone’s display-size setting. Page heights marked est. are estimates of the bars, not measured on a phone.</p>
          </div>
        )}
      </div>
      <span className="min-w-0 flex-1" />
      <span className="mono truncate text-[11.5px] text-fg-muted" data-phone-readout>
        page <b className="font-medium text-fg">{layout.pageW}×{layout.pageH}</b>
        {layout.est && <abbr title={estTitle} className="ml-0.5 cursor-help border-b border-dotted border-warn no-underline">est.</abbr>}
        {!custom && <> · screen {layout.screenW}×{layout.screenH}</>}
        {' '}· DPR {here}{!custom && <> here, {device.dpr} on the phone</>} · {device.uaName}
      </span>
      {fit !== 'full' && (
        <p role="status" data-phone-fit-note className="w-full text-[11.5px] text-warn">
          {fit === 'page'
            ? 'The whole phone does not fit this tab: the page area alone, at its true size.'
            : 'The page area is larger than this tab and runs past its edge, at its true size: make the window larger, rotate, or pick a smaller device.'}
        </p>
      )}
    </div>
  )
}

/** Width × height of a custom page, kept on Enter or leaving the field. */
function CustomSize({ w, h, onChange }: { w: number; h: number; onChange: (w: number, h: number) => void }) {
  const [tw, setTw] = useState(String(w))
  const [th, setTh] = useState(String(h))
  useEffect(() => { setTw(String(w)); setTh(String(h)) }, [w, h])
  const commit = () => {
    const nw = clampSide(Number(tw))
    const nh = clampSide(Number(th))
    setTw(String(nw))
    setTh(String(nh))
    if (nw !== w || nh !== h) onChange(nw, nh)
  }
  const field = 'mono h-[24px] w-[56px] rounded-[6px] border border-[var(--app-hairline)] bg-panel px-1 text-[12px] text-fg'
  const props = { type: 'number', min: CUSTOM_MIN, max: CUSTOM_MAX, onBlur: commit, onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { e.preventDefault(); commit() } } } as const
  return (
    <span className="flex items-center gap-1">
      <input aria-label="Width" value={tw} onChange={(e) => setTw(e.target.value)} className={field} {...props} />
      <span className="text-fg-faint">×</span>
      <input aria-label="Height" value={th} onChange={(e) => setTh(e.target.value)} className={field} {...props} />
    </span>
  )
}
