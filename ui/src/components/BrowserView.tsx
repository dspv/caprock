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
import { addressOrSearch, BROWSER_EVENT, browserAct, browserKey, cutOff, engineOf, overlayOpen, pageId, rectOf, sameRect, type BrowserNews, type PageRect } from '@/lib/browsertab'
import { deviceOf, fitOf, frameSize, layoutOf, loadPhonePrefs, pageScale, phoneChosen, phoneSpec, savePhonePrefs, setPhoneOn, zoomedSpec, sideKey, sideMain, sideScale, SIDE_DEVICES, SIDE_GAP, SIDE_LABEL, SIDE_MARGIN, type DeviceId, type PhonePrefs, type PhoneSpec } from '@/lib/phonemode'
import { BackIcon, CloseIcon, CopyIcon, ExternalIcon, ForwardIcon, GlobeIcon, PhoneIcon, ReloadIcon } from './AppIcons'
import { DeviceBar } from './DeviceBar'
import { PhoneFrame } from './PhoneFrame'
import { PhoneRow } from './PhoneRow'

/** One page window the tab has: its own, or a side-by-side phone's. */
interface Slot {
  key: string
  /** Side by side: which phone's page area it is laid over. */
  dev?: DeviceId
  spec?: PhoneSpec
}

/** Side by side: how often each phone is asked whether its page runs past its edge, in seconds. */
const MEASURE_EVERY = 2

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
  /** It has the keyboard: a phone preview in a split leaves the terminal beside it its keys while that pane is focused. */
  focused?: boolean
  /** A phone preview (lib/devservers): Phone mode on unless turned off this window. */
  phoneFirst?: boolean
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

export function BrowserView({ pageKey, url, visible, enabled = true, armed, onArm, onNav, onOpenPage, onClose, onStep, from, engine, pause, waiting = [], onGoWaiting, focused = true, phoneFirst = false, isMac = isMacPlatform(), inApp = isTauri() }: BrowserViewProps) {
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [address, setAddress] = useState(url)
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [note, setNote] = useState('')
  const [nudge, setNudge] = useState<WaitingAgent | null>(null)
  // A load where nothing answers (browser.rs `probe`): said in place of the
  // page, whose window is a blank white rectangle then. `trying` once Retry
  // or a new address sent it again, until the shell hears back.
  const [failed, setFailed] = useState<{ url: string; text: string; trying: boolean } | null>(null)
  const urlRef = useRef(url)
  urlRef.current = url

  // Phone mode: on per tab (for the window's life), the device and the rest
  // this viewer's (lib/phonemode).
  const [phone, setPhoneState] = useState(() => phoneChosen(pageKey) ?? phoneFirst)
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
  // Side by side: three phones, portrait, the tab's own page window one of
  // them (the device in use, else iPhone 16) and two more beside it.
  const side = phone && phonePrefs.side
  const device = side ? deviceOf({ ...phonePrefs, device: sideMain(phonePrefs.device) }) : deviceOf(phonePrefs)
  const rotate = side ? false : phonePrefs.rotate
  const layout = useMemo(() => layoutOf(device, phonePrefs.bars, rotate), [device, phonePrefs.bars, rotate])
  const avail = { w: (boxSize?.w ?? 0) * zoom, h: (boxSize?.h ?? 0) * zoom }
  const fit = side ? 'full' : fitOf(frameSize(device, layout, rotate), { w: layout.pageW, h: layout.pageH }, avail)
  // A page area that does not fit is drawn smaller, never past the tab: a
  // native window is not clipped by the box, and would draw over the status
  // bar, past the app's window, over the Dock.
  const fitAt = fit === 'scaled' ? pageScale({ w: layout.pageW, h: layout.pageH }, avail) : 1
  const trio = useMemo(() => SIDE_DEVICES.map((id) => deviceOf({ device: id, customW: 0, customH: 0 })), [])
  const sideAt = side
    ? sideScale(
      trio.map((d) => frameSize(d, layoutOf(d, phonePrefs.bars, false), false)),
      SIDE_GAP * zoom,
      { w: ((boxSize?.w ?? 0) - 2 * SIDE_MARGIN) * zoom, h: ((boxSize?.h ?? 0) - 2 * SIDE_MARGIN - SIDE_LABEL) * zoom },
    )
    : 1
  // Drawn smaller, the page still lays out at the device's width: the shell zooms it out to match.
  const spec = phone ? (fitAt < 1 ? zoomedSpec(device, phonePrefs.touch, layout) : phoneSpec(device, phonePrefs.touch)) : undefined
  // The pages this tab shows: its own, and side by side two more.
  const slots: Slot[] = side
    ? trio.map((d) => ({ key: d.id === device.id ? pageKey : sideKey(pageKey, d.id), dev: d.id, spec: zoomedSpec(d, phonePrefs.touch, layoutOf(d, phonePrefs.bars, false)) }))
    : [{ key: pageKey, ...(spec ? { spec } : {}) }]
  const slotsRef = useRef(slots)
  slotsRef.current = slots
  const sideEls = useRef<Partial<Record<DeviceId, HTMLDivElement | null>>>({})
  const sideRefs = useRef<Partial<Record<DeviceId, (el: HTMLDivElement | null) => void>>>({})
  const sideRef = (id: DeviceId) => (sideRefs.current[id] ??= (el) => { sideEls.current[id] = el })
  // Side by side: the phones scrolled partly out of view, and the ones whose page runs past their edge.
  const [out, setOut] = useState<Partial<Record<DeviceId, boolean>>>({})
  const [wide, setWide] = useState<Partial<Record<DeviceId, number>>>({})
  useEffect(() => { if (!side) { setOut({}); setWide({}) } }, [side])
  // What reopens the page windows: a new device, side, bars, fit or scale
  // moves a page area; a new agent or touch is the shell's to apply.
  const phoneKey = phone ? `${side ? `side@${sideAt}` : ''}|${slots.map((sl) => `${sl.key}=${sl.spec?.ua}|${sl.spec?.touch}|${sl.spec?.width ?? ''}x${sl.spec?.height ?? ''}`).join(',')}|${layout.pageW}x${layout.pageH}|${fit}@${fitAt}` : ''
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
    // A side-by-side phone's own window: what it measured, a window it
    // asked for, a key pressed in it. Where it went is its own.
    const extras = new Map(SIDE_DEVICES.map((dev) => [pageId(sideKey(pageKey, dev)), dev] as const))
    const measured = (d: BrowserNews, dev: DeviceId | undefined) => {
      if (!dev || d.doc === undefined) return
      const w = cutOff(d) ? d.doc : undefined
      setWide((m) => (m[dev] === w ? m : { ...m, [dev]: w }))
    }
    const on = (e: Event) => {
      const d = (e as CustomEvent<BrowserNews>).detail
      if (!d) return
      const extra = extras.get(d.id)
      if (extra) {
        measured(d, extra)
        if (typeof d.open === 'string') handlers.current.onOpenPage(d.open)
        if (d.key === 'prev') handlers.current.onStep(-1)
        if (d.key === 'next') handlers.current.onStep(1)
        if (d.key === 'address') focusAddress()
        if (d.key === 'phone') handlers.current.togglePhone()
        return
      }
      if (d.id !== id) return
      measured(d, slotsRef.current.find((sl) => sl.key === pageKey)?.dev)
      if (typeof d.unreachable === 'string') {
        const text = d.unreachable
        setFailed({ url: d.url ?? urlRef.current, text, trying: false })
      } else if (d.reachable || typeof d.url === 'string') setFailed(null)
      if (typeof d.url === 'string' && d.unreachable === undefined) {
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
    if (!visible || !focused) return
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
  }, [visible, focused, isMac])

  // A new tab: the cursor in the address box as soon as it is in front.
  useEffect(() => {
    if (visible && !url) focusAddress()
  }, [visible, url])

  // The page's window follows the tab: opened (or shown) and placed while
  // the tab is in front and uncovered; hidden otherwise, never unloaded.
  const live = inApp && enabled && armed && url !== ''
  const overlay = useOverlay(live && visible, box)
  const windowShown = useWindowShown()
  // A failed page's window stays hidden: the reason shows where it would be.
  const showing = live && visible && !overlay && windowShown && !failed
  /** The page windows asked for and not closed since, by key. */
  const opened = useRef(new Set<string>())
  useEffect(() => {
    const slots = slotsRef.current
    // A page window no longer wanted is closed: every one when the in-app
    // browser is turned off (the page goes, not just out of sight), the two
    // extra phones when side by side goes off.
    const want = new Set(live ? slots.map((sl) => sl.key) : [])
    for (const k of Array.from(opened.current)) {
      if (want.has(k)) continue
      opened.current.delete(k)
      void browserAct(k, { do: 'close' }).catch(() => {})
    }
    if (!live) return
    if (!showing) {
      for (const k of opened.current) void browserAct(k, { do: 'hide' }).catch(() => {})
      return
    }
    const last = new Map<string, PageRect | null>()
    const measure = (sl: Slot): PageRect | null => {
      if (sl.dev) {
        // A side-by-side phone shows only while wholly inside the stage: a
        // native window is not clipped, and would draw over the panes beside.
        const el = sideEls.current[sl.dev]
        const stage = box.current?.getBoundingClientRect()
        if (!el || !stage) return null
        const r = el.getBoundingClientRect()
        const inside = r.left >= stage.left - 0.5 && r.top >= stage.top - 0.5 && r.right <= stage.right + 0.5 && r.bottom <= stage.bottom + 0.5
        return inside && r.width >= 1 && r.height >= 1 ? rectOf(r, getUiScale()) : null
      }
      if (sl.spec && !pageEl.current) return null
      const r = (sl.spec ? pageEl.current : box.current)?.getBoundingClientRect()
      if (!r || r.width < 1 || r.height < 1) return null
      // A phone's page area shows only while inside the tab's box (a resize
      // the scale has not caught up with yet): never drawn past it.
      const stage = sl.spec ? box.current?.getBoundingClientRect() : undefined
      if (stage && !(r.left >= stage.left - 0.5 && r.top >= stage.top - 0.5 && r.right <= stage.right + 0.5 && r.bottom <= stage.bottom + 0.5)) return null
      return rectOf(r, getUiScale())
    }
    const open = (sl: Slot, rect: PageRect) => {
      const own = sl.key === pageKey
      const focus = own && focusNext.current
      if (own) focusNext.current = false
      opened.current.add(sl.key)
      void browserAct(sl.key, { do: 'open', url: urlRef.current, rect, focus, ...(sl.spec ? { phone: sl.spec } : {}) }).catch((e: unknown) => setNote(e instanceof Error ? e.message : String(e)))
    }
    const outNow: Partial<Record<DeviceId, boolean>> = {}
    const sync = (first: boolean) => {
      let changed = first
      for (const sl of slots) {
        const r = measure(sl)
        const was = last.get(sl.key) ?? null
        if (sl.dev && (r === null) !== (outNow[sl.dev] === true)) {
          outNow[sl.dev] = r === null
          changed = true
        }
        if (!r) {
          // Out of view: hidden until it is back.
          if (was && opened.current.has(sl.key)) void browserAct(sl.key, { do: 'hide' }).catch(() => {})
          last.set(sl.key, null)
          continue
        }
        if (!first && sameRect(r, was)) continue
        last.set(sl.key, r)
        if (was && !first) void browserAct(sl.key, { do: 'place', rect: r }).catch(() => {})
        else open(sl, r)
      }
      if (changed && slots.some((sl) => sl.dev)) setOut({ ...outNow })
    }
    sync(true)
    const follow = () => sync(false)
    const ro = new ResizeObserver(follow)
    if (box.current) ro.observe(box.current)
    if (pageEl.current) ro.observe(pageEl.current)
    window.addEventListener('resize', follow)
    // The side-by-side row scrolls inside the box; scroll does not bubble,
    // so it is heard on the way down.
    const boxEl = box.current
    boxEl?.addEventListener('scroll', follow, true)
    // A panel that moves the box without resizing it (a line appearing
    // above the strip): one rectangle read a second, nothing more. Side by
    // side, each phone in view is asked every MEASURE_EVERY seconds whether
    // its page runs past its edge.
    let ticks = 0
    const tick = window.setInterval(() => {
      follow()
      ticks += 1
      if (ticks % MEASURE_EVERY !== 0) return
      for (const sl of slots) if (sl.dev && last.get(sl.key)) void browserAct(sl.key, { do: 'measure' }).catch(() => {})
    }, 1000)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', follow)
      boxEl?.removeEventListener('scroll', follow, true)
      window.clearInterval(tick)
    }
  }, [live, showing, pageKey, phoneKey])
  // A closed tab takes its pages with it.
  useEffect(() => () => {
    for (const k of opened.current) void browserAct(k, { do: 'close' }).catch(() => {})
    opened.current.clear()
  }, [pageKey])

  // An agent that starts waiting on you while this tab is in front.
  const seen = useRef<Set<string>>(new Set(waiting.map((w) => w.id)))
  useEffect(() => {
    const before = seen.current
    seen.current = new Set(waiting.map((w) => w.id))
    const fresh = waiting.filter((w) => !before.has(w.id))
    if (fresh.length === 0) return
    if (!visible) return
    setNudge(fresh[fresh.length - 1]!)
    if (pause) for (const k of opened.current) void browserAct(k, { do: 'pause' }).catch(() => {})
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
    setFailed((f) => (f ? { url: next, text: f.text, trying: true } : f))
    input.current?.blur()
    focusNext.current = true
    onNav(next)
    if (!url) { onArm(); return }
    if (!armed) { onArm(); return }
    void browserAct(pageKey, { do: 'go', url: next }).then(() => browserAct(pageKey, { do: 'focus' })).catch((err: unknown) => setNote(err instanceof Error ? err.message : String(err)))
    // Side by side, the address box sends every phone there.
    for (const k of opened.current) if (k !== pageKey) void browserAct(k, { do: 'go', url: next }).catch(() => {})
  }
  // Side by side, back, forward and reload act on every phone: one click reloads all three.
  const act = (a: 'back' | 'forward' | 'reload') => {
    void browserAct(pageKey, { do: a }).catch(() => {})
    for (const k of opened.current) if (k !== pageKey) void browserAct(k, { do: a }).catch(() => {})
  }
  // Retry a page where nothing answered: sent again while its window stays
  // hidden, shown when the shell hears it answer or load.
  const retry = () => {
    const to = urlRef.current
    setFailed((f) => (f ? { ...f, url: to, trying: true } : f))
    for (const k of opened.current) void browserAct(k, { do: 'go', url: to }).catch(() => {})
  }
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
  ) : failed ? (
    <Failed url={failed.url} text={failed.text} trying={failed.trying} onRetry={retry} />
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
          scale={fitAt}
          side={side ? { scale: sideAt, devices: trio } : null}
        />
      )}
      <div ref={box} className={`relative min-h-0 flex-1${phone ? ' overflow-hidden' : ''}`} data-page-box>
        {side ? (
          <PhoneRow
            devices={trio}
            bars={phonePrefs.bars}
            scale={sideAt}
            zoom={zoom}
            host={hostOf(url)}
            pageRef={sideRef}
            wide={wide}
            out={out}
            onPick={(id) => changePhone({ side: false, device: id })}
            content={content}
          />
        ) : phone ? (
          <div className="flex h-full w-full items-center justify-center" data-phone-stage>
            <PhoneFrame device={device} layout={layout} rotate={phonePrefs.rotate} fit={fit} zoom={zoom / fitAt} host={hostOf(url)} pageRef={pageEl}>
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

/** A page where nothing answers: what happened, and Retry. */
function Failed({ url, text, trying, onRetry }: { url: string; text: string; trying: boolean; onRetry: () => void }) {
  return (
    <div role="alert" data-page-failed className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <GlobeIcon size={28} className="text-fg-faint" />
      <p className="max-w-[52ch] text-[13.5px] font-medium text-fg">{text}</p>
      <p className="mono max-w-[60ch] break-all text-[12px] text-fg-muted">{url}</p>
      <p className="max-w-[52ch] text-[12.5px] text-fg-muted">The page did not load: start the server, or check the address.</p>
      <button type="button" onClick={onRetry} disabled={trying} className="app-primary rounded-[8px] px-3 py-1.5 text-[13px] disabled:opacity-60">{trying ? 'Trying…' : 'Retry'}</button>
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
