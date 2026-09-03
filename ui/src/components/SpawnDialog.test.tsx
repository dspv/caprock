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
/** Ids that answered a real prompt on a real key and that pricing.json can
 *  cost. Verified against Google, not against the CLI bundle: the bundle also
 *  names models Google has since closed to new keys, and models a free key is
 *  quota-barred from calling. */
const REAL_GEMINI_MODELS = [
  'gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.5-flash',
]

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

  it('keeps permissions live for Gemini, which spells them differently', async () => {
    // An earlier version greyed this out on the belief that Gemini had no
    // permission modes. It has four — default, auto_edit, yolo, plan — and the
    // daemon maps onto them, so disabling the control threw away a real choice.
    render(<SpawnDialog available geminiAvailable onClose={() => {}} initialCwd="/x" />)
    fireEvent.change(screen.getByLabelText<HTMLSelectElement>('Agent'), { target: { value: 'gemini' } })
    expect(screen.getByLabelText(/Permissions/)).not.toBeDisabled()
  })

  it('offers only models the CLI and the pricing table both know', () => {
    // Two of the three ids in the first version were written from memory and
    // do not exist: the session opens a terminal, then dies at the binary.
    // Every id here was checked against the installed CLI and pricing.json.
    render(<SpawnDialog available geminiAvailable onClose={() => {}} initialCwd="/x" />)
    fireEvent.change(screen.getByLabelText<HTMLSelectElement>('Agent'), { target: { value: 'gemini' } })
    const offered = Array.from(screen.getByLabelText<HTMLSelectElement>(/Model/).options).map((o) => o.value)
    for (const id of offered) expect(REAL_GEMINI_MODELS).toContain(id)
  })

  /** Claude ids that answered a real prompt from the installed `claude` on this
   *  machine and that pricing.json can cost. `claude-mythos-5` is in
   *  pricing.json and is deliberately absent: the real binary answers "it may
   *  not exist or you may not have access to it". Being priceable says we can
   *  cost a model, never that the account can call it. */
  const REAL_CLAUDE_MODELS = [
    'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5',
  ]

  it('offers every Claude model the CLI can actually run', () => {
    render(<SpawnDialog available onClose={() => {}} initialCwd="/x" />)
    const offered = Array.from(screen.getByLabelText<HTMLSelectElement>(/Model/).options).map((o) => o.value)
    // Nothing invented: a session would open a terminal and die at the binary.
    for (const id of offered) expect(REAL_CLAUDE_MODELS).toContain(id)
    // And nothing missing. Fable 5 was absent while `claude --help` named it
    // alongside opus and sonnet — the most capable model on the machine simply
    // could not be picked, which is the half a "no invented ids" test misses.
    for (const id of REAL_CLAUDE_MODELS) expect(offered).toContain(id)
  })

  it('orders the Claude models by capability, priciest first', () => {
    render(<SpawnDialog available onClose={() => {}} initialCwd="/x" />)
    const offered = Array.from(screen.getByLabelText<HTMLSelectElement>(/Model/).options).map((o) => o.value)
    // pricing.json, per million output tokens: Fable 50, Opus 25, Sonnet 15,
    // Haiku 5. The list is a ranking, so it has to match the money.
    expect(offered).toEqual(REAL_CLAUDE_MODELS)
  })
})
