/**
 * A browser tab's content (the in-app browser, beta, ADR-075): a toolbar —
 * back, forward, reload, the address box, copy, open in your browser,
 * close — over the page.
 *
 * The page is a window of its own that the shell lays over this
 * component's box (app/src-tauri/src/browser.rs), never a child webview of
 * the dashboard's window. It follows the box as the window and the panels
 * move, and hides while the tab is behind, the window is hidden, or a sheet
 * or a menu lies over it (a native window draws over the dashboard's own
 * elements). Hidden is all: the page stays loaded where it was, scrolled
 * where it was, until its tab is closed.
 *
 * A new tab has no page yet: its address box takes the cursor, and Enter
 * goes to an address or searches with the engine in Settings. A tab restored
 * after a restart waits on *Load the page* (rule 4: nothing loads without a
 * click).
 *
 * When an agent turns to waiting on you while the tab is in front, a strip
 * names it with *Go*, and a playing video is paused (Settings: *Pause a
 * video when an agent needs me*) — the YouTube tab's idea (#618), for any
 * page.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { isMacPlatform, isTauri } from '@/lib/appmode'
import { getUiScale, useUiScale } from '@/lib/uiscale'
import { openLink } from '@/lib/termlinks'
import { keys, PHONE_MODE_KEY } from '@/lib/appkeys'
import { addressOrSearch, BROWSER_EVENT, browserAct, browserKey, engineOf, overlayOpen, pageId, rectOf, sameRect, type BrowserNews, type PageRect } from '@/lib/browsertab'
import { deviceOf, fitOf, frameSize, layoutOf, loadPhonePrefs, phoneOn, phoneSpec, savePhonePrefs, setPhoneOn, type PhonePrefs } from '@/lib/phonemode'
import { BackIcon, CloseIcon, CopyIcon, ExternalIcon, ForwardIcon, GlobeIcon, PhoneIcon, ReloadIcon } from './AppIcons'
import { DeviceBar } from './DeviceBar'
import { PhoneFrame } from './PhoneFrame'

/** A session waiting on you, as the nudge names it. */
export interface WaitingAgent {
  id: string
  title: string
}

export interface BrowserViewProps {
  /** The tab's key (`page:…`), which names the page's window. */
  pageKey: string
  /** The address it shows; '' for a new tab not yet sent anywhere. */
  url: string
  /** The tab is in front (and no view of the workspace covers it). */
  visible: boolean
  /** The in-app browser is on (Settings); off, no page window exists and an open one is closed. */
  enabled?: boolean
  /** The user asked for this page since the window loaded; until then it waits on a click. */
  armed: boolean
  onArm: () => void
  /** The page moved on or named itself. */
  onNav: (url?: string, title?: string) => void
  /** A new window the page asked for: another browser tab. */
  onOpenPage: (url: string) => void
  onClose: () => void
  /** ⌥← ⌥→ (Ctrl+PageUp/PageDown off macOS): the tab before or after. */
  onStep: (delta: 1 | -1) => void
  /** The session whose link opened it, and how to bring that session to the front. */
  from?: { title: string; show: () => void }
  /** The search engine's id (lib/browsertab SEARCH_ENGINES). */
  engine: string
  /** Pause a playing video when an agent starts waiting on you. */
  pause: boolean
  /** The sessions waiting on you now; one that joins while the tab is in front is named. */
  waiting?: readonly WaitingAgent[]
  onGoWaiting?: (id: string) => void
  /** Tests: the platform and whether this is the desktop app. */
  isMac?: boolean
  inApp?: boolean
}

/** A field the user types text into: its keys are its own. */
function inTextField(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return t.isContentEditable || t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(t.type))
}

/** Whether a dialog or a menu is on screen over `box`, followed while `on`. */
function useOverlay(on: boolean, box: { current: HTMLElement | null }): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!on) { setOpen(false); return }
    let frame = 0
    const check = () => {
      frame = 0
      setOpen(overlayOpen(document, null, box.current?.getBoundingClientRect()))
    }
    check()
    const mo = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(check) })
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open'] })
    return () => {
      mo.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [on, box])
  return open
}

/** Whether the dashboard's own window is on screen (not hidden, not minimized). */
function useWindowShown(): boolean {
  const [shown, setShown] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  useEffect(() => {
    const on = () => setShown(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return shown
}

export function BrowserView({ pageKey, url, visible, enabled = true, armed, onArm, onNav, onOpenPage, onClose, onStep, from, engine, pause, waiting = [], onGoWaiting, isMac = isMacPlatform(), inApp = isTauri() }: BrowserViewProps) {
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [address, setAddress] = useState(url)
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [note, setNote] = useState('')
  const [nudge, setNudge] = useState<WaitingAgent | null>(null)
  const urlRef = useRef(url)
  urlRef.current = url

  // Phone mode: on per tab (for the window's life), the device and the rest
  // this viewer's (lib/phonemode).
  const [phone, setPhoneState] = useState(() => phoneOn(pageKey))
  const [phonePrefs, setPhonePrefs] = useState<PhonePrefs>(loadPhonePrefs)
  const togglePhone = () => setPhoneState((on) => { setPhoneOn(pageKey, !on); return !on })
  const changePhone = (next: Partial<PhonePrefs>) => setPhonePrefs((p) => { const n = { ...p, ...next }; savePhonePrefs(n); return n })
  const zoom = useUiScale()
  const pageEl = useRef<HTMLDivElement>(null)
  const [boxSize, setBoxSize] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    if (!phone) return
    const el = box.current
    if (!el) return
    const read = () => { const r = el.getBoundingClientRect(); setBoxSize((s) => (s && s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height })) }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [phone])
  const device = deviceOf(phonePrefs)
  const layout = useMemo(() => layoutOf(device, phonePrefs.bars, phonePrefs.rotate), [device, phonePrefs.bars, phonePrefs.rotate])
  const fit = fitOf(frameSize(device, layout, phonePrefs.rotate), { w: layout.pageW, h: layout.pageH }, { w: (boxSize?.w ?? 0) * zoom, h: (boxSize?.h ?? 0) * zoom })
  const spec = phone ? phoneSpec(device, phonePrefs.touch) : undefined
  const specRef = useRef(spec)
  specRef.current = spec
  // What reopens the page's window: a new device, side, bars or fit moves
  // the page area; a new agent or touch is the shell's to apply.
  const phoneKey = phone ? `${device.id}|${layout.pageW}x${layout.pageH}|${fit}|${spec?.ua}|${spec?.touch}` : ''
  // The page takes the keyboard when it was just sent somewhere from the address box.
  const focusNext = useRef(false)
  useEffect(() => { if (!editing) setAddress(url) }, [url, editing])

  const focusAddress = () => {
    const el = input.current
    if (!el) return
    el.focus()
    el.select()
  }

  // The shell's news about this page.
  const handlers = useRef({ onNav, onOpenPage, onStep, togglePhone })
  handlers.current = { onNav, onOpenPage, onStep, togglePhone }
  useEffect(() => {
    if (!inApp) return
    const id = pageId(pageKey)
    const on = (e: Event) => {
      const d = (e as CustomEvent<BrowserNews>).detail
      if (!d || d.id !== id) return
      if (typeof d.url === 'string') {
        if (d.loading !== undefined) setLoading(d.loading)
        if (!d.loading) handlers.current.onNav(d.url)
      }
      if (typeof d.title === 'string') handlers.current.onNav(undefined, d.title)
      if (typeof d.open === 'string') handlers.current.onOpenPage(d.open)
      if (typeof d.refused === 'string') setNote(`Not followed: ${d.refused.split(':')[0]}: links would open another app.`)
      if (d.saved !== undefined) setNote(d.ok && d.saved ? `Saved ${d.saved} to Downloads` : 'The download failed')
      if (d.key === 'prev') handlers.current.onStep(-1)
      if (d.key === 'next') handlers.current.onStep(1)
      if (d.key === 'address') focusAddress()
      if (d.key === 'phone') handlers.current.togglePhone()
    }
    window.addEventListener(BROWSER_EVENT, on)
    return () => window.removeEventListener(BROWSER_EVENT, on)
  }, [inApp, pageKey])

  // The same keys pressed in the dashboard while this tab is in front.
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const k = browserKey(e, isMac, inTextField(e.target))
      if (!k) return
      e.preventDefault()
      e.stopPropagation()
      if (k === 'address') focusAddress()
      else if (k === 'phone') handlers.current.togglePhone()
      else handlers.current.onStep(k === 'prev' ? -1 : 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, isMac])

  // A new tab: the cursor in the address box as soon as it is in front.
  useEffect(() => {
    if (visible && !url) focusAddress()
  }, [visible, url])

  // The page's window follows the tab: opened (or shown) and placed while
  // the tab is in front and uncovered; hidden otherwise, never unloaded.
  const live = inApp && enabled && armed && url !== ''
  const overlay = useOverlay(live && visible, box)
  const windowShown = useWindowShown()
  const showing = live && visible && !overlay && windowShown
  const opened = useRef(false)
  useEffect(() => {
    if (!live) {
      // Turned off in Settings: the page goes, not just out of sight.
      if (opened.current) {
        opened.current = false
        void browserAct(pageKey, { do: 'close' }).catch(() => {})
      }
      return
    }
    if (!showing) {
      if (opened.current) void browserAct(pageKey, { do: 'hide' }).catch(() => {})
      return
    }
    let last: PageRect | null = null
    const measure = (): PageRect | null => {
      if (specRef.current && !pageEl.current) return null
      const r = (specRef.current ? pageEl.current : box.current)?.getBoundingClientRect()
      return r && r.width >= 1 && r.height >= 1 ? rectOf(r, getUiScale()) : null
    }
    const open = (rect: PageRect) => {
      const focus = focusNext.current
      focusNext.current = false
      opened.current = true
      const phoneNow = specRef.current
      void browserAct(pageKey, { do: 'open', url: urlRef.current, rect, focus, ...(phoneNow ? { phone: phoneNow } : {}) }).catch((e: unknown) => setNote(e instanceof Error ? e.message : String(e)))
    }
    const first = measure()
    if (first) {
      last = first
      open(first)
    }
    const follow = () => {
      const r = measure()
      if (!r || sameRect(r, last)) return
      const was = last
      last = r
      if (was) void browserAct(pageKey, { do: 'place', rect: r }).catch(() => {})
      else open(r)
    }
    const ro = new ResizeObserver(follow)
    if (box.current) ro.observe(box.current)
    if (pageEl.current) ro.observe(pageEl.current)
    window.addEventListener('resize', follow)
    // A panel that moves the box without resizing it (a line appearing
    // above the strip): one rectangle read a second, nothing more.
    const tick = window.setInterval(follow, 1000)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', follow)
      window.clearInterval(tick)
    }
  }, [live, showing, pageKey, phoneKey])
  // A closed tab takes its page with it.
  useEffect(() => () => { if (opened.current) void browserAct(pageKey, { do: 'close' }).catch(() => {}) }, [pageKey])

  // An agent that starts waiting on you while this tab is in front.
  const seen = useRef<Set<string>>(new Set(waiting.map((w) => w.id)))
  useEffect(() => {
    const before = seen.current
    seen.current = new Set(waiting.map((w) => w.id))
    const fresh = waiting.filter((w) => !before.has(w.id))
    if (fresh.length === 0) return
    if (!visible) return
    setNudge(fresh[fresh.length - 1]!)
    if (pause && opened.current) void browserAct(pageKey, { do: 'pause' }).catch(() => {})
  }, [waiting, visible, pause, pageKey])
  useEffect(() => {
    if (nudge && !waiting.some((w) => w.id === nudge.id)) setNudge(null)
  }, [waiting, nudge])

  const go = (e: FormEvent) => {
    e.preventDefault()
    const next = addressOrSearch(address, engine)
    if (!next) return
    setEditing(false)
    setNote('')
    input.current?.blur()
    focusNext.current = true
    onNav(next)
    if (!url) { onArm(); return }
    if (!armed) { onArm(); return }
    void browserAct(pageKey, { do: 'go', url: next }).then(() => browserAct(pageKey, { do: 'focus' })).catch((err: unknown) => setNote(err instanceof Error ? err.message : String(err)))
  }
  const act = (a: 'back' | 'forward' | 'reload') => { void browserAct(pageKey, { do: a }).catch(() => {}) }
  const copy = () => {
    void navigator.clipboard?.writeText(url).then(() => setNote('Address copied'), () => setNote('Could not copy the address'))
  }
  const ready = armed && !!url
  const btn = 'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[6px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent'
  const searchWith = engineOf(engine).name
  const content = !inApp ? (
    <Note url={url} text="The in-app browser is part of the desktop app." />
  ) : !enabled ? (
    <Note url={url} text="The in-app browser is off. Turn it on in Settings → In-app browser, or open the page in your browser." />
  ) : !url ? (
    <Note text={`Type an address, or words to search with ${searchWith}.`} />
  ) : !armed ? (
    <Waiting url={url} onLoad={onArm} />
  ) : null
  return (
    <div className="flex h-full w-full flex-col bg-bg" data-browser-view={pageKey}>
      <form onSubmit={go} className="flex h-[38px] shrink-0 items-center gap-1 border-b border-[var(--app-hairline)] px-2">
        <button type="button" className={btn} title="Back" aria-label="Back" disabled={!ready} onClick={() => act('back')}><BackIcon size={14} /></button>
        <button type="button" className={btn} title="Forward" aria-label="Forward" disabled={!ready} onClick={() => act('forward')}><ForwardIcon size={14} /></button>
        <button type="button" className={btn} title="Reload" aria-label="Reload" disabled={!ready} onClick={() => act('reload')}><ReloadIcon size={14} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} /></button>
        <label className="flex h-[28px] min-w-0 flex-1 items-center gap-1.5 rounded-[7px] border border-[var(--app-hairline)] bg-panel px-2 focus-within:border-accent">
          <GlobeIcon size={13} className="text-fg-faint" />
          <input
            ref={input}
            aria-label="Address or search"
            placeholder={`Search with ${searchWith} or type an address`}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={address}
            onFocus={(e) => { setEditing(true); e.currentTarget.select() }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setAddress(url); e.currentTarget.blur() } }}
            className="mono min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-fg-faint"
          />
        </label>
        {from && (
          <button type="button" onClick={from.show} title={`Opened from ${from.title}: bring it to the front`} className="max-w-[180px] shrink-0 truncate rounded-[6px] px-1.5 text-[11.5px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg">
            from {from.title}
          </button>
        )}
        <button
          type="button"
          aria-pressed={phone}
          title={`Phone mode: the page at a phone’s size (${keys(PHONE_MODE_KEY, isMac)})`}
          onClick={togglePhone}
          data-phone-toggle
          className={`flex h-[26px] shrink-0 items-center gap-1.5 rounded-[6px] border px-2 text-[12px] ${phone ? 'border-accent bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-fg' : 'border-[var(--app-hairline)] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg'}`}
        >
          <PhoneIcon size={14} />Phone
        </button>
        <button type="button" className={btn} title="Copy the address" aria-label="Copy the address" disabled={!url} onClick={copy}><CopyIcon size={14} /></button>
        <button type="button" className={btn} title="Open in your browser" aria-label="Open in your browser" disabled={!url} onClick={() => openLink(url)}><ExternalIcon size={14} /></button>
        <button type="button" className={btn} title="Close the tab" aria-label="Close the tab" onClick={onClose}><CloseIcon size={14} /></button>
      </form>
      {nudge && (
        <div role="status" data-browser-nudge className="flex shrink-0 items-center gap-2 border-b border-[var(--app-hairline)] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] px-3 py-1 text-[12.5px] text-fg">
          <span className="min-w-0 flex-1 truncate"><b className="font-semibold">{nudge.title}</b> is waiting for you{pause ? ' · paused the video' : ''}</span>
          <button type="button" className="app-primary rounded-[6px] px-2 py-0.5 text-[12px]" onClick={() => { const id = nudge.id; setNudge(null); onGoWaiting?.(id) }}>Go</button>
          <button type="button" className="text-fg-faint hover:text-fg" aria-label="Dismiss" onClick={() => setNudge(null)}><CloseIcon size={11} /></button>
        </div>
      )}
      {note && (
        <div role="status" className="flex shrink-0 items-center gap-2 border-b border-[var(--app-hairline)] px-3 py-1 text-[12px] text-fg-muted">
          <span className="min-w-0 flex-1 truncate">{note}</span>
          <button type="button" className="text-fg-faint hover:text-fg" aria-label="Dismiss" onClick={() => setNote('')}><CloseIcon size={11} /></button>
        </div>
      )}
      {phone && (
        <DeviceBar
          prefs={phonePrefs}
          onChange={changePhone}
          device={device}
          layout={layout}
          fit={fit}
        />
      )}
      <div ref={box} className={`relative min-h-0 flex-1${phone ? ' overflow-hidden' : ''}`} data-page-box>
        {phone ? (
          <div className={`flex h-full w-full ${fit === 'over' ? 'items-start justify-start' : 'items-center justify-center'}`} data-phone-stage>
            <PhoneFrame device={device} layout={layout} rotate={phonePrefs.rotate} fit={fit} zoom={zoom} host={hostOf(url)} pageRef={pageEl}>
              {content}
            </PhoneFrame>
          </div>
        ) : content}
      </div>
    </div>
  )
}

/** The host the drawn phone's address bar shows. */
function hostOf(url: string): string {
  try { return new URL(url).host || url } catch { return url }
}

/** A restored tab: its address and a button, until it is asked for. */
function Waiting({ url, onLoad }: { url: string; onLoad: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <GlobeIcon size={28} className="text-fg-faint" />
      <p className="mono max-w-[60ch] break-all text-[13px] text-fg">{url}</p>
      <p className="max-w-[52ch] text-[12.5px] text-fg-muted">A page loads only when you ask for it.</p>
      <button type="button" onClick={onLoad} className="app-primary rounded-[8px] px-3 py-1.5 text-[13px]">Load the page</button>
    </div>
  )
}

/** An empty tab, or one that cannot show here. */
function Note({ url, text }: { url?: string; text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <GlobeIcon size={28} className="text-fg-faint" />
      {url && <p className="mono max-w-[60ch] break-all text-[13px] text-fg">{url}</p>}
      <p className="max-w-[56ch] text-[12.5px] text-fg-muted">{text}</p>
      {url && <button type="button" onClick={() => openLink(url)} className="app-primary rounded-[8px] px-3 py-1.5 text-[13px]">Open in your browser</button>}
    </div>
  )
}
