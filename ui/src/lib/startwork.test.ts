/**
 * A clone from the phone that survives the phone's connection (WP-15; Phone
 * v2 definition of done item 8): the request is kept before it is sent, a
 * lost answer is asked about rather than resent blindly, the same op_id is
 * sent every time, and a refusal is shown, not retried.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { live } from './live'
import type { AddProjectRequest, OpFrame } from './projects'
import {
  CloneTracker, PENDING_CLONE_KEY, isPhoneCloneURL, loadPendingClone, mergeOp, repoName, savePendingClone,
  type CloneView, type PendingClone,
} from './startwork'

const pending: PendingClone = { op_id: 'op-1', url: 'https://github.com/octocat/Hello-World', parent: '/Users/me/dev', started_at: Date.now() }
const running = (progress: number): OpFrame => ({ op_id: 'op-1', state: 'running', phase: 'Receiving objects', progress })
const done: OpFrame = { op_id: 'op-1', state: 'done', progress: 100, dest: '/Users/me/dev/Hello-World', project_id: 7 }

describe('what a phone may clone', () => {
  it('takes https:// and git@ and nothing else', () => {
    for (const ok of ['https://github.com/octocat/Hello-World', 'https://gitlab.com/a/b.git', 'git@github.com:octocat/Hello-World.git']) {
      expect(isPhoneCloneURL(ok)).toBe(true)
    }
    for (const bad of ['http://github.com/a/b', 'file:///Users/me/repo.git', '/Users/me/repo', 'ssh://git@github.com/a/b', 'ext::sh -c x', '--upload-pack=x', 'alice@host:repo', 'https://github.com', 'git@github.com:a b', '']) {
      expect(isPhoneCloneURL(bad)).toBe(false)
    }
  })
  it('names the folder as git will', () => {
    expect(repoName('https://github.com/octocat/Hello-World')).toBe('Hello-World')
    expect(repoName('git@github.com:octocat/Hello-World.git')).toBe('Hello-World')
    expect(repoName('https://gitlab.com/group/sub/repo.git/')).toBe('repo')
  })
})

describe('the pending clone', () => {
  beforeEach(() => localStorage.clear())
  it('survives a reload for an hour, and no longer', () => {
    savePendingClone(pending)
    expect(loadPendingClone()).toEqual(pending)
    expect(loadPendingClone(pending.started_at + 61 * 60 * 1000)).toBeNull()
    localStorage.setItem(PENDING_CLONE_KEY, '{nonsense')
    expect(loadPendingClone()).toBeNull()
  })
  it('never lets a late running frame undo a finished clone', () => {
    expect(mergeOp(done, running(40)).state).toBe('done')
    expect(mergeOp(running(10), running(40)).progress).toBe(40)
  })
})

describe('CloneTracker', () => {
  let views: CloneView[]
  let tracker: CloneTracker | null
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    savePendingClone(pending)
    views = []
    tracker = null
  })
  afterEach(() => {
    tracker?.stop()
    vi.useRealTimers()
  })
  const last = () => views[views.length - 1]
  const follow = (apis: ConstructorParameters<typeof CloneTracker>[2]) => {
    tracker = new CloneTracker(pending, (v) => views.push(v), apis)
    tracker.start()
  }

  it('starts the clone once, follows its frames and forgets it when done', async () => {
    const add = vi.fn(async (_req: AddProjectRequest) => ({ op: running(0), existing: false }))
    follow({ ops: async () => [], add })
    await vi.advanceTimersByTimeAsync(0)
    expect(add).toHaveBeenCalledTimes(1)
    expect(add.mock.calls[0]![0]).toEqual({ clone: { url: pending.url, parent: pending.parent }, op_id: 'op-1' })
    live.handle({ type: 'op', data: running(45) })
    expect(last()).toMatchObject({ phase: 'running', op: { progress: 45 } })
    live.handle({ type: 'op', data: { ...done, op_id: 'someone-else' } })
    expect(last()?.phase).toBe('running')
    live.handle({ type: 'op', data: done })
    expect(last()).toMatchObject({ phase: 'done', op: { dest: '/Users/me/dev/Hello-World' } })
    expect(loadPendingClone()).toBeNull()
  })

  it('dropped mid-clone: the answer is lost, the daemon is asked, and nothing is cloned twice', async () => {
    let serverHasIt = false
    const add = vi.fn(async () => {
      serverHasIt = true // the request reached the daemon…
      throw new TypeError('Load failed') // …and the answer never came back
    })
    const ops = vi.fn(async () => {
      if (!navigatorOnline) throw new TypeError('Load failed')
      return serverHasIt ? [running(80)] : []
    })
    let navigatorOnline = true
    follow({ ops, add })
    await vi.advanceTimersByTimeAsync(0)
    expect(last()?.phase).toBe('offline')
    // Still offline for a while: retries fail, with backoff, and never resend.
    navigatorOnline = false
    await vi.advanceTimersByTimeAsync(20_000)
    expect(last()?.phase).toBe('offline')
    // The network is back: the live feed's hello makes it ask at once.
    navigatorOnline = true
    live.handle({ type: 'hello', data: { server_time: Date.now() } })
    await vi.advanceTimersByTimeAsync(0)
    expect(last()).toMatchObject({ phase: 'running', op: { progress: 80 } })
    expect(add).toHaveBeenCalledTimes(1)
    // It finished while nobody watched: the next look says so.
    ops.mockResolvedValue([done])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(last()?.phase).toBe('done')
    expect(add).toHaveBeenCalledTimes(1)
  })

  it('shows a refusal instead of retrying it', async () => {
    const add = vi.fn(async () => { throw new ApiError(400, '400 Bad Request', { error: 'a phone clones an https:// or git@host:owner/repo address' }) })
    follow({ ops: async () => [], add })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(last()).toMatchObject({ phase: 'failed', error: 'a phone clones an https:// or git@host:owner/repo address' })
    expect(add).toHaveBeenCalledTimes(1)
    expect(loadPendingClone()).toBeNull()
  })

  it("says git's own words when the clone fails on the machine", async () => {
    follow({ ops: async () => [{ op_id: 'op-1', state: 'failed', error: 'fatal: repository not found' }], add: vi.fn() })
    await vi.advanceTimersByTimeAsync(0)
    expect(last()).toMatchObject({ phase: 'failed', error: 'fatal: repository not found' })
  })
})
