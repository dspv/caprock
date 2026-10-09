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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GEMINI_MODELS, MODELS, SpawnDialog } from './SpawnDialog'

const spawn = vi.hoisted(() => vi.fn(async () => ({ session_id: 's1', cwd: '/x' })))
// What the status answers: nothing, unless a test says otherwise.
const statusAnswer = vi.hoisted(() => ({ next: (): Promise<unknown> => new Promise(() => {}) }))
// The Settings preference for new sessions; '' is not set.
const pref = vi.hoisted(() => ({ mode: '' }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      recentDirs: async () => [],
      browse: async () => ({ entries: [] }),
      // The status is passed in by every test below; a fetch here would only
      // race it.
      status: () => statusAnswer.next(),
      spawn,
      settings: async () => ({ spawn_permission_mode: pref.mode }),
      // The shape GET /v1/agents/models answers for Codex, from a real
      // models_cache.json (codex-cli 0.160.0): the configured default first.
      agentModels: async () => ({
        agent: 'codex',
        default: 'gpt-6-astra',
        models: [
          { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
          { id: 'gpt-6-sol', label: 'GPT-6-Sol' },
        ],
      }),
    },
  }
})

vi.mock('@/lib/router', async (orig) => ({ ...(await orig<typeof import('@/lib/router')>()), navigate: () => {} }))

/** Every permission mode `claude --help` accepts. Anything the dialog offers
 *  must be in here, or the spawn fails at the binary. */
const CLAUDE_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']

describe('SpawnDialog', () => {
  const open = () => render(<SpawnDialog available onClose={() => {}} initialCwd="/x" />)

  it('starts on a real model and permission mode, not an empty default', () => {
    open()
    expect(screen.getByLabelText<HTMLSelectElement>(/Model/).value).toBe('claude-opus-5-5')
    // ADR-043 (owner, 2026-10-08): a new install asks before running commands.
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
  // Settings → New sessions: someone who always runs with permissions
  // skipped should not have to pick it in every dialog.
  it('opens on the mode Settings names for new sessions', async () => {
    pref.mode = 'bypassPermissions'
    try {
      open()
      await waitFor(() => expect(screen.getByLabelText<HTMLSelectElement>(/Permissions/).value).toBe('bypassPermissions'))
    } finally {
      pref.mode = ''
    }
  })

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
    'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5',
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

  // The list stopped at Opus 5 while Opus 5.5 was out, and the owner picked
  // "Opus 5" believing it was the newest. A release lands in pricing.json
  // first (rule 8), so a family whose newest priced model is not offered here
  // fails the build until it is — after the id has answered the real CLI.
  it('offers the newest priced model of every Claude family', () => {
    const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
    const table = JSON.parse(readFileSync(join(root, 'pricing', 'pricing.json'), 'utf8')) as { models: { id: string }[] }
    const version = (id: string) => id.split('-').slice(2).map(Number)
    const newer = (a: number[], b: number[]) => (a[0]! - b[0]!) || ((a[1] ?? 0) - (b[1] ?? 0))
    // Mythos is priced and deliberately not offered: the real binary refuses it.
    for (const family of ['fable', 'opus', 'sonnet', 'haiku']) {
      const ids = table.models.map((m) => m.id).filter((id) => new RegExp(`^claude-${family}-\\d+(-\\d)?$`).test(id))
      const newest = ids.sort((a, b) => newer(version(b), version(a)))[0]
      expect(newest, family).toBeDefined()
      expect(REAL_CLAUDE_MODELS, family).toContain(newest)
    }
  })

  it('names the exact version in every Claude label', () => {
    render(<SpawnDialog available onClose={() => {}} initialCwd="/x" />)
    const labels = Array.from(screen.getByLabelText<HTMLSelectElement>(/Model/).options).map((o) => o.text)
    expect(labels.map((l) => l.split(' · ')[0])).toEqual(['Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'])
  })

  it('orders the Claude models by capability, priciest first', () => {
    render(<SpawnDialog available onClose={() => {}} initialCwd="/x" />)
    const offered = Array.from(screen.getByLabelText<HTMLSelectElement>(/Model/).options).map((o) => o.value)
    // pricing.json, per million output tokens: Fable 5.1 50, Opus 5.5 20,
    // Sonnet 5.5 10, Haiku 5.5 0.5. The list is a ranking, so it has to match the money.
    expect(offered).toEqual(REAL_CLAUDE_MODELS)
  })
})

/**
 * Codex and OpenCode are started like Claude Code — a TUI in a PTY — and take
 * their own flags. The picker offers only what the daemon found, remembers the
 * last choice for this viewer, and each agent's model control is its own.
 */
describe('Codex and OpenCode', () => {
  beforeEach(() => {
    localStorage.clear()
    spawn.mockClear()
  })
  const all = ['claude', 'codex', 'opencode', 'gemini'] as const
  const open = () => render(<SpawnDialog available agents={[...all]} onClose={() => {}} initialCwd="/x" />)

  it('offers every agent the daemon found, and only those', () => {
    render(<SpawnDialog available agents={['claude', 'opencode']} onClose={() => {}} initialCwd="/x" />)
    const offered = Array.from(screen.getByLabelText<HTMLSelectElement>('Agent').options).map((o) => o.value)
    expect(offered).toEqual(['claude', 'opencode'])
  })

  it("offers Codex's own catalog, starting on the user's configured default", async () => {
    open()
    fireEvent.change(screen.getByLabelText<HTMLSelectElement>('Agent'), { target: { value: 'codex' } })
    await waitFor(() => expect(screen.getByLabelText<HTMLSelectElement>(/Model/).options.length).toBe(2))
    const model = screen.getByLabelText<HTMLSelectElement>(/Model/)
    // "" is "what your config says": the default is not restated as a flag.
    expect(model.value).toBe('')
    expect(model.options[0]!.textContent).toBe('gpt-6-astra (default)')
    expect(Array.from(model.options).map((o) => o.value)).toEqual(['', 'gpt-6-sol'])
  })

  it('takes an OpenCode model as provider/model text', () => {
    open()
    fireEvent.change(screen.getByLabelText<HTMLSelectElement>('Agent'), { target: { value: 'opencode' } })
    const model = screen.getByLabelText<HTMLInputElement>(/Model/)
    expect(model.tagName).toBe('INPUT')
    expect(model.placeholder).toMatch(/OpenCode default/)
  })

  it('labels each mode with what it becomes in that agent', () => {
    open()
    fireEvent.change(screen.getByLabelText<HTMLSelectElement>('Agent'), { target: { value: 'opencode' } })
    const labels = Array.from(screen.getByLabelText<HTMLSelectElement>(/Permissions/).options).map((o) => o.textContent)
    expect(labels).toContain("Bypass · OpenCode's own rules")
  })

  it('words bypass as --auto when OpenCode 2 is installed', async () => {
    statusAnswer.next = async () => ({ claude_available: true, opencode_available: true, opencode_version: '2.0.26' })
    try {
      open()
      fireEvent.change(screen.getByLabelText<HTMLSelectElement>('Agent'), { target: { value: 'opencode' } })
      await waitFor(() => {
        const labels = Array.from(screen.getByLabelText<HTMLSelectElement>(/Permissions/).options).map((o) => o.textContent)
        expect(labels).toContain("Bypass · approves all it doesn't deny")
      })
    } finally {
      statusAnswer.next = () => new Promise(() => {})
    }
  })

  it('remembers the last agent chosen, for this viewer', () => {
    const first = open()
    fireEvent.change(screen.getByLabelText<HTMLSelectElement>('Agent'), { target: { value: 'opencode' } })
    first.unmount()
    open()
    expect(screen.getByLabelText<HTMLSelectElement>('Agent').value).toBe('opencode')
  })

  it('falls back when the remembered agent is gone from this machine', () => {
    localStorage.setItem('caprock.spawn.agent', 'codex')
    render(<SpawnDialog available agents={['claude', 'gemini']} onClose={() => {}} initialCwd="/x" />)
    expect(screen.getByLabelText<HTMLSelectElement>('Agent').value).toBe('claude')
  })

  it("sends the agent, and the mode in Claude's words for the daemon to translate", async () => {
    open()
    fireEvent.change(screen.getByLabelText<HTMLSelectElement>('Agent'), { target: { value: 'codex' } })
    fireEvent.click(screen.getByText('Start session'))
    await waitFor(() => expect(spawn).toHaveBeenCalled())
    expect(spawn.mock.calls[0]).toEqual([{ cwd: '/x', agent: 'codex', permission_mode: 'acceptEdits' }])
  })
})

/**
 * On a controller phone (ADR-034): the full dialog, and bypass behind one
 * inline confirm, because nobody may be at the machine to see what it does.
 */
describe('on a paired phone', () => {
  beforeEach(async () => {
    localStorage.clear()
    spawn.mockClear()
    const { setDeviceToken } = await import('@/lib/api')
    setDeviceToken('tok')
  })
  const open = () => render(<SpawnDialog available onClose={() => {}} initialCwd="/home/me/fresh" />)

  it('offers the folder browser and bypass, as the machine does', async () => {
    open()
    expect(await screen.findByRole('button', { name: 'Browse' })).toBeTruthy()
    const modes = Array.from(screen.getByLabelText<HTMLSelectElement>(/Permissions/).options).map((o) => o.value)
    expect(modes).toContain('bypassPermissions')
  })

  it('asks once before starting in bypass, inline', async () => {
    open()
    // Picked on the phone, bypass is still confirmed there.
    fireEvent.change(screen.getByLabelText<HTMLSelectElement>(/Permissions/), { target: { value: 'bypassPermissions' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }))
    expect(screen.getByText("The agent won't ask before running commands or editing files. Start?")).toBeTruthy()
    expect(spawn).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Start in bypass' }))
    await waitFor(() => expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/home/me/fresh', permission_mode: 'bypassPermissions' })))
  })

  it('starts a mode that asks without a confirm', async () => {
    open()
    fireEvent.change(screen.getByLabelText<HTMLSelectElement>(/Permissions/), { target: { value: 'acceptEdits' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }))
    await waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    expect(screen.queryByText(/won't ask/)).toBeNull()
  })
})

describe('on a phone', () => {
  it('gives every footer button and the close button a 44 px target', () => {
    render(<SpawnDialog available onClose={() => {}} />)
    for (const name of ['Cancel', 'Start session']) {
      expect(screen.getByRole('button', { name }).className).toContain('max-sm:min-h-11')
    }
    expect(screen.getByRole('button', { name: 'Close' }).className).toContain('max-sm:h-11')
  })
})

/** Owner, 2026-10-09: the New agent sheet's half-width Model select cut
 *  "gpt-6.1-sol · your Codex def…" off mid-word. Every label fits it. */
describe('model labels fit a half-width select', () => {
  it('keeps every Claude and Gemini label within 25 characters', () => {
    for (const [, label] of [...MODELS, ...GEMINI_MODELS]) expect(label.length, label).toBeLessThanOrEqual(25)
  })
})
