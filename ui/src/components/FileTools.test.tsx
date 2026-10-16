/**
 * Reading a Markdown file and handing it on, from the file tab: the
 * toolbar's copies and download, typing the reference into a running
 * session without sending it, the contents and anchors, task boxes, a code
 * block's copy, and a relative picture read through the daemon.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileView } from './FileView'

const DOC = [
  '# Guide', '', 'Jump to [setup](#set-up).', '',
  '## Set up', '', '- [x] clone', '- [ ] run', '',
  '```sh', 'make dev', '```', '',
  '## Use', '', '![shot](img/shot.png) and ![web](https://example.com/a.png)', '',
  '### Details', '', 'end',
].join('\n')

let calls: { url: string; method: string; body?: unknown }[] = []
let copied: string[] = []

beforeEach(() => {
  localStorage.clear()
  calls = []
  copied = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url.includes('/file?')) return new Response(JSON.stringify({ path: 'docs/GUIDE.md', size: DOC.length, text: DOC, lang: 'markdown' }), { status: 200 })
    if (url.includes('/image?')) return new Response(new Uint8Array([0x89, 0x50]), { status: 200, headers: { 'Content-Type': 'image/png' } })
    if (url.endsWith('/permission')) return new Response(JSON.stringify({ permission: null }), { status: 200 })
    return new Response(null, { status: 204 })
  }))
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async (t: string) => { copied.push(t) }) } })
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:local/1'), revokeObjectURL: vi.fn() }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const ABS = '/Users/me/dev/app/docs/GUIDE.md'
const view = (over: Partial<Parameters<typeof FileView>[0]> = {}) =>
  render(<FileView projectId="7" worktree="" path="docs/GUIDE.md" visible absPath={ABS} {...over} />)

describe('the file tab’s toolbar', () => {
  it('copies the path, the agent’s reference and the Markdown', async () => {
    view()
    await screen.findByRole('heading', { level: 1, name: 'Guide' })
    fireEvent.click(screen.getByRole('button', { name: 'Copy path' }))
    await waitFor(() => expect(copied).toEqual([ABS]))
    const forAgent = screen.getByRole('button', { name: 'Copy for an agent' })
    expect(forAgent.getAttribute('title')).toContain('Paste into any agent')
    fireEvent.click(forAgent)
    await waitFor(() => expect(copied[1]).toBe(`@${ABS}`))
    fireEvent.click(screen.getByRole('button', { name: 'Copy Markdown' }))
    await waitFor(() => expect(copied[2]).toBe(DOC))
    expect(screen.getByText('Markdown copied.')).toBeInTheDocument()
  })

  it('downloads the file under its own name', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    view()
    await screen.findByRole('heading', { level: 1, name: 'Guide' })
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(click).toHaveBeenCalled()
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('GUIDE.md')
    click.mockRestore()
  })

  it('without a known folder, offers no path to copy or send', async () => {
    view({ absPath: undefined })
    await screen.findByRole('heading', { level: 1, name: 'Guide' })
    expect(screen.getByRole('button', { name: 'Copy path' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send to a session' })).toBeDisabled()
  })

  it('types the reference into the session picked, without Enter, and brings it forward', async () => {
    const onSent = vi.fn()
    view({ sendTargets: [{ id: 'a1', title: 'Fix the login', where: 'app' }, { id: 'b2', title: 'Docs pass', where: 'app · docs' }], onSent })
    await screen.findByRole('heading', { level: 1, name: 'Guide' })
    fireEvent.click(screen.getByRole('button', { name: 'Send to a session' }))
    const menu = screen.getByRole('menu', { name: 'Send to a session' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Docs pass/ }))
    await waitFor(() => expect(onSent).toHaveBeenCalledWith('b2'))
    const input = calls.filter((c) => c.url.endsWith('/input'))
    expect(input).toEqual([{ url: '/v1/agents/b2/input', method: 'POST', body: { data: `@${ABS} ` } }])
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('says when there is no session it may type into', async () => {
    view({ sendTargets: [] })
    await screen.findByRole('heading', { level: 1, name: 'Guide' })
    fireEvent.click(screen.getByRole('button', { name: 'Send to a session' }))
    expect(screen.getByText('No agent Caprock started is running. Start one, then send.')).toBeInTheDocument()
  })
})

describe('reading Markdown', () => {
  it('draws task boxes, a code block’s copy, and anchors an in-page link jumps to', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    view()
    await screen.findByRole('heading', { level: 1, name: 'Guide' })
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([true, false])
    expect(screen.queryByText(/☑|☐/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Copy the code' }))
    await waitFor(() => expect(copied).toEqual(['make dev']))

    expect(screen.getByRole('heading', { level: 2, name: 'Set up' }).getAttribute('data-anchor')).toBe('set-up')
    fireEvent.click(screen.getByRole('button', { name: 'setup' }))
    expect(scroll).toHaveBeenCalled()
    expect(scroll.mock.contexts[0]).toBe(screen.getByRole('heading', { level: 2, name: 'Set up' }))
  })

  it('lists the contents in a dropdown on a narrow window', async () => {
    view()
    await screen.findByRole('heading', { level: 1, name: 'Guide' })
    fireEvent.click(screen.getByRole('button', { name: 'Contents' }))
    const menu = screen.getByRole('menu', { name: 'Contents' })
    expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Guide', 'Set up', 'Use', 'Details'])
  })

  it('reads a relative picture through the daemon, and leaves one on the web as text', async () => {
    view()
    const img = await screen.findByRole('img', { name: 'shot' })
    expect(img.getAttribute('src')).toBe('blob:local/1')
    expect(calls.some((c) => c.url === '/v1/projects/7/image?path=docs%2Fimg%2Fshot.png')).toBe(true)
    expect(calls.some((c) => c.url.includes('example.com'))).toBe(false)
    expect(screen.getByText('[web]')).toBeInTheDocument()
  })
})
