import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddProjectSheet, cloneDest, defaultCandidate, repoName, requestFor } from './AddProjectSheet'

const m = vi.hoisted(() => ({ add: vi.fn(), patch: vi.fn(), settings: vi.fn(), save: vi.fn(), stat: vi.fn(), recent: vi.fn(), repos: vi.fn(), scan: vi.fn() }))
vi.mock('@/lib/projects', async (orig) => {
  const actual = await orig<typeof import('@/lib/projects')>()
  return { ...actual, projectsApi: { ...actual.projectsApi, add: m.add, patch: m.patch, scan: m.scan } }
})
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, settings: m.settings, saveSettings: m.save, browseStat: m.stat, recentDirs: m.recent, localRepos: m.repos } }
})
vi.mock('./DirPicker', () => ({ DirPicker: () => null }))
vi.mock('@/lib/appmode', async (orig) => ({ ...(await orig<typeof import('@/lib/appmode')>()), isMacPlatform: () => true }))

beforeEach(() => {
  m.add.mockReset().mockResolvedValue({ project: { id: '9', root: '/dev/api', name: 'api', kind: 'repo' } })
  m.patch.mockReset().mockResolvedValue({ id: '9', root: '/dev/api', name: 'api', kind: 'repo' })
  m.settings.mockReset().mockResolvedValue({})
  m.save.mockReset().mockResolvedValue({})
  m.stat.mockReset().mockResolvedValue({ path: '/x', exists: true, is_dir: true, empty: false, parent_exists: true })
  m.recent.mockReset().mockResolvedValue([])
  m.repos.mockReset().mockResolvedValue({ root: '/Users/me/dev', home: '/Users/me', scanned_at: 0, repos: [] })
  m.scan.mockReset().mockResolvedValue({ root: '/dev/api', repo_root: '/dev/api', repos: [] })
})
afterEach(() => { vi.useRealTimers() })

const folderField = () => screen.getByRole('textbox', { name: /^Folder/ })

describe('adding a project', () => {
  it('sets its agents’ instructions as it is added, and only when there are some', async () => {
    const onAdded = vi.fn()
    render(<AddProjectSheet source="api" onClose={() => {}} onAdded={onAdded} onAddLocal={() => {}} />)
    fireEvent.change(folderField(), { target: { value: '/dev/api' } })
    fireEvent.click(screen.getByRole('button', { name: /Standing instructions/ }))
    fireEvent.change(screen.getByRole('textbox', { name: /Standing instructions/ }), { target: { value: 'Use the Makefile.' } })
    fireEvent.click(screen.getByRole('button', { name: /^Add/ }))
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('9', undefined))
    expect(m.patch).toHaveBeenCalledWith('9', { defaults: { system_prompt: 'Use the Makefile.' } })
  })

  it('touches no defaults when the field is left empty', async () => {
    const onAdded = vi.fn()
    render(<AddProjectSheet source="api" onClose={() => {}} onAdded={onAdded} onAddLocal={() => {}} />)
    fireEvent.change(folderField(), { target: { value: '/dev/api' } })
    fireEvent.click(screen.getByRole('button', { name: /^Add/ }))
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('9', undefined))
    expect(m.patch).not.toHaveBeenCalled()
  })

  // Text typed as a first task must start an agent. It used to be typed into
  // the instructions field, which only shapes later sessions, and nothing ran.
  it('hands a first task to the caller with the project root', async () => {
    const onAdded = vi.fn()
    render(<AddProjectSheet source="api" onClose={() => {}} onAdded={onAdded} onAddLocal={() => {}} />)
    fireEvent.change(folderField(), { target: { value: '/dev/api' } })
    fireEvent.change(screen.getByRole('textbox', { name: /First task/ }), { target: { value: 'Read the repo.' } })
    fireEvent.click(screen.getByRole('button', { name: /^Add/ }))
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('9', { root: '/dev/api', task: 'Read the repo.' }))
  })

  // Pasting a URL fills the destination the way `git clone` names it.
  it('names the clone folder after the repository until edited', () => {
    render(<AddProjectSheet source="api" defaultParent="/Users/me/dev" onClose={() => {}} onAdded={() => {}} onAddLocal={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: /Clone/ }))
    fireEvent.change(screen.getByPlaceholderText(/github.com\/you\/repo/), { target: { value: 'git@github.com:donmiro/rateguard.git' } })
    expect(screen.getByDisplayValue('/Users/me/dev/rateguard')).toBeInTheDocument()
  })
})

// Owner, 2026-10-09: the field starts on the home folder or the default the
// user set, and Set as default keeps the folder typed.
describe('the default folder', () => {
  it('starts on ~/ with no setting, and on the setting once it arrives', async () => {
    m.settings.mockResolvedValue({ default_folder: '~/dev' })
    render(<AddProjectSheet source="api" onClose={() => {}} onAdded={() => {}} onAddLocal={() => {}} />)
    expect(folderField()).toHaveValue('~/')
    await waitFor(() => expect(folderField()).toHaveValue('~/dev/'))
    expect(folderField()).toHaveFocus()
  })

  it('saves the folder typed as the default', async () => {
    render(<AddProjectSheet source="api" onClose={() => {}} onAdded={() => {}} onAddLocal={() => {}} />)
    fireEvent.change(folderField(), { target: { value: '~/src/' } })
    fireEvent.click(screen.getByRole('button', { name: /Set ~\/src as default/ }))
    await waitFor(() => expect(m.save).toHaveBeenCalledWith({ default_folder: '~/src' }))
  })

  it('keeps the folder a new project or a clone goes in', () => {
    expect(defaultCandidate('folder', '~/dev/api')).toBe('~/dev/api')
    expect(defaultCandidate('new', '~/dev/app')).toBe('~/dev')
    expect(defaultCandidate('clone', '~/src/')).toBe('~/src')
    expect(defaultCandidate('folder', '')).toBe('')
  })
})

describe('what is at the path', () => {
  it('asks the daemon 250 ms after the last key and says it', async () => {
    vi.useFakeTimers()
    m.stat.mockResolvedValue({ path: '/Users/me/dev/x', exists: true, is_dir: true, empty: false, parent_exists: true })
    render(<AddProjectSheet source="api" defaultParent="/Users/me/dev" onClose={() => {}} onAdded={() => {}} onAddLocal={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: /Clone/ }))
    m.stat.mockClear()
    fireEvent.change(screen.getByRole('textbox', { name: /^Clone into/ }), { target: { value: '/Users/me/dev/x' } })
    fireEvent.change(screen.getByRole('textbox', { name: /^Clone into/ }), { target: { value: '/Users/me/dev/xy' } })
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(m.stat).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(60) })
    expect(m.stat).toHaveBeenCalledTimes(1)
    expect(m.stat).toHaveBeenCalledWith('/Users/me/dev/xy')
    expect(screen.getByRole('status', { name: 'What is there' })).toHaveTextContent('exists — not empty, clone will fail')
  })
})

describe('keys', () => {
  it('switches modes on ⌘1–3 and adds on ⌘↩ from anywhere', async () => {
    const onAdded = vi.fn()
    render(<AddProjectSheet source="api" onClose={() => {}} onAdded={onAdded} onAddLocal={() => {}} />)
    fireEvent.keyDown(window, { key: '2', code: 'Digit2', metaKey: true })
    expect(screen.getByRole('tab', { name: /New project/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(window, { key: '3', code: 'Digit3', metaKey: true })
    expect(screen.getByRole('tab', { name: /Clone/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(window, { key: '1', code: 'Digit1', metaKey: true })
    fireEvent.change(folderField(), { target: { value: '/dev/api' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: /First task/ }), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('9', undefined))
  })

  it('shows each key on its button', () => {
    render(<AddProjectSheet source="api" onClose={() => {}} onAdded={() => {}} onAddLocal={() => {}} />)
    expect(screen.getByRole('button', { name: /^Add/ })).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter')
    expect(screen.getByRole('button', { name: /^Cancel/ })).toHaveTextContent('Esc')
    expect(screen.getByRole('tab', { name: /Clone/ })).toHaveTextContent('⌘3')
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
    // A folder still open for a name is where the repository's folder goes.
    expect(requestFor('clone', '~/src/', 'git@h:a/b.git', '/d', 'op1')).toEqual({ clone: { url: 'git@h:a/b.git', parent: '~/src', name: 'b' }, op_id: 'op1' })
  })
})

// Owner, 2026-10-10: ~/dev/caprock-website for ~/dev/caprock-web was answered
// only with "no such folder".
describe('the search under the Folder field', () => {
  const repos = [
    { name: 'caprock', path: '/Users/me/dev/caprock' },
    { name: 'caprock-web', path: '/Users/me/dev/caprock-web' },
    { name: 'notes', path: '/Users/me/dev/notes' },
  ]

  it('lists matches as the name is typed, and ↓ Enter picks one', async () => {
    m.repos.mockResolvedValue({ root: '/Users/me/dev', home: '/Users/me', scanned_at: 0, repos })
    render(<AddProjectSheet source="api" defaultParent="~/dev" onClose={() => {}} onAdded={() => {}} onAddLocal={() => {}} />)
    await waitFor(() => expect(m.repos).toHaveBeenCalled())
    fireEvent.change(folderField(), { target: { value: '~/dev/capr' } })
    const options = await screen.findAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining('caprock'), expect.stringContaining('caprock-web')])
    fireEvent.keyDown(folderField(), { key: 'ArrowDown' })
    fireEvent.keyDown(folderField(), { key: 'ArrowDown' })
    fireEvent.keyDown(folderField(), { key: 'Enter' })
    expect(folderField()).toHaveValue('~/dev/caprock-web')
    expect(m.add).not.toHaveBeenCalled()
  })

  it('says "no such folder" only when nothing matches, with the nearest names', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    m.repos.mockResolvedValue({ root: '/Users/me/dev', home: '/Users/me', scanned_at: 0, repos })
    m.stat.mockResolvedValue({ path: '/Users/me/dev/x', exists: false, is_dir: false, empty: false, parent_exists: true })
    render(<AddProjectSheet source="api" defaultParent="~/dev" onClose={() => {}} onAdded={() => {}} onAddLocal={() => {}} />)
    await waitFor(() => expect(m.repos).toHaveBeenCalled())
    fireEvent.change(folderField(), { target: { value: '~/dev/capro' } })
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(screen.getByRole('status', { name: 'What is there' })).not.toHaveTextContent('no such folder')
    fireEvent.change(folderField(), { target: { value: '~/dev/caprock-website' } })
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(screen.getByRole('status', { name: 'What is there' })).toHaveTextContent('no such folder')
    fireEvent.click(screen.getByRole('button', { name: '~/dev/caprock-web' }))
    expect(folderField()).toHaveValue('~/dev/caprock-web')
  })
})

// ADR-055: a folder that holds several repositories asks once — one project
// of N repositories (the default) or N separate projects.
describe('a folder of repositories', () => {
  const scan = {
    root: '/work',
    repos: [
      { path: '/work/api', name: 'api' },
      { path: '/work/web', name: 'web', project_id: 4, project_name: 'web' },
      { path: '/work/infra', name: 'infra' },
    ],
  }

  it('asks once, defaults to one project, and adds the ticked repositories', async () => {
    m.scan.mockResolvedValue(scan)
    m.add.mockResolvedValue({ project: { id: '12', root: '/work', name: 'work', kind: 'folder' } })
    const onAdded = vi.fn()
    render(<AddProjectSheet source="api" onClose={() => {}} onAdded={onAdded} onAddLocal={() => {}} />)
    fireEvent.change(folderField(), { target: { value: '/work' } })
    fireEvent.click(screen.getByRole('button', { name: /^Add/ }))
    const group = await screen.findByRole('radiogroup', { name: 'Add them as' })
    expect(m.add).not.toHaveBeenCalled()
    expect(group).toHaveTextContent('One project of 3 repositories')
    expect(screen.getByRole('radio', { name: /One project/ })).toBeChecked()
    expect(screen.getByText('listed as web')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: /infra/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Add 1 project/ }))
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('12', undefined))
    expect(m.add).toHaveBeenCalledTimes(1)
    expect(m.add).toHaveBeenCalledWith({ path: '/work', repos: ['/work/api', '/work/web'] })
  })

  it('adds each ticked repository on its own when asked for separate projects', async () => {
    m.scan.mockResolvedValue(scan)
    m.add.mockImplementation(async (req: { path: string }) => ({ project: { id: req.path, root: req.path, name: req.path, kind: 'repo' } }))
    const onAdded = vi.fn()
    render(<AddProjectSheet source="api" onClose={() => {}} onAdded={onAdded} onAddLocal={() => {}} />)
    fireEvent.change(folderField(), { target: { value: '/work' } })
    fireEvent.click(screen.getByRole('button', { name: /^Add/ }))
    fireEvent.click(await screen.findByRole('radio', { name: /separate projects/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Add 3 projects/ }))
    await waitFor(() => expect(m.add).toHaveBeenCalledTimes(3))
    expect(m.add.mock.calls.map((c) => c[0])).toEqual([{ path: '/work/api' }, { path: '/work/web' }, { path: '/work/infra' }])
    expect(onAdded).toHaveBeenCalledWith('/work/api', undefined)
  })

  it('refuses one project of a single repository', async () => {
    m.scan.mockResolvedValue(scan)
    render(<AddProjectSheet source="api" onClose={() => {}} onAdded={() => {}} onAddLocal={() => {}} />)
    fireEvent.change(folderField(), { target: { value: '/work' } })
    fireEvent.click(screen.getByRole('button', { name: /^Add/ }))
    await screen.findByRole('radiogroup', { name: 'Add them as' })
    fireEvent.click(screen.getByRole('checkbox', { name: /infra/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /web/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Add 1 project/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('two repositories or more')
    expect(m.add).not.toHaveBeenCalled()
  })

  it('asks nothing for a folder inside one repository', async () => {
    m.scan.mockResolvedValue({ root: '/work/api/src', repo_root: '/work/api', repos: [] })
    const onAdded = vi.fn()
    render(<AddProjectSheet source="api" onClose={() => {}} onAdded={onAdded} onAddLocal={() => {}} />)
    fireEvent.change(folderField(), { target: { value: '/work/api/src' } })
    fireEvent.click(screen.getByRole('button', { name: /^Add/ }))
    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    expect(m.add).toHaveBeenCalledWith({ path: '/work/api/src' })
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })
})
