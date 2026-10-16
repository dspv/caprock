/**
 * A project's file, read-only, in a tab of its own (.ai/04-ui.md § The app
 * workspace, File tabs). Markdown is rendered with the chat's renderer read
 * as a document (Prose.tsx ProseDoc) at a reading measure, with its contents
 * beside it on a wide window (a dropdown on a narrow one), a reading
 * progress line, anchors, and its relative pictures read through the
 * daemon; a Source switch shows the text. Anything else is monospace with
 * line numbers and a soft-wrap switch — no highlighting, so the bundle stays
 * as it was. A binary or an over-large file gets one calm line and "Open in
 * editor". The header's toolbar (FileTools.tsx) hands the file on: its path,
 * an agent's `@` reference, its contents, a download, a running session.
 *
 * Kept current without a timer: read when the tab comes to the front, when
 * the window regains focus while it is in front, and when the live socket
 * says the file may have moved (its project's git state, or an agent's edit
 * of this path). ⌘F finds in the file.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FIND_EVENT } from '@/lib/appkeys'
import { failureOf } from '@/lib/changes'
import { baseName, filesApi, fmtBytes, isMarkdown, resolveLink, type FileContent } from '@/lib/files'
import { live } from '@/lib/live'
import { imageUrl, outlineOf, type OutlineItem } from '@/lib/mdreader'
import { docHeadings, parseDoc, ProseDoc, type DocImage, type DocLink } from './Prose'
import { CloseIcon, ExternalIcon, ListIcon, SearchIcon } from './AppIcons'
import { FileToolbar, IconButton, MENU_ROW, Popover, type SendTarget } from './FileTools'

const WRAP_KEY = 'caprock.file.wrap'
const TOC_KEY = 'caprock.file.toc'
/** Frames come in bursts while an agent edits; one read per burst. */
const FRAME_DEBOUNCE_MS = 400
/** Lines per block that the browser may skip laying out while off screen. */
const CHUNK = 400
/** From this body width the contents sit beside the text; below it, a dropdown. */
export const RAIL_MIN_WIDTH = 960
/** A document needs this many headings before it gets contents at all. */
const MIN_OUTLINE = 3

function loadFlag(key: string): boolean {
  try { return localStorage.getItem(key) !== '0' } catch { return true }
}

export interface FileViewProps {
  projectId: string
  /** git's name for a linked worktree; '' for the main checkout. */
  worktree: string
  path: string
  /** The tab is in front. */
  visible: boolean
  /** A relative link in a Markdown file: open that file in a tab. */
  onOpenFile?: (path: string) => void
  /** The editor's name and its open, when an editor is found on this machine and the folder is known. */
  editor?: { name: string; open: () => void }
  /** The file's path on this machine, when its folder is known. */
  absPath?: string
  /** Running sessions Caprock started, that the file's reference may be typed into. */
  sendTargets?: readonly SendTarget[]
  /** A reference was typed into this session. */
  onSent?: (sessionId: string) => void
}

/** Does a live frame say this file may have changed? */
function touches(frame: unknown, projectId: string, path: string): boolean {
  const f = frame as { type?: string; data?: { id?: unknown; kind?: string; payload?: { tool_input?: Record<string, unknown> } } }
  if (f.type === 'reset') return true
  if (f.type === 'project') return String(f.data?.id) === projectId
  if (f.type !== 'event' || f.data?.kind !== 'tool.post') return false
  const i = f.data.payload?.tool_input
  const p = i && (i.file_path ?? i.notebook_path ?? i.filePath)
  return typeof p === 'string' && p.replace(/\\/g, '/').endsWith(`/${path}`)
}

const NO_TARGETS: readonly SendTarget[] = []

export const FileView = memo(function FileView({ projectId, worktree, path, visible, onOpenFile, editor, absPath, sendTargets = NO_TARGETS, onSent }: FileViewProps) {
  const [file, setFile] = useState<FileContent | null>(null)
  const [error, setError] = useState<{ message: string; status?: number } | null>(null)
  const [source, setSource] = useState(false)
  const [wrap, setWrap] = useState(() => loadFlag(WRAP_KEY))
  const [rail, setRail] = useState(() => loadFlag(TOC_KEY))
  const [find, setFind] = useState<{ open: boolean; token: number }>({ open: false, token: 0 })
  const [width, setWidth] = useState(0)
  const [progress, setProgress] = useState(0)
  const [current, setCurrent] = useState('')
  const [contentsMenu, setContentsMenu] = useState(false)
  const contentsButton = useRef<HTMLButtonElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const seq = useRef(0)

  const load = useCallback(() => {
    const n = ++seq.current
    filesApi.read({ projectId, worktree }, path)
      .then((f) => {
        if (n !== seq.current) return
        // The same text keeps the same object, so nothing re-renders and the
        // reader's place and selection stay where they were.
        setFile((cur) => (cur && cur.text === f.text && cur.size === f.size && cur.binary === f.binary && cur.truncated === f.truncated ? cur : f))
        setError(null)
      })
      .catch((e: unknown) => {
        if (n !== seq.current) return
        const f = failureOf(e)
        setError({ message: f.message, status: f.status })
      })
  }, [projectId, worktree, path])

  // Every time the tab comes to the front, and on focus while it is.
  useEffect(() => {
    if (!visible) return
    load()
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [visible, load])

  useEffect(() => {
    if (!visible) return
    let timer = 0
    live.start()
    const off = live.onFrame((f) => {
      if (!touches(f, projectId, path)) return
      window.clearTimeout(timer)
      timer = window.setTimeout(load, FRAME_DEBOUNCE_MS)
    })
    return () => { off(); window.clearTimeout(timer) }
  }, [visible, projectId, path, load])

  useEffect(() => { try { localStorage.setItem(WRAP_KEY, wrap ? '1' : '0') } catch { /* not kept */ } }, [wrap])
  useEffect(() => { try { localStorage.setItem(TOC_KEY, rail ? '1' : '0') } catch { /* not kept */ } }, [rail])

  useEffect(() => {
    if (!visible) return
    const onFind = () => setFind((f) => ({ open: true, token: f.token + 1 }))
    window.addEventListener(FIND_EVENT, onFind)
    return () => window.removeEventListener(FIND_EVENT, onFind)
  }, [visible])

  // The body's width decides where the contents go.
  useEffect(() => {
    const el = body.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const md = isMarkdown(path, file?.lang)
  const rendered = md && !source
  const blocks = useMemo(() => (rendered && file && !file.binary ? parseDoc(file.text) : null), [rendered, file])
  const outline = useMemo<OutlineItem[]>(() => {
    const h = blocks ? docHeadings(blocks) : []
    return h.length >= MIN_OUTLINE ? outlineOf(h) : []
  }, [blocks])
  const wide = width >= RAIL_MIN_WIDTH
  const showRail = wide && rail && outline.length > 0

  /** Scrolls the heading with this anchor to the top of the body. */
  const jump = useCallback((slug: string) => {
    const el = body.current?.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(slug)}"]`)
    el?.scrollIntoView?.({ block: 'start' })
    if (el) setCurrent(slug)
  }, [])

  // Reading progress and the heading being read, from one scroll handler.
  useEffect(() => {
    const el = body.current
    if (!el || !blocks) { setProgress(0); return }
    let frame = 0
    const measure = () => {
      frame = 0
      const room = el.scrollHeight - el.clientHeight
      setProgress(room > 0 ? Math.min(1, el.scrollTop / room) : 0)
      if (outline.length === 0) return
      const top = el.getBoundingClientRect().top + 96
      let at = ''
      for (const h of el.querySelectorAll<HTMLElement>('[data-anchor]')) {
        if (h.getBoundingClientRect().top > top) break
        at = h.dataset.anchor ?? ''
      }
      setCurrent(at)
    }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure) }
    el.addEventListener('scroll', onScroll, { passive: true })
    measure()
    return () => { el.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame) }
  }, [blocks, outline])

  // Through a ref, so a parent's new callback does not parse the document again.
  const openFile = useRef(onOpenFile)
  openFile.current = onOpenFile
  const canOpen = !!onOpenFile
  const link = useCallback<DocLink>((href) => {
    const h = href.trim()
    if (h.startsWith('#') && h.length > 1) {
      let slug = h.slice(1)
      try { slug = decodeURIComponent(slug) } catch { /* as written */ }
      return { onOpen: () => jump(slug.toLowerCase()) }
    }
    const to = resolveLink(path, href)
    if (!to) return null
    if ('external' in to) return { href: to.external }
    return canOpen ? { onOpen: () => openFile.current?.(to.file) } : null
  }, [path, canOpen, jump])
  const image = useCallback<DocImage>((src, alt) => {
    // A picture on the web stays its alt text: reading a file fetches
    // nothing from outside the machine.
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return null
    const to = resolveLink(path, src)
    if (!to || 'external' in to) return null
    return <LocalImage projectId={projectId} worktree={worktree} path={to.file} alt={alt} />
  }, [projectId, worktree, path])
  const doc = useMemo(() => (blocks && file ? <ProseDoc text={file.text} blocks={blocks} link={link} image={image} /> : null), [blocks, file, link, image])

  const lines = useMemo(() => {
    const out = file && !file.binary ? file.text.split('\n') : []
    if (out.length > 1 && out[out.length - 1] === '') out.pop()
    return out
  }, [file])
  const slash = path.lastIndexOf('/')

  return (
    <div className="flex h-full w-full flex-col bg-bg text-fg" data-file-view={path}>
      <div className="flex h-[36px] shrink-0 items-center gap-2.5 border-b border-[var(--app-hairline)] px-4">
        <span className="mono flex min-w-0 flex-1 text-[12px]" title={absPath ?? path}>
          {slash >= 0 && <span className="min-w-0 truncate text-fg-faint">{path.slice(0, slash + 1)}</span>}
          <span className="shrink-0 text-fg">{baseName(path)}</span>
        </span>
        {file && !file.binary && (
          <span className="num hidden shrink-0 text-[11px] text-fg-faint min-[900px]:inline">
            {`${lines.length.toLocaleString()} ${lines.length === 1 ? 'line' : 'lines'} · ${fmtBytes(file.size)}`}
          </span>
        )}
        {rendered && outline.length > 0 && (
          <IconButton
            label="Contents"
            tip={wide ? (rail ? 'Hide the contents' : 'Show the contents') : 'Contents'}
            pressed={wide ? rail : contentsMenu}
            popup={!wide}
            buttonRef={contentsButton}
            onClick={() => (wide ? setRail((r) => !r) : setContentsMenu((m) => !m))}
          >
            <ListIcon size={14} />
          </IconButton>
        )}
        {contentsMenu && !wide && (
          <Popover anchor={contentsButton.current} label="Contents" onClose={() => setContentsMenu(false)} width={300}>
            {outline.map((o) => (
              <button key={o.slug} type="button" role="menuitem" tabIndex={-1} onClick={() => { setContentsMenu(false); jump(o.slug) }} className={`${MENU_ROW} min-h-[28px] py-1 ${o.slug === current ? 'text-accent' : ''}`} style={{ paddingLeft: `${0.625 + (o.level - 1) * 0.875}rem` }}>
                <span className="line-clamp-2">{o.text}</span>
              </button>
            ))}
          </Popover>
        )}
        {md && file && !file.binary && (
          <Segmented label="Show" value={source ? 'source' : 'rendered'} onChange={(v) => setSource(v === 'source')} options={[['rendered', 'Rendered'], ['source', 'Source']]} />
        )}
        {file && !file.binary && !rendered && (
          <button
            type="button"
            aria-pressed={wrap}
            onClick={() => setWrap((w) => !w)}
            title="Wrap long lines"
            className={`h-[24px] shrink-0 rounded-[6px] px-2 text-[11.5px] ${wrap ? 'bg-[var(--app-row-active)] text-fg' : 'text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg'}`}
          >
            Wrap
          </button>
        )}
        <span aria-hidden className="h-[16px] w-px shrink-0 bg-[var(--app-hairline)]" />
        <FileToolbar
          path={path}
          absPath={absPath}
          text={file && !file.binary ? file.text : undefined}
          truncated={file?.truncated}
          md={md}
          targets={sendTargets}
          onSent={onSent}
        />
        {editor && (
          <button type="button" onClick={editor.open} title={`Open ${path} in ${editor.name}`} className="flex h-[24px] shrink-0 items-center gap-1.5 rounded-[6px] px-2 text-[11.5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">
            <ExternalIcon size={13} /> {editor.name}
          </button>
        )}
      </div>
      {find.open && visible && body.current && (
        <FindBar container={body.current} focusToken={find.token} contentKey={`${file?.text.length ?? 0}:${rendered}`} onClose={() => setFind((f) => ({ ...f, open: false }))} />
      )}
      {file?.truncated && !file.binary && (
        <p className="shrink-0 border-b border-[var(--app-hairline)] px-4 py-1 text-[11.5px] text-fg-faint">
          The first {fmtBytes(file.text.length)} of {fmtBytes(file.size)}{editor ? `; the rest is in ${editor.name}` : ''}.
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        {doc && (
          <div aria-hidden data-read-progress className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[2px]">
            <div className="h-full origin-left bg-accent/70" style={{ transform: `scaleX(${progress})` }} />
          </div>
        )}
        <div ref={body} className="app-scroll absolute inset-0 overflow-auto" tabIndex={-1}>
          {error && !file ? (
            <Calm text={error.status === 404 ? 'This file is not there any more.' : error.message} editor={error.status === 404 ? undefined : editor} />
          ) : !file ? (
            <p className="px-4 py-3 text-[12px] text-fg-faint">Reading…</p>
          ) : file.binary ? (
            <Calm text={`${file.truncated ? 'A large' : 'A'} binary file of ${fmtBytes(file.size)}; it is not shown here.`} editor={editor} />
          ) : doc ? (
            <div className="flex w-full justify-center gap-10 px-8 pb-24 pt-9">
              <article data-doc className="min-w-0 max-w-[72ch] flex-1 text-[15px]">
                {doc}
              </article>
              {showRail && <Contents outline={outline} current={current} onJump={jump} />}
            </div>
          ) : (
            <Lines lines={lines} wrap={wrap} />
          )}
        </div>
      </div>
    </div>
  )
})

/** The contents beside a wide document: sticky, the heading being read marked. */
function Contents({ outline, current, onJump }: { outline: OutlineItem[]; current: string; onJump: (slug: string) => void }) {
  return (
    <nav aria-label="Contents" data-contents className="sticky top-6 max-h-[calc(100vh-120px)] w-[220px] shrink-0 self-start overflow-y-auto pt-1">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-fg-faint">Contents</p>
      <ul className="grid gap-px border-l border-[var(--app-hairline)]">
        {outline.map((o) => {
          const on = o.slug === current
          return (
            <li key={o.slug}>
              <button
                type="button"
                onClick={() => onJump(o.slug)}
                aria-current={on ? 'location' : undefined}
                className={`-ml-px block w-full border-l py-[3px] pr-1 text-left text-[12.5px] leading-[1.4] ${on ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg'}`}
                style={{ paddingLeft: `${0.75 + (o.level - 1) * 0.75}rem` }}
              >
                <span className="line-clamp-2">{o.text}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/**
 * A picture inside the project, read through the daemon (`GET
 * /v1/projects/{id}/image`) with the device's token, and shown from an
 * object URL; its alt text until it arrives, and if it never does.
 */
function LocalImage({ projectId, worktree, path, alt }: { projectId: string; worktree: string; path: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    let url = ''
    setFailed(false)
    imageUrl({ projectId, worktree }, path)
      .then((u) => { if (alive) { url = u; setSrc(u) } else URL.revokeObjectURL(u) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false; if (url) URL.revokeObjectURL(url) }
  }, [projectId, worktree, path])
  if (!src) return <span className="italic text-fg-muted" title={failed ? `${path} could not be read` : path}>[{alt}]</span>
  return <img src={src} alt={alt} title={alt || path} className="inline-block h-auto max-w-full rounded-[6px] align-middle" />
}

function Calm({ text, editor }: { text: string; editor?: { name: string; open: () => void } }) {
  return (
    <div className="flex items-center gap-3 px-4 py-4 text-[12.5px] text-fg-muted">
      <span>{text}</span>
      {editor && (
        <button type="button" onClick={editor.open} className="h-[26px] rounded-[7px] border border-[var(--app-hairline-strong)] px-2.5 text-[12px] text-fg hover:bg-[var(--app-row-hover)]">
          Open in {editor.name}
        </button>
      )}
    </div>
  )
}

/** The text with its line numbers; blocks off screen are skipped by layout. */
const Lines = memo(function Lines({ lines, wrap }: { lines: string[]; wrap: boolean }) {
  const digits = String(lines.length).length
  const chunks = useMemo(() => {
    const out: { start: number; rows: string[] }[] = []
    for (let i = 0; i < lines.length; i += CHUNK) out.push({ start: i, rows: lines.slice(i, i + CHUNK) })
    return out
  }, [lines])
  return (
    <div className={`mono py-2 text-[12.5px] leading-[1.6] ${wrap ? '' : 'w-max min-w-full'}`} data-lines>
      {chunks.map((c) => (
        <div key={c.start} style={{ contentVisibility: 'auto', containIntrinsicSize: `auto ${c.rows.length * 20}px` }}>
          {c.rows.map((l, i) => (
            <div key={i} className="flex hover:bg-[var(--app-row-hover)]">
              <span data-gutter aria-hidden className="shrink-0 select-none pr-4 text-right text-fg-faint" style={{ width: `calc(${digits}ch + 2rem)` }}>{c.start + i + 1}</span>
              <span className={`min-w-0 flex-1 pr-4 ${wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'}`}>{l || '​'}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
})

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 items-center rounded-[7px] border border-[var(--app-hairline-strong)] p-0.5">
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)} className={`h-[20px] rounded-[5px] px-2 text-[11.5px] ${value === v ? 'bg-[var(--app-row-active)] text-fg' : 'text-fg-muted hover:text-fg'}`}>
          {text}
        </button>
      ))}
    </div>
  )
}

/** Matches past this are not marked; the count says so. */
const MAX_MATCHES = 5000

/** Every match of q in the container's text, skipping the line numbers. */
export function findRanges(container: HTMLElement, q: string): Range[] {
  if (!q) return []
  const needle = q.toLowerCase()
  const out: Range[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => ((n.parentElement?.closest('[data-gutter]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)),
  })
  for (let n = walker.nextNode(); n && out.length < MAX_MATCHES; n = walker.nextNode()) {
    const hay = (n.nodeValue ?? '').toLowerCase()
    for (let at = hay.indexOf(needle); at >= 0 && out.length < MAX_MATCHES; at = hay.indexOf(needle, at + needle.length)) {
      const r = document.createRange()
      r.setStart(n, at)
      r.setEnd(n, at + needle.length)
      out.push(r)
    }
  }
  return out
}

interface HighlightsLike { set: (name: string, h: unknown) => void; delete: (name: string) => void }
function highlights(): { reg: HighlightsLike; make: (...r: Range[]) => unknown } | null {
  const reg = (globalThis.CSS as unknown as { highlights?: HighlightsLike } | undefined)?.highlights
  const H = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
  return reg && H ? { reg, make: (...r) => new H(...r) } : null
}

/** Find in the file: Enter and ⇧Enter step through the matches, Esc closes. */
function FindBar({ container, focusToken, contentKey, onClose }: { container: HTMLElement; focusToken: number; contentKey: string; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const ranges = useMemo(() => findRanges(container, q), [container, q, contentKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { input.current?.focus(); input.current?.select() }, [focusToken])
  useEffect(() => { setAt(0) }, [q])
  useEffect(() => {
    const h = highlights()
    const cur = ranges[at]
    if (h) {
      h.reg.set('file-find', h.make(...ranges))
      if (cur) h.reg.set('file-find-current', h.make(cur))
      else h.reg.delete('file-find-current')
    }
    cur?.startContainer.parentElement?.scrollIntoView?.({ block: 'center' })
  }, [ranges, at])
  useEffect(() => () => { const h = highlights(); h?.reg.delete('file-find'); h?.reg.delete('file-find-current') }, [])

  const step = (d: number) => { if (ranges.length) setAt((n) => (n + d + ranges.length) % ranges.length) }
  const count = !q ? '' : ranges.length === 0 ? 'No results' : `${at + 1} of ${ranges.length}${ranges.length >= MAX_MATCHES ? '+' : ''}`
  return (
    <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-[var(--app-hairline)] px-4" role="search">
      <SearchIcon size={13} className="text-fg-faint" />
      <input
        ref={input}
        aria-label="Find in the file"
        placeholder="Find in the file"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1) }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
        }}
        className="h-[24px] min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-fg-faint"
      />
      <span className="num shrink-0 text-[11px] text-fg-faint" aria-live="polite">{count}</span>
      <button type="button" onClick={onClose} aria-label="Close find (Esc)" className="flex h-[22px] w-[22px] items-center justify-center rounded-[5px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg">
        <CloseIcon size={11} />
      </button>
    </div>
  )
}
