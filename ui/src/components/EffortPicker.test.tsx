/**
 * Effort at start, in the local New session dialog: the agent's own default
 * marked and passed as nothing, a different pick passed and kept per agent,
 * no control for an agent that takes no effort at launch.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effortDefault, effortToSend } from '@/lib/effort'
import type { CatalogEntry } from '@/lib/api'
import { SpawnDialog } from './SpawnDialog'

const spawn = vi.hoisted(() => vi.fn(async (_req: Record<string, unknown>) => ({ session_id: 's1', cwd: '/x' })))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      recentDirs: async () => [],
      browse: async () => ({ entries: [] }),
      status: () => new Promise(() => {}),
      spawn,
      settings: async () => ({ spawn_permission_mode: '' }),
      agentCatalog: async () => ({
        agents: [
          { id: 'claude', label: 'Claude Code', installed: true, ready: true, observed: true, prompt: true, models: [], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], model_efforts: { 'claude-opus-5-5': 'medium', 'claude-sonnet-5-5': 'low' } },
          { id: 'gemini', label: 'Gemini CLI', installed: true, ready: true, observed: true, prompt: true, models: [] },
        ],
      }),
    },
  }
})
vi.mock('@/lib/router', async (orig) => ({ ...(await orig<typeof import('@/lib/router')>()), navigate: () => {} }))

const group = () => screen.queryByRole('radiogroup', { name: 'Effort' })
const checked = () => within(group()!).getAllByRole('radio').find((r) => r.getAttribute('aria-checked') === 'true')?.getAttribute('data-effort')

describe('Effort in the New session dialog', () => {
  afterEach(() => {
    cleanup()
    spawn.mockClear()
    try { localStorage.clear() } catch { /* none */ }
  })
  const open = () => render(<SpawnDialog available agents={['claude', 'gemini']} onClose={() => {}} initialCwd="/x" />)

  it('marks the default for the model, follows the model, and passes nothing for it', async () => {
    open()
    await waitFor(() => expect(checked()).toBe('medium'))
    const def = within(group()!).getAllByRole('radio').filter((r) => r.hasAttribute('data-default'))
    expect(def.map((r) => r.getAttribute('data-effort'))).toEqual(['medium'])
    // One line in the segment; the default is named in the label row, the name stays "Effort".
    expect(def[0]!.textContent).toBe('Med')
    expect(document.querySelector('[data-effort-hint]')?.textContent).toBe(' · Med is default')
    fireEvent.change(screen.getByLabelText<HTMLSelectElement>(/Model/), { target: { value: 'claude-sonnet-5-5' } })
    expect(checked()).toBe('low')
    // No default known for this one: nothing marked, nothing checked.
    fireEvent.change(screen.getByLabelText<HTMLSelectElement>(/Model/), { target: { value: 'claude-haiku-5-5' } })
    expect(checked()).toBeUndefined()
    expect(document.querySelector('[data-effort-hint]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }))
    await waitFor(() => expect(spawn).toHaveBeenCalled())
    expect(spawn.mock.calls[0]![0]).not.toHaveProperty('effort')
  })

  it('passes a different pick and keeps it; picking the default again clears it', async () => {
    open()
    await waitFor(() => expect(checked()).toBe('medium'))
    fireEvent.click(within(group()!).getByRole('radio', { name: 'extra high' }))
    expect(checked()).toBe('xhigh')
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }))
    await waitFor(() => expect(spawn).toHaveBeenCalled())
    expect(spawn.mock.calls[0]![0]).toMatchObject({ effort: 'xhigh', model: 'claude-opus-5-5' })
    cleanup()
    open()
    await waitFor(() => expect(checked()).toBe('xhigh'))
    fireEvent.click(within(group()!).getByRole('radio', { name: 'medium, its default' }))
    expect(checked()).toBe('medium')
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }))
    await waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(spawn.mock.calls[1]![0]).not.toHaveProperty('effort')
  })

  it('is not there for an agent that takes no effort at launch', async () => {
    open()
    await waitFor(() => expect(group()).not.toBeNull())
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'gemini' } })
    await waitFor(() => expect(group()).toBeNull())
  })
})

describe('effortDefault', () => {
  const entry = (e: Partial<CatalogEntry>): CatalogEntry => ({ id: 'codex', label: 'Codex', installed: true, ready: true, observed: true, prompt: true, models: [], ...e })
  it('reads the agent-wide default first, then the model, then the agent default model', () => {
    expect(effortDefault(entry({ efforts: ['low'], effort_default: 'high', model_efforts: { a: 'low' } }), 'a')).toBe('high')
    expect(effortDefault(entry({ efforts: ['low'], model_efforts: { a: 'low' } }), 'a')).toBe('low')
    expect(effortDefault(entry({ efforts: ['low'], default: 'a', model_efforts: { a: 'low' } }), '')).toBe('low')
    expect(effortDefault(entry({ efforts: ['low'], model_efforts: { a: 'low' } }), 'b')).toBe('')
    expect(effortDefault(entry({ effort_default: 'high' }), 'a')).toBe('')
    expect(effortDefault(undefined, 'a')).toBe('')
  })
  it('sends only a pick that is not the default', () => {
    expect(effortToSend('', 'high')).toBeUndefined()
    expect(effortToSend('high', 'high')).toBeUndefined()
    expect(effortToSend('low', 'high')).toBe('low')
    expect(effortToSend('low', '')).toBe('low')
  })
})
