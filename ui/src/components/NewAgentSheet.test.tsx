/**
 * The New agent sheet from the keyboard alone (owner, 2026-10-07): arrows
 * change a select in place, ⌘↩ starts from anywhere in the sheet, Esc
 * cancels, and the keys are named in the sheet itself.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/lib/projects'

const spawn = vi.fn(async (_req: unknown) => ({ session_id: 'new-1', cwd: '/w/app' }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      status: async () => ({ version: 'v0.0.0', claude_available: true }),
      settings: async () => ({}),
      spawn: (req: unknown) => spawn(req),
    },
  }
})

import { NewAgentSheet } from './NewAgentSheet'

const projects = [
  { id: '1', root: '/w/app', name: 'app', kind: 'repo' },
  { id: '2', root: '/w/site', name: 'site', kind: 'repo' },
] as Project[]

function open(onClose = vi.fn()) {
  const onStarted = vi.fn()
  render(<NewAgentSheet projects={projects} projectId="1" onClose={onClose} onStarted={onStarted} />)
  return { onClose, onStarted }
}

beforeEach(() => { spawn.mockClear(); localStorage.clear() })

describe('the New agent sheet on the keyboard', () => {
  it('names its keys in the sheet', async () => {
    open()
    expect(await screen.findByLabelText(/Tab moves, arrows change a choice, Command Enter starts, Escape cancels/)).toBeTruthy()
  })

  it('changes a select with the arrow keys, in place', async () => {
    open()
    const model = await screen.findByLabelText<HTMLSelectElement>('Model')
    expect(model.value).toBe('claude-opus-5-5')
    fireEvent.keyDown(model, { key: 'ArrowDown' })
    expect(model.value).toBe('claude-sonnet-5-5')
    fireEvent.keyDown(model, { key: 'ArrowUp' })
    fireEvent.keyDown(model, { key: 'ArrowUp' })
    expect(model.value).toBe('claude-fable-5-1')
    // At the top it stays.
    fireEvent.keyDown(model, { key: 'ArrowUp' })
    expect(model.value).toBe('claude-fable-5-1')
    const project = screen.getByLabelText<HTMLSelectElement>('Project')
    fireEvent.keyDown(project, { key: 'ArrowDown' })
    expect(project.value).toBe('2')
  })

  it('starts with ⌘↩ from a select and from the footer, with what was chosen', async () => {
    open()
    const model = await screen.findByLabelText<HTMLSelectElement>('Model')
    fireEvent.keyDown(model, { key: 'ArrowDown' })
    fireEvent.keyDown(model, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    expect(spawn.mock.calls[0]![0]).toMatchObject({ cwd: '/w/app', model: 'claude-sonnet-5-5', permission_mode: 'bypassPermissions' })
  })

  it('starts with ⌘↩ while a footer button has focus', async () => {
    open()
    const cancel = await screen.findByRole('button', { name: 'Cancel' })
    cancel.focus()
    fireEvent.keyDown(cancel, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(spawn).toHaveBeenCalledOnce())
  })

  it('cancels with Esc', async () => {
    const { onClose } = open()
    await screen.findByLabelText('Model')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('opens on the first message, and its fields come in the stated Tab order', async () => {
    open()
    await screen.findByLabelText('Model')
    expect(document.activeElement).toBe(screen.getByPlaceholderText('What should it do?'))
    const order = Array.from(document.querySelectorAll<HTMLElement>('select, textarea, input, button'))
      .filter((el) => !el.hasAttribute('disabled'))
      .map((el) => el.getAttribute('aria-label') || (el.closest('label')?.querySelector('span')?.firstChild?.textContent ?? el.textContent ?? '').trim())
    expect(order).toEqual(['Project', 'Where', 'Model', 'Permissions', 'First message', 'Cancel', 'Start'])
  })
})
