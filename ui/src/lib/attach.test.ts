import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import { ATTACH_ACCEPT, ATTACH_LIMIT_BYTES, PASTE_EXTS, attachLabels, attachRefusal, attachRefusalOf, baseName, isPhotoFile } from './attach'

/** The extensions in paste.go's pasteKinds, in order. */
function goExts(): string[] {
  const src = readFileSync(resolve(__dirname, '../../../internal/api/paste.go'), 'utf8')
  const table = src.slice(src.indexOf('var pasteKinds'), src.indexOf('// pasteExts is'))
  const out: string[] = []
  for (const [, list = ''] of table.matchAll(/\[\]string\{([^}]*)\}/g)) {
    for (const [, ext = ''] of list.matchAll(/"([^"]+)"/g)) out.push(ext)
  }
  return out
}

describe('attach — what a phone may attach', () => {
  it('lists exactly the extensions the daemon accepts (paste.go pasteKinds)', () => {
    const go = goExts()
    expect(go.length).toBeGreaterThan(20)
    expect([...PASTE_EXTS]).toEqual(go)
  })

  it('accepts every image and each allowed extension, Markdown among them', () => {
    const parts = ATTACH_ACCEPT.split(',')
    expect(parts[0]).toBe('image/*')
    expect(parts).toContain('.md')
    expect(parts).toContain('.pdf')
    expect(parts).not.toContain('.exe')
    expect(parts).toHaveLength(PASTE_EXTS.length + 1)
  })

  it('numbers images among images only; any other file is its name', () => {
    expect(attachLabels(['/p/a.png', '/p/x/notes.md', '/p/b.JPG', 'C:\\d\\spec.pdf'])).toEqual(['Image 1', 'notes.md', 'Image 2', 'spec.pdf'])
    expect(baseName('/a/b c/d.txt')).toBe('d.txt')
  })

  // Owner, 2026-10-23: the daemon's refusal was six red lines on a phone.
  it('says a refusal in one short line: the type, the size, or the daemon as it is', () => {
    const type = new ApiError(415, 'Unsupported Media Type', { error: 'unsupported file type: .exe', detail: 'accepted: images (png, jpg); PDF (pdf); …' })
    expect(attachRefusal({ name: 'setup.exe', size: 2 }, type)).toBe("setup.exe can't be attached: .exe isn't a supported type. Photos, PDFs, text, Markdown, office, data and source files can.")
    const none = new ApiError(415, 'Unsupported Media Type', { error: 'unsupported file type: a file with no extension', detail: 'accepted: …' })
    expect(attachRefusal({ name: 'Makefile' }, none)).toBe("Makefile can't be attached: a file with no extension isn't supported. Photos, PDFs, text, Markdown, office, data and source files can.")
    const big = new ApiError(413, 'Request Entity Too Large', { error: 'file is larger than 10 MB', detail: 'attach it by path instead' })
    expect(attachRefusal({ name: 'big.pdf' }, big)).toBe('big.pdf is over 10 MB')
    // Past the limit, whatever the daemon answered (its body cap says "bad request").
    expect(attachRefusal({ name: 'big.pdf', size: ATTACH_LIMIT_BYTES + 1 }, new ApiError(400, 'Bad Request', { error: 'bad request' }))).toBe('big.pdf is over 10 MB')
    const other = new ApiError(500, 'Internal Server Error', { error: 'cannot write', detail: 'disk full' })
    expect(attachRefusal({ name: 'a.md' }, other)).toBe('a.md: not added — cannot write — disk full')
  })

  it('finds which of several files the Inbox refused, by its extension or its size', () => {
    const files = [{ name: 'a.png', size: 10 }, { name: 'B.EXE', size: 10 }, { name: 'huge.pdf', size: ATTACH_LIMIT_BYTES + 5 }]
    expect(attachRefusalOf(files, new ApiError(415, 'x', { error: 'unsupported file type: .exe' }))).toMatch(/^B\.EXE can't be attached: \.exe isn't/)
    expect(attachRefusalOf(files, new ApiError(413, 'x', { error: 'file is larger than 10 MB' }))).toBe('huge.pdf is over 10 MB')
    expect(attachRefusalOf(files, new ApiError(400, 'x', { error: 'the text is longer than 16 KiB' }))).toBe('the text is longer than 16 KiB')
  })

  it('tells a photo by type, or by name when the type is empty', () => {
    expect(isPhotoFile({ name: 'IMG_1.HEIC', type: 'image/heic' })).toBe(true)
    expect(isPhotoFile({ name: 'shot.png', type: '' })).toBe(true)
    expect(isPhotoFile({ name: 'notes.md', type: '' })).toBe(false)
  })
})
