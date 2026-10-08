import { describe, expect, it } from 'vitest'
import { fileKey, fuzzyScore, isMarkdown, rankFiles, resolveLink } from './files'

describe('where a link in a file points', () => {
  it('opens a web or mail address outside', () => {
    expect(resolveLink('README.md', 'https://caprock.dev/docs')).toEqual({ external: 'https://caprock.dev/docs' })
    expect(resolveLink('README.md', 'mailto:who@example.com')).toEqual({ external: 'mailto:who@example.com' })
  })

  it('resolves a relative link against the file, dropping its anchor', () => {
    expect(resolveLink('docs/app.md', './setup.md#install')).toEqual({ file: 'docs/setup.md' })
    expect(resolveLink('docs/app.md', '../CHANGELOG.md')).toEqual({ file: 'CHANGELOG.md' })
    expect(resolveLink('docs/app.md', '/README.md')).toEqual({ file: 'README.md' })
    expect(resolveLink('README.md', 'docs/a%20b.md')).toEqual({ file: 'docs/a b.md' })
  })

  it('refuses a link out of the worktree, an anchor alone and any other scheme', () => {
    expect(resolveLink('README.md', '../outside.md')).toBeNull()
    expect(resolveLink('README.md', '#usage')).toBeNull()
    expect(resolveLink('README.md', 'javascript:alert(1)')).toBeNull()
    expect(resolveLink('README.md', '//evil.example/x')).toBeNull()
  })
})

describe('the file filter', () => {
  const files = ['internal/api/files.go', 'internal/api/files_test.go', 'ui/src/components/FileView.tsx', 'README.md', 'docs/app.md']

  it('matches a subsequence and refuses the rest', () => {
    expect(fuzzyScore('fv', 'ui/src/components/FileView.tsx')).toBeGreaterThan(0)
    expect(fuzzyScore('zz', 'README.md')).toBe(0)
  })

  it('puts a match in the file name before one spread over the folders', () => {
    expect(rankFiles(files, 'files')[0]).toBe('internal/api/files.go')
    expect(rankFiles(files, 'readme')).toEqual(['README.md'])
    expect(rankFiles(files, 'app')[0]).toBe('docs/app.md')
  })

  it('caps what it returns', () => {
    expect(rankFiles(files, '', 2)).toHaveLength(2)
  })
})

describe('naming', () => {
  it('keys a file by project, worktree and path', () => {
    expect(fileKey('7', '', 'README.md')).not.toBe(fileKey('7', 'feat', 'README.md'))
  })
  it('knows Markdown by its language or its extension', () => {
    expect(isMarkdown('a.MDX')).toBe(true)
    expect(isMarkdown('notes', 'markdown')).toBe(true)
    expect(isMarkdown('main.go', 'go')).toBe(false)
  })
})
