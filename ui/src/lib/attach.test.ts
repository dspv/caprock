import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ATTACH_ACCEPT, PASTE_EXTS, attachLabels, baseName, isPhotoFile } from './attach'

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

  it('tells a photo by type, or by name when the type is empty', () => {
    expect(isPhotoFile({ name: 'IMG_1.HEIC', type: 'image/heic' })).toBe(true)
    expect(isPhotoFile({ name: 'shot.png', type: '' })).toBe(true)
    expect(isPhotoFile({ name: 'notes.md', type: '' })).toBe(false)
  })
})
