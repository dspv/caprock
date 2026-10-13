import { describe, expect, it } from 'vitest'
import { mayShare, overlapChip, peerName, relPath } from './overlap'
import type { Overlap, SessionSummary } from './api'

const live = (repo_root: string, cwd = repo_root, status: SessionSummary['status'] = 'active') => ({ repo_root, cwd, status })

describe('mayShare', () => {
  it('is true only when two live sessions are in one repository or folder', () => {
    expect(mayShare([live('/r/a'), live('/r/b')])).toBe(false)
    expect(mayShare([live('/r/a', '/r/a'), live('/r/a', '/r/a/.caprock-worktrees/x')])).toBe(true)
    expect(mayShare([live('', '/tmp/x'), live('', '/tmp/x')])).toBe(true)
    expect(mayShare([live('/r/a'), live('/r/a', '/r/a', 'ended')])).toBe(false)
    expect(mayShare([live('C:\\r\\a'), live('C:/r/a')])).toBe(true)
  })
})

describe('overlapChip', () => {
  const me = { session_id: 'b', started_at: 200 }
  const o = (files: string[], started = 100): Overlap => ({
    window_minutes: 30,
    sessions: { b: { checkout: '/r/caprock', with: [{ session_id: 'a', name: 'fix the login bug in auth', name_source: 'prompt', started_at: started, files }] } },
  })

  it('is nothing for a session alone in its checkout', () => {
    expect(overlapChip({ window_minutes: 30, sessions: {} }, me, 'Router')).toBeUndefined()
  })

  it('names the neighbour quietly when they share only the folder', () => {
    const c = overlapChip(o([]), me, 'Router')!
    expect(c.tone).toBe('info')
    expect(c.label).toBe('shares checkout with Fix the login bug')
    expect(c.newer).toEqual({ session_id: 'b', name: 'Router' })
  })

  it('warns on files both edited, relative to the checkout, and moves the newer session', () => {
    const c = overlapChip(o(['/r/caprock/ui/a.ts', '/r/caprock/go.mod'], 300), me, 'Router')!
    expect(c.tone).toBe('warn')
    expect(c.label).toBe('2 files touched by both')
    expect(c.files).toEqual(['go.mod', 'ui/a.ts'])
    expect(c.title).toMatch(/go\.mod\nui\/a\.ts$/)
    expect(c.newer.session_id).toBe('a')
  })
})

describe('helpers', () => {
  it('peerName falls back to the short id', () => {
    expect(peerName({ session_id: 'abcdef1234567', name: '', name_source: undefined })).toBe('abcdef12')
    expect(peerName({ session_id: 'x', name: 'Renamed', name_source: 'name' })).toBe('Renamed')
  })
  it('relPath writes a file under the checkout relative to it, either separator', () => {
    expect(relPath('C:\\r\\a\\x.go', 'C:/r/a')).toBe('x.go')
    expect(relPath('/elsewhere/x.go', '/r/a')).toBe('/elsewhere/x.go')
  })
})

describe('a warning with a third session that touched nothing', () => {
  it('names only the one that collides, and moves the newer of the two', () => {
    const o: Overlap = {
      window_minutes: 30,
      sessions: { a: { checkout: '/r/caprock', with: [
        { session_id: 'b', name: 'Router', name_source: 'name', started_at: 200, files: ['/r/caprock/ui/app.tsx'] },
        { session_id: 'c', name: 'Notes', name_source: 'name', started_at: 300, files: [] },
      ] } },
    }
    const c = overlapChip(o, { session_id: 'a', started_at: 100 }, 'Login')!
    expect(c.summary).toBe("Edited by this session and Router in caprock in the last 30 minutes — one can write over the other's change.")
    expect(c.newer.session_id).toBe('b')
  })
})
