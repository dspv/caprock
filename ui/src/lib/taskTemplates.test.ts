import { describe, expect, it } from 'vitest'
import type { DetectedCheck } from './api'
import { checksFor, TASK_TEMPLATES, unfilled } from './taskTemplates'

const tpl = (id: string) => TASK_TEMPLATES.find((t) => t.id === id)!

const goRepo: DetectedCheck[] = [
  { command: 'make check', kind: 'all', source: 'Makefile' },
  { command: 'make test', kind: 'test', source: 'Makefile' },
  { command: 'go test ./...', kind: 'test', source: 'go.mod' },
  { command: 'go vet ./...', kind: 'lint', source: 'go.mod' },
]
const nodeRepo: DetectedCheck[] = [
  { command: 'npm test', kind: 'test', source: 'package.json' },
  { command: 'npm run lint', kind: 'lint', source: 'package.json' },
  { command: 'npm run typecheck', kind: 'typecheck', source: 'package.json' },
]

describe('checksFor', () => {
  it('takes the project entry point over the stock command, once per kind', () => {
    expect(checksFor(tpl('fix-tests'), goRepo)).toEqual(['make test'])
  })
  it('prefers the umbrella check for a change that must keep everything green', () => {
    expect(checksFor(tpl('bump-dep'), goRepo)).toEqual(['make check'])
    expect(checksFor(tpl('bump-dep'), nodeRepo)).toEqual(['npm test', 'npm run lint', 'npm run typecheck'])
  })
  it('asks lint and type checks together', () => {
    expect(checksFor(tpl('fix-lint'), nodeRepo)).toEqual(['npm run lint', 'npm run typecheck'])
  })
  it('falls back down the preferences, and to nothing rather than a guess', () => {
    expect(checksFor(tpl('fix-lint'), [{ command: 'make check', kind: 'all', source: 'Makefile' }])).toEqual(['make check'])
    expect(checksFor(tpl('fix-tests'), [])).toEqual([])
  })
  it('gives a blank task the general default', () => {
    expect(checksFor(undefined, nodeRepo)).toEqual(['npm test', 'npm run lint', 'npm run typecheck'])
  })
})

describe('templates', () => {
  it('name every placeholder they use, and carry no budget', () => {
    for (const t of TASK_TEMPLATES) {
      const used = new Set([...(t.title + t.prompt).matchAll(/<[a-z]+>/g)].map((m) => m[0]))
      expect([...used].sort()).toEqual([...t.placeholders].sort())
      expect(Object.keys(t)).not.toContain('budget_usd')
    }
  })
  it('report what is still unfilled', () => {
    expect(unfilled(tpl('bump-dep'), 'Upgrade react to <version>', '')).toEqual(['<version>'])
    expect(unfilled(undefined, '<anything>')).toEqual([])
  })
})
