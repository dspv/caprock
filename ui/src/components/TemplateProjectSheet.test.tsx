/**
 * New project from a template: the steps, what Create says it will do, the
 * operation's progress, and the agent started once it is done — through the
 * same hook the app uses (lib/useTemplateJob.ts), so a hidden sheet behaves
 * the same.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpFrame } from '@/lib/projects'
import type { GHStatus, Template, TemplateOp } from '@/lib/templates'

const m = vi.hoisted(() => ({
  templates: vi.fn(),
  inspect: vi.fn(),
  from: vi.fn(),
  retry: vi.fn(),
  add: vi.fn(),
  spawn: vi.fn(),
  browse: vi.fn(),
  stat: vi.fn(),
  readText: vi.fn(),
  tauri: { on: false },
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      templates: () => m.templates(),
      inspectTemplate: (s: unknown) => m.inspect(s),
      fromTemplate: (r: unknown) => m.from(r),
      retryOp: (id: string) => m.retry(id),
      addTemplate: (t: unknown) => m.add(t),
      spawn: (r: unknown) => m.spawn(r),
      settings: async () => ({ default_folder: '/Users/me/dev' }),
      localRepos: async () => ({ root: '/Users/me/dev', home: '/Users/me', scanned_at: 0, repos: [] }),
      browse: (d: string) => m.browse(d),
      browseStat: (p: string) => m.stat(p),
      agentCatalog: async () => ({ agents: [
        { id: 'claude', label: 'Claude Code', installed: true, ready: true, models: [], observed: true, prompt: true },
        { id: 'codex', label: 'Codex', installed: true, ready: true, models: [], observed: true, prompt: true },
      ], licensed: true }),
    },
  }
})
vi.mock('@/lib/projects', async (orig) => {
  const actual = await orig<typeof import('@/lib/projects')>()
  return { ...actual, newOpId: () => 'op-1', projectsApi: { ...actual.projectsApi, ops: async () => [] } }
})
vi.mock('@/lib/appmode', async (orig) => ({ ...(await orig<typeof import('@/lib/appmode')>()), isMacPlatform: () => true, isTauri: () => m.tauri.on }))
vi.mock('@/lib/shell', async (orig) => {
  const actual = await orig<typeof import('@/lib/shell')>()
  return { ...actual, shell: { ...actual.shell, readDroppedText: (p: string) => m.readText(p) } }
})

import { TemplateProjectSheet, EMPTY_TEMPLATES } from './TemplateProjectSheet'
import { useTemplateJob } from '@/lib/useTemplateJob'

const READY: GHStatus = { installed: true, logged_in: true, login: 'dspv' }
const CORPUS: Template = { id: 'a1b2c3d4', name: 'Corpus', github: 'dspv/corpus', brief_path: 'docs/source-spec.md', prompt: 'Read TEMPLATE.md. Build the .ai/ corpus from {brief}.', created_at: 1 }
const SITE: Template = { id: 'e5f6a7b8', name: 'Site', folder: '/Users/me/templates/site', brief_path: 'docs/brief.md', prompt: 'Read {brief}.', created_at: 2 }

const cb = { started: vi.fn(), made: vi.fn(), toast: vi.fn(), startAgent: vi.fn() }

/** The sheet and the app's job, as AppShell wires them; `ops` are the live frames. */
let pushOp: (op: OpFrame) => void = () => {}
let hide: () => void = () => {}
let show: () => void = () => {}
function Host() {
  const [ops, setOps] = useState<OpFrame[]>([])
  const [open, setOpen] = useState(true)
  pushOp = (op) => setOps((cur) => [op, ...cur.filter((o) => o.op_id !== op.op_id)])
  hide = () => setOpen(false)
  show = () => setOpen(true)
  const tpl = useTemplateJob(ops, {
    onStarted: (id, pid, job) => cb.started(id, pid, job.name),
    onMade: cb.made,
    toast: cb.toast,
    sheetOpen: () => open,
    closeSheet: () => setOpen(false),
  })
  return open ? (
    <TemplateProjectSheet
      projects={[]}
      job={tpl.job}
      op={tpl.op}
      onClose={() => setOpen(false)}
      onSubmitted={tpl.submit}
      onOp={tpl.setOp}
      onStartAgent={(job) => cb.startAgent(job)}
      onReset={tpl.reset}
    />
  ) : null
}

const frame = (o: Partial<TemplateOp>): TemplateOp => ({ op_id: 'op-1', kind: 'template', state: 'running', url: 'https://github.com/dspv/corpus', dest: '/Users/me/dev/new-corpus', ...o })

beforeEach(() => {
  m.tauri.on = false
  for (const f of [m.templates, m.inspect, m.from, m.retry, m.add, m.spawn, m.browse, m.stat, m.readText]) f.mockReset()
  for (const f of Object.values(cb)) f.mockReset()
  m.templates.mockResolvedValue({ templates: [CORPUS, SITE], gh: READY })
  m.browse.mockResolvedValue({ dir: '/Users/me/dev', parent: '/Users/me', root: '/Users/me', entries: [{ name: 'new-corpus', path: '/Users/me/dev/new-corpus', repo: true }] })
  m.stat.mockResolvedValue({ path: '/x', exists: false, is_dir: false, empty: false, parent_exists: true })
  m.from.mockImplementation(async () => ({ op: frame({ step: 'create' }), existing: false }))
  m.spawn.mockResolvedValue({ session_id: 's-1' })
  m.add.mockResolvedValue({ template: { ...CORPUS, id: 'new' } })
})

async function toBrief(card = /Corpus/) {
  fireEvent.click(await screen.findByRole('button', { name: card }))
  fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
  await screen.findByRole('heading', { name: 'Name it' })
  // The parent folder comes from Settings and home from the repo scan, both
  // answered apart from the templates: wait for them, or the plan and Create
  // read the bare fallback.
  await waitFor(() => expect(screen.getByLabelText('Path')).toHaveTextContent(/^~\/dev\/new-/))
  fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
  return screen.findByRole('textbox', { name: 'Brief' })
}

describe('new project from a template', () => {
  it('with none saved: says what a template is, and offers to add one', async () => {
    m.templates.mockResolvedValue({ templates: [], gh: READY })
    render(<Host />)
    expect(await screen.findByText(EMPTY_TEMPLATES)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'GitHub template' })).toBeInTheDocument()
    expect(screen.getByText(/Reads TEMPLATE.md and README.md from/)).toHaveTextContent('github.com/owner/name with your gh login')
  })

  it('shows the saved ones as cards: name, where it is, where the brief goes', async () => {
    render(<Host />)
    const corpus = await screen.findByRole('button', { name: /Corpus/ })
    expect(corpus).toHaveTextContent('github.com/dspv/corpus')
    expect(corpus).toHaveTextContent('brief → docs/source-spec.md')
    expect(screen.getByRole('button', { name: /Site/ })).toHaveTextContent('~/templates/site')
    expect(screen.getByRole('button', { name: '+ Another template' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Steps' })).toHaveTextContent('1Template·2Project·3Brief')
    // The first card is chosen and focused: Enter on it moves on.
    await waitFor(() => expect(corpus).toHaveFocus())
    expect(corpus).toHaveAttribute('aria-pressed', 'true')
    fireEvent.keyDown(corpus, { key: 'Enter' })
    expect(await screen.findByRole('heading', { name: 'Name it' })).toBeInTheDocument()
  })

  it('looks up a template typed as a git@ address, and fills in what TEMPLATE.md says', async () => {
    m.templates.mockResolvedValue({ templates: [], gh: READY })
    m.inspect.mockResolvedValue({ github: 'dspv/corpus', is_template: true, visibility: 'public', template_md: '# T', brief_path: 'docs/source-spec.md', brief_from: 'marker', prompt: 'Build from {brief}.', prompt_from: 'marker', suggested_name: 'new-corpus-2' })
    render(<Host />)
    const field = await screen.findByRole('textbox', { name: 'GitHub template' })
    fireEvent.change(field, { target: { value: 'git@github.com:dspv/corpus.git' } })
    expect(screen.getByText(/Reads TEMPLATE.md and README.md from/)).toHaveTextContent('github.com/dspv/corpus with your gh login')
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(m.inspect).toHaveBeenCalledWith({ github: 'dspv/corpus' }))
    expect(await screen.findByText('Template repository · public · has TEMPLATE.md')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Brief goes to' })).toHaveValue('docs/source-spec.md')
    expect(screen.getByText('from TEMPLATE.md')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'First message to the agent' })).toHaveValue('Build from {brief}.')
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(screen.getByRole('textbox', { name: 'Template name' })).toHaveValue('corpus')
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('new-corpus-2')
  })

  it('says when a repository is not a template, or cannot be seen', async () => {
    m.templates.mockResolvedValue({ templates: [], gh: READY })
    m.inspect.mockResolvedValueOnce({ github: 'dspv/site', is_template: false, template_md: '', brief_path: 'docs/brief.md', brief_from: 'default', prompt: 'p', prompt_from: 'default', suggested_name: 'new-site' })
    render(<Host />)
    const field = await screen.findByRole('textbox', { name: 'GitHub template' })
    fireEvent.change(field, { target: { value: 'https://github.com/dspv/site' } })
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }))
    expect(await screen.findByText('dspv/site is not a template repository. On GitHub: Settings → Template repository.')).toBeInTheDocument()
    m.inspect.mockResolvedValueOnce({ github: 'dspv/nope', error: 'gh: Could not resolve', template_md: '', brief_path: 'docs/brief.md', brief_from: 'default', prompt: 'p', prompt_from: 'default', suggested_name: 'new-nope' })
    fireEvent.change(field, { target: { value: 'dspv/nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }))
    expect(await screen.findByText('Not found, or your gh login can’t see it.')).toBeInTheDocument()
  })

  it('names it from the template, numbered past what is taken, and says how it will be made', async () => {
    render(<Host />)
    fireEvent.click(await screen.findByRole('button', { name: /Corpus/ }))
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('new-corpus-2')
    await waitFor(() => expect(screen.getByLabelText('Path')).toHaveTextContent('~/dev/new-corpus-2'))
    expect(screen.getByRole('radio', { name: 'Private' })).toBeChecked()
    expect(screen.getByLabelText('How it will be made')).toHaveTextContent('On GitHub as dspv/new-corpus-2, from dspv/corpus, then cloned to ~/dev/new-corpus-2.')
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'bad name' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Letters, digits')
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled()
    m.stat.mockResolvedValue({ path: '/Users/me/dev/taken', exists: true, is_dir: true, empty: false, parent_exists: true })
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'taken' } })
    expect(await screen.findByText('~/dev/taken already exists; pick another name.')).toBeInTheDocument()
  })

  it('gh signed out: never made locally on its own; Check again, or make it locally when asked', async () => {
    m.templates.mockResolvedValue({ templates: [CORPUS], gh: { installed: true, logged_in: false, error: 'run gh auth login' } })
    m.inspect.mockResolvedValue({ github: 'dspv/corpus', local_folder: '/Users/me/dev/corpus', template_md: '', brief_path: 'x', brief_from: 'default', prompt: 'p', prompt_from: 'default', suggested_name: 'new-corpus' })
    render(<Host />)
    fireEvent.click(await screen.findByRole('button', { name: /Corpus/ }))
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    const line = await screen.findByLabelText('How it will be made')
    expect(line).toHaveTextContent('gh is installed but not signed in')
    expect(line).toHaveTextContent('or make it locally from /Users/me/dev/corpus')
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(m.templates).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'Make it locally' }))
    expect(screen.getByLabelText('How it will be made')).toHaveTextContent('Made on this computer')
    expect(screen.queryByRole('radio', { name: 'Private' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    await screen.findByRole('textbox', { name: 'Brief' })
    expect(screen.getByRole('region', { name: 'When you press Create' })).toHaveTextContent('Nothing leaves this computer.')
  })

  it('Create waits for a brief, and says what it will do and send on GitHub', async () => {
    render(<Host />)
    const brief = await toBrief()
    const create = screen.getByRole('button', { name: /Create/ })
    expect(create).toBeDisabled()
    expect(create).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter')
    expect(create).toHaveTextContent('⌘↩')
    const plan = screen.getByRole('region', { name: 'When you press Create' })
    expect(plan).toHaveTextContent('gh repo create dspv/new-corpus-2 --template dspv/corpus --private — makes a private repository on GitHub with your gh login.')
    expect(plan).toHaveTextContent('Clones it to ~/dev/new-corpus-2.')
    expect(plan).toHaveTextContent('Writes your brief to docs/source-spec.md and commits it. Not pushed.')
    expect(plan).toHaveTextContent('Starts Claude Code there with: “Read TEMPLATE.md. Build the .ai/ corpus from docs/source-spec.md.”')
    expect(plan).toHaveTextContent('Sent to GitHub: the name and visibility. Your brief stays on this computer until you push.')
    fireEvent.change(brief, { target: { value: 'A tea shop.' } })
    expect(create).toBeEnabled()
  })

  it('a folder template: copied here, nothing sent', async () => {
    render(<Host />)
    await toBrief(/Site/)
    const plan = screen.getByRole('region', { name: 'When you press Create' })
    expect(plan).toHaveTextContent('Copies /Users/me/templates/site to ~/dev/new-site')
    expect(plan).toHaveTextContent('git init and one commit')
    expect(plan).toHaveTextContent('Nothing leaves this computer.')
    expect(plan).not.toHaveTextContent('gh repo create')
  })

  it('creates, follows the frames, starts the agent with the prompt and opens its tab; saves nothing it was not asked to', async () => {
    render(<Host />)
    const brief = await toBrief()
    fireEvent.change(brief, { target: { value: 'A tea shop.' } })
    fireEvent.keyDown(brief, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(m.from).toHaveBeenCalledWith({
      op_id: 'op-1', source: { github: 'dspv/corpus' }, via: 'github', name: 'new-corpus-2', parent: '~/dev', visibility: 'private',
      brief: 'A tea shop.', brief_path: 'docs/source-spec.md', template_name: 'Corpus',
    }))
    expect(await screen.findByRole('status')).toHaveTextContent('Creating the repository on GitHub…')
    act(() => pushOp(frame({ step: 'clone', progress: 42, repo: 'dspv/new-corpus-2', repo_url: 'https://github.com/dspv/new-corpus-2' })))
    expect(screen.getByRole('status')).toHaveTextContent('Cloning… 42%')
    act(() => pushOp(frame({ step: 'brief' })))
    expect(screen.getByRole('status')).toHaveTextContent('Writing the brief…')
    expect(m.spawn).not.toHaveBeenCalled()
    act(() => pushOp(frame({ state: 'done', step: 'add', project_id: 9, repo: 'dspv/new-corpus-2' })))
    await waitFor(() => expect(m.spawn).toHaveBeenCalledWith({ cwd: '/Users/me/dev/new-corpus', agent: 'claude', prompt: 'Read TEMPLATE.md. Build the .ai/ corpus from docs/source-spec.md.' }))
    await waitFor(() => expect(cb.started).toHaveBeenCalledWith('s-1', '9', 'new-corpus-2'))
    expect(cb.made).toHaveBeenCalledWith('9')
    expect(cb.toast).toHaveBeenCalledWith('new-corpus-2 is ready — github.com/dspv/new-corpus-2')
    expect(m.add).not.toHaveBeenCalled() // a saved card is not saved again
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('hidden with Esc, it still starts the agent when done; a new template is saved only then', async () => {
    m.templates.mockResolvedValue({ templates: [], gh: READY })
    m.inspect.mockResolvedValue({ github: 'dspv/corpus', is_template: true, visibility: 'public', template_md: '# T', brief_path: 'docs/source-spec.md', brief_from: 'mention', prompt: 'Build from {brief}.', prompt_from: 'default', suggested_name: 'new-corpus' })
    render(<Host />)
    fireEvent.change(await screen.findByRole('textbox', { name: 'GitHub template' }), { target: { value: 'dspv/corpus' } })
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }))
    await screen.findByRole('textbox', { name: 'Brief goes to' })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    await screen.findByRole('heading', { name: 'Name it' })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Brief' }), { target: { value: 'Brief.' } })
    fireEvent.click(screen.getByRole('button', { name: /Create/ }))
    await screen.findByRole('status')
    act(() => hide())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(m.add).not.toHaveBeenCalled()
    act(() => pushOp(frame({ state: 'done', step: 'add', project_id: 3, dest: '/Users/me/dev/new-corpus' })))
    await waitFor(() => expect(m.add).toHaveBeenCalledWith({ name: 'corpus', github: 'dspv/corpus', folder: undefined, brief_path: 'docs/source-spec.md', prompt: 'Build from {brief}.', agent: 'claude' }))
    await waitFor(() => expect(cb.started).toHaveBeenCalledWith('s-1', '3', 'new-corpus'))
  })

  it('a clone that failed after the repository was made: Try the clone again, Open on GitHub, and never deleted', async () => {
    render(<Host />)
    fireEvent.change(await toBrief(), { target: { value: 'Brief.' } })
    fireEvent.click(screen.getByRole('button', { name: /Create/ }))
    await screen.findByRole('status')
    act(() => pushOp(frame({
      state: 'failed', step: 'clone', error: 'fatal: early EOF', repo: 'dspv/new-corpus-2', repo_url: 'https://github.com/dspv/new-corpus-2',
      dest: '/Users/me/dev/new-corpus-2', removed: true, retryable: true, notes: ['The folder ~/dev/new-corpus-2 was removed again.'],
    })))
    expect(await screen.findByRole('alert')).toHaveTextContent('The repository is on GitHub (https://github.com/dspv/new-corpus-2), but the clone failed: fatal: early EOF. ~/dev/new-corpus-2 was removed.')
    expect(screen.getByText('Caprock never deletes a GitHub repository; delete it there if you don’t want it.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open on GitHub' })).toHaveAttribute('href', 'https://github.com/dspv/new-corpus-2')
    expect(cb.toast).not.toHaveBeenCalled() // the open sheet says it
    m.retry.mockResolvedValue({ op: frame({ step: 'clone', repo: 'dspv/new-corpus-2' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Try the clone again' }))
    await waitFor(() => expect(m.retry).toHaveBeenCalledWith('op-1'))
    expect(await screen.findByRole('status')).toHaveTextContent('Cloning…')
  })

  it('a refused create made nothing', async () => {
    render(<Host />)
    fireEvent.change(await toBrief(), { target: { value: 'Brief.' } })
    fireEvent.click(screen.getByRole('button', { name: /Create/ }))
    await screen.findByRole('status')
    act(() => pushOp(frame({ state: 'failed', step: 'create', error: 'Name already exists on this account', retryable: false })))
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing was created.')
    expect(screen.queryByRole('button', { name: /Try/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }))
    expect(await screen.findByRole('heading', { name: 'Which template?' })).toBeInTheDocument()
  })

  it('the agent did not start: Start an agent opens New agent with the prompt', async () => {
    m.spawn.mockRejectedValue(new Error('claude is not installed'))
    render(<Host />)
    fireEvent.change(await toBrief(), { target: { value: 'Brief.' } })
    fireEvent.click(screen.getByRole('button', { name: /Create/ }))
    await screen.findByRole('status')
    act(() => pushOp(frame({ state: 'done', step: 'add', project_id: 9 })))
    expect(await screen.findByRole('alert')).toHaveTextContent('The project is made, but Claude Code did not start: claude is not installed')
    fireEvent.click(screen.getByRole('button', { name: 'Start an agent' }))
    expect(cb.startAgent).toHaveBeenCalledWith(expect.objectContaining({ projectId: '9', cwd: '/Users/me/dev/new-corpus', prompt: 'Read TEMPLATE.md. Build the .ai/ corpus from docs/source-spec.md.' }))
    act(() => { hide(); show() })
  })

  it('takes the brief from a .md dropped in the browser, and from a path the desktop app hands over', async () => {
    render(<Host />)
    const brief = await toBrief()
    const file = new File(['# Brief\nA tea shop.'], 'spec.md', { type: 'text/markdown' })
    fireEvent.drop(brief, { dataTransfer: { files: [file], types: ['Files'] } })
    await waitFor(() => expect(brief).toHaveValue('# Brief\nA tea shop.'))
    expect(screen.getByText('From spec.md.')).toBeInTheDocument()
    fireEvent.drop(brief, { dataTransfer: { files: [new File(['x'], 'shot.png')], types: ['Files'] } })
    expect(await screen.findByText('Only a .md or .txt file can be the brief.')).toBeInTheDocument()

    m.readText.mockResolvedValue('Brief from Finder. ∂ café')
    act(() => { window.dispatchEvent(new CustomEvent('caprock:drop-paths', { detail: { paths: ['/Users/me/Desktop/brief.txt'], x: 10, y: 10 } })) })
    await waitFor(() => expect(brief).toHaveValue('Brief from Finder. ∂ café'))
    expect(m.readText).toHaveBeenCalledWith('/Users/me/Desktop/brief.txt')
    act(() => { window.dispatchEvent(new CustomEvent('caprock:drop-paths', { detail: { paths: ['/Users/me/Desktop/a.pdf'], x: 10, y: 10 } })) })
    expect(await screen.findByText('Only a .md or .txt file can be the brief.')).toBeInTheDocument()
    expect(m.readText).toHaveBeenCalledTimes(1)
  })

  it('a click on another card before the sheet has settled is the one chosen', async () => {
    // The cards can be on screen before React has run the sheet's effects; a
    // click in that gap once lost to "choose the first card".
    let release: () => void = () => {}
    m.templates.mockImplementation(() => new Promise((r) => { release = () => r({ templates: [CORPUS, SITE], gh: READY }) }))
    render(<Host />)
    await act(async () => {})
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    g.IS_REACT_ACT_ENVIRONMENT = false // outside act, as a real answer arrives
    try {
      release()
      let site: HTMLElement | null = null
      for (let i = 0; i < 500 && !site; i++) {
        await new Promise((r) => (i < 200 ? queueMicrotask(() => r(null)) : setTimeout(r, 0)))
        site = screen.queryByRole('button', { name: /Site/ })
      }
      expect(site).not.toBeNull()
      site!.click()
    } finally {
      g.IS_REACT_ACT_ENVIRONMENT = true
    }
    await waitFor(() => expect(screen.getByRole('button', { name: /Site/ })).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.getByRole('button', { name: /Corpus/ })).toHaveAttribute('aria-pressed', 'false')
  })
})
