/**
 * The file tab: Markdown rendered with a Source switch, other text with line
 * numbers, a binary and an over-large file said in one calm line, a relative
 * link opening another file tab, and a fresh read each time the tab comes to
 * the front.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileContent } from '@/lib/files'
import { FileView } from './FileView'

let files: Record<string, Partial<FileContent>> = {}
let reads: string[] = []

beforeEach(() => {
  localStorage.clear()
  reads = []
  files = {}
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url, 'http://x').searchParams.get('path') ?? ''
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

  it('shows code as text with line numbers, wrapped until switched off', async () => {
    files['main.go'] = { text: 'package main\n\nfunc main() {}\n', lang: 'go' }
    view('main.go')
    expect(await screen.findByText('package main')).toBeInTheDocument()
    expect(screen.getByText('3 lines · 29 bytes')).toBeInTheDocument()
    const gutters = [...document.querySelectorAll('[data-gutter]')].map((g) => g.textContent)
    expect(gutters).toEqual(['1', '2', '3'])
    const wrap = screen.getByRole('button', { name: 'Wrap' })
    expect(wrap.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(wrap)
    expect(screen.getByText('package main').className).toContain('whitespace-pre')
    expect(localStorage.getItem('caprock.file.wrap')).toBe('0')
  })

  it('says a binary is not shown and offers the editor', async () => {
    files['logo.png'] = { binary: true, size: 2048 }
    const open = vi.fn()
    view('logo.png', { editor: { name: 'Zed', open } })
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
