/**
 * The share button in a panel's header, and its menu (.ai/04-ui.md § Share,
 * "Any panel"; owner, 2026-10-28, translated: "I want to be able to share
 * every block, in any convenient form").
 *
 * A panel opts in with `share` (its name, for the file and the post);
 * its body says what it names and how it reads as text with
 * `usePanelShare`. The menu:
 *
 *  - **Hide project names** — on by default, remembered per viewer: every
 *    project, repository, session title, branch and folder becomes
 *    "project 1", "session 1"… in all four outputs (lib/panelShare.ts).
 *  - **Copy image** — the panel at 2x on the clipboard (the app's own
 *    clipboard command in the desktop app, lib/attachments copyImage).
 *  - **Save PNG** — a download; in the desktop app, its save dialog.
 *  - **Copy as text** — Markdown, only where the panel wrote a `toText`.
 *  - **Post to X, Threads or LinkedIn…** — the share sheet with the picture
 *    shown large and the share card's own buttons (ShareActions, ADR-086):
 *    only those three upload, to caprock.dev, and only on their press.
 *
 * Everything else stays on the machine; nothing is drawn until asked.
 */
import { createContext, lazy, Suspense, useContext, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import { createPortal } from 'react-dom'
import { Aliaser, loadHideNames, panelFileName, panelText, saveHideNames, type PanelShareData } from '@/lib/panelShare'

const PanelShareSheet = lazy(() => import('./PanelShareSheet'))

const Ctx = createContext<MutableRefObject<PanelShareData | undefined> | null>(null)
export const PanelShareProvider = Ctx.Provider

/** From inside a panel's body: the names it shows and its text, for the share menu. */
export function usePanelShare(data: PanelShareData): void {
  const ref = useContext(Ctx)
  useEffect(() => { if (ref) ref.current = data })
}

/** usePanelShare as an element, for a panel whose figures are read above its Panel. */
export function ShareWith(props: PanelShareData): null {
  usePanelShare(props)
  return null
}

/** The aliaser for one export, from what the panel says it names. */
function aliaserFor(data: PanelShareData | undefined, hide: boolean): Aliaser {
  let names = data?.names?.() ?? []
  if (!Array.isArray(names)) names = []
  return new Aliaser(hide, names)
}

/** How long a result stays in the menu. */
const NOTE_MS = 4000

export function PanelShareButton({ name, section, data }: {
  /** The panel's name: the file, the text's heading and the post. */
  name: string
  section: () => HTMLElement | null
  data: MutableRefObject<PanelShareData | undefined>
}) {
  const [open, setOpen] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [hide, setHide] = useState(loadHideNames)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState({ left: 0, top: 0 })
  // Whether the body wrote a text version, read when the menu opens.
  const [hasText, setHasText] = useState(false)

  // A menu that would run past the window's bottom opens above the button.
  useLayoutEffect(() => {
    if (!open) return
    const h = menu.current?.getBoundingClientRect().height ?? 0
    const r = button.current?.getBoundingClientRect()
    if (r && at.top + h > window.innerHeight - 8 && r.top - h - 4 >= 8) setAt((a) => ({ ...a, top: r.top - h - 4 }))
  }, [open, at.top])

  const toggleHide = (on: boolean) => { setHide(on); saveHideNames(on) }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); button.current?.focus() } }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!menu.current?.contains(t) && !button.current?.contains(t)) setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [open])

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const say = (s: string) => {
    setNote(s)
    if (timer.current) clearTimeout(timer.current)
    if (s) timer.current = setTimeout(() => setNote(''), NOTE_MS)
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const toggleMenu = () => {
    if (!open) {
      // Under the button, kept inside the window; on a phone the menu is the
      // window's width less the gutters.
      const r = button.current?.getBoundingClientRect()
      const w = Math.min(MENU_W, window.innerWidth - 32)
      setAt({ left: Math.max(16, Math.min((r?.right ?? 0) - w, window.innerWidth - w - 16)), top: (r?.bottom ?? 0) + 4 })
      say('')
      setHasText(!!data.current?.toText)
      // Another panel's menu may have changed the choice since this one mounted.
      setHide(loadHideNames())
    }
    setOpen((v) => !v)
  }

  const draw = async (): Promise<Blob | null> => {
    const el = section()
    if (!el) return null
    const { renderPanelPNG } = await import('@/lib/panelImage')
    return renderPanelPNG(el, aliaserFor(data.current, hide))
  }

  const run = async (job: () => Promise<string>) => {
    if (busy) return
    setBusy(true); say('')
    try { say(await job()) } catch { say('Could not draw this panel here.') } finally { setBusy(false) }
  }

  const copyImg = () => run(async () => {
    const b = await draw()
    if (!b) return 'Could not draw this panel here.'
    const { copyImage } = await import('@/lib/attachments')
    return (await copyImage(b)) ? 'Copied — paste it anywhere.' : 'Copying was refused — use Save PNG.'
  })
  const savePng = () => run(async () => {
    const b = await draw()
    if (!b) return 'Could not draw this panel here.'
    const { download } = await import('./ShareActions')
    download(b, panelFileName(name))
    return 'Saved to your downloads.'
  })
  const copyTxt = () => run(async () => {
    const fn = data.current?.toText
    if (!fn) return ''
    const a = aliaserFor(data.current, hide)
    const { copyText } = await import('@/lib/mdreader')
    return (await copyText(panelText(name, fn(a.alias)))) ? 'Copied as Markdown.' : 'Copying was refused.'
  })

  const item = 'app-row flex h-[30px] w-full items-center gap-2 rounded-[6px] px-2 text-left text-[12.5px] text-fg disabled:opacity-50'
  return (
    <>
      <button ref={button} type="button" data-panel-share onClick={toggleMenu} aria-haspopup="menu" aria-expanded={open}
        aria-label={`Share ${name}`} title={`Share this panel: copy or save it as a picture or text, or post it`}
        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-faint transition-opacity hover:bg-fg/5 hover:text-fg focus-visible:opacity-100 [@media(hover:none)]:opacity-100 ${open ? 'opacity-100 text-fg' : 'opacity-0 group-hover/panel:opacity-100 group-focus-within/panel:opacity-100'}`}>
        <ShareGlyph />
      </button>
      {open && createPortal(
        <div ref={menu} role="menu" aria-label={`Share ${name}`} data-panel-share-menu
          className="app-fade-in fixed z-50 grid gap-px rounded-[9px] border border-[var(--app-hairline-strong)] bg-panel p-1 normal-case tracking-normal shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]"
          style={{ left: at.left, top: at.top, width: Math.min(MENU_W, window.innerWidth - 32) }}>
          <label role="menuitemcheckbox" aria-checked={hide} className={`${item} cursor-pointer`}
            title="Projects, repositories, sessions, branches and folders become “project 1”, “session 1”… in the picture and the text; costs and counts stay">
            <input type="checkbox" checked={hide} onChange={(e) => toggleHide(e.target.checked)} data-panel-share-hide className="accent-[var(--color-accent)]" />
            <span className="flex-1">Hide project names</span>
          </label>
          <div className="my-0.5 h-px bg-border" aria-hidden />
          <button type="button" role="menuitem" className={item} disabled={busy} onClick={() => void copyImg()} data-panel-share-copy
            title="Puts a picture of this panel on your clipboard">Copy image</button>
          <button type="button" role="menuitem" className={item} disabled={busy} onClick={() => void savePng()} data-panel-share-save
            title="Saves a picture of this panel as a PNG">Save PNG</button>
          {hasText && (
            <button type="button" role="menuitem" className={item} disabled={busy} onClick={() => void copyTxt()} data-panel-share-text
              title="Puts this panel’s figures on your clipboard as a Markdown table">Copy as text</button>
          )}
          <button type="button" role="menuitem" className={item} disabled={busy} onClick={() => { setOpen(false); setSheet(true) }} data-panel-share-post
            title="Shows the picture first; X, Threads and LinkedIn upload it to caprock.dev only when you press them">
            Post to X, Threads or LinkedIn…</button>
          <p role="status" aria-live="polite" className="min-h-[18px] px-2 pb-0.5 text-[11.5px] text-fg-muted">
            {busy ? 'Drawing…' : note || 'Drawn on your machine.'}
          </p>
        </div>,
        document.body,
      )}
      {sheet && (
        <Suspense fallback={null}>
          <PanelShareSheet name={name} hide={hide} onHide={toggleHide} draw={draw} onClose={() => setSheet(false)} />
        </Suspense>
      )}
    </>
  )
}

const MENU_W = 244

/** Three joined dots, the share card's own mark. */
function ShareGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
      <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
    </svg>
  )
}
