import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectInstructions } from './ProjectInstructions'
import type { Project } from '@/lib/projects'

const m = vi.hoisted(() => ({ patch: vi.fn() }))
vi.mock('@/lib/projects', async (orig) => {
  const actual = await orig<typeof import('@/lib/projects')>()
  return { ...actual, projectsApi: { ...actual.projectsApi, patch: m.patch } }
})

const project: Project = { id: '7', root: '/r', name: 'api', kind: 'repo', defaults: { model: 'claude-opus-5-5' } }

beforeEach(() => { m.patch.mockReset().mockImplementation(async (id: string, p: Partial<Project>) => ({ ...project, id, ...p })) })

describe('project instructions', () => {
  it('says there are none, and saves new ones keeping the other defaults', async () => {
    render(<ProjectInstructions project={project} />)
    expect(screen.getByText(/None — set them once/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Project instructions' }), { target: { value: '  Use the Makefile.  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('7', { defaults: { model: 'claude-opus-5-5', system_prompt: 'Use the Makefile.' } }))
  })

  it('shows what is set, and clearing it removes only the instructions', async () => {
    render(<ProjectInstructions project={{ ...project, defaults: { model: 'x', system_prompt: 'Answer in English.' } }} />)
    expect(screen.getByText('Answer in English.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Project instructions' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('7', { defaults: { model: 'x' } }))
  })
})
