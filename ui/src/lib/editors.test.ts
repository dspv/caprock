import { describe, expect, it } from 'vitest'
import { firstChangedLine, joinPath, preferredName } from './editors'

describe('open in editor helpers', () => {
  it('reads the first changed line from the first hunk', () => {
    expect(firstChangedLine('diff --git a/x b/x\n@@ -12,4 +14,6 @@ func x()\n-a\n+b\n@@ -40 +44 @@\n')).toBe(14)
    expect(firstChangedLine('@@ -0,0 +1 @@\n+new')).toBe(1)
    expect(firstChangedLine('@@ -3,2 +0,0 @@\n-gone')).toBe(0)
    expect(firstChangedLine(undefined)).toBe(0)
    expect(firstChangedLine('Binary files differ')).toBe(0)
  })

  it('joins a diff path onto its checkout', () => {
    expect(joinPath('/w/app/', '/ui/src/App.tsx')).toBe('/w/app/ui/src/App.tsx')
    expect(joinPath('/w/app', 'go.mod')).toBe('/w/app/go.mod')
  })

  it('names the default editor, else the first', () => {
    const editors = [{ id: 'vscode', name: 'VS Code' }, { id: 'zed', name: 'Zed' }]
    expect(preferredName({ editors, preferred: 'zed' })).toBe('Zed')
    expect(preferredName({ editors, preferred: '' })).toBe('VS Code')
  })
})
