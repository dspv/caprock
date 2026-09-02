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
  return (
    <div className="grid gap-2.5 text-[13px] leading-relaxed text-fg-muted">
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
