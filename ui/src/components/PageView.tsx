/**
 * A Page tab's content (ADR-070): a toolbar — back, forward, reload, the
 * address, copy, open in the browser, close — over the page.
 *
 * In the desktop app the page is a native child webview that the shell lays
 * over this component's box (app/src-tauri/src/page.rs). It follows the box
 * as the window and the panels move, hides while the tab is behind or a
 * sheet or a menu lies over it (a native view draws over the dashboard's own
 * elements), and is closed — its memory freed — after five minutes behind
 * (UNLOAD_AFTER_MS), to be opened again from its address when it comes back.
 *
 * In a browser a page on this machine shows in an iframe; anything else is
 * a link to the browser, since most sites refuse to be framed.
 *
 * Nothing loads without a click (rule 4): a tab restored after a restart
 * waits on *Load the page* until it is brought to the front by hand.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { isTauri } from '@/lib/appmode'
import { getUiScale } from '@/lib/uiscale'
import { openLink } from '@/lib/termlinks'
import { canShowInTab, overlayOpen, requestOpenPage, PAGE_EVENT, pageAct, pageId, pageUrl, rectOf, sameRect, UNLOAD_AFTER_MS, type PageNews, type PageRect } from '@/lib/pagetab'
import { BackIcon, CloseIcon, CopyIcon, ExternalIcon, ForwardIcon, GlobeIcon, ReloadIcon } from './AppIcons'
import { Sheet, SHEET_CLOSE_ROOM } from './Sheet'

export interface PageViewProps {
  /** The tab's key (`page:…`), which names the native page. */
  pageKey: string
  url: string
  /** The tab is in front (and no view of the workspace covers it). */
  visible: boolean
  /** The user asked for this page since the window loaded; until then it waits on a click. */
  armed: boolean
  onArm: () => void
  /** The page moved on or named itself. */
  onNav: (url?: string, title?: string) => void
  /** A new window the page asked for, or a link: another Page tab. */
  onOpenPage: (url: string) => void
  onClose: () => void
  /** The session whose link opened it, and how to bring that session to the front. */
  from?: { title: string; show: () => void }
  /** In the desktop app; a browser otherwise (tests pass it). */
  inApp?: boolean
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

export function PageView({ pageKey, url, visible, armed, onArm, onNav, onOpenPage, onClose, from, inApp = isTauri() }: PageViewProps) {
  const box = useRef<HTMLDivElement>(null)
  const [address, setAddress] = useState(url)
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [note, setNote] = useState('')
  // A browser's iframe: reloaded by a new key, unloaded after a while behind.
  const [frameKey, setFrameKey] = useState(0)
  const [unloaded, setUnloaded] = useState(false)
  const urlRef = useRef(url)
  urlRef.current = url
  useEffect(() => { if (!editing) setAddress(url) }, [url, editing])
  const embeddable = canShowInTab(url, inApp)

  // The shell's news about this page.
  const handlers = useRef({ onNav, onOpenPage })
  handlers.current = { onNav, onOpenPage }
  useEffect(() => {
    if (!inApp) return
    const id = pageId(pageKey)
    const on = (e: Event) => {
      const d = (e as CustomEvent<PageNews>).detail
      if (!d || d.id !== id) return
      if (typeof d.url === 'string') {
        if (d.loading !== undefined) setLoading(d.loading)
        if (!d.loading) handlers.current.onNav(d.url)
      }
      if (typeof d.title === 'string') handlers.current.onNav(undefined, d.title)
      if (typeof d.open === 'string') handlers.current.onOpenPage(d.open)
      if (typeof d.refused === 'string') setNote(`Not followed: ${d.refused.split(':')[0]}: links would open another app.`)
      if (d.saved !== undefined) setNote(d.ok && d.saved ? `Saved ${d.saved} to Downloads` : 'The download failed')
    }
    window.addEventListener(PAGE_EVENT, on)
    return () => window.removeEventListener(PAGE_EVENT, on)
  }, [inApp, pageKey])

  // The native page follows the tab: open (or shown) and placed while the
  // tab is in front and uncovered; hidden otherwise, and closed after a while.
  const overlay = useOverlay(inApp && armed && visible, box)
  const showing = inApp && armed && visible && !overlay
  useEffect(() => {
    if (!inApp || !armed) return
    if (!showing) {
      void pageAct(pageKey, { do: 'hide' }).catch(() => {})
      const t = window.setTimeout(() => { void pageAct(pageKey, { do: 'close' }).catch(() => {}) }, UNLOAD_AFTER_MS)
      return () => window.clearTimeout(t)
    }
    let last: PageRect | null = null
    const measure = (): PageRect | null => {
      const r = box.current?.getBoundingClientRect()
      return r && r.width >= 1 && r.height >= 1 ? rectOf(r, getUiScale()) : null
    }
    const first = measure()
    if (first) {
      last = first
      void pageAct(pageKey, { do: 'open', url: urlRef.current, rect: first }).catch((e: unknown) => setNote(e instanceof Error ? e.message : String(e)))
    }
    const follow = () => {
      const r = measure()
      if (!r || sameRect(r, last)) return
      const opened = last !== null
      last = r
      void pageAct(pageKey, opened ? { do: 'place', rect: r } : { do: 'open', url: urlRef.current, rect: r }).catch(() => {})
    }
    const ro = new ResizeObserver(follow)
    if (box.current) ro.observe(box.current)
    window.addEventListener('resize', follow)
    // A panel that moves the box without resizing it (a line appearing
    // above the strip): one rectangle read a second, nothing more.
    const tick = window.setInterval(follow, 1000)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', follow)
      window.clearInterval(tick)
    }
  }, [inApp, armed, showing, pageKey])
  // A closed tab takes its page with it.
  useEffect(() => () => { if (inApp) void pageAct(pageKey, { do: 'close' }).catch(() => {}) }, [inApp, pageKey])

  // A browser's iframe is dropped after the same while behind.
  useEffect(() => {
    if (inApp) return
    if (visible) { setUnloaded(false); return }
    const t = window.setTimeout(() => setUnloaded(true), UNLOAD_AFTER_MS)
    return () => window.clearTimeout(t)
  }, [inApp, visible])

  const go = (e: FormEvent) => {
    e.preventDefault()
    const next = pageUrl(address)
    if (!next) { setNote(`“${address}” is not a web address`); return }
    setEditing(false)
    setNote('')
    if (!canShowInTab(next, inApp)) { openLink(next); return }
    onNav(next)
    if (inApp) void pageAct(pageKey, { do: 'go', url: next }).catch((err: unknown) => setNote(err instanceof Error ? err.message : String(err)))
    else setFrameKey((k) => k + 1)
  }
  const act = (a: 'back' | 'forward' | 'reload') => {
    if (inApp) { void pageAct(pageKey, { do: a }).catch(() => {}); return }
    if (a === 'reload') setFrameKey((k) => k + 1)
  }
  const copy = () => {
    void navigator.clipboard?.writeText(url).then(() => setNote('Address copied'), () => setNote('Could not copy the address'))
  }
  // In a browser the iframe's history is the page's own, across origins: no back or forward here.
  const history = inApp
  const btn = 'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[6px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent'
  return (
    <div className="flex h-full w-full flex-col bg-bg" data-page-view={pageKey}>
      <form onSubmit={go} className="flex h-[38px] shrink-0 items-center gap-1 border-b border-[var(--app-hairline)] px-2">
        <button type="button" className={btn} title="Back" aria-label="Back" disabled={!history || !armed} onClick={() => act('back')}><BackIcon size={14} /></button>
        <button type="button" className={btn} title="Forward" aria-label="Forward" disabled={!history || !armed} onClick={() => act('forward')}><ForwardIcon size={14} /></button>
        <button type="button" className={btn} title="Reload" aria-label="Reload" disabled={!armed || !embeddable} onClick={() => act('reload')}><ReloadIcon size={14} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} /></button>
        <label className="flex h-[28px] min-w-0 flex-1 items-center gap-1.5 rounded-[7px] border border-[var(--app-hairline)] bg-panel px-2 focus-within:border-accent">
          <GlobeIcon size={13} className="text-fg-faint" />
          <input
            aria-label="Address"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={address}
            onFocus={(e) => { setEditing(true); e.currentTarget.select() }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setAddress(url); e.currentTarget.blur() } }}
            className="mono min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none"
          />
        </label>
        {from && (
          <button type="button" onClick={from.show} title={`Opened from ${from.title}: bring it to the front`} className="max-w-[180px] shrink-0 truncate rounded-[6px] px-1.5 text-[11.5px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg">
            from {from.title}
          </button>
        )}
        <button type="button" className={btn} title="Copy the address" aria-label="Copy the address" onClick={copy}><CopyIcon size={14} /></button>
        <button type="button" className={btn} title="Open in your browser" aria-label="Open in your browser" onClick={() => openLink(url)}><ExternalIcon size={14} /></button>
        <button type="button" className={btn} title="Close the page" aria-label="Close the page" onClick={onClose}><CloseIcon size={14} /></button>
      </form>
      {note && (
        <div role="status" className="flex shrink-0 items-center gap-2 border-b border-[var(--app-hairline)] px-3 py-1 text-[12px] text-fg-muted">
          <span className="min-w-0 flex-1 truncate">{note}</span>
          <button type="button" className="text-fg-faint hover:text-fg" aria-label="Dismiss" onClick={() => setNote('')}><CloseIcon size={11} /></button>
        </div>
      )}
      <div ref={box} className="relative min-h-0 flex-1" data-page-box>
        {!armed ? (
          <Waiting url={url} onLoad={onArm} />
        ) : !embeddable ? (
          <Elsewhere url={url} />
        ) : inApp ? null : unloaded ? null : (
          <iframe
            key={frameKey}
            title={url}
            src={url}
            className="absolute inset-0 h-full w-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
            referrerPolicy="no-referrer"
          />
        )}
      </div>
    </div>
  )
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

/** In a browser: an address not on this machine, which most sites would refuse to show framed. */
function Elsewhere({ url }: { url: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <GlobeIcon size={28} className="text-fg-faint" />
      <p className="mono max-w-[60ch] break-all text-[13px] text-fg">{url}</p>
      <p className="max-w-[56ch] text-[12.5px] text-fg-muted">In a browser only a page on this machine (localhost) shows in a tab; the desktop app shows any page.</p>
      <button type="button" onClick={() => openLink(url)} className="app-primary rounded-[8px] px-3 py-1.5 text-[13px]">Open in your browser</button>
    </div>
  )
}

/** ⌘K → *Open a page…* and the + menu: an address, then Enter. */
export function OpenPageSheet({ onClose, inApp = isTauri() }: { onClose: () => void; inApp?: boolean }) {
  const [text, setText] = useState('')
  const url = pageUrl(text)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!url) return
    onClose()
    requestOpenPage({ url })
  }
  return (
    <Sheet label="Open a page" onClose={onClose} width={560}>
      <form onSubmit={submit} className={`grid gap-2 py-4 pl-5 ${SHEET_CLOSE_ROOM}`}>
        <label className="text-[13px] font-semibold text-fg" htmlFor="open-page-url">Open a page</label>
        <input
          id="open-page-url"
          autoFocus
          spellCheck={false}
          autoCapitalize="off"
          placeholder="localhost:5173 or https://…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="mono h-[36px] rounded-[8px] border border-[var(--app-hairline-strong)] bg-bg px-3 text-[13.5px] text-fg outline-none focus:border-accent"
        />
        <p className="text-[12px] text-fg-muted">
          {text.trim() && !url
            ? 'Not a web address.'
            : inApp
              ? 'In a tab of its own, after your agents’ tabs. It shares no cookies with Caprock and gets none of its commands.'
              : 'A page on this machine opens in a tab here; any other opens in your browser.'}
        </p>
        <div className="flex justify-end">
          <button type="submit" disabled={!url} className="app-primary rounded-[8px] px-3 py-1.5 text-[13px] disabled:opacity-50">Open</button>
        </div>
      </form>
    </Sheet>
  )
}
