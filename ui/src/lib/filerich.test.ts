/**
 * The file tab's richer readers, their pure halves: CSV and TSV read into
 * rows, an HTML page made safe for a sandboxed frame, and the highlighter's
 * lines.
 */
import { describe, expect, it } from 'vitest'
import { parseDelimited, previewHtml, PREVIEW_CSP } from './filerich'
import { highlightLang, viewKind } from './files'
import { highlightLines } from './highlight'

describe('parseDelimited', () => {
  it('reads quoted fields, doubled quotes, line breaks inside quotes and CRLF', () => {
    const { rows, more } = parseDelimited('a,b\r\n"x, y","say ""hi"""\r\n"two\nlines",z\r\n', false)
    expect(rows).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', 'z']])
    expect(more).toBe(false)
  })

  it('reads tabs for TSV and semicolons for a CSV whose header has no comma', () => {
    expect(parseDelimited('a\tb\n1\t2', true).rows).toEqual([['a', 'b'], ['1', '2']])
    expect(parseDelimited('a;b\n1;2\n', false).rows).toEqual([['a', 'b'], ['1', '2']])
  })

  it('stops at the cap and says there was more', () => {
    const { rows, more } = parseDelimited('n\n'.repeat(10), false, 4)
    expect(rows).toHaveLength(4)
    expect(more).toBe(true)
  })
})

describe('previewHtml', () => {
  it('puts the policy first and strips scripts, frames, refreshes, handlers and outbound links', async () => {
    const out = await previewHtml(
      '<html><head><meta http-equiv="refresh" content="0;url=https://x.test"><base href="https://x.test/"></head><body>'
      + '<script>1</script><iframe src="https://x.test"></iframe><p onclick="1">t</p><a href="#top">in</a><a href="https://x.test">out</a>'
      + '<img src="a.png" srcset="b.png 2x"></body></html>',
      'index.html',
      null,
    )
    expect(out.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"')).toBe(true)
    expect(out).toContain(PREVIEW_CSP)
    for (const gone of ['<script', '<iframe', 'refresh', '<base', 'onclick', 'srcset', 'href="https://x.test"', 'src="a.png"']) expect(out).not.toContain(gone)
    expect(out).toContain('href="#top"')
  })

  it('inlines a relative stylesheet and picture through the reader, never one on the web', async () => {
    const asked: string[] = []
    const out = await previewHtml(
      '<link rel="stylesheet" href="../css/a.css"><link rel="stylesheet" href="//cdn.test/b.css"><img src="img/p.png"><img src="https://x.test/q.png">',
      'site/index.html',
      {
        text: async (f) => { asked.push(f); return 'p{color:red}</style><script>' },
        image: async (f) => { asked.push(f); return 'data:image/png;base64,AA==' },
      },
    )
    expect(asked).toEqual(['css/a.css', 'site/img/p.png'])
    expect(out).toContain('<style>p{color:red}<\\/style><script></style>')
    expect(out).toContain('src="data:image/png;base64,AA=="')
    expect(out).not.toContain('cdn.test')
    expect(out).not.toContain('x.test')
  })
})

describe('viewKind and highlightLang', () => {
  it('names the reader and the language by the file', () => {
    expect(viewKind('a/README.md')).toBe('markdown')
    expect(viewKind('index.HTML')).toBe('html')
    expect(viewKind('d.tsv')).toBe('table')
    expect(viewKind('i.svg')).toBe('image')
    expect(viewKind('main.go')).toBe('text')
    expect(highlightLang('ui/App.tsx')).toBe('typescript')
    expect(highlightLang('Makefile')).toBe('makefile')
    expect(highlightLang('pyproject.toml')).toBe('ini')
    expect(highlightLang('notes.txt')).toBeNull()
  })
})

describe('highlightLines', () => {
  it('turns the markup into lines of coloured plain-text segments', () => {
    const lines = highlightLines('const a = "<b>" // é\n\nlet x = 1\n', 'javascript')!
    expect(lines).toHaveLength(3)
    expect(lines[0]!.map((s) => s.t).join('')).toBe('const a = "<b>" // é')
    expect(lines[0]![0]).toEqual({ r: 'kw', t: 'const' })
    expect(lines[0]!.find((s) => s.r === 'str')?.t).toBe('"<b>"')
    expect(lines[0]!.find((s) => s.r === 'com')?.t).toBe('// é')
    expect(lines[1]).toEqual([])
  })

  it('carries a multi-line comment across lines', () => {
    const lines = highlightLines('/* one\ntwo */\nx', 'css')!
    expect(lines[0]).toEqual([{ r: 'com', t: '/* one' }])
    expect(lines[1]).toEqual([{ r: 'com', t: 'two */' }])
  })

  it('knows no language it was not given', () => {
    expect(highlightLines('x', 'cobol')).toBeNull()
  })
})
