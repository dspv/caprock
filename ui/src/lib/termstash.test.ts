import { describe, expect, it } from 'vitest'
import { Terminal as Xterm } from '@xterm/xterm'
import { stashScrollback } from './termstash'

const write = (t: Xterm, s: string) => new Promise<void>((r) => t.write(s, r))

/** The cell's underline style and link (xterm keeps them apart from the colours). */
const ext = (c: unknown) => {
  const cell = c as { hasExtendedAttrs?: () => number; extended?: { underlineStyle?: number; urlId?: number } }
  // A reused cell keeps the last extended attributes it read: only this cell's own count.
  if (!cell.hasExtendedAttrs?.()) return '-'
  const e = cell.extended
  return `${e?.underlineStyle ?? ''}:${e?.urlId ?? ''}`
}

/** Every cell of every line of the normal buffer: text, width and attributes. */
function cells(t: Xterm): string[] {
  const b = t.buffer.normal
  const out: string[] = []
  const c = b.getNullCell()
  for (let y = 0; y < b.length; y++) {
    const l = b.getLine(y)!
    const row: string[] = [l.isWrapped ? 'W' : '-']
    for (let x = 0; x < l.length; x++) {
      l.getCell(x, c)
      row.push(`${c.getChars()}|${c.getWidth()}|${c.getFgColorMode()}:${c.getFgColor()}|${c.getBgColorMode()}:${c.getBgColor()}|${c.isBold()}${c.isUnderline()}${c.isInverse()}|${ext(c)}`)
    }
    out.push(row.join(' '))
  }
  return out
}

async function filled(lines = 600, cols = 60): Promise<Xterm> {
  const t = new Xterm({ cols, rows: 20, scrollback: 10_000, allowProposedApi: true })
  let s = ''
  for (let i = 0; i < lines; i++) {
    switch (i % 6) {
      case 0: s += `\x1b[3${i % 8}mline ${i}\x1b[0m plain tail\r\n`; break
      case 1: s += `\x1b[48;5;${i % 256}m  bg to the end of the line \x1b[K\x1b[0m\r\n`; break
      case 2: s += `wide 日本語 ${i} and é combined é and 👍\r\n`; break
      case 3: s += `\x1b]8;;https://example.com/${i}\x07link ${i}\x1b]8;;\x07 \x1b[4:3mcurly\x1b[0m\r\n`; break
      case 4: s += `${'x'.repeat(cols + 15)} wrapped ${i}\r\n`; break
      default: s += '\r\n'
    }
  }
  await write(t, s)
  return t
}

describe('stashScrollback', () => {
  it('takes the old scrollback out and puts it back cell for cell', async () => {
    const t = await filled()
    const before = cells(t)
    const base = t.buffer.normal.baseY
    const st = stashScrollback(t, 100)!
    expect(st).toBeDefined()
    expect(st.lines).toBe(base - 100)
    expect(t.buffer.normal.baseY).toBe(100)
    expect(t.buffer.normal.length).toBe(100 + t.rows)
    // The screen and the kept lines are untouched meanwhile.
    expect(cells(t)).toEqual(before.slice(before.length - 100 - t.rows))
    // Smaller than the lines it held: 60 columns × 12 bytes each.
    expect(st.bytes).toBeLessThan(st.lines * 60 * 12 / 2)
    expect(st.restore()).toBe(base - 100)
    expect(t.buffer.normal.baseY).toBe(base)
    expect(t.buffer.normal.viewportY).toBe(base)
    expect(cells(t)).toEqual(before)
    // Once.
    expect(st.restore()).toBe(0)
    t.dispose()
  })

  it('writes after it go below the packed lines, and the cursor stays', async () => {
    const t = await filled()
    const before = cells(t)
    const st = stashScrollback(t, 50)!
    await write(t, 'after one\r\nafter two\r\n')
    st.restore()
    const now = cells(t)
    // Everything that was there, then the new output (the screen scrolled by two).
    expect(now.slice(0, before.length - t.rows)).toEqual(before.slice(0, before.length - t.rows))
    expect(t.buffer.normal.getLine(t.buffer.normal.baseY + t.buffer.normal.cursorY - 2)!.translateToString(true)).toBe('after one')
    expect(t.buffer.normal.cursorX).toBe(0)
    t.dispose()
  })

  it('keeps markers on the kept lines where they were', async () => {
    const t = await filled()
    const m = t.registerMarker(-3)!
    const text = t.buffer.normal.getLine(m.line)!.translateToString(true)
    const st = stashScrollback(t, 100)!
    expect(t.buffer.normal.getLine(m.line)!.translateToString(true)).toBe(text)
    st.restore()
    expect(t.buffer.normal.getLine(m.line)!.translateToString(true)).toBe(text)
    t.dispose()
  })

  it('lets the packed lines go when the scrollback is erased, or the terminal reset, meanwhile', async () => {
    const a = await filled()
    const sa = stashScrollback(a, 100)!
    await write(a, '\x1b[3J')
    expect(sa.restore()).toBe(0)
    expect(a.buffer.normal.baseY).toBe(0)
    a.dispose()

    const b = await filled()
    const sb = stashScrollback(b, 100)!
    b.reset()
    expect(sb.restore()).toBe(0)
    expect(b.buffer.normal.length).toBe(b.rows)
    b.dispose()
  })

  it('puts back only what xterm would have kept', async () => {
    const t = new Xterm({ cols: 40, rows: 10, scrollback: 300, allowProposedApi: true })
    let s = ''
    for (let i = 0; i < 400; i++) s += `line ${i}\r\n`
    await write(t, s)
    const st = stashScrollback(t, 50)!
    expect(st.lines).toBe(250)
    // 30 new lines: the buffer itself has room, the packed lines lose the 30 oldest.
    s = ''
    for (let i = 400; i < 430; i++) s += `line ${i}\r\n`
    await write(t, s)
    expect(st.restore()).toBe(220)
    expect(t.buffer.normal.length).toBe(310)
    expect(t.buffer.normal.getLine(0)!.translateToString(true)).toBe('line 121')
    expect(t.buffer.normal.getLine(t.buffer.normal.baseY + t.buffer.normal.cursorY - 1)!.translateToString(true)).toBe('line 429')
    t.dispose()
  })

  it('moves nothing while the reader is scrolled up, something is selected, or there is too little', async () => {
    const t = await filled()
    t.scrollLines(-30)
    expect(stashScrollback(t, 100)).toBeUndefined()
    t.scrollToBottom()
    // An unopened xterm has no selection service: stand one in.
    const has = t.hasSelection
    t.hasSelection = () => true
    expect(stashScrollback(t, 100)).toBeUndefined()
    t.hasSelection = has
    expect(stashScrollback(t, 10_000)).toBeUndefined()
    t.dispose()
  })

  it('does nothing on an xterm whose buffer it does not recognise', async () => {
    const t = await filled()
    const lines = t.buffer.normal.length
    ;(t as unknown as { _core: { buffers: { normal: { lines: { splice?: unknown } } } } })._core.buffers.normal.lines.splice = undefined
    expect(stashScrollback(t, 100)).toBeUndefined()
    expect(t.buffer.normal.length).toBe(lines)
    t.dispose()
  })

  it('a dropped stash puts nothing back', async () => {
    const t = await filled()
    const st = stashScrollback(t, 100)!
    st.drop()
    expect(st.restore()).toBe(0)
    expect(t.buffer.normal.baseY).toBe(100)
    t.dispose()
  })
})
