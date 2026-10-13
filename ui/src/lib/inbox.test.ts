import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboxItem } from './api'

const state = vi.hoisted(() => ({ items: [] as unknown[], removed: [] as number[], calls: 0 }))
vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      inbox: async () => { state.calls++; return { items: state.items, max: 500 } },
      removeInbox: async (id: number) => { state.removed.push(id) },
    },
  }
})
const frames = vi.hoisted(() => ({ fn: null as null | ((f: { type: string }) => void) }))
vi.mock('./live', () => ({ live: { onFrame: (fn: (f: { type: string }) => void) => { frames.fn = fn; return () => { frames.fn = null } } } }))

import { inboxPrompt, inboxStart, inboxWhere, isInboxImage, useInbox } from './inbox'

const item = (more: Partial<InboxItem> = {}): InboxItem => ({ id: 1, text: 'look at this', files: [], created_at: 1, ...more })

beforeEach(() => { state.items = []; state.removed = []; state.calls = 0 })

describe('a chat from a saved item', () => {
  it('is sent the text, then each file quoted as a pasted path is', () => {
    expect(inboxPrompt(item({ files: ['/d/inbox/a b/IMG 1.png', '/d/inbox/c/x.pdf'] }))).toBe('look at this\n\n"/d/inbox/a b/IMG 1.png" "/d/inbox/c/x.pdf"')
    expect(inboxPrompt(item({ text: '  ', files: ['/d/inbox/c/x.png'] }))).toBe('"/d/inbox/c/x.png"')
  })

  it('starts in the project the item was saved to, else in a chat folder', () => {
    expect(inboxStart(item({ project_id: 3, project_root: '/work/alpha', project_name: 'alpha' }))).toEqual({ prompt: 'look at this', cwd: '/work/alpha' })
    expect(inboxStart(item())).toEqual({ prompt: 'look at this' })
  })

  it('says where it was saved', () => {
    expect(inboxWhere(item())).toBe('Inbox')
    expect(inboxWhere(item({ project_id: 3, project_name: 'alpha' }))).toBe('alpha')
  })

  it('previews images only', () => {
    expect(isInboxImage('/x/IMG.JPG')).toBe(true)
    expect(isInboxImage('/x/page.html')).toBe(false)
  })
})

describe('useInbox', () => {
  it('reads the list, again on an inbox frame, and drops a deleted item at once', async () => {
    state.items = [item({ id: 2 }), item({ id: 1 })]
    const { result } = renderHook(() => useInbox())
    await waitFor(() => expect(result.current.items).toHaveLength(2))
    expect(result.current.loaded).toBe(true)

    state.items = [item({ id: 3 }), ...state.items]
    act(() => frames.fn?.({ type: 'inbox' }))
    await waitFor(() => expect(result.current.items).toHaveLength(3))

    await act(() => result.current.remove(2))
    expect(state.removed).toEqual([2])
    expect(result.current.items.map((i) => i.id)).toEqual([3, 1])
  })

  it('ignores other frames', async () => {
    renderHook(() => useInbox())
    await waitFor(() => expect(state.calls).toBe(1))
    act(() => frames.fn?.({ type: 'session' }))
    expect(state.calls).toBe(1)
  })
})
