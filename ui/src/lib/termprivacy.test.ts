import { afterEach, describe, expect, it } from 'vitest'
import { findPrivacyRefusal, hidePrivacy, isPrivacyHidden, privacyText } from './termprivacy'

const rows = (...lines: string[]) => lines.map((text) => ({ text, wrapped: false }))

describe('a guarded folder refused', () => {
  it('finds the refusal as ls, cat and Node print it', () => {
    expect(findPrivacyRefusal(rows('ls: /Users/ds/Downloads: Operation not permitted'), 120)).toBe('Downloads')
    expect(findPrivacyRefusal(rows("  ⎿  Error: EPERM: operation not permitted, open '/Users/ds/Downloads/shot.png'"), 120)).toBe('Downloads')
    expect(findPrivacyRefusal(rows('cat: ~/Desktop/notes.txt: Operation not permitted'), 120)).toBe('Desktop')
    expect(findPrivacyRefusal(rows("EPERM: operation not permitted, scandir '/Users/a/Documents'"), 120)).toBe('Documents')
    expect(findPrivacyRefusal(rows('ls: /Users/a/Library/Mobile Documents/com~apple~CloudDocs: Operation not permitted'), 120)).toBe('iCloud Drive')
    expect(findPrivacyRefusal(rows('find: /Users/a/Library/CloudStorage/Dropbox: Operation not permitted'), 120)).toBe('cloud storage')
    expect(findPrivacyRefusal(rows('ls: /Volumes/Share: Operation not permitted'), 120)).toBe('a drive')
  })

  it('wants the refusal and the guarded path on one line', () => {
    expect(findPrivacyRefusal(rows('Operation not permitted', 'ls /Users/ds/Downloads'), 120)).toBeNull()
    expect(findPrivacyRefusal(rows('ls: /Users/ds/dev: Operation not permitted'), 120)).toBeNull()
    expect(findPrivacyRefusal(rows('ls: /Users/ds/DownloadsOld: Operation not permitted'), 120)).toBeNull()
  })

  it('leaves an ordinary permission error alone', () => {
    expect(findPrivacyRefusal(rows('cat: /Users/ds/Downloads/x: Permission denied'), 120)).toBeNull()
    expect(findPrivacyRefusal([], 80)).toBeNull()
  })

  it('finds the line across rows xterm wrapped', () => {
    const line = 'ls: /Users/ds/Downloads: Operation not permitted'
    expect(findPrivacyRefusal([{ text: line.slice(0, 20), wrapped: false }, { text: line.slice(20), wrapped: true }], 20)).toBe('Downloads')
  })
})

describe('the sentence', () => {
  it('names the folder, the program and where the switch is', () => {
    const t = privacyText('Downloads', 'Caprock Terminal')
    expect(t).toContain('out of Downloads')
    expect(t).toContain('Allow Caprock Terminal in System Settings › Privacy & Security › Full Disk Access')
    expect(privacyText('Desktop', '')).toContain('the program in this terminal')
  })
})

describe('× is per session', () => {
  afterEach(() => localStorage.clear())
  it('hides the strip for that session only', () => {
    expect(isPrivacyHidden('s1')).toBe(false)
    hidePrivacy('s1')
    expect(isPrivacyHidden('s1')).toBe(true)
    expect(isPrivacyHidden('s2')).toBe(false)
  })
})
