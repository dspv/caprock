/**
 * The Files tab: two panels, the right on the agent's worktree; Compare
 * tints what differs and what is on one side only; the keys move, open,
 * mark and switch; F3 / ⌥3 shows the diff; Delete asks first and names the
 * files; a paired device sees no write it could make.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilesCommander, type FilesRoot } from './FilesCommander'

const roots: FilesRoot[] = [
  { key: '', name: 'app', branch: 'main', path: '/dev/app' },
  { key: 'agent-x', name: 'agent-x', branch: 'agent/files', path: '/dev/app/.claude/worktrees/agent-x', agent: { title: 'Add a file manager', state: 'working' } },
]

let writable = true
let posts: { url: string; body: unknown }[] = []

const listing = (wt: string, path: string) => {
  const base = path === ''
    ? [{ name: 'src', dir: true, size: 0, mtime: 1 }, { name: 'README.md', size: 10, mtime: 1 }, { name: wt ? 'new.go' : 'notes.txt', size: 4, mtime: 1, git: '?' }]
    : [{ name: 'app.go', size: 20, mtime: 1, git: wt ? undefined : 'M' }]
  return { path, root: wt ? '/dev/app/.claude/worktrees/agent-x' : '/dev/app', entries: base, git: true, branch: wt ? 'agent/files' : 'main', writable }
}

beforeEach(() => {
  localStorage.clear()
  writable = true
  posts = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'http://x')
    const p = u.searchParams
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
    if (init?.method === 'POST') { posts.push({ url: u.pathname, body: JSON.parse(String(init.body)) }); return ok({ done: 1 }) }
    if (u.pathname.endsWith('/fs/list')) return ok(listing(p.get('worktree') ?? '', p.get('path') ?? ''))
    if (u.pathname.endsWith('/fs/compare')) return ok(p.get('path') ? { path: 'src', states: { 'app.go': 'diff' } } : { path: '', states: { src: 'diff', 'notes.txt': 'left', 'new.go': 'right' } })
    if (u.pathname.endsWith('/fs/changed')) return ok({ base: 'abc', changes: [{ path: 'src/app.go', status: 'modified' }, { path: 'new.go', status: 'untracked' }] })
    if (u.pathname.endsWith('/fs/diff')) return ok({ path: p.get('path'), left: true, right: true, patch: '@@ -1,1 +1,1 @@\n-one\n+two\n', additions: 1, deletions: 1 })
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const view = () => render(<FilesCommander projectId="7" projectName="app" roots={roots} visible />)
const pane = (i: number) => document.querySelector(`[data-pane="${i}"]`)!
const row = (i: number, name: string) => pane(i).querySelector(`[data-name="${name}"]`)!
const box = () => document.querySelector('[data-files]') as HTMLElement

describe('the Files tab', () => {
  it('opens the checkout on the left and the agent worktree on the right, comparing', async () => {
    view()
    await waitFor(() => expect(row(1, 'new.go')).toBeTruthy())
    expect(pane(1).textContent).toContain('Add a file manager')
    await waitFor(() => expect(row(0, 'src').className).toContain('c-diff'))
    expect(row(0, 'notes.txt').className).toContain('c-only')
    expect(row(1, 'new.go').className).toContain('c-only')
    expect(row(0, 'README.md').className).not.toMatch(/\bc-(diff|only)/)
  })

  it('moves with the keys, opens a folder in both panels, and shows the diff on ⌥3', async () => {
    view()
    await waitFor(() => expect(row(1, 'src')).toBeTruthy())
    // The right panel is active; src is first.
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(row(1, 'app.go')).toBeTruthy())
    // Compare follows: the left panel went to src too.
    await waitFor(() => expect(row(0, 'app.go')).toBeTruthy())
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(row(1, 'app.go').className).toContain('cur')
    fireEvent.keyDown(box(), { key: '£', code: 'Digit3', altKey: true })
    expect(await screen.findByText('+two')).toBeInTheDocument()
    expect(screen.getByText('-one')).toBeInTheDocument()
    fireEvent.keyDown(box(), { key: 'Backspace' })
    await waitFor(() => expect(row(1, 'src').className).toContain('cur'))
  })

  it('switches panels with Tab, marks with Space, and asks before the Trash', async () => {
    view()
    await waitFor(() => expect(row(0, 'notes.txt')).toBeTruthy())
    fireEvent.keyDown(box(), { key: 'Tab' })
    expect(pane(0).className).toContain('active')
    fireEvent.keyDown(box(), { key: 'End' })
    fireEvent.keyDown(box(), { key: ' ' })
    expect(row(0, 'notes.txt').className).toContain('marked')
    fireEvent.keyDown(box(), { key: 'F8' })
    const dlg = await screen.findByRole('dialog')
    expect(dlg.textContent).toContain('notes.txt')
    expect(dlg.textContent).toContain('Trash')
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({ url: '/v1/projects/7/fs/trash', body: { worktree: '', paths: ['notes.txt'] } })
  })

  it('says a copy from the agent is a plain file copy', async () => {
    view()
    await waitFor(() => expect(row(1, 'new.go')).toBeTruthy())
    fireEvent.keyDown(box(), { key: 'End' })
    fireEvent.keyDown(box(), { key: 'F5' })
    const dlg = await screen.findByRole('dialog')
    expect(dlg.textContent).toMatch(/plain file copy.*No git command runs/)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(posts[0]?.body).toEqual({ from: 'agent-x', paths: ['new.go'], to: '', dir: '', overwrite: false }))
  })

  it('filters to what the agent changed', async () => {
    view()
    await waitFor(() => expect(row(0, 'README.md')).toBeTruthy())
    fireEvent.click(await screen.findByRole('button', { name: /What agent-x changed/ }))
    await waitFor(() => expect(pane(0).querySelector('[data-name="README.md"]')).toBeNull())
    expect(row(0, 'src')).toBeTruthy()
    expect(row(1, 'new.go')).toBeTruthy()
  })

  it('is read-only on a paired device', async () => {
    writable = false
    view()
    await waitFor(() => expect(row(1, 'src')).toBeTruthy())
    for (const name of [/Copy/, /Move/, /New folder/, /Delete/]) expect(screen.getByRole('button', { name })).toBeDisabled()
    fireEvent.keyDown(box(), { key: 'F8' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('paints Norton when asked, and keeps it', async () => {
    view()
    fireEvent.click(screen.getByRole('button', { name: 'Norton' }))
    expect(box().className).toContain('fc-norton')
    expect(localStorage.getItem('caprock.files.look')).toBe('norton')
  })
})
