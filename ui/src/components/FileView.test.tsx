/**
 * The file tab: Markdown rendered with a Source switch, other text with line
 * numbers, a binary and an over-large file said in one calm line, a relative
 * link opening another file tab, and a fresh read each time the tab comes to
 * the front.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileContent } from '@/lib/files'
import { FileView, findRanges } from './FileView'

let files: Record<string, Partial<FileContent>> = {}
let reads: string[] = []

beforeEach(() => {
  localStorage.clear()
  reads = []
  files = {}
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url, 'http://x').searchParams.get('path') ?? ''
    if (url.startsWith('blob:')) return new Response(new Uint8Array([0x89, 0x50]), { status: 200, headers: { 'Content-Type': 'image/png' } })
    if (url.includes('/image?')) {
      return files[path] ? new Response(new Uint8Array([0x89, 0x50]), { status: 200, headers: { 'Content-Type': 'image/png' } }) : new Response(null, { status: 404 })
    }
    reads.push(path)
    const f = files[path]
    if (!f) return new Response(JSON.stringify({ error: 'no such file' }), { status: 404 })
    return new Response(JSON.stringify({ path, size: (f.text ?? '').length, text: '', lang: 'text', ...f }), { status: 200 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const view = (path: string, over: Partial<Parameters<typeof FileView>[0]> = {}) =>
  render(<FileView projectId="7" worktree="" path={path} visible {...over} />)

describe('the file tab', () => {
  it('renders Markdown, and shows its source on asking', async () => {
    files['README.md'] = { text: '# Caprock\n\nSee [setup](docs/setup.md) and [the site](https://caprock.dev).\n\n```sh\nmake dev\n```\n\n| Key | Does |\n|---|---|\n| ⌘K | palette |\n\n![logo](logo.png)\n', lang: 'markdown' }
    const onOpenFile = vi.fn()
    view('README.md', { onOpenFile })
    expect(await screen.findByRole('heading', { level: 1, name: 'Caprock' })).toBeInTheDocument()
    expect(screen.getByText('make dev').tagName).toBe('PRE')
    expect(screen.getByText('Key').closest('th')).not.toBeNull()
    expect(screen.getByText('[logo]')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    const site = screen.getByText('the site')
    expect(site.tagName).toBe('A')
    expect(site.getAttribute('target')).toBe('_blank')
    fireEvent.click(screen.getByText('setup'))
    expect(onOpenFile).toHaveBeenCalledWith('docs/setup.md')

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    expect(screen.getByText('# Caprock')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Caprock' })).toBeNull()
  })

  it('shows code as highlighted text with line numbers, wrapped until switched off', async () => {
    files['main.go'] = { text: 'package main\n\nfunc main() {}\n', lang: 'go' }
    view('main.go')
    await waitFor(() => expect(document.querySelector('[data-lines][data-highlighted]')).not.toBeNull())
    expect(screen.getByText('3 lines · 29 bytes')).toBeInTheDocument()
    const gutters = [...document.querySelectorAll('[data-gutter]')].map((g) => g.textContent)
    expect(gutters).toEqual(['1', '2', '3'])
    const rows = [...document.querySelectorAll('[data-row] > span:last-child')]
    expect(rows[0]!.textContent).toBe('package main')
    expect(screen.getByText('package').getAttribute('style')).toContain('--color-accent')
    const wrap = screen.getByRole('button', { name: 'Wrap' })
    expect(wrap.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(wrap)
    expect(rows[0]!.className).toContain('whitespace-pre')
    expect(localStorage.getItem('caprock.file.wrap')).toBe('0')
  })

  it('leaves a file past the highlighting limit, and one in no known language, plain', async () => {
    files['big.js'] = { text: `const x = '${'y'.repeat(300_000)}'\n`, lang: 'javascript' }
    files['notes.txt'] = { text: 'const x = 1\n', lang: 'text' }
    view('big.js')
    await screen.findByText('1 line · 293 KB')
    await new Promise((r) => setTimeout(r, 50))
    expect(document.querySelector('[data-highlighted]')).toBeNull()
    cleanup()
    view('notes.txt')
    expect(await screen.findByText('const x = 1')).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 50))
    expect(document.querySelector('[data-highlighted]')).toBeNull()
  })

  it('finds across the coloured tokens of one line', async () => {
    files['main.go'] = { text: 'package main\n\nfunc main() {}\n', lang: 'go' }
    view('main.go')
    await waitFor(() => expect(document.querySelector('[data-highlighted]')).not.toBeNull())
    const ranges = findRanges(document.querySelector('[data-lines]') as HTMLElement, 'func main(')
    expect(ranges).toHaveLength(1)
    expect(ranges[0]!.toString()).toBe('func main(')
  })

  it('says a binary is not shown and offers the editor', async () => {
    files['font.woff2'] = { binary: true, size: 2048 }
    const open = vi.fn()
    view('font.woff2', { editor: { name: 'Zed', open } })
    expect(await screen.findByText('A binary file of 2 KB; it is not shown here.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open in Zed' }))
    expect(open).toHaveBeenCalled()
  })

  it('says how much of a large file it shows', async () => {
    files['big.log'] = { text: 'line\n'.repeat(10), size: 3 * (1 << 20), truncated: true }
    view('big.log', { editor: { name: 'Zed', open: () => {} } })
    expect(await screen.findByText('The first 50 bytes of 3.0 MB; the rest is in Zed.')).toBeInTheDocument()
  })

  it('says a file that went away is gone', async () => {
    view('gone.md')
    expect(await screen.findByText('This file is not there any more.')).toBeInTheDocument()
  })

  it('reads again when the tab comes back to the front, and not while it is behind', async () => {
    files['a.txt'] = { text: 'one\n' }
    const r = view('a.txt')
    await screen.findByText('one')
    r.rerender(<FileView projectId="7" worktree="" path="a.txt" visible={false} />)
    files['a.txt'] = { text: 'two\n' }
    window.dispatchEvent(new Event('focus'))
    expect(reads).toEqual(['a.txt'])
    r.rerender(<FileView projectId="7" worktree="" path="a.txt" visible />)
    await waitFor(() => expect(screen.getByText('two')).toBeInTheDocument())
    expect(reads).toEqual(['a.txt', 'a.txt'])
  })
})

describe('the file tab’s readers', () => {
  let width = 0
  beforeEach(() => {
    width = 0
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width })
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:local/1'), revokeObjectURL: vi.fn() }))
  })
  afterEach(() => { delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth })

  it('shows Markdown source and page side by side on a wide tab, and remembers it', async () => {
    width = 1200
    files['README.md'] = { text: '# Caprock\n\nHello.\n', lang: 'markdown' }
    view('README.md')
    await screen.findByRole('heading', { level: 1, name: 'Caprock' })
    fireEvent.click(screen.getByRole('button', { name: 'Split' }))
    await waitFor(() => expect(document.querySelector('[data-split-source] [data-lines]')).not.toBeNull())
    expect(document.querySelector('[data-split-page] h1')?.textContent).toBe('Caprock')
    expect(localStorage.getItem('caprock.file.view.markdown')).toBe('split')
    cleanup()
    view('README.md')
    await waitFor(() => expect(document.querySelector('[data-split]')).not.toBeNull())
  })

  it('falls back to the switch on a narrow tab', async () => {
    width = 600
    localStorage.setItem('caprock.file.view.markdown', 'split')
    files['README.md'] = { text: '# Caprock\n', lang: 'markdown' }
    view('README.md')
    await screen.findByRole('heading', { level: 1, name: 'Caprock' })
    expect(document.querySelector('[data-split]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Split' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Rendered' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('draws an HTML page in a sandboxed frame that loads nothing, its local style and picture inlined', async () => {
    files['site/index.html'] = {
      text: '<html><head><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="https://cdn.example.com/x.css"><script>alert(1)</script></head>'
        + '<body onload="x()"><h1>Hi</h1><img src="logo.png"><img src="https://example.com/a.png"><a href="https://example.com">out</a></body></html>',
      lang: 'html',
    }
    files['site/style.css'] = { text: 'h1 { color: red }', lang: 'css' }
    files['site/logo.png'] = { binary: true, size: 2 }
    view('site/index.html')
    const frame = await waitFor(() => {
      const f = document.querySelector('iframe[data-html-preview]')
      expect(f).not.toBeNull()
      return f as HTMLIFrameElement
    })
    expect(frame.getAttribute('sandbox')).toBe('')
    const doc = frame.getAttribute('srcdoc') ?? ''
    expect(doc).toContain('Content-Security-Policy')
    expect(doc).toContain('h1 { color: red }')
    expect(doc).toContain('src="data:image/png;base64,')
    expect(doc).not.toContain('<script')
    expect(doc).not.toContain('example.com/a.png')
    expect(doc).not.toContain('cdn.example.com')
    expect(doc).not.toContain('onload')
    expect(doc).not.toContain('href="https://example.com"')
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    await waitFor(() => expect(document.querySelector('[data-highlighted]')).not.toBeNull())
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('shows a CSV file as a table, with its source a click away', async () => {
    files['data.csv'] = { text: 'name,note\nada,"says ""hi"", twice"\nbob,plain\n', lang: 'text' }
    view('data.csv')
    const table = await waitFor(() => {
      const t = document.querySelector('table[data-csv]')
      expect(t).not.toBeNull()
      return t as HTMLTableElement
    })
    expect([...table.querySelectorAll('thead th')].map((t) => t.textContent)).toEqual(['', 'name', 'note'])
    expect(screen.getByText('says "hi", twice')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    expect(document.querySelector('table')).toBeNull()
    expect(screen.getByText('name,note')).toBeInTheDocument()
    expect(localStorage.getItem('caprock.file.view.table')).toBe('source')
  })

  it('shows a picture as itself, and an SVG’s source on asking', async () => {
    files['shot.png'] = { binary: true, size: 2048 }
    view('shot.png')
    const img = await screen.findByRole('img', { name: 'shot.png' })
    expect(img.getAttribute('src')).toBe('blob:local/1')
    expect(screen.getByText('2 KB')).toBeInTheDocument()
    cleanup()
    files['icon.svg'] = { text: '<svg xmlns="http://www.w3.org/2000/svg"/>\n', lang: 'xml' }
    view('icon.svg')
    await screen.findByRole('img', { name: 'icon.svg' })
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    await waitFor(() => expect(document.querySelector('[data-lines]')?.textContent).toContain('<svg'))
  })
})
