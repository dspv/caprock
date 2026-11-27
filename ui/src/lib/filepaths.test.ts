import { describe, expect, it } from 'vitest'
import { baseName, extOf, fileKind, hasFilePath, middleTruncate, pathParts, pathsAsNames } from './filepaths'

const drop = '/Users/me/Library/Application Support/caprock/paste/drop-1795599021771608000/Some_File_Name.pdf'
const files = (t: string) => pathParts(t).flatMap((p) => (p.kind === 'file' ? [p.path] : []))

describe('pathParts — the file paths in a prompt', () => {
  it('chips a quoted PDF as Caprock types a dropped file, the words kept', () => {
    expect(pathParts(`"${drop}" how is my CV?`)).toEqual([
      { kind: 'file', path: drop, raw: `"${drop}"`, file: 'pdf' },
      { kind: 'text', text: ' how is my CV?' },
    ])
  })

  it('takes a single-quoted path, and a double-quoted one with an escaped quote', () => {
    expect(pathParts(`read '/tmp/a b/notes.md' now`)).toEqual([
      { kind: 'text', text: 'read ' },
      { kind: 'file', path: '/tmp/a b/notes.md', raw: `'/tmp/a b/notes.md'`, file: 'text' },
      { kind: 'text', text: ' now' },
    ])
    expect(files(String.raw`"/tmp/the \"final\" cut.pdf" ok`)).toEqual(['/tmp/the "final" cut.pdf'])
  })

  it('takes Windows paths, quoted and bare, either separator', () => {
    expect(pathParts(String.raw`"C:\Users\me\Downloads\My CV.pdf" check`)).toEqual([
      { kind: 'file', path: String.raw`C:\Users\me\Downloads\My CV.pdf`, raw: String.raw`"C:\Users\me\Downloads\My CV.pdf"`, file: 'pdf' },
      { kind: 'text', text: ' check' },
    ])
    expect(files(String.raw`see C:\work\spec.docx and D:/data/rows.csv.`)).toEqual([String.raw`C:\work\spec.docx`, 'D:/data/rows.csv'])
  })

  it('takes a bare path mid-sentence, its escaped spaces unescaped, the full stop left out', () => {
    expect(pathParts(String.raw`compare /Users/me/My\ Report.pdf with the old one.`)).toEqual([
      { kind: 'text', text: 'compare ' },
      { kind: 'file', path: '/Users/me/My Report.pdf', raw: String.raw`/Users/me/My\ Report.pdf`, file: 'pdf' },
      { kind: 'text', text: ' with the old one.' },
    ])
    expect(files('(see /srv/app/main.go)')).toEqual(['/srv/app/main.go'])
    expect(files('open ~/Downloads/invoice.pdf')).toEqual(['~/Downloads/invoice.pdf'])
  })

  it('finds several paths, in order, glued ones included', () => {
    expect(files('"/a/1.pdf" "/a/2.md" /b/c/3.csv compare them')).toEqual(['/a/1.pdf', '/a/2.md', '/b/c/3.csv'])
    expect(files('"/x/20.02.57.pdf""/x/20.03.03.pdf"')).toEqual(['/x/20.02.57.pdf', '/x/20.03.03.pdf'])
  })

  it('leaves non-paths that look like paths as text', () => {
    for (const t of [
      'https://example.com/docs/a.pdf',
      'and/or',
      'src/lib/attach.ts',
      'notes.md',
      '/v1/events/{id}/video',
      '/api/users?id=1.json',
      '/b.pdf',
      '//server/share/a.pdf',
      '"/Users/me/project"',
      '/usr/lib/libc.so.6',
      '/Users/me/.zshrc',
      'C:relative.pdf',
      'μήνυμα 日本 🙂',
    ]) {
      expect(pathParts(t), t).toEqual([{ kind: 'text', text: t }])
      expect(hasFilePath(t)).toBe(false)
    }
    expect(pathParts('')).toEqual([{ kind: 'text', text: '' }])
  })

  it('keeps accented and emoji names whole', () => {
    expect(files('"/tmp/résumé 日本 🙂.pdf"')).toEqual(['/tmp/résumé 日本 🙂.pdf'])
  })
})

describe('pathsAsNames — a one-line preview', () => {
  it('cuts each path to its file name and keeps the words', () => {
    expect(pathsAsNames(`"${drop}" how is my CV?`)).toBe('Some_File_Name.pdf how is my CV?')
    expect(pathsAsNames(String.raw`"C:\a\b.pdf" "/c/d.md" diff`)).toBe('b.pdf d.md diff')
    expect(pathsAsNames('fix the login bug')).toBe('fix the login bug')
    expect(pathsAsNames('https://x.dev/a/b.pdf')).toBe('https://x.dev/a/b.pdf')
  })
})

describe('the name and kind of a file', () => {
  it('reads the extension and the kind', () => {
    expect(extOf('/a/B.PDF')).toBe('pdf')
    expect(extOf('/a/.zshrc')).toBe('')
    expect(extOf('/a/v.12')).toBe('')
    expect(fileKind('/a/b.pdf')).toBe('pdf')
    expect(fileKind('/a/b.png')).toBe('image')
    expect(fileKind('/a/b.mov')).toBe('video')
    expect(fileKind('/a/b.xlsx')).toBe('sheet')
    expect(fileKind('/a/b.unknownx')).toBe('file')
    expect(baseName(String.raw`C:\a\b.pdf`)).toBe('b.pdf')
  })

  it('cuts a long name in the middle, the extension and the end kept', () => {
    expect(middleTruncate('short.pdf')).toBe('short.pdf')
    const cut = middleTruncate('Quarterly_Report_2026_Q3_board_pack_final_v2.pdf', 28)
    expect(Array.from(cut)).toHaveLength(28)
    expect(cut.endsWith('_v2.pdf')).toBe(true)
    expect(cut.startsWith('Quarterly_')).toBe(true)
    expect(cut).toContain('…')
    expect(Array.from(middleTruncate('🙂'.repeat(40) + '.pdf', 12))).toHaveLength(12)
  })
})
