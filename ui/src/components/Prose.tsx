/**
 * The Markdown Caprock displays, rendered rather than dumped.
 *
 * Used for release notes and for the answers Claude wrote. Both arrived as raw
 * text for the same reason and looked equally wrong: `### Fixed` as a literal
 * heading, asterisks around bold phrases, and a table collapsed into `| | |`.
 *
 * These used to be shown as preformatted text on the reasoning that release
 * bodies are remote content and a local-first tool has no business rendering
 * remote markup. The first half is right and the conclusion was not: the
 * result was `### Fixed` as a literal heading and `**bold**` with its asterisks
 * showing, in a dialog whose whole job is to be read.
 *
 * The answer is not a Markdown library — that would parse arbitrary remote
 * input into HTML, which is the thing worth avoiding. It is to recognise the
 * four shapes our own release notes actually use and turn those into elements.
 * Everything else stays text. Nothing here can produce a script, an image or
 * any attribute but one: the output is `<h3>`, `<li>`, `<p>`, `<strong>` and
 * `<a>`, built from strings, so remote content cannot become markup no matter
 * what it contains.
 *
 * The one attribute is a link's href, and only an http(s) one: a bare
 * `https://…` in the text and a `[text](https://…)` or `<https://…>` become
 * a link that opens in a new tab — in the desktop app, the default browser
 * (lib/externalLinks.ts) — so a reply's links can be tapped on a phone
 * (2026-10-21). Any other scheme stays text (lib/autolink.ts).
 *
 * One more, and it is not a link: an agent's reply that names a `.md`
 * file (`docs/PLAN.md`, `/Users/…/NOTES.md`) gets that path as a button when
 * the caller passes `onPath` — the chat does, and the click opens the file
 * in a file tab of the workspace. It opens nothing on the web.
 */
import { Fragment, useState, type ReactNode } from 'react'
import { mdPathsIn, slugOf, type OutlineItem } from '@/lib/mdreader'
import { extTitle } from '@/lib/externalLinks'
import { safeHref, splitLinks, trimUrl } from '@/lib/autolink'

/** One rendered block. */
type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'bullet'; parts: Inline[] }
  | { kind: 'para'; parts: Inline[] }
  | { kind: 'table'; rows: Inline[][][] }
  | { kind: 'quote'; parts: Inline[] }

type Inline = { text: string; bold: boolean; code: boolean; href?: string }

/** Splits `**bold**`, `` `code` `` and http(s) links written as
 *  `[text](url)` or `<url>` out of a line, leaving everything else as plain
 *  text — a bare address in it is found when it is drawn. Unmatched markers
 *  are left alone rather than swallowed — a stray asterisk in prose is text,
 *  not a broken tag — and so is a link to anything but http(s). */
export function inlines(line: string): Inline[] {
  const out: Inline[] = []
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|<(https?:\/\/[^>\s]+)>|\*\*([^*]+)\*\*|`([^`]+)`/gi
  let last = 0
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const href = m[2] !== undefined || m[3] !== undefined ? safeHref(m[2] ?? m[3] ?? '') : undefined
    if (href === null) continue
    if (m.index > last) out.push({ text: line.slice(last, m.index), bold: false, code: false })
    if (href) out.push({ text: m[1] ?? m[3] ?? '', bold: false, code: false, href })
    else if (m[4] !== undefined) out.push({ text: m[4], bold: true, code: false })
    else out.push({ text: m[5] ?? '', bold: false, code: true })
    last = m.index + m[0].length
  }
  if (last < line.length) out.push({ text: line.slice(last), bold: false, code: false })
  return out
}

/**
 * Turns release-note text into blocks.
 *
 * Paragraphs are joined across lines: a changelog entry is hard-wrapped at
 * eighty columns for the sake of diffs, and showing those line breaks in a
 * dialog of a different width produces ragged text that looks broken.
 */
export function parseNotes(src: string): Block[] {
  const out: Block[] = []
  let para: string[] = []
  let bullet: string[] = []
  let table: string[] = []

  const flushPara = () => {
    if (para.length) out.push({ kind: 'para', parts: inlines(para.join(' ')) })
    para = []
  }
  const flushBullet = () => {
    if (bullet.length) out.push({ kind: 'bullet', parts: inlines(bullet.join(' ')) })
    bullet = []
  }
  // A Markdown table read as plain text is the worst case of all: `| | |`
  // followed by `|---|---|` and then rows whose columns no longer line up,
  // which is what an answer containing one looked like on the Answers screen.
  const flushTable = () => {
    if (table.length) {
      const rows = table
        // The separator row carries no content — it only told a parser which
        // line was the header, and there is no header row worth keeping when
        // the table is two columns of a summary.
        .filter((line) => !/^[|\s:-]+$/.test(line))
        .map((line) =>
          line
            .replace(/^\||\|$/g, '')
            .split('|')
            .map((cell) => inlines(cell.trim())),
        )
        .filter((cells) => cells.some((c) => c.some((p) => p.text.trim() !== '')))
      if (rows.length) out.push({ kind: 'table', rows })
    }
    table = []
  }
  const flush = () => {
    flushTable()
    flushBullet()
    flushPara()
  }

  for (const raw of src.split('\n')) {
    const line = raw.trimEnd()
    const trimmed = line.trim()

    if (trimmed === '') {
      flush()
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed)
    if (heading) {
      flush()
      out.push({ kind: 'heading', text: heading[1] ?? '' })
      continue
    }
    if (trimmed.startsWith('|')) {
      flushBullet()
      flushPara()
      table.push(trimmed)
      continue
    }
    flushTable()

    const quoted = /^>\s?(.*)$/.exec(trimmed)
    if (quoted) {
      flush()
      out.push({ kind: 'quote', parts: inlines(quoted[1] ?? '') })
      continue
    }

    const item = /^[-*•]\s+(.*)$/.exec(trimmed)
    if (item) {
      flush()
      bullet.push(item[1] ?? '')
      continue
    }
    // An indented continuation belongs to whatever is open above it.
    if (bullet.length) {
      bullet.push(trimmed)
      continue
    }
    para.push(trimmed)
  }
  flush()
  return out
}

/** Renders parsed notes. No `dangerouslySetInnerHTML` anywhere in this file. */
export function Prose({ text, onPath }: { text: string; onPath?: (path: string) => void }) {
  const blocks = parseNotes(text)
  // min-w-0 and overflow-wrap:anywhere: a long URL in a reply is one
  // unbreakable word, and as a grid item it set the session page's width —
  // the Answers tab scrolled sideways and pushed the header's buttons off it.
  return (
    <div className="grid gap-2.5 min-w-0 [overflow-wrap:anywhere] text-[13px] leading-relaxed text-fg-muted">
      {blocks.map((b, i) => {
        if (b.kind === 'heading') {
          return (
            <h3
              key={i}
              className="text-[11px] uppercase tracking-[0.08em] text-fg-faint mt-1.5 first:mt-0"
            >
              {b.text}
            </h3>
          )
        }
        if (b.kind === 'table') {
          return (
            // The table scrolls in its own frame and its cells keep their
            // words whole: the reply's overflow-wrap:anywhere, inherited,
            // let a wide table fit a phone by breaking every cell into
            // two-letter lines (2026-10-21).
            <div key={i} className="app-scroll min-w-0 max-w-full overflow-x-auto">
              <table className="w-max min-w-full border-collapse text-[12px] [overflow-wrap:normal]">
                <tbody>
                  {b.rows.map((cells, r) => (
                    <tr key={r} className="border-b border-border last:border-0">
                      {cells.map((cell, c) => (
                        <td key={c} className="py-1 pr-4 align-top">
                          {renderInline(cell, onPath)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
        if (b.kind === 'quote') {
          return (
            <p key={i} className="m-0 border-l-2 border-border pl-3 text-fg-faint">
              {renderInline(b.parts, onPath)}
            </p>
          )
        }
        if (b.kind === 'bullet') {
          return (
            <div key={i} className="grid grid-cols-[auto_1fr] gap-x-2">
              <span className="text-accent select-none">·</span>
              <p className="m-0">{renderInline(b.parts, onPath)}</p>
            </div>
          )
        }
        return (
          <p key={i} className="m-0">
            {renderInline(b.parts, onPath)}
          </p>
        )
      })}
    </div>
  )
}

function renderInline(parts: Inline[], onPath?: (path: string) => void) {
  return parts.map((p, i) => {
    if (p.href) return <WebLink key={i} href={p.href}>{p.text}</WebLink>
    if (p.code) return <code key={i} className="mono text-[12px] text-fg">{onPath ? withPaths(p.text, onPath) : p.text}</code>
    // A bare address is a link, and never a `.md` path inside one.
    const body = splitLinks(p.text).map((r, n) => (r.href ? <WebLink key={n} href={r.href}>{r.text}</WebLink> : <Fragment key={n}>{onPath ? withPaths(r.text, onPath) : r.text}</Fragment>))
    if (p.bold) return <strong key={i} className="font-medium text-fg">{body}</strong>
    return <span key={i}>{body}</span>
  })
}

const LINK_CLASS = 'text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent [overflow-wrap:anywhere]'

/** Plain text with each bare http(s) address in it a link, for text shown as written. */
export function LinkedText({ text }: { text: string }) {
  const runs = splitLinks(text)
  if (runs.length === 1 && !runs[0]!.href) return <>{text}</>
  return <>{runs.map((r, n) => (r.href ? <WebLink key={n} href={r.href}>{r.text}</WebLink> : <Fragment key={n}>{r.text}</Fragment>))}</>
}

/** A web address, opened in a new tab (in the desktop app, the default browser). */
function WebLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer noopener" className={LINK_CLASS} style={{ textDecorationLine: 'underline' }} title={extTitle(href)}>{children}</a>
}

/** `text` with each `.md` path in it a button that opens the file. */
function withPaths(text: string, onPath: (path: string) => void): ReactNode {
  const hits = mdPathsIn(text)
  if (hits.length === 0) return text
  const out: ReactNode[] = []
  let at = 0
  for (const h of hits) {
    if (h.start > at) out.push(text.slice(at, h.start))
    out.push(
      <button key={h.start} type="button" data-md-path onClick={() => onPath(h.path)} title={`Open ${h.path} in a tab`} className="cursor-pointer text-left text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">
        {text.slice(h.start, h.end)}
      </button>,
    )
    at = h.end
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}
/*
 * A document: the same renderer, read wider, for a project's own Markdown
 * in the app's file tab (README, docs). On top of the chat's shapes it knows
 * heading levels with their anchors, fenced code with a copy button,
 * numbered, nested and task items, a table's header row, a rule, links and
 * images. It is still built from strings into elements — nothing here sets
 * HTML — and a link only becomes one through the caller's `link`, which
 * decides what a link may open. An image is its alt text unless the caller's
 * `image` draws it: the file tab reads a relative picture from the project
 * through the daemon, and nothing is ever fetched from the web.
 */

type DocInline = { text: string; bold?: boolean; code?: boolean; italic?: boolean; href?: string; image?: boolean; src?: string }

export type DocBlock =
  | { kind: 'heading'; level: number; parts: DocInline[] }
  | { kind: 'para'; parts: DocInline[] }
  | { kind: 'item'; depth: number; marker: string; parts: DocInline[]; task?: 'open' | 'done' }
  | { kind: 'quote'; parts: DocInline[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'table'; head?: DocInline[][]; rows: DocInline[][][] }
  | { kind: 'rule' }

/** Links, images, `code`, **bold** and *italic* or _italic_, in one pass; a
 *  bare http(s) address in the text is found when it is drawn. */
export function docInlines(line: string): DocInline[] {
  const out: DocInline[] = []
  const re = /!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<(https?:\/\/[^>\s]+)>|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w*])\*([^*\s][^*]*)\*(?!\w)|(?<!\w)_([^_\s][^_]*)_(?!\w)|\b(https?:\/\/[^\s<>"'`]+)/gi
  let last = 0
  for (let m = re.exec(line); m; m = re.exec(line)) {
    // A bare address, taken whole before an underscore in it reads as italic.
    if (m[11] !== undefined) {
      const url = trimUrl(m[11])
      if (!safeHref(url)) continue
      if (m.index > last) out.push({ text: line.slice(last, m.index) })
      out.push({ text: url, href: url })
      last = m.index + url.length
      re.lastIndex = last
      continue
    }
    if (m.index > last) out.push({ text: line.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ text: m[1] || 'image', image: true, src: m[2] ?? '' })
    else if (m[3] !== undefined) out.push({ text: m[3], href: m[4] })
    else if (m[5] !== undefined) out.push({ text: m[5], href: m[5] })
    else if (m[6] !== undefined) out.push({ text: m[6], code: true })
    else if (m[7] !== undefined || m[8] !== undefined) out.push({ text: m[7] ?? m[8] ?? '', bold: true })
    else out.push({ text: m[9] ?? m[10] ?? '', italic: true })
    last = m.index + m[0].length
  }
  if (last < line.length) out.push({ text: line.slice(last) })
  return out
}

function cellsOf(line: string): DocInline[][] {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => docInlines(c.trim()))
}

/** Turns a Markdown document into blocks; whatever it does not know stays text. */
export function parseDoc(src: string): DocBlock[] {
  const out: DocBlock[] = []
  let para: string[] = []
  let table: string[] = []
  let item: { depth: number; marker: string; lines: string[]; task?: 'open' | 'done' } | null = null
  let fence: { mark: string; lang: string; lines: string[] } | null = null

  const flushPara = () => {
    if (para.length) out.push({ kind: 'para', parts: docInlines(para.join(' ')) })
    para = []
  }
  const flushItem = () => {
    if (item) out.push({ kind: 'item', depth: item.depth, marker: item.marker, parts: docInlines(item.lines.join(' ')), ...(item.task ? { task: item.task } : {}) })
    item = null
  }
  const flushTable = () => {
    if (table.length) {
      const sep = table.findIndex((l) => /^\|?[\s:|-]+\|?$/.test(l) && l.includes('-'))
      const rows = table.filter((_, i) => i !== sep).map(cellsOf)
      if (sep === 1) out.push({ kind: 'table', head: rows[0], rows: rows.slice(1) })
      else out.push({ kind: 'table', rows })
    }
    table = []
  }
  let quote: string[] = []
  const flushQuote = () => {
    if (quote.length) out.push({ kind: 'quote', parts: docInlines(quote.join(' ').trim()) })
    quote = []
  }
  const flush = () => { flushTable(); flushItem(); flushPara(); flushQuote() }

  for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      if (raw.trim().startsWith(fence.mark) && raw.trim().replace(/[`~]/g, '') === '') {
        out.push({ kind: 'code', lang: fence.lang, text: fence.lines.join('\n') })
        fence = null
      } else {
        fence.lines.push(raw)
      }
      continue
    }
    const line = raw.trimEnd()
    const trimmed = line.trim()
    const open = /^(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(trimmed)
    if (open) {
      flush()
      fence = { mark: open[1]!, lang: open[2] ?? '', lines: [] }
      continue
    }
    if (trimmed === '') { flush(); continue }
    if (/^<!--.*-->$/.test(trimmed)) continue
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(trimmed)
    if (heading) {
      flush()
      out.push({ kind: 'heading', level: heading[1]!.length, parts: docInlines(heading[2] ?? '') })
      continue
    }
    if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) { flush(); out.push({ kind: 'rule' }); continue }
    if (trimmed.startsWith('|')) {
      flushItem()
      flushPara()
      flushQuote()
      table.push(trimmed)
      continue
    }
    flushTable()
    const quoted = /^>\s?(.*)$/.exec(trimmed)
    if (quoted) {
      // A quote hard-wrapped over several `>` lines is one quote.
      flushItem(); flushPara()
      quote.push(quoted[1] ?? '')
      continue
    }
    flushQuote()
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) {
      flushItem()
      flushPara()
      const indent = li[1]!.replace(/\t/g, '  ').length
      const marker = /\d/.test(li[2]!) ? li[2]!.replace(')', '.') : '·'
      let rest = li[3] ?? ''
      const box = /^\[([ xX])\]\s+/.exec(rest)
      let task: 'open' | 'done' | undefined
      if (box) { task = box[1] === ' ' ? 'open' : 'done'; rest = rest.slice(box[0].length) }
      item = { depth: Math.min(4, Math.floor(indent / 2)), marker, lines: [rest], task }
      continue
    }
    if (item) { item.lines.push(trimmed); continue }
    para.push(trimmed)
  }
  if (fence) out.push({ kind: 'code', lang: fence.lang, text: fence.lines.join('\n') })
  flush()
  return out
}

/** The plain text of inline parts: a heading's words, for its anchor and the contents. */
export function plainOf(parts: readonly DocInline[]): string {
  return parts.map((p) => p.text).join('')
}

/** Each heading's level, words and anchor, in order: what the contents lists and the links jump to. */
export function docHeadings(blocks: readonly DocBlock[]): OutlineItem[] {
  const seen = new Map<string, number>()
  const out: OutlineItem[] = []
  for (const b of blocks) {
    if (b.kind !== 'heading') continue
    const text = plainOf(b.parts)
    out.push({ level: b.level, text, slug: slugOf(text, seen) })
  }
  return out
}

/** What a link may do, decided by the caller: a web address, an action, or nothing (text). */
export type DocLink = (href: string) => { href: string } | { onOpen: () => void } | null

/** How the caller draws an image, or null for its alt text. */
export type DocImage = (src: string, alt: string) => ReactNode | null

const HAIR = 'border-[var(--app-hairline,var(--color-border))]'

// A reading scale: one step per level, room above a heading to start a
// section and little below it, so a heading belongs to what follows.
const HEADING_CLASS = [
  '',
  `text-[30px] leading-[1.2] font-semibold tracking-[-0.022em] text-fg mt-8 first:mt-0 mb-1 pb-2 border-b ${HAIR}`,
  `text-[22px] leading-[1.3] font-semibold tracking-[-0.016em] text-fg mt-9 first:mt-0 mb-0.5 pb-1.5 border-b ${HAIR}`,
  'text-[18px] leading-[1.35] font-semibold tracking-[-0.01em] text-fg mt-7 first:mt-0',
  'text-[16px] leading-[1.4] font-semibold text-fg mt-5 first:mt-0',
  'text-[15px] font-semibold text-fg mt-4 first:mt-0',
  'text-[13px] font-semibold uppercase tracking-[0.06em] text-fg-muted mt-4 first:mt-0',
]

/** A fenced block, with a copy button that shows on hover or focus. */
function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }, () => {})
  }
  return (
    <div className="group/code relative min-w-0">
      <pre data-lang={lang || undefined} className={`mono app-scroll m-0 overflow-x-auto rounded-[8px] border ${HAIR} bg-[var(--app-row-hover,var(--color-panel-2))] px-4 py-3 text-[13px] leading-[1.6] text-fg`}>
        {text}
      </pre>
      <span className="pointer-events-none absolute right-2 top-1.5 flex items-center gap-1.5 opacity-0 transition-opacity group-hover/code:opacity-100 group-focus-within/code:opacity-100 motion-reduce:transition-none">
        {lang && <span className="mono text-[10.5px] text-fg-faint">{lang}</span>}
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'Copied' : 'Copy the code'}
          title="Copy the code"
          className={`pointer-events-auto h-[22px] rounded-[5px] border ${HAIR} bg-bg px-1.5 text-[11px] text-fg-muted hover:text-fg`}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </span>
    </div>
  )
}

/**
 * A Markdown document, rendered. No `dangerouslySetInnerHTML`; an `<img>`
 * only through the caller's `image`. `blocks` may come parsed, so a caller
 * that also lists the headings parses once. Each heading carries its anchor
 * in `data-anchor`, scoped to this document rather than the page's ids, as
 * several file tabs live in the page at once.
 */
export function ProseDoc({ text, blocks: given, link, image }: { text: string; blocks?: DocBlock[]; link?: DocLink; image?: DocImage }) {
  const blocks = given ?? parseDoc(text)
  const anchors = docHeadings(blocks)
  let h = 0
  const inl = (parts: DocInline[]) => renderDocInline(parts, link, image)
  return (
    // minmax(0,1fr), not the implicit auto track: a grid item's min-content
    // is its longest word under break-word, and one long link or path set
    // the whole document's width — a chat's file viewer scrolled sideways
    // at 1,512px on a 360px phone (2026-10-21).
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 text-[15px] leading-[1.72] text-fg [overflow-wrap:break-word]">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading': {
            const H = `h${b.level}` as 'h1'
            const a = anchors[h++]
            return <H key={i} data-anchor={a?.slug} className={`scroll-mt-4 ${HEADING_CLASS[b.level]}`}>{inl(b.parts)}</H>
          }
          case 'code':
            return <CodeBlock key={i} lang={b.lang} text={b.text} />
          case 'rule':
            return <hr key={i} className={`my-2 border-0 border-t ${HAIR}`} />
          case 'quote':
            return <p key={i} className="m-0 border-l-[3px] border-[var(--app-hairline-strong,var(--color-border))] pl-4 text-fg-muted">{inl(b.parts)}</p>
          case 'item':
            return (
              <div key={i} className="-mt-3 grid grid-cols-[1.5em_minmax(0,1fr)] first:mt-0" style={{ marginLeft: `${b.depth * 1.5}em` }} data-task={b.task}>
                {b.task ? (
                  <input type="checkbox" checked={b.task === 'done'} readOnly disabled aria-label={b.task === 'done' ? 'Done' : 'Not done'} className="mt-[0.42em] h-[14px] w-[14px] accent-[var(--color-accent)]" />
                ) : (
                  <span className={`select-none ${b.marker === '·' ? 'text-accent text-center' : 'num text-fg-muted'}`}>{b.marker}</span>
                )}
                <p className={`m-0 ${b.task === 'done' ? 'text-fg-muted' : ''}`}>{inl(b.parts)}</p>
              </div>
            )
          case 'table':
            return (
              <div key={i} data-doc-table className={`app-scroll min-w-0 max-w-full overflow-x-auto rounded-[8px] border ${HAIR}`}>
                <table className="w-max min-w-full border-collapse text-[13.5px] leading-[1.5] [overflow-wrap:normal]">
                  {b.head && (
                    <thead className="bg-[var(--app-row-hover,var(--color-panel-2))]">
                      <tr className="border-b border-[var(--app-hairline-strong,var(--color-border))]">
                        {b.head.map((c, n) => <th key={n} className="max-w-[44ch] px-3 py-2 text-left align-bottom font-semibold">{inl(c)}</th>)}
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    {b.rows.map((cells, r) => (
                      <tr key={r} className={`border-b ${HAIR} last:border-0`}>
                        {cells.map((c, n) => <td key={n} className="max-w-[44ch] px-3 py-2 align-top">{inl(c)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          default:
            return <p key={i} className="m-0">{inl(b.parts)}</p>
        }
      })}
    </div>
  )
}

function renderDocInline(parts: DocInline[], link?: DocLink, image?: DocImage) {
  const cls = 'text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent'
  // With no `link` from the caller, a web address still opens: an http(s)
  // one, in a new tab; anything else stays text.
  const route = link ?? ((href: string) => { const h = safeHref(href); return h ? { href: h } : null })
  const anchor = (key: number, href: string, text: string) => {
    const to = route(href)
    if (to && 'href' in to) return <a key={key} href={to.href} target="_blank" rel="noreferrer noopener" className={`${cls} [overflow-wrap:anywhere]`} style={{ textDecorationLine: 'underline' }} title={extTitle(to.href)}>{text}</a>
    if (to) return <button key={key} type="button" onClick={to.onOpen} className={`${cls} cursor-pointer text-left`} title={href}>{text}</button>
    return <span key={key}>{text}</span>
  }
  // A bare address in text, bold or italic is a link too; in `code` it is not.
  const linked = (text: string) => {
    const runs = splitLinks(text)
    return runs.length === 1 && !runs[0]!.href ? text : runs.map((r, n) => (r.href ? anchor(n, r.href, r.text) : <Fragment key={n}>{r.text}</Fragment>))
  }
  return parts.map((p, i) => {
    if (p.image) {
      const drawn = image?.(p.src ?? '', p.text)
      if (drawn) return <Fragment key={i}>{drawn}</Fragment>
      return <span key={i} className="italic text-fg-muted" title="An image">[{p.text}]</span>
    }
    if (p.code) return <code key={i} className="mono rounded-[4px] bg-[var(--app-row-hover,var(--color-panel-2))] px-1 py-px text-[0.86em]">{p.text}</code>
    if (p.bold) return <strong key={i} className="font-semibold">{linked(p.text)}</strong>
    if (p.italic) return <em key={i}>{linked(p.text)}</em>
    if (p.href !== undefined) return anchor(i, p.href, p.text)
    return <span key={i}>{linked(p.text)}</span>
  })
}
