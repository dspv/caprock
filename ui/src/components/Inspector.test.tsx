import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/lib/api'

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      permission: async () => ({ permission: null }),
      diff: async () => ({
        root: '/w/app', branch: 'main', stat: '',
        files: [
          { path: 'ui/src/App.tsx', status: 'modified', additions: 2, deletions: 1, patch: '@@ -10,3 +12,4 @@\n-a\n+b' },
          { path: 'old.txt', status: 'deleted', additions: 0, deletions: 3 },
        ],
      }),
    },
  }
})

import { Inspector } from './Inspector'

const s = { session_id: 's1', kind: 'shell', cwd: '/w/app/wt/feature', status: 'active', owned: true } as unknown as SessionSummary
const editors = { editors: [{ id: 'cursor', name: 'Cursor' }], preferred: 'cursor' }

describe('the inspector’s Open in editor (F18)', () => {
  it('opens the session’s folder, and a changed file at its first changed line', async () => {
    const open = vi.fn()
    render(<Inspector session={s} sessionId="s1" hasPermission={false} onClose={() => {}} onDetach={() => {}} editors={editors} onOpenInEditor={open} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in Cursor' }))
    expect(open).toHaveBeenLastCalledWith('/w/app/wt/feature', 'the folder')
    fireEvent.click(await screen.findByTitle('Open ui/src/App.tsx in Cursor'))
    expect(open).toHaveBeenLastCalledWith('/w/app/ui/src/App.tsx', 'ui/src/App.tsx', undefined, 12)
    // A deleted file has nothing to open.
    expect(screen.queryByTitle('Open old.txt in Cursor')).toBeNull()
  })

  it('offers nothing without an editor', () => {
    render(<Inspector session={s} sessionId="s1" hasPermission={false} onClose={() => {}} onDetach={() => {}} />)
    expect(screen.queryByRole('button', { name: /Open in/ })).toBeNull()
  })
})
