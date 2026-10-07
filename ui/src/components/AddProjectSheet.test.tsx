import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AddProjectSheet } from './AddProjectSheet'

const m = vi.hoisted(() => ({ add: vi.fn(), patch: vi.fn() }))
vi.mock('@/lib/projects', async (orig) => {
  const actual = await orig<typeof import('@/lib/projects')>()
  return { ...actual, projectsApi: { ...actual.projectsApi, add: m.add, patch: m.patch } }
})
vi.mock('./DirPicker', () => ({ DirPicker: () => null }))

beforeEach(() => {
  m.add.mockReset().mockResolvedValue({ project: { id: '9', root: '/dev/api', name: 'api', kind: 'repo' } })
  m.patch.mockReset().mockResolvedValue({ id: '9', root: '/dev/api', name: 'api', kind: 'repo' })
})

describe('adding a project', () => {
  it('sets its agents’ instructions as it is added, and only when there are some', async () => {
    const onAdded = vi.fn()
    render(<AddProjectSheet source="api" onClose={() => {}} onAdded={onAdded} onAddLocal={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('/Users/you/dev/project'), { target: { value: '/dev/api' } })
    fireEvent.change(screen.getByRole('textbox', { name: /Instructions for its agents/ }), { target: { value: 'Use the Makefile.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('9'))
    expect(m.patch).toHaveBeenCalledWith('9', { defaults: { system_prompt: 'Use the Makefile.' } })
  })

  it('touches no defaults when the field is left empty', async () => {
    const onAdded = vi.fn()
    render(<AddProjectSheet source="api" onClose={() => {}} onAdded={onAdded} onAddLocal={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('/Users/you/dev/project'), { target: { value: '/dev/api' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('9'))
    expect(m.patch).not.toHaveBeenCalled()
  })
})
