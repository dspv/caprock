/**
 * The new-session dialog.
 *
 * It asked five questions before it would start anything, and answered none of
 * them itself: model and permission mode both opened on an empty "default"
 * that says nothing about what is about to run. Worse, "default" is not a
 * permission mode Claude Code accepts — `claude --help` lists acceptEdits,
 * auto, bypassPermissions, manual, dontAsk and plan — so the dialog could send
 * the binary a value it rejects.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SpawnDialog } from './SpawnDialog'

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, recentDirs: async () => [], browse: async () => ({ entries: [] }) } }
})

/** Every permission mode `claude --help` accepts. Anything the dialog offers
 *  must be in here, or the spawn fails at the binary. */
const CLAUDE_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']

describe('SpawnDialog', () => {
  const open = () => render(<SpawnDialog available onClose={() => {}} initialCwd="/x" />)

  it('starts on a real model and permission mode, not an empty default', () => {
    open()
    expect(screen.getByLabelText<HTMLSelectElement>(/Model/).value).toBe('claude-opus-5')
    expect(screen.getByLabelText<HTMLSelectElement>(/Permissions/).value).toBe('acceptEdits')
  })

  it('only offers permission modes the claude binary accepts', () => {
    open()
    const select = screen.getByLabelText<HTMLSelectElement>(/Permissions/)
    const offered = Array.from(select.options).map((o) => o.value)
    expect(offered.length).toBeGreaterThan(0)
    for (const mode of offered) expect(CLAUDE_MODES).toContain(mode)
  })

  // Worktree and "create the directory" matter to a handful of runs and to
  // nobody else; every field on screen is a decision asked of someone who
  // wanted to press one button.
  it('keeps the rare settings folded away', () => {
    open()
    expect(screen.getByText('Advanced')).toBeInTheDocument()
    expect(screen.getByText(/create the directory/).closest('details')).not.toBeNull()
    expect(screen.getByText(/Git worktree/).closest('details')).not.toBeNull()
  })
})
