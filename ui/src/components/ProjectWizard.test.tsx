/**
 * New project, tap-tap-tap: a folder, what is there, done — each step one
 * click or one Enter.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/lib/projects'

const m = vi.hoisted(() => ({ add: vi.fn(), patch: vi.fn(), scan: vi.fn(), browse: vi.fn(), pick: vi.fn(), tauri: { on: false } }))
vi.mock('@/lib/projects', async (orig) => {
  const actual = await orig<typeof import('@/lib/projects')>()
  return { ...actual, projectsApi: { ...actual.projectsApi, add: m.add, patch: m.patch, scan: m.scan } }
})
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      settings: async () => ({ default_folder: '~/dev' }),
      recentDirs: async () => [],
      localRepos: async () => ({ root: '/Users/me/dev', home: '/Users/me', scanned_at: 0, repos: [] }),
      browse: (dir: string) => m.browse(dir),
    },
  }
})
vi.mock('@/lib/appmode', async (orig) => ({ ...(await orig<typeof import('@/lib/appmode')>()), isMacPlatform: () => true, isTauri: () => m.tauri.on }))
vi.mock('@/lib/shell', async (orig) => {
  const actual = await orig<typeof import('@/lib/shell')>()
  return { ...actual, shell: { ...actual.shell, pickFolder: (s?: string) => m.pick(s) } }
})

import { ProjectWizard } from './ProjectWizard'

const THREE = {
  root: '/Users/me/work',
  repos: [
    { path: '/Users/me/work/api', name: 'api', instruction_files: ['CLAUDE.md'] },
    { path: '/Users/me/work/web', name: 'web' },
    { path: '/Users/me/work/infra', name: 'infra', project_id: 4, project_name: 'infra' },
  ],
}
const ONE = {
  root: '/Users/me/dev/site',
  repo_root: '/Users/me/dev/site',
  repos: [],
  instruction_files: [{ name: 'CLAUDE.md', text: 'Use the Makefile.\nNever npm.\n' }],
}

beforeEach(() => {
  m.tauri.on = false
  m.add.mockReset().mockImplementation(async (req: { path: string; repos?: string[] }) => ({
    project: { id: req.repos ? '30' : '31', root: req.path, name: req.path.split('/').pop(), kind: req.repos ? 'folder' : 'repo', ...(req.repos ? { repos: req.repos.map((p) => ({ path: p, name: p.split('/').pop() })) } : {}) },
    created: true,
  }))
  m.patch.mockReset().mockImplementation(async (id: string, p: Partial<Project>) => ({ id, root: '/x', name: 'x', kind: 'repo', ...p }))
  m.scan.mockReset().mockImplementation(async (path: string) => (path.includes('work') ? THREE : ONE))
  m.browse.mockReset().mockResolvedValue({ dir: '/Users/me/dev', parent: '/Users/me', root: '/Users/me', entries: [{ name: 'site', path: '/Users/me/dev/site', repo: true }, { name: 'notes', path: '/Users/me/dev/notes', repo: false }] })
  m.pick.mockReset()
})

function open(projects: Project[] = []) {
  const cb = { onClose: vi.fn(), onCreated: vi.fn(), onStartAgent: vi.fn(), onMoreWays: vi.fn() }
  render(<ProjectWizard projects={projects} {...cb} />)
  return cb
}

const folder = () => screen.getByRole('combobox', { name: 'Folder' })

describe('new project, tap-tap-tap', () => {
  it('a folder of three repositories: all but the one in another project ticked, one project of them with instructions, then an agent', async () => {
    const cb = open()
    fireEvent.change(folder(), { target: { value: '~/work' } })
    fireEvent.keyDown(folder(), { key: 'Enter' })
    expect(await screen.findByRole('heading', { name: 'What is there' })).toHaveTextContent('3 repositories')
    expect(m.scan).toHaveBeenCalledWith('~/work')
    // Every card ticked: infra is listed on its own, which is folded in, not left out.
    expect((screen.getByRole('checkbox', { name: 'api' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'infra' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText(/listed as infra/)).toBeInTheDocument()
    expect(screen.getByText(/api \(CLAUDE.md\)/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'web' }))
    fireEvent.change(screen.getByRole('textbox', { name: /Instructions for every agent here/ }), { target: { value: 'Answer in English.' } })
    fireEvent.click(screen.getByRole('button', { name: /Create project of 2 repos/ }))
    await waitFor(() => expect(m.add).toHaveBeenCalledWith({ path: '/Users/me/work', repos: ['/Users/me/work/api', '/Users/me/work/infra'] }))
    expect(m.patch).toHaveBeenCalledWith('30', { defaults: { system_prompt: 'Answer in English.' } })
    expect(cb.onCreated).toHaveBeenCalledWith('30')
    expect(await screen.findByText(/is ready/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Start an agent here/ }))
    expect(cb.onStartAgent).toHaveBeenCalledWith('30')
  })

  it('or as separate projects, one each', async () => {
    open()
    fireEvent.change(folder(), { target: { value: '~/work' } })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Or add them as 3 separate projects/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Create 3 projects' }))
    await waitFor(() => expect(m.add).toHaveBeenCalledTimes(3))
    expect(m.add).toHaveBeenNthCalledWith(2, { path: '/Users/me/work/web' })
    expect(await screen.findByText('3 projects are ready')).toBeInTheDocument()
  })

  it('a single repository: one click on its row, Enter creates, the repository’s CLAUDE.md shown on a click, no instructions sent', async () => {
    const cb = open()
    fireEvent.click(await screen.findByRole('option', { name: /^site/ }))
    expect(await screen.findByRole('heading', { name: 'What is there' })).toHaveTextContent('One repository')
    expect(m.scan).toHaveBeenCalledWith('/Users/me/dev/site')
    expect(screen.getByText(/Already has/)).toHaveTextContent('Already has CLAUDE.md — agents read it')
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(screen.getByLabelText('CLAUDE.md text')).toHaveTextContent('Use the Makefile.')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Hide' }), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(m.add).toHaveBeenCalledWith({ path: '/Users/me/dev/site' }))
    expect(m.patch).not.toHaveBeenCalled()
    expect(cb.onCreated).toHaveBeenCalledWith('31')
  })

  it('offers the places projects live as chips, and the folder chooser in the desktop app', async () => {
    m.tauri.on = true
    m.pick.mockResolvedValue('/Users/me/dev/site')
    open([{ id: '1', root: '/Users/me/code/a', name: 'a', kind: 'repo' }] as Project[])
    const places = await screen.findByRole('group', { name: 'Places' })
    await waitFor(() => expect(places).toHaveTextContent('~/code~/dev~'))
    fireEvent.click(screen.getByRole('button', { name: '~/dev' }))
    expect(folder()).toHaveValue('~/dev')
    fireEvent.click(screen.getByRole('button', { name: 'Choose…' }))
    await waitFor(() => expect(m.pick).toHaveBeenCalledWith('/Users/me/dev'))
    expect(await screen.findByRole('heading', { name: 'What is there' })).toHaveTextContent('One repository')
  })

  it('a folder that is already a project opens it, adding nothing', async () => {
    const cb = open([{ id: '5', root: '/Users/me/dev/site', name: 'site', kind: 'repo' }] as Project[])
    fireEvent.change(folder(), { target: { value: '/Users/me/dev/site' } })
    fireEvent.keyDown(folder(), { key: 'Enter' })
    expect(await screen.findByText(/Already a project/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Open project/ }))
    expect(m.add).not.toHaveBeenCalled()
    expect(cb.onCreated).toHaveBeenCalledWith('5')
    expect(await screen.findByText('site is already a project')).toBeInTheDocument()
  })

  it('says what the scan could not do, and keeps the step', async () => {
    m.scan.mockRejectedValue(new Error('/nope is not a folder'))
    open()
    fireEvent.change(folder(), { target: { value: '/nope' } })
    fireEvent.keyDown(folder(), { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('/nope is not a folder')
    expect(folder()).toBeInTheDocument()
  })

  it('hands clone and a new folder to the Add project sheet', async () => {
    const cb = open()
    fireEvent.click(screen.getByRole('button', { name: /Clone, or start an empty folder/ }))
    expect(cb.onMoreWays).toHaveBeenCalled()
  })

  it('offers From a template… beside it, and only on the first step', async () => {
    const onFromTemplate = vi.fn()
    render(<ProjectWizard projects={[]} onClose={vi.fn()} onCreated={vi.fn()} onStartAgent={vi.fn()} onMoreWays={vi.fn()} onFromTemplate={onFromTemplate} />)
    const link = screen.getByRole('button', { name: 'From a template…' })
    expect(link.parentElement).toHaveTextContent('Clone, or start an empty folder…·From a template…')
    fireEvent.click(link)
    expect(onFromTemplate).toHaveBeenCalled()
    fireEvent.change(folder(), { target: { value: '~/work' } })
    fireEvent.keyDown(folder(), { key: 'Enter' })
    await screen.findByRole('heading', { name: 'What is there' })
    expect(screen.queryByRole('button', { name: 'From a template…' })).toBeNull()
  })

  it('without a template handler (a paired device), no link', () => {
    open()
    expect(screen.queryByRole('button', { name: 'From a template…' })).toBeNull()
  })
})

describe('typing a name searches the folder it is in', () => {
  const DEV = {
    dir: '/Users/me/dev', parent: '/Users/me', root: '/Users/me',
    entries: [
      { name: 'ai-crm', path: '/Users/me/dev/ai-crm', repo: true },
      { name: 'caprock', path: '/Users/me/dev/caprock', repo: true },
      { name: 'Caprock-web', path: '/Users/me/dev/Caprock-web', repo: true },
      { name: 'escape', path: '/Users/me/dev/escape', repo: false },
      { name: 'notes', path: '/Users/me/dev/notes', repo: false },
    ],
  }
  const NOTES = { dir: '/Users/me/dev/escape', parent: '/Users/me/dev', root: '/Users/me', entries: [{ name: 'inner', path: '/Users/me/dev/escape/inner', repo: true }] }
  beforeEach(() => {
    // Only real folders answer, as the daemon does: a half-typed name is a 404.
    m.browse.mockImplementation(async (dir: string) => {
      const d = dir.replace(/[\\/]+$/, '')
      if (d === '~/dev') return DEV
      if (d === '~/dev/escape') return NOTES
      throw new Error('not found')
    })
  })
  const rows = () => screen.getAllByRole('option').map((o) => o.textContent?.replace(/git$/, ''))
  const selected = () => screen.getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')?.textContent?.replace(/git$/, '')

  it('~/dev/cap keeps the folders of ~/dev that hold "cap", prefix first, the match marked', async () => {
    open()
    fireEvent.change(folder(), { target: { value: '~/dev/cap' } })
    await waitFor(() => expect(rows()).toEqual(['caprock', 'Caprock-web', 'escape']))
    expect(m.browse).toHaveBeenCalledWith('~/dev/')
    expect(screen.getAllByText('cap', { selector: 'mark' })).toHaveLength(2)
    expect(screen.getByText('Cap', { selector: 'mark' })).toBeInTheDocument()
    expect(selected()).toBe('caprock')
    // Letters re-filter at once, with no new listing.
    const calls = m.browse.mock.calls.length
    fireEvent.change(folder(), { target: { value: '~/dev/capr' } })
    expect(rows()).toEqual(['caprock', 'Caprock-web'])
    expect(m.browse.mock.calls.length).toBe(calls)
  })

  it('arrows move the highlight; Enter picks the highlighted folder', async () => {
    open()
    fireEvent.change(folder(), { target: { value: '~/dev/cap' } })
    await waitFor(() => expect(selected()).toBe('caprock'))
    fireEvent.keyDown(folder(), { key: 'ArrowDown' })
    expect(selected()).toBe('Caprock-web')
    expect(folder()).toHaveAttribute('aria-activedescendant', 'wizard-folder-1')
    fireEvent.keyDown(folder(), { key: 'ArrowDown' })
    fireEvent.keyDown(folder(), { key: 'ArrowDown' })
    expect(selected()).toBe('caprock')
    fireEvent.keyDown(folder(), { key: 'ArrowUp' })
    expect(selected()).toBe('escape')
    fireEvent.keyDown(folder(), { key: 'ArrowUp' })
    fireEvent.keyDown(folder(), { key: 'Enter' })
    await screen.findByRole('heading', { name: 'What is there' })
    expect(m.scan).toHaveBeenCalledWith('/Users/me/dev/Caprock-web')
  })

  it('Tab completes to the highlighted folder and a separator, and lists inside it', async () => {
    open()
    fireEvent.change(folder(), { target: { value: '~/dev/ESC' } })
    await waitFor(() => expect(selected()).toBe('escape'))
    fireEvent.keyDown(folder(), { key: 'Tab' })
    expect(folder()).toHaveValue('~/dev/escape/')
    await waitFor(() => expect(rows()).toEqual(['inner']))
    // A plain listing highlights nothing: Enter looks at the folder in the field.
    expect(selected()).toBeUndefined()
    fireEvent.keyDown(folder(), { key: 'Enter' })
    await waitFor(() => expect(m.scan).toHaveBeenCalledWith('~/dev/escape/'))
  })

  it('no match says so, and Enter looks at what was typed', async () => {
    open()
    fireEvent.change(folder(), { target: { value: '~/dev/zz' } })
    expect(await screen.findByRole('status')).toHaveTextContent("No folder starting with ‘zz’ in ~/dev")
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.keyDown(folder(), { key: 'Tab' })
    expect(folder()).toHaveValue('~/dev/zz')
  })

  it('an existing folder lists what is inside it, as before', async () => {
    open()
    fireEvent.change(folder(), { target: { value: '~/dev' } })
    await waitFor(() => expect(rows()).toEqual(['ai-crm', 'caprock', 'Caprock-web', 'escape', 'notes']))
    expect(screen.getByText(/a click picks one/)).toBeInTheDocument()
    expect(screen.queryAllByText(/./, { selector: 'mark' })).toHaveLength(0)
    fireEvent.keyDown(folder(), { key: 'ArrowDown' })
    expect(selected()).toBe('ai-crm')
  })

  it('a Windows path filters the same way', async () => {
    m.browse.mockImplementation(async (dir: string) => {
      if (dir === 'C:\\Users\\me\\dev\\') return { ...DEV, dir: 'C:\\Users\\me\\dev', entries: DEV.entries.map((e) => ({ ...e, path: `C:\\Users\\me\\dev\\${e.name}` })) }
      throw new Error('not found')
    })
    open()
    fireEvent.change(folder(), { target: { value: 'C:\\Users\\me\\dev\\no' } })
    await waitFor(() => expect(rows()).toEqual(['notes']))
    fireEvent.keyDown(folder(), { key: 'Tab' })
    expect(folder()).toHaveValue('C:\\Users\\me\\dev\\notes\\')
  })
})
