/**
 * Handing a file on: the reference an agent reads, the anchors a heading
 * takes, the `.md` paths found in an agent's output and where they live, and
 * typing a reference into a session without sending it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentRef, locateFile, mdPathsIn, outlineOf, sendRef, SendRefError, slugOf } from './mdreader'

describe('agentRef', () => {
  it('is @ and the absolute path, quoted only when it holds a space', () => {
    expect(agentRef('/Users/me/dev/app/docs/PLAN.md')).toBe('@/Users/me/dev/app/docs/PLAN.md')
    expect(agentRef('/Users/me/My Docs/a.md')).toBe('@"/Users/me/My Docs/a.md"')
    expect(agentRef('C:\\Users\\me\\a.md')).toBe('@C:\\Users\\me\\a.md')
  })
})

describe('slugOf', () => {
  it('names a heading as GitHub does, numbering repeats', () => {
    const seen = new Map<string, number>()
    expect(slugOf('The app workspace', seen)).toBe('the-app-workspace')
    expect(slugOf('Files: read a project’s file', seen)).toBe('files-read-a-projects-file')
    expect(slugOf('The app workspace', seen)).toBe('the-app-workspace-1')
    expect(slugOf('Café — déjà vu', seen)).toBe('café--déjà-vu')
  })

  it('lists levels one to three from the shallowest present', () => {
    expect(outlineOf([{ level: 2, text: 'a', slug: 'a' }, { level: 3, text: 'b', slug: 'b' }, { level: 5, text: 'c', slug: 'c' }]))
      .toEqual([{ level: 1, text: 'a', slug: 'a' }, { level: 2, text: 'b', slug: 'b' }])
  })
})

describe('mdPathsIn', () => {
  const paths = (s: string) => mdPathsIn(s).map((h) => h.path)
  it('finds the .md paths an agent prints', () => {
    expect(paths('I wrote docs/PLAN.md and updated ./README.md:12.')).toEqual(['docs/PLAN.md', './README.md'])
    expect(paths('Saved to /Users/me/dev/app/.ai/04-ui.md')).toEqual(['/Users/me/dev/app/.ai/04-ui.md'])
    expect(paths('See ~/notes/today.md, then ../x.mdx')).toEqual(['~/notes/today.md', '../x.mdx'])
    expect(paths('Wrote C:\\work\\app\\NOTES.md')).toEqual(['C:\\work\\app\\NOTES.md'])
  })

  it('leaves a URL, a longer extension and a bare word alone', () => {
    expect(paths('https://github.com/x/y/blob/main/README.md')).toEqual([])
    expect(paths('file:///Users/me/a.md')).toEqual([])
    expect(paths('wrote:docs/a.md')).toEqual(['docs/a.md'])
    expect(paths('read @/Users/me/a.md')).toEqual(['/Users/me/a.md'])
    expect(paths('main.mdz, x.md5, foo.markdownx and the md file')).toEqual([])
  })

  it('says where each one starts and ends', () => {
    expect(mdPathsIn('see a.md now')).toEqual([{ start: 4, end: 8, path: 'a.md' }])
  })
})

describe('locateFile', () => {
  const roots = [
    { projectId: '1', worktree: '', folder: '/Users/me/dev/app' },
    { projectId: '1', worktree: 'feat', folder: '/Users/me/dev/app/.claude/worktrees/feat' },
    { projectId: 'dir:/tmp/x', worktree: '', folder: 'C:\\work\\x' },
  ]
  it('opens an absolute path inside a known folder, the deepest folder first', () => {
    expect(locateFile('/Users/me/dev/app/docs/PLAN.md', '', roots)).toEqual({ projectId: '1', worktree: '', path: 'docs/PLAN.md' })
    expect(locateFile('/Users/me/dev/app/.claude/worktrees/feat/README.md', '', roots)).toEqual({ projectId: '1', worktree: 'feat', path: 'README.md' })
    expect(locateFile('c:\\work\\x\\NOTES.md', '', roots)).toEqual({ projectId: 'dir:/tmp/x', worktree: '', path: 'NOTES.md' })
  })

  it('reads a relative path against the session’s folder', () => {
    expect(locateFile('../docs/a.md', '/Users/me/dev/app/sub', roots)).toEqual({ projectId: '1', worktree: '', path: 'docs/a.md' })
    expect(locateFile('./a.md', '/Users/me/dev/app/.claude/worktrees/feat', roots)).toEqual({ projectId: '1', worktree: 'feat', path: 'a.md' })
  })

  it('opens nothing outside the known folders', () => {
    expect(locateFile('/etc/motd.md', '', roots)).toBeNull()
    expect(locateFile('/Users/me/dev/application/a.md', '', roots)).toBeNull()
    expect(locateFile('a.md', '', roots)).toBeNull()
    expect(locateFile('~/a.md', '/Users/me/dev/app', roots)).toBeNull()
  })
})

describe('sendRef', () => {
  let calls: { url: string; method: string; body: unknown }[] = []
  let waiting = false
  beforeEach(() => {
    calls = []
    waiting = false
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.endsWith('/permission')) return new Response(JSON.stringify({ permission: waiting ? { tool: 'Bash' } : null }), { status: 200 })
      return new Response(null, { status: 204 })
    }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('types the reference and a space, and never Enter', async () => {
    await sendRef('s1', '/Users/me/dev/app/docs/PLAN.md')
    const input = calls.filter((c) => c.url.endsWith('/input'))
    expect(input).toHaveLength(1)
    expect(input[0]).toMatchObject({ url: '/v1/agents/s1/input', method: 'POST', body: { data: '@/Users/me/dev/app/docs/PLAN.md ' } })
    expect(JSON.stringify(input[0]!.body)).not.toMatch(/\\r|\\n/)
  })

  it('types nothing while the agent waits on a permission prompt', async () => {
    waiting = true
    await expect(sendRef('s1', '/a.md')).rejects.toBeInstanceOf(SendRefError)
    expect(calls.some((c) => c.url.endsWith('/input'))).toBe(false)
  })
})
