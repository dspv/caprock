import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectInstructions } from './ProjectInstructions'
import type { Project } from '@/lib/projects'

const m = vi.hoisted(() => ({ patch: vi.fn(), read: vi.fn() }))
vi.mock('@/lib/projects', async (orig) => {
  const actual = await orig<typeof import('@/lib/projects')>()
  return { ...actual, projectsApi: { ...actual.projectsApi, patch: m.patch } }
})
vi.mock('@/lib/files', async (orig) => {
  const actual = await orig<typeof import('@/lib/files')>()
  return { ...actual, filesApi: { ...actual.filesApi, read: m.read } }
})

const project: Project = { id: '7', root: '/r', name: 'api', kind: 'repo', defaults: { model: 'claude-opus-5-5' } }

beforeEach(() => {
  m.read.mockReset().mockImplementation(async (_ref: unknown, path: string) => ({ path, size: 1, text: `text of ${path}`, lang: 'markdown' }))
  m.patch.mockReset().mockImplementation(async (id: string, p: Partial<Project>) => ({ ...project, id, ...p }))
})

describe('project instructions', () => {
  it('says there are none, and saves new ones keeping the other defaults', async () => {
    render(<ProjectInstructions project={project} />)
    expect(screen.getByLabelText('Project instructions state')).toHaveTextContent('None')
    expect(screen.getByText(/set them once, and every new session here starts with them/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add project instructions' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Project instructions' }), { target: { value: '  Use the Makefile.  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('7', { defaults: { model: 'claude-opus-5-5', system_prompt: 'Use the Makefile.' } }))
  })

  it('shows what is set, and clearing it removes only the instructions', async () => {
    render(<ProjectInstructions project={{ ...project, defaults: { model: 'x', system_prompt: 'Answer in English.' } }} />)
    expect(screen.getByText('Answer in English.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit project instructions' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Project instructions' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('7', { defaults: { model: 'x' } }))
  })

  it('says at a glance whether instructions are set, and shows them whole on a click', () => {
    render(<ProjectInstructions project={{ ...project, defaults: { system_prompt: 'One.\nTwo.\nThree.' } }} />)
    expect(screen.getByLabelText('Project instructions state')).toHaveTextContent('Set · 3 lines')
    fireEvent.click(screen.getByRole('button', { name: 'Show project instructions' }))
    expect(screen.getByLabelText('Project instructions text')).toHaveTextContent('One. Two. Three.')
  })

  it('names the repository’s own files and reads one on a click, a member’s included', async () => {
    render(<ProjectInstructions project={{ ...project, instruction_files: ['CLAUDE.md', 'web/AGENTS.md'] }} />)
    expect(screen.getByLabelText('Project instructions state')).toHaveTextContent('None')
    expect(screen.getByLabelText('Repository instruction files')).toHaveTextContent('CLAUDE.md · AGENTS.md in web')
    fireEvent.click(screen.getByRole('button', { name: 'Show the repository’s files' }))
    expect(await screen.findByLabelText('CLAUDE.md text')).toHaveTextContent('text of CLAUDE.md')
    expect(m.read).toHaveBeenCalledWith({ projectId: '7', worktree: '' }, 'CLAUDE.md')
    fireEvent.click(screen.getByRole('tab', { name: 'web/AGENTS.md' }))
    expect(await screen.findByLabelText('web/AGENTS.md text')).toHaveTextContent('text of web/AGENTS.md')
  })

  it('says when the repository has none, and when the agent takes none of Caprock’s', () => {
    render(<ProjectInstructions project={project} agent="gemini" />)
    expect(screen.getByLabelText('Repository instruction files')).toHaveTextContent('no CLAUDE.md or AGENTS.md')
    expect(screen.getByText(/Not given to this agent/)).toBeTruthy()
  })
})
