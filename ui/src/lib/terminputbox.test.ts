import { afterEach, describe, expect, it } from 'vitest'
import { Terminal as Xterm } from '@xterm/xterm'
import { attachInputBoxBand, boxColor, findInputBox, isPromptText, isRuleText } from './terminputbox'

const COLS = 40
const rule = '─'.repeat(COLS)
const rows = (...r: string[]) => (i: number) => r[i] ?? ''

describe('findInputBox', () => {
  it('finds the rows between the rules, under the prompt, with a footer below', () => {
    const r = ['output', '', rule, '❯ hello', rule, '  ⏵⏵ accept edits on', '']
    expect(findInputBox(rows(...r), r.length, COLS)).toEqual({ first: 3, last: 3 })
  })

  it('follows the box as it grows', () => {
    const r = ['output', rule, '❯ first line', '  second line', '  third', rule, '  ? for shortcuts']
    expect(findInputBox(rows(...r), r.length, COLS)).toEqual({ first: 2, last: 4 })
  })

  it('takes an empty prompt, an older >, and bash mode', () => {
    for (const p of ['❯', '> ', '! ls']) {
      const r = [rule, p.trimEnd(), rule]
      expect(findInputBox(rows(...r), r.length, COLS), p).toEqual({ first: 1, last: 1 })
    }
  })

  it('finds nothing without a prompt under the top rule — a dialog, a menu, a shell', () => {
    const cases = [
      [rule, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', rule],
      [rule, '❯ 1. Yes', rule],
      ['$ ls', 'a b c', '$ '],
      [rule, rule],
      ['❯ hello', rule],
      [],
    ]
    for (const r of cases) expect(findInputBox(rows(...r), r.length, COLS), r.join('|')).toBeNull()
  })

  it('takes nothing taller than a box can be', () => {
    const r = [rule, '❯ a', ...Array.from({ length: 40 }, () => '  x'), rule]
    expect(findInputBox(rows(...r), r.length, COLS)).toBeNull()
  })
})

describe('isRuleText / isPromptText', () => {
  it('a rule is mostly ─ from the left edge; a short or indented dash run is not', () => {
    expect(isRuleText(rule, COLS)).toBe(true)
    expect(isRuleText('─'.repeat(30) + ' plan ──', COLS)).toBe(true)
    expect(isRuleText('───', COLS)).toBe(false)
    expect(isRuleText('     ' + '─'.repeat(35), COLS)).toBe(false)
    expect(isRuleText('a ' + '─'.repeat(38), COLS)).toBe(false)
  })

  it('a prompt is the glyph and a space, never a numbered menu row', () => {
    expect(isPromptText('❯ fix it')).toBe(true)
    expect(isPromptText('❯ 1. Yes')).toBe(false)
    expect(isPromptText('❯fix')).toBe(false)
    expect(isPromptText('   ❯ deep')).toBe(false)
  })
})

describe('boxColor', () => {
  it('lifts the ground toward the ink — 7% dark, 5% light — and refuses what is not #rrggbb', () => {
    expect(boxColor('#000000', '#ffffff')).toBe('#121212')
    expect(boxColor('#ffffff', '#000000')).toBe('#f2f2f2')
    expect(boxColor('rgba(0,0,0,0)', '#ffffff')).toBe('')
    expect(boxColor(undefined, '#ffffff')).toBe('')
  })
})

describe('attachInputBoxBand', () => {
  let term: Xterm | undefined
  afterEach(() => term?.dispose())

  const write = (t: Xterm, s: string) => new Promise<void>((r) => t.write(s, r))
  const make = () => {
    term = new Xterm({ cols: COLS, rows: 10, allowProposedApi: true, theme: { background: '#1a1a1a', foreground: '#e0e0e0' } })
    return term
  }
  const bands = (t: Xterm) => (t as unknown as { _core: { _decorationService: { decorations: IterableIterator<{ marker: { line: number }; options: { x?: number; width?: number; height?: number; backgroundColor?: string } }> } } })
    ._core._decorationService.decorations

  it('puts one band on the box and moves it when the box moves', async () => {
    const t = make()
    const band = attachInputBoxBand(t)
    band.setEnabled(true)
    await write(t, `out\r\n${rule}\r\n❯ hi\r\n${rule}\r\nfooter`)
    band.update()
    let d = [...bands(t)]
    expect(d).toHaveLength(1)
    expect(d[0]!.marker.line).toBe(2)
    expect(d[0]!.options).toMatchObject({ x: 0, width: COLS, height: 1, backgroundColor: boxColor('#1a1a1a', '#e0e0e0') })

    // Two more lines in the box: one band, two rows taller, same place.
    await write(t, `\x1b[2K\x1b[A\x1b[2K\x1b[A\x1b[2K\r❯ hi\r\n  two\r\n  three\r\n${rule}\r\nfooter`)
    band.update()
    d = [...bands(t)]
    expect(d).toHaveLength(1)
    expect(d[0]!.marker.line).toBe(2)
    expect(d[0]!.options.height).toBe(3)
  })

  it('leaves a cell Claude Code coloured or inverted alone', async () => {
    const t = make()
    const band = attachInputBoxBand(t)
    band.setEnabled(true)
    // An inverse cursor cell at column 5.
    await write(t, `${rule}\r\n❯ hi \x1b[7m \x1b[27m\r\n${rule}\r\n`)
    band.update()
    const d = [...bands(t)].map((x) => [x.options.x, x.options.width])
    expect(d).toEqual([[0, 5], [6, COLS - 6]])
  })

  it('clears when the box goes, and draws nothing while off', async () => {
    const t = make()
    const band = attachInputBoxBand(t)
    await write(t, `${rule}\r\n❯ hi\r\n${rule}\r\n`)
    band.update()
    expect([...bands(t)]).toHaveLength(0)
    band.setEnabled(true)
    expect([...bands(t)]).toHaveLength(1)
    await write(t, '\x1b[2J\x1b[H$ ')
    band.update()
    expect([...bands(t)]).toHaveLength(0)
    await write(t, `\r\n${rule}\r\n❯ hi\r\n${rule}\r\n`)
    band.update()
    expect([...bands(t)]).toHaveLength(1)
    band.setEnabled(false)
    expect([...bands(t)]).toHaveLength(0)
  })
})
