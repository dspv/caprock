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
import { fireEvent, render, screen } from '@testing-library/react'
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

/**
 * Gemini CLI is a coding agent in the same shape as Claude Code, so it belongs
 * in this dialog. The two take different flags — no --session-id, model as -m,
 * no permission modes — so choosing one has to change what the request carries.
 */
describe('choosing an agent', () => {
  it('offers no picker when the machine has only Claude', async () => {
    render(<SpawnDialog available onClose={() => {}} initialCwd="/x" />)
    // A choice that fails on click is worse than no choice.
    expect(screen.queryByLabelText('Agent')).not.toBeInTheDocument()
  })

  it('switches the model list when Gemini is chosen', async () => {
    render(<SpawnDialog available geminiAvailable onClose={() => {}} initialCwd="/x" />)
    const agent = screen.getByLabelText<HTMLSelectElement>('Agent')
    fireEvent.change(agent, { target: { value: 'gemini' } })

    const model = screen.getByLabelText<HTMLSelectElement>(/Model/)
    const options = Array.from(model.options).map((o) => o.value)
    // Carrying a Claude model across would launch Gemini with a model it has
    // never heard of.
    expect(options.every((v) => v.startsWith('gemini-'))).toBe(true)
    expect(model.value).toMatch(/^gemini-/)
  })

  it('greys out permissions for Gemini, which has none', async () => {
    render(<SpawnDialog available geminiAvailable onClose={() => {}} initialCwd="/x" />)
    fireEvent.change(screen.getByLabelText<HTMLSelectElement>('Agent'), { target: { value: 'gemini' } })
    expect(screen.getByLabelText(/Permissions/)).toBeDisabled()
  })
})
