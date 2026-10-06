/**
 * The Changes view: files listed by area, j/k between them, s to stage, a
 * two-step discard, Commit all when nothing is staged, a hook's refusal and
 * an auth failure shown with their output, and a 5,000-line diff that keeps
 * only a screenful of rows in the page.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Changes, FilePatch } from '@/lib/changes'
import { ChangesView } from './ChangesView'
import { DiffView } from './DiffView'

const m = vi.hoisted(() => ({ notes: vi.fn(async () => [{ event_id: 1, text: 'Fixed the parser. All tests pass.', fragment: false }]) }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, notes: m.notes } }
})

function status(over: Partial<Changes> = {}): Changes {
  return {
    project_id: 7, worktree: '', path: '/r', branch: 'feat/x', ahead: 1, behind: 0, remote: 'origin', published: false,
    upstream: 'origin/main', staged: [], conflicted: [], token: 't1', at: 1,
    unstaged: [
      { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 },
      { path: 'notes.md', status: 'untracked', additions: 3, deletions: 0 },
    ],
    ...over,
  }
}

function patch(path: string): FilePatch {
  return { path, staged: false, status: 'modified', bytes: 60, token: `p-${path}`, patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,3 @@\n ctx\n-gone\n+came ${path}\n+more\n` }
}

interface Call { method: string; url: string; body?: unknown }
let calls: Call[] = []
let handler: (c: Call) => { status?: number; body: unknown }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  localStorage.clear()
  calls = []
  m.notes.mockClear()
  handler = (c) => {
    if (c.url.includes('/changes/diff')) return { body: patch(new URL(c.url, 'http://x').searchParams.get('path')!) }
    return { body: status() }
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const c: Call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(init.body as string) : undefined }
    calls.push(c)
    const r = handler(c)
    return json(r.status ?? 200, r.body)
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const view = () => render(<ChangesView target={{ projectId: '7', worktree: '' }} title="repo · feat/x" sessionId="s1" onClose={() => {}} />)
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.url.includes(path))

describe('ChangesView', () => {
  it('lists the files, opens the first diff, and moves with j and k', async () => {
    view()
    await screen.findByText('a.ts')
    expect(await screen.findByText('came src/a.ts')).toBeTruthy()
    fireEvent.keyDown(screen.getByLabelText('Changes in repo · feat/x'), { key: 'j' })
    expect(await screen.findByText('came notes.md')).toBeTruthy()
    fireEvent.keyDown(screen.getByLabelText('Changes in repo · feat/x'), { key: 'k' })
    expect(await screen.findByText('came src/a.ts')).toBeTruthy()
    expect(screen.getByText('Publish branch')).toBeTruthy()
  })

  it('stages the selected file with s', async () => {
    handler = (c) => {
      if (c.url.includes('/changes/stage')) return { body: { changes: status({ staged: [{ path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 }], unstaged: [status().unstaged[1]!] }) } }
      if (c.url.includes('/changes/diff')) return { body: patch('src/a.ts') }
      return { body: status() }
    }
    view()
    await screen.findByText('came src/a.ts')
    fireEvent.keyDown(screen.getByLabelText('Changes in repo · feat/x'), { key: 's' })
    await waitFor(() => expect(posts('/changes/stage')).toHaveLength(1))
    expect(posts('/changes/stage')[0]!.body).toEqual({ paths: ['src/a.ts'] })
    expect(await screen.findByRole('button', { name: 'Commit 1 staged' })).toBeTruthy()
  })

  it('discards only after a second, confirmed call', async () => {
    handler = (c) => {
      if (c.url.includes('/changes/discard')) {
        const b = c.body as { confirm?: string }
        if (!b.confirm) return { body: { preview: { confirm: 'tok', files: [{ path: 'notes.md', status: 'untracked', additions: 3, deletions: 0 }] } } }
        return { body: { changes: status({ unstaged: [status().unstaged[0]!] }) } }
      }
      if (c.url.includes('/changes/diff')) return { body: patch('src/a.ts') }
      return { body: status() }
    }
    view()
    await screen.findByText('came src/a.ts')
    fireEvent.click(screen.getAllByRole('button', { name: 'Discard (d)' })[1]!)
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('It is new and will be deleted')
    expect(posts('/changes/discard')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(posts('/changes/discard')).toHaveLength(2))
    expect(posts('/changes/discard')[1]!.body).toEqual({ paths: ['notes.md'], confirm: 'tok' })
  })

  it('commits everything when nothing is staged, drafting from the agent', async () => {
    handler = (c) => {
      if (c.url.includes('/changes/commit')) return { body: { commit: { sha: 'a'.repeat(40), short: 'aaaaaaa', subject: 'Fixed the parser' }, changes: status({ unstaged: [] }) } }
      if (c.url.includes('/changes/diff')) return { body: patch('src/a.ts') }
      return { body: status() }
    }
    view()
    await screen.findByText('came src/a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Use the agent’s summary' }))
    await waitFor(() => expect((screen.getByLabelText('Commit message') as HTMLTextAreaElement).value).toBe('Fixed the parser\n\nAll tests pass.'))
    fireEvent.click(screen.getByRole('button', { name: 'Commit all 2' }))
    await waitFor(() => expect(posts('/changes/commit')).toHaveLength(1))
    expect(posts('/changes/commit')[0]!.body).toEqual({ message: 'Fixed the parser\n\nAll tests pass.', all: true })
    expect(await screen.findByText(/Committed aaaaaaa/)).toBeTruthy()
  })

  it('shows a hook refusal with what the hook said', async () => {
    handler = (c) => {
      if (c.url.includes('/changes/commit')) return { status: 422, body: { error: 'a commit hook refused the commit; what was staged is still staged', kind: 'hook', output: 'eslint: 3 problems' } }
      if (c.url.includes('/changes/diff')) return { body: patch('src/a.ts') }
      return { body: status() }
    }
    view()
    await screen.findByText('came src/a.ts')
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'try' } })
    fireEvent.keyDown(screen.getByLabelText('Commit message'), { key: 'Enter', metaKey: true })
    expect(await screen.findByText(/a commit hook refused/)).toBeTruthy()
    expect(screen.getByText('What the hook said')).toBeTruthy()
    expect(screen.getByText('eslint: 3 problems')).toBeTruthy()
  })

  it('says a push was refused for credentials, and that the commit stands', async () => {
    handler = (c) => {
      if (c.url.includes('/changes/commit')) return { body: { commit: { sha: 'b'.repeat(40), short: 'bbbbbbb', subject: 'x' }, changes: status({ unstaged: [] }) } }
      if (c.url.includes('/changes/push')) return { status: 422, body: { error: 'the remote refused your credentials; sign in to it in a terminal once', kind: 'auth', output: 'fatal: Authentication failed' } }
      if (c.url.includes('/changes/diff')) return { body: patch('src/a.ts') }
      return { body: status() }
    }
    view()
    await screen.findByText('came src/a.ts')
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Commit & Push' }))
    expect(await screen.findByText(/Committed bbbbbbb, but the push failed: the remote refused your credentials/)).toBeTruthy()
    expect(screen.getByText('fatal: Authentication failed')).toBeTruthy()
  })

  it('collapses a huge diff until asked', async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `+line ${i}`).join('\n')
    handler = (c) => {
      if (c.url.includes('/changes/diff')) return { body: { ...patch('src/a.ts'), patch: `@@ -0,0 +1,5000 @@\n${lines}\n`, bytes: lines.length } }
      return { body: status() }
    }
    view()
    fireEvent.click(await screen.findByRole('button', { name: 'Show the diff' }))
    expect(await screen.findByText('line 0')).toBeTruthy()
  })
})

describe('DiffView', () => {
  it('keeps only a screenful of a 5,000-line diff in the page', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `+line ${i}`).join('\n')
    const { container } = render(<DiffView patch={`@@ -0,0 +1,5000 @@\n${lines}\n`} layout="unified" />)
    const drawn = container.querySelectorAll('.h-\\[18px\\]').length
    expect(drawn).toBeGreaterThan(10)
    expect(drawn).toBeLessThan(200)
    const scroller = screen.getByRole('region', { name: 'Diff' })
    act(() => {
      scroller.scrollTop = 18 * 4000
      fireEvent.scroll(scroller)
    })
    return waitFor(() => expect(screen.getByText('line 4000')).toBeTruthy())
  })

  it('offers a hunk action on each hunk header', () => {
    const run = vi.fn()
    render(<DiffView patch={'@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n'} layout="split" hunkAction={{ label: 'Stage hunk', run }} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Stage hunk' })[1]!)
    expect(run).toHaveBeenCalledWith(1)
  })
})
