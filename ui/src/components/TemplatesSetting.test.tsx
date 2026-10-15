/** Settings → Project templates: the list, a change sent as only what changed, a delete. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Template } from '@/lib/templates'

const m = vi.hoisted(() => ({ templates: vi.fn(), update: vi.fn(), remove: vi.fn() }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      templates: () => m.templates(),
      updateTemplate: (id: string, t: unknown) => m.update(id, t),
      removeTemplate: (id: string) => m.remove(id),
      agentCatalog: async () => ({ agents: [{ id: 'claude', label: 'Claude Code', installed: true, ready: true, models: [], observed: true, prompt: true }, { id: 'codex', label: 'Codex', installed: true, ready: true, models: [], observed: true, prompt: true }], licensed: true, home: '/Users/me' }),
    },
  }
})
vi.mock('@/lib/appmode', async (orig) => ({ ...(await orig<typeof import('@/lib/appmode')>()), isMacPlatform: () => false }))

import { TemplatesSetting, templatePatch } from './TemplatesSetting'

const CORPUS: Template = { id: 'a1b2c3d4', name: 'Corpus', github: 'dspv/corpus', brief_path: 'docs/source-spec.md', prompt: 'Build from {brief}.', agent: 'claude', created_at: 1 }
const SITE: Template = { id: 'e5f6a7b8', name: 'Site', folder: '/Users/me/templates/site', brief_path: 'docs/brief.md', prompt: 'Read {brief}.', created_at: 2 }

beforeEach(() => {
  m.templates.mockReset().mockResolvedValue({ templates: [CORPUS, SITE], gh: { installed: true, logged_in: true, login: 'dspv' } })
  m.update.mockReset().mockImplementation(async (id: string, t: object) => ({ template: { ...CORPUS, id, ...t } }))
  m.remove.mockReset().mockResolvedValue(undefined)
})

describe('Settings → Project templates', () => {
  it('lists each with where it is, where the brief goes and its agent; the key spelled for this OS', async () => {
    render(<TemplatesSetting />)
    const list = await screen.findByRole('list', { name: 'Project templates' })
    expect(list).toHaveTextContent('Corpus · Claude Code')
    expect(list).toHaveTextContent('github.com/dspv/corpus · brief → docs/source-spec.md')
    await waitFor(() => expect(list).toHaveTextContent('~/templates/site · brief → docs/brief.md'))
    expect(list).toHaveTextContent('Site · any agent')
    expect(screen.getByText(/New project from a template…/).parentElement).toHaveTextContent('(Ctrl+Shift+K, or New project')
  })

  it('says when there are none', async () => {
    m.templates.mockResolvedValue({ templates: [], gh: { installed: false, logged_in: false } })
    render(<TemplatesSetting />)
    expect(await screen.findByText(/^No templates yet\. Add one from New project/)).toBeInTheDocument()
  })

  it('edits one, sending only what changed; a GitHub link is read as owner/name', async () => {
    render(<TemplatesSetting />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[0]!)
    fireEvent.change(screen.getByRole('textbox', { name: 'GitHub' }), { target: { value: 'https://github.com/dspv/corpus2.git' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief goes to' }), { target: { value: 'docs/spec.md' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(m.update).toHaveBeenCalledWith('a1b2c3d4', { github: 'dspv/corpus2', brief_path: 'docs/spec.md' }))
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
  })

  it('refuses a GitHub field that is not a repository', async () => {
    render(<TemplatesSetting />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[0]!)
    fireEvent.change(screen.getByRole('textbox', { name: 'GitHub' }), { target: { value: 'gitlab.com/x/y' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('owner/name')
    expect(m.update).not.toHaveBeenCalled()
  })

  it('deletes one', async () => {
    render(<TemplatesSetting />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Site' }))
    await waitFor(() => expect(m.remove).toHaveBeenCalledWith('e5f6a7b8'))
    expect(m.templates).toHaveBeenCalledTimes(2)
  })

  it('a cleared field is sent as "" so the daemon clears it', () => {
    expect(templatePatch(CORPUS, { name: 'Corpus', github: '', folder: '/t', brief_path: 'docs/source-spec.md', prompt: 'Build from {brief}.', agent: '' }))
      .toEqual({ github: '', folder: '/t', agent: '' })
  })
})
