import { describe, expect, it } from 'vitest'
import { parsePatch } from './patch'

describe('parsePatch', () => {
  it('numbers both sides and drops the header the file row already says', () => {
    const rows = parsePatch('diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -10,3 +10,3 @@ func f\n ctx\n-old\n+new\n')
    expect(rows.map((r) => r.kind)).toEqual(['hunk', 'ctx', 'del', 'add'])
    expect(rows[1]).toMatchObject({ old: 10, new: 10, at: 10 })
    // A removed line points at the new-file line it sat above.
    expect(rows[2]).toMatchObject({ old: 11, at: 11 })
    expect(rows[2]?.new).toBeUndefined()
    expect(rows[3]).toMatchObject({ new: 11, at: 11 })
  })

  it('keeps header lines that say something, and the truncation marker', () => {
    const rows = parsePatch('diff --git a/x b/x\nnew file mode 100644\n@@ -0,0 +1 @@\n+a\n… [patch truncated]\n')
    expect(rows[0]).toMatchObject({ kind: 'meta', text: 'new file mode 100644' })
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'meta', text: '… [patch truncated]' })
  })
})
