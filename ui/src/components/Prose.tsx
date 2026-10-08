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
 * Everything else stays text. Nothing here can produce a link, a script, an
 * image or any attribute: the output is `<h3>`, `<li>`, `<p>` and `<strong>`,
 * built from strings, so remote content cannot become markup no matter what it
 * contains.
 */

/** One rendered block. */
type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'bullet'; parts: Inline[] }
  | { kind: 'para'; parts: Inline[] }
  | { kind: 'table'; rows: Inline[][][] }
  | { kind: 'quote'; parts: Inline[] }

type Inline = { text: string; bold: boolean; code: boolean }

/** Splits `**bold**` and `` `code` `` out of a line, leaving everything else
 *  as plain text. Unmatched markers are left alone rather than swallowed — a
 *  stray asterisk in prose is text, not a broken tag. */
export function inlines(line: string): Inline[] {
  const out: Inline[] = []
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g
  let last = 0
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) out.push({ text: line.slice(last, m.index), bold: false, code: false })
    if (m[1] !== undefined) out.push({ text: m[1], bold: true, code: false })
    else out.push({ text: m[2] ?? '', bold: false, code: true })
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
export function Prose({ text }: { text: string }) {
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
            <div key={i} className="overflow-x-auto">
              <table className="border-collapse text-[12px]">
                <tbody>
                  {b.rows.map((cells, r) => (
                    <tr key={r} className="border-b border-border last:border-0">
                      {cells.map((cell, c) => (
                        <td key={c} className="py-1 pr-4 align-top">
                          {renderInline(cell)}
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
              {renderInline(b.parts)}
            </p>
          )
        }
        if (b.kind === 'bullet') {
          return (
            <div key={i} className="grid grid-cols-[auto_1fr] gap-x-2">
              <span className="text-accent select-none">·</span>
              <p className="m-0">{renderInline(b.parts)}</p>
            </div>
          )
        }
        return (
          <p key={i} className="m-0">
            {renderInline(b.parts)}
          </p>
        )
      })}
    </div>
  )
}

function renderInline(parts: Inline[]) {
  return parts.map((p, i) => {
    if (p.bold) return <strong key={i} className="font-medium text-fg">{p.text}</strong>
    if (p.code) return <code key={i} className="mono text-[12px] text-fg">{p.text}</code>
    return <span key={i}>{p.text}</span>
  })
}

/*
 * A document: the same renderer, read wider, for a project's own Markdown
 * in the app's file tab (README, docs). On top of the chat's shapes it knows
 * heading levels, fenced code, numbered and nested lists, a table's header
 * row, a rule, links and images. It is still built from strings into
 * elements — nothing here sets HTML — and a link only becomes one through
 * the caller's `link`, which decides what a link may open; an image is its
 * alt text, so a document never fetches anything.
 */

type DocInline = { text: string; bold?: boolean; code?: boolean; italic?: boolean; href?: string; image?: boolean }

export type DocBlock =
  | { kind: 'heading'; level: number; parts: DocInline[] }
  | { kind: 'para'; parts: DocInline[] }
  | { kind: 'item'; depth: number; marker: string; parts: DocInline[] }
  | { kind: 'quote'; parts: DocInline[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'table'; head?: DocInline[][]; rows: DocInline[][][] }
  | { kind: 'rule' }

/** Links, images, `code`, **bold** and *italic* or _italic_, in one pass. */
export function docInlines(line: string): DocInline[] {
  const out: DocInline[] = []
  const re = /!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<(https?:\/\/[^>\s]+)>|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w*])\*([^*\s][^*]*)\*(?!\w)|(?<!\w)_([^_\s][^_]*)_(?!\w)/g
  let last = 0
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) out.push({ text: line.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ text: m[1] || 'image', image: true })
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
  let item: { depth: number; marker: string; lines: string[] } | null = null
  let fence: { mark: string; lang: string; lines: string[] } | null = null

  const flushPara = () => {
    if (para.length) out.push({ kind: 'para', parts: docInlines(para.join(' ')) })
    para = []
  }
  const flushItem = () => {
    if (item) out.push({ kind: 'item', depth: item.depth, marker: item.marker, parts: docInlines(item.lines.join(' ')) })
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
  const flush = () => { flushTable(); flushItem(); flushPara() }

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
      table.push(trimmed)
      continue
    }
    flushTable()
    const quoted = /^>\s?(.*)$/.exec(trimmed)
    if (quoted) {
      flush()
      out.push({ kind: 'quote', parts: docInlines(quoted[1] ?? '') })
      continue
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) {
      flushItem()
      flushPara()
      const indent = li[1]!.replace(/\t/g, '  ').length
      const marker = /\d/.test(li[2]!) ? li[2]!.replace(')', '.') : '·'
      item = { depth: Math.min(4, Math.floor(indent / 2)), marker, lines: [(li[3] ?? '').replace(/^\[([ xX])\]\s+/, (_, c: string) => (c === ' ' ? '☐ ' : '☑ '))] }
      continue
    }
    if (item) { item.lines.push(trimmed); continue }
    para.push(trimmed)
  }
  if (fence) out.push({ kind: 'code', lang: fence.lang, text: fence.lines.join('\n') })
  flush()
  return out
}

/** What a link may do, decided by the caller: a web address, an action, or nothing (text). */
export type DocLink = (href: string) => { href: string } | { onOpen: () => void } | null

const HEADING_CLASS = [
  '',
  'text-[24px] font-semibold tracking-[-0.02em] text-fg mt-3 first:mt-0 pb-1.5 border-b border-[var(--app-hairline,var(--color-border))]',
  'text-[19px] font-semibold tracking-[-0.015em] text-fg mt-3 first:mt-0 pb-1 border-b border-[var(--app-hairline,var(--color-border))]',
  'text-[16px] font-semibold text-fg mt-2 first:mt-0',
  'text-[14px] font-semibold text-fg mt-1.5 first:mt-0',
  'text-[13px] font-semibold text-fg mt-1 first:mt-0',
  'text-[12px] font-semibold uppercase tracking-[0.06em] text-fg-muted mt-1 first:mt-0',
]

/** A Markdown document, rendered. No `dangerouslySetInnerHTML`, no `<img>`. */
export function ProseDoc({ text, link }: { text: string; link?: DocLink }) {
  const blocks = parseDoc(text)
  const inl = (parts: DocInline[]) => renderDocInline(parts, link)
  return (
    <div className="grid min-w-0 gap-3 [overflow-wrap:anywhere] text-[14px] leading-[1.65] text-fg">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading': {
            const H = `h${b.level}` as 'h1'
            return <H key={i} className={HEADING_CLASS[b.level]}>{inl(b.parts)}</H>
          }
          case 'code':
            return (
              <pre key={i} data-lang={b.lang || undefined} className="mono app-scroll m-0 overflow-x-auto rounded-[8px] border border-[var(--app-hairline,var(--color-border))] bg-[var(--app-row-hover,var(--color-panel-2))] px-3.5 py-2.5 text-[12.5px] leading-[1.55] text-fg">
                {b.text}
              </pre>
            )
          case 'rule':
            return <hr key={i} className="m-0 border-0 border-t border-[var(--app-hairline,var(--color-border))]" />
          case 'quote':
            return <p key={i} className="m-0 border-l-[3px] border-[var(--app-hairline-strong,var(--color-border))] pl-3.5 text-fg-muted">{inl(b.parts)}</p>
          case 'item':
            return (
              <div key={i} className="-mt-2 grid grid-cols-[1.4em_1fr] first:mt-0" style={{ marginLeft: `${b.depth * 1.4}em` }}>
                <span className={`select-none ${b.marker === '·' ? 'text-accent text-center' : 'num text-fg-muted'}`}>{b.marker}</span>
                <p className="m-0">{inl(b.parts)}</p>
              </div>
            )
          case 'table':
            return (
              <div key={i} className="app-scroll overflow-x-auto">
                <table className="border-collapse text-[13px]">
                  {b.head && (
                    <thead>
                      <tr className="border-b border-[var(--app-hairline-strong,var(--color-border))]">
                        {b.head.map((c, n) => <th key={n} className="py-1.5 pr-5 text-left align-bottom font-semibold">{inl(c)}</th>)}
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    {b.rows.map((cells, r) => (
                      <tr key={r} className="border-b border-[var(--app-hairline,var(--color-border))] last:border-0">
                        {cells.map((c, n) => <td key={n} className="py-1.5 pr-5 align-top">{inl(c)}</td>)}
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

function renderDocInline(parts: DocInline[], link?: DocLink) {
  return parts.map((p, i) => {
    if (p.image) return <span key={i} className="italic text-fg-muted" title="An image">[{p.text}]</span>
    if (p.code) return <code key={i} className="mono rounded-[4px] bg-[var(--app-row-hover,var(--color-panel-2))] px-1 py-px text-[0.88em]">{p.text}</code>
    if (p.bold) return <strong key={i} className="font-semibold">{p.text}</strong>
    if (p.italic) return <em key={i}>{p.text}</em>
    if (p.href !== undefined) {
      const to = link?.(p.href)
      const cls = 'text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent'
      if (to && 'href' in to) return <a key={i} href={to.href} target="_blank" rel="noreferrer noopener" className={cls} style={{ textDecorationLine: 'underline' }} title={to.href}>{p.text}</a>
      if (to) return <button key={i} type="button" onClick={to.onOpen} className={`${cls} cursor-pointer`} title={p.href}>{p.text}</button>
      return <span key={i}>{p.text}</span>
    }
    return <span key={i}>{p.text}</span>
  })
}
