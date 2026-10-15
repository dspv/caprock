import { describe, expect, it } from 'vitest'
import {
  failureView, fillPrompt, howMade, howMadeLine, isBriefFile, nameProblem, normalizeGitHub, planLines, progressLine, readyLine, suggestName,
  type GHStatus, type TemplateOp,
} from './templates'

const READY: GHStatus = { installed: true, logged_in: true, login: 'dspv' }
const OUT: GHStatus = { installed: true, logged_in: false, error: 'run gh auth login' }
const NONE: GHStatus = { installed: false, logged_in: false }

describe('normalizeGitHub', () => {
  it.each([
    ['dspv/corpus', 'dspv/corpus'],
    ['  dspv/corpus  ', 'dspv/corpus'],
    ['https://github.com/dspv/corpus', 'dspv/corpus'],
    ['https://github.com/dspv/corpus/', 'dspv/corpus'],
    ['https://github.com/dspv/corpus.git', 'dspv/corpus'],
    ['github.com/dspv/corpus', 'dspv/corpus'],
    ['https://www.github.com/dspv/corpus/tree/main/docs', 'dspv/corpus'],
    ['git@github.com:dspv/corpus.git', 'dspv/corpus'],
    ['ssh://git@github.com/dspv/corpus.git', 'dspv/corpus'],
    ['https://github.com/dspv/corpus?tab=readme', 'dspv/corpus'],
    ['dspv/my.repo_name-2', 'dspv/my.repo_name-2'],
  ])('%s → %s', (input, want) => {
    expect(normalizeGitHub(input)).toBe(want)
  })

  it.each(['', 'corpus', 'https://gitlab.com/dspv/corpus', 'git@gitlab.com:dspv/corpus.git', 'dspv/..', 'bad owner/x', 'dspv/corpus/extra/path', 'https://github.com/dspv'])('refuses %j', (input) => {
    expect(normalizeGitHub(input)).toBeNull()
  })
})

describe('the first prompt', () => {
  it('replaces every {brief} with the path and leaves the rest', () => {
    expect(fillPrompt('Read TEMPLATE.md. Build the corpus from {brief}; keep {brief} as the source.', 'docs/source-spec.md'))
      .toBe('Read TEMPLATE.md. Build the corpus from docs/source-spec.md; keep docs/source-spec.md as the source.')
    expect(fillPrompt('No variable here.', 'docs/brief.md')).toBe('No variable here.')
  })
})

describe('names', () => {
  it('takes what the daemon takes', () => {
    expect(nameProblem('new-corpus')).toBe('')
    expect(nameProblem('my.site_2')).toBe('')
    expect(nameProblem('')).toBe('Name it.')
    expect(nameProblem('..')).not.toBe('')
    expect(nameProblem('a b')).not.toBe('')
    expect(nameProblem('café')).not.toBe('')
    expect(nameProblem('x'.repeat(101))).not.toBe('')
  })
  it('suggests new-<name>, numbered while taken', () => {
    expect(suggestName('corpus', new Set())).toBe('new-corpus')
    expect(suggestName('corpus', new Set(['new-corpus', 'new-corpus-2']))).toBe('new-corpus-3')
    expect(suggestName('my site', new Set())).toBe('new-my-site')
  })
})

describe('how it will be made', () => {
  // The table in lib/templates.ts, row by row.
  it.each([
    ['github, gh signed in', { github: 'dspv/corpus' }, READY, false, 'github', 'github'],
    ['github and folder, gh signed in', { github: 'dspv/corpus', folder: '/t' }, READY, false, 'github', 'github'],
    ['folder only, gh signed in', { folder: '/t' }, READY, false, 'folder', 'local'],
    ['folder only, no gh', { folder: '/t' }, NONE, false, 'folder', 'local'],
    ['github and folder, no gh', { github: 'dspv/corpus', folder: '/t' }, NONE, false, 'no-gh', 'local'],
    ['github with a clone, no gh', { github: 'dspv/corpus', localFolder: '/Users/me/dev/corpus' }, NONE, false, 'no-gh', 'local'],
    ['github only, no gh', { github: 'dspv/corpus' }, NONE, false, 'none', null],
    ['github, gh signed out', { github: 'dspv/corpus', folder: '/t' }, OUT, false, 'signed-out', null],
    ['github, gh signed out, local asked', { github: 'dspv/corpus', folder: '/t' }, OUT, true, 'signed-out', 'local'],
    ['github only, gh signed out, local asked', { github: 'dspv/corpus' }, OUT, true, 'signed-out', null],
    ['gh unknown yet', { github: 'dspv/corpus' }, undefined, false, 'none', null],
  ] as const)('%s', (_, t, gh, local, kind, via) => {
    const h = howMade(t, gh, local)
    expect(h.kind).toBe(kind)
    expect(h.via).toBe(via)
  })

  it('says it in one line', () => {
    const p = { github: 'dspv/corpus', name: 'shop', dest: '~/dev/shop' }
    expect(howMadeLine(howMade({ github: 'dspv/corpus' }, READY), p)).toBe('On GitHub as dspv/shop, from dspv/corpus, then cloned to ~/dev/shop.')
    expect(howMadeLine(howMade({ github: 'dspv/corpus', localFolder: '~/dev/corpus' }, NONE), p)).toContain('Install gh and run `gh auth login` to have one made.')
    const out = howMadeLine(howMade({ github: 'dspv/corpus', localFolder: '~/dev/corpus' }, OUT), p)
    expect(out).toContain('gh is installed but not signed in')
    expect(out).toContain('then Check again — or make it locally from ~/dev/corpus')
    expect(howMadeLine(howMade({ github: 'dspv/corpus' }, NONE), p)).toContain('gh is not installed here')
  })
})

describe('what Create will do and send', () => {
  const base = { name: 'shop', github: 'dspv/corpus', visibility: 'private' as const, dest: '~/dev/shop', briefPath: 'docs/source-spec.md', agent: 'Claude Code', prompt: 'Build the corpus from {brief}.' }
  it('on GitHub: the gh command, the clone, the brief committed and not pushed, the agent; the name and visibility sent', () => {
    const p = planLines({ ...base, via: 'github', login: 'dspv' })
    expect(p.steps.map((s) => (s.code ? `${s.code} — ${s.text}` : s.text))).toEqual([
      'gh repo create dspv/shop --template dspv/corpus --private — makes a private repository on GitHub with your gh login.',
      'Clones it to ~/dev/shop.',
      'Writes your brief to docs/source-spec.md and commits it. Not pushed.',
      'Starts Claude Code there with: “Build the corpus from docs/source-spec.md.”',
    ])
    expect(p.sent).toBe('Sent to GitHub: the name and visibility. Your brief stays on this computer until you push.')
    expect(planLines({ ...base, via: 'github', login: 'dspv', visibility: 'public' }).steps[0]!.code).toContain('--public')
  })
  it('locally: a copy, git init and a commit, the brief, the agent; nothing sent', () => {
    const p = planLines({ ...base, via: 'local', folder: '~/dev/corpus' })
    expect(p.steps.map((s) => s.text)).toEqual([
      'Copies ~/dev/corpus to ~/dev/shop — its last commit, when it is a repository.',
      'Makes it a new repository: git init and one commit.',
      'Writes your brief to docs/source-spec.md and commits it. Not pushed.',
      'Starts Claude Code there with: “Build the corpus from docs/source-spec.md.”',
    ])
    expect(p.steps.some((s) => s.code)).toBe(false)
    expect(p.sent).toBe('Nothing leaves this computer.')
  })
})

const op = (o: Partial<TemplateOp>): TemplateOp => ({ op_id: 'x', kind: 'template', state: 'running', ...o })

describe('progress and failure', () => {
  it('reads each step', () => {
    expect(progressLine(op({ step: 'create' }), 'Claude Code')).toBe('Creating the repository on GitHub…')
    expect(progressLine(op({ step: 'clone', progress: 42 }), 'Claude Code')).toBe('Cloning… 42%')
    expect(progressLine(op({ step: 'clone' }), 'Claude Code')).toBe('Cloning…')
    expect(progressLine(op({ step: 'copy' }), 'Claude Code')).toBe('Copying the template…')
    expect(progressLine(op({ step: 'brief' }), 'Claude Code')).toBe('Writing the brief…')
    expect(progressLine(op({ state: 'done', step: 'add' }), 'Claude Code')).toBe('Starting Claude Code…')
  })
  it('a refused create made nothing', () => {
    const f = failureView(op({ state: 'failed', step: 'create', error: 'Name already exists on this account', retryable: false }))
    expect(f.text).toBe('GitHub did not make the repository: Name already exists on this account. Nothing was created.')
    expect(f.retry).toBe(false)
    expect(f.repoUrl).toBeUndefined()
  })
  it('a failed clone keeps the repository on GitHub, offers the clone again and says it is never deleted', () => {
    const f = failureView(op({ state: 'failed', step: 'clone', error: 'fatal: early EOF', repo: 'dspv/shop', repo_url: 'https://github.com/dspv/shop', dest: '/Users/me/dev/shop', removed: true, retryable: true }), '/Users/me')
    expect(f.text).toBe('The repository is on GitHub (https://github.com/dspv/shop), but the clone failed: fatal: early EOF. ~/dev/shop was removed.')
    expect(f.retry).toBe(true)
    expect(f.repoUrl).toBe('https://github.com/dspv/shop')
    expect(f.keep).toContain('never deletes a GitHub repository')
  })
  it('says the project is ready with its notes', () => {
    expect(readyLine('shop', op({ state: 'done', repo: 'dspv/shop', notes: ['No git identity: set one.'] }))).toBe('shop is ready — github.com/dspv/shop. No git identity: set one.')
    expect(readyLine('shop', op({ state: 'done' }))).toBe('shop is ready')
  })
  it('a brief file is Markdown or text', () => {
    expect(isBriefFile('spec.md')).toBe(true)
    expect(isBriefFile('SPEC.MARKDOWN')).toBe(true)
    expect(isBriefFile('notes.txt')).toBe(true)
    expect(isBriefFile('shot.png')).toBe(false)
    expect(isBriefFile('spec.md.exe')).toBe(false)
  })
})
