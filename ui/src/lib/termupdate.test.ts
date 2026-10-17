import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal as Xterm } from '@xterm/xterm'
import {
  attachUpdateWatch, DISMISS_UNVERSIONED_MS, dismissKey, dismissNotice, findUpdateNotice, isDismissed,
  noticeLabel, OPEN_SHELL_BESIDE_EVENT, requestShellBeside, UPDATE_SCAN_MS, type Row,
} from './termupdate'

// Codex CLI's banner, exactly as the owner saw it in a Caprock terminal (2026-10-17).
const COMMAND = "sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'"
const BANNER = [
  '✨ Update available! 0.161.0 -> 0.162.0',
  `Run ${COMMAND} to update.`,
  'See full release notes: https://github.com/openai/codex/releases/latest',
]
const CODEX = { agent: 'codex', version: '0.162.0', command: COMMAND }

/** Lines as xterm wraps them: cut at `cols`, the continuation rows marked wrapped. */
function softWrap(lines: readonly string[], cols: number): Row[] {
  const out: Row[] = []
  for (const l of lines) {
    const chars = [...l]
    if (chars.length === 0) out.push({ text: '', wrapped: false })
    for (let i = 0; i < chars.length; i += cols) out.push({ text: chars.slice(i, i + cols).join(''), wrapped: i > 0 })
  }
  return out
}

/** Lines as an agent word-wraps them itself (textwrap's greedy fill, long words broken), in a `│` box or not. */
function wordWrap(lines: readonly string[], width: number, box: boolean, cols: number): Row[] {
  const out: Row[] = []
  for (const l of lines) {
    const rows: string[] = []
    let cur = ''
    for (let word of l.split(' ')) {
      if (cur && cur.length + 1 + word.length <= width) { cur += ` ${word}`; continue }
      if (cur) rows.push(cur)
      while (word.length > width) { rows.push(word.slice(0, width)); word = word.slice(width) }
      cur = word
    }
    rows.push(cur)
    for (const r of rows) out.push({ text: box ? `│ ${r.padEnd(width)} │`.padEnd(cols) : `  ${r}`.padEnd(cols), wrapped: false })
  }
  return out
}

describe('findUpdateNotice: Codex', () => {
  it('reads the exact banner on a wide terminal', () => {
    expect(findUpdateNotice(softWrap(['some output', ...BANNER, '', '› '], 200), 200)).toEqual(CODEX)
  })

  it('joins the command across rows xterm wrapped, at every narrow width', () => {
    for (let cols = 16; cols <= 120; cols++) {
      expect(findUpdateNotice(softWrap(BANNER, cols), cols), `cols ${cols}`).toEqual(CODEX)
    }
  })

  it('joins the command across rows Codex word-wrapped, in its box and out of it', () => {
    for (let width = 20; width <= 100; width++) {
      // At 23 `CODEX_NON_INTERACTIVE=1` fills its row exactly, and a whole
      // word there cannot be told from one broken there: no rule gets both.
      if (width === 23) continue
      for (const box of [true, false]) {
        const cols = width + 4
        expect(findUpdateNotice(wordWrap(BANNER, width, box, cols), cols), `width ${width} box ${box}`).toEqual(CODEX)
      }
    }
  })

  it('takes the command out of backticks, as older Codex printed it', () => {
    const rows = softWrap(['✨⬆️ Update available! 0.20.0 -> 0.21.0', 'Run `npm install -g @openai/codex@latest` to update.'], 120)
    expect(findUpdateNotice(rows, 120)).toEqual({ agent: 'codex', version: '0.21.0', command: 'npm install -g @openai/codex@latest' })
  })

  it('finds nothing without a command, without codex in it, or without the end of the sentence', () => {
    const cases = [
      ['✨ Update available! 0.161.0 -> 0.162.0', 'See https://github.com/openai/codex for installation options.'],
      ['Update available! 1.0.0 -> 1.1.0', 'Run pip install -U something to update.'],
      ['✨ Update available! 0.161.0 -> 0.162.0', `Run ${COMMAND}`],
      ['✨ Update available! 0.161.0 -> 0.162.0'],
      ['$ echo Run codex to update.'],
    ]
    for (const c of cases) expect(findUpdateNotice(softWrap(c, 80), 80), c.join('|')).toBeNull()
  })

  it('takes the most recent notice', () => {
    const rows = softWrap([...BANNER, '✨ Update available! 0.162.0 -> 0.163.0', 'Run brew upgrade --cask codex to update.'], 80)
    expect(findUpdateNotice(rows, 80)).toEqual({ agent: 'codex', version: '0.163.0', command: 'brew upgrade --cask codex' })
  })
})

describe('findUpdateNotice: Claude Code', () => {
  it('reads its update and auto-update-failed notices', () => {
    expect(findUpdateNotice(softWrap(['  Update available! Run: brew upgrade claude-code'], 80), 80))
      .toEqual({ agent: 'claude', command: 'brew upgrade claude-code' })
    expect(findUpdateNotice(softWrap(['✗ Auto-update failed · Try claude doctor or npm i -g @anthropic-ai/claude-code'], 30), 30))
      .toEqual({ agent: 'claude', command: 'npm i -g @anthropic-ai/claude-code' })
  })

  it('takes no command that is not Claude Code’s', () => {
    expect(findUpdateNotice(softWrap(['Update available! Run: rm -rf ~'], 80), 80)).toBeNull()
  })
})

describe('labels and dismissal', () => {
  beforeEach(() => localStorage.clear())

  it('names the agent and the version', () => {
    expect(noticeLabel(CODEX as never)).toBe('Codex 0.162.0 available')
    expect(noticeLabel({ agent: 'claude', command: 'claude update' })).toBe('Claude Code update available')
  })

  it('× holds for that agent and version, and a newer version shows again', () => {
    dismissNotice(CODEX as never)
    expect(isDismissed(CODEX as never)).toBe(true)
    expect(isDismissed({ ...CODEX, version: '0.163.0' } as never)).toBe(false)
    expect(isDismissed({ ...CODEX, agent: 'claude' } as never)).toBe(false)
    expect(dismissKey(CODEX as never)).toBe('codex@0.162.0')
  })

  it('a notice without a version is dismissed for a day', () => {
    const n = { agent: 'claude' as const, command: 'claude update' }
    dismissNotice(n, 1_000)
    expect(isDismissed(n, 1_000 + DISMISS_UNVERSIONED_MS - 1)).toBe(true)
    expect(isDismissed(n, 1_000 + DISMISS_UNVERSIONED_MS + 1)).toBe(false)
  })

  it('survives storage that throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => dismissNotice(CODEX as never)).not.toThrow()
    expect(isDismissed(CODEX as never)).toBe(false)
    get.mockRestore()
    set.mockRestore()
  })
})

describe('attachUpdateWatch on a real xterm', () => {
  let term: Xterm | undefined
  afterEach(() => {
    term?.dispose()
    term = undefined
    localStorage.clear()
  })
  const write = (t: Xterm, s: string) => new Promise<void>((r) => t.write(s, r))
  const settle = () => new Promise((r) => setTimeout(r, UPDATE_SCAN_MS + 50))

  it('finds the banner xterm wrapped at 40 columns, once, and the command is whole', async () => {
    term = new Xterm({ cols: 40, rows: 12, allowProposedApi: true })
    const seen: unknown[] = []
    const w = attachUpdateWatch(term, (n) => seen.push(n))
    await write(term, `starting\r\n${BANNER.join('\r\n')}\r\n\r\n› `)
    await settle()
    await write(term, 'more output\r\n')
    await settle()
    expect(seen).toEqual([CODEX])
    w.dispose()
  })

  it('says nothing about a dismissed version', async () => {
    dismissNotice(CODEX as never)
    term = new Xterm({ cols: 60, rows: 12, allowProposedApi: true })
    const seen: unknown[] = []
    const w = attachUpdateWatch(term, (n) => seen.push(n))
    await write(term, BANNER.join('\r\n'))
    await settle()
    expect(seen).toEqual([])
    w.dispose()
  })
})

describe('requestShellBeside', () => {
  it('asks the workspace with the session, and carries no command', () => {
    const got: unknown[] = []
    const on = (e: Event) => got.push((e as CustomEvent).detail)
    window.addEventListener(OPEN_SHELL_BESIDE_EVENT, on)
    requestShellBeside('s1')
    window.removeEventListener(OPEN_SHELL_BESIDE_EVENT, on)
    expect(got).toEqual([{ sessionId: 's1' }])
  })
})
