import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AddProjectSheet, cloneDest, repoName, requestFor } from './AddProjectSheet'

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
    fireEvent.change(screen.getByPlaceholderText('~/dev/project'), { target: { value: '/dev/api' } })
    fireEvent.click(screen.getByRole('button', { name: /Standing instructions/ }))
    fireEvent.change(screen.getByRole('textbox', { name: /Standing instructions/ }), { target: { value: 'Use the Makefile.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('9', undefined))
    expect(m.patch).toHaveBeenCalledWith('9', { defaults: { system_prompt: 'Use the Makefile.' } })
  })

  it('touches no defaults when the field is left empty', async () => {
    const onAdded = vi.fn()
    render(<AddProjectSheet source="api" onClose={() => {}} onAdded={onAdded} onAddLocal={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('~/dev/project'), { target: { value: '/dev/api' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('9', undefined))
    expect(m.patch).not.toHaveBeenCalled()
  })

  // Text typed as a first task must start an agent. It used to be typed into
  // the instructions field, which only shapes later sessions, and nothing ran.
  it('hands a first task to the caller with the project root', async () => {
    const onAdded = vi.fn()
    render(<AddProjectSheet source="api" onClose={() => {}} onAdded={onAdded} onAddLocal={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('~/dev/project'), { target: { value: '/dev/api' } })
    fireEvent.change(screen.getByRole('textbox', { name: /First task/ }), { target: { value: 'Read the repo.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('9', { root: '/dev/api', task: 'Read the repo.' }))
  })

  // Pasting a URL fills the destination the way `git clone` names it.
  it('names the clone folder after the repository until edited', () => {
    render(<AddProjectSheet source="api" defaultParent="/Users/me/dev" onClose={() => {}} onAdded={() => {}} onAddLocal={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Clone' }))
    fireEvent.change(screen.getByPlaceholderText(/github.com\/you\/repo/), { target: { value: 'git@github.com:donmiro/rateguard.git' } })
    expect(screen.getByDisplayValue('/Users/me/dev/rateguard')).toBeInTheDocument()
  })
})

describe('clone destination', () => {
  it('is the repository name without .git, under the default folder', () => {
    expect(repoName('git@github.com:donmiro/rateguard.git')).toBe('rateguard')
    expect(repoName('https://github.com/a/b/')).toBe('b')
    expect(cloneDest('https://github.com/a/b.git', '/Users/me/dev/')).toBe('/Users/me/dev/b')
    expect(cloneDest('https://github.com/a/b.git', '')).toBe('')
  })
  it('sends the whole destination as parent and name', () => {
    expect(requestFor('clone', '~/dev/x', 'git@h:a/b.git', '/d', 'op1')).toEqual({ clone: { url: 'git@h:a/b.git', parent: '~/dev', name: 'x' }, op_id: 'op1' })
    expect(requestFor('clone', '', 'git@h:a/b.git', '/d', 'op1')).toEqual({ clone: { url: 'git@h:a/b.git', parent: '/d', name: 'b' }, op_id: 'op1' })
  })
})
