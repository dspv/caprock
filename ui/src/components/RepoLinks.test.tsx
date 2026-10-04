import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProjectRepoLinks, RepoLinks } from './RepoLinks'
import type { SessionPR } from '@/lib/api'

const pr = (n: number, over: Partial<SessionPR> = {}): SessionPR => ({
  session_id: 's', url: `https://github.com/o/r/pull/${n}`, number: n, title: `change ${n}`, last_at: n, ...over,
})

describe('RepoLinks', () => {
  it('opens the branch page in a new tab, and the latest PR not known merged', () => {
    render(
      <RepoLinks
        cwd="/r"
        repo={{ root: '/r', url: 'https://github.com/o/r', branch: 'fix/x', branch_url: 'https://github.com/o/r/tree/fix/x' }}
        prs={[pr(9, { merged_at: 5 }), pr(8)]}
      />,
    )
    const repo = screen.getByRole('link', { name: 'Open repo ↗' })
    expect(repo.getAttribute('href')).toBe('https://github.com/o/r/tree/fix/x')
    expect(repo.getAttribute('target')).toBe('_blank')
    expect(repo.getAttribute('rel')).toContain('noopener')
    // #9 is recorded as merged, so the button goes to #8.
    expect(screen.getByRole('link', { name: 'Open PR #8 ↗' }).getAttribute('href')).toBe('https://github.com/o/r/pull/8')
    expect(screen.getByText('merged')).toBeTruthy()
  })

  it('shows three PRs and the rest behind +N more', () => {
    render(<RepoLinks cwd="/r" repo={{ root: '/r', url: 'https://github.com/o/r' }} prs={[pr(5), pr(4), pr(3), pr(2), pr(1)]} />)
    expect(screen.queryByText('#1 change 1')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '+2 more' }))
    expect(screen.getByText('#1 change 1')).toBeTruthy()
  })

  it('without a remote, shows the path to copy rather than a link that opens nothing', () => {
    render(<RepoLinks cwd="/home/u/proj" repo={{ root: '/home/u/proj' }} prs={[]} />)
    expect(screen.queryByRole('link', { name: 'Open repo ↗' })).toBeNull()
    expect(screen.getByText('/home/u/proj')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy path' })).toBeTruthy()
  })
})

describe('ProjectRepoLinks', () => {
  it('links the repository and the last PR, and says merged only when recorded', () => {
    const { rerender } = render(<ProjectRepoLinks url="https://github.com/o/r" pr={pr(12)} />)
    expect(screen.getByRole('link', { name: 'Open repo ↗' }).getAttribute('href')).toBe('https://github.com/o/r')
    expect(screen.getByRole('link', { name: /last PR #12/ }).textContent).not.toContain('merged')
    rerender(<ProjectRepoLinks url="https://github.com/o/r" pr={pr(12, { merged_at: 1 })} />)
    expect(screen.getByRole('link', { name: /last PR #12/ }).textContent).toContain('merged')
  })
})
