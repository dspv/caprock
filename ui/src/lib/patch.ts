/** One row of a unified diff, numbered on both sides where it has a side. */
export interface PatchLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'
  text: string
  /** Line number in the old file: context and removed lines. */
  old?: number
  /** Line number in the new file: context and added lines. For a removed line,
   *  the new-file line it sat above — what "around line N" means to an agent
   *  reading the file as it is now. */
  at?: number
  new?: number
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Header lines the file row already says: the path twice and the blob ids. */
const REDUNDANT = /^(diff --git |index |--- |\+\+\+ )/

/**
 * Splits a unified diff into numbered rows.
 *
 * The header lines before the first hunk are dropped except for the ones that
 * say something the file row does not (a new mode, a rename, a binary note).
 */
export function parsePatch(patch: string): PatchLine[] {
  const out: PatchLine[] = []
  let oldN = 0
  let newN = 0
  let inHunk = false
  const lines = patch.endsWith('\n') ? patch.slice(0, -1).split('\n') : patch.split('\n')
  for (const text of lines) {
    const h = HUNK.exec(text)
    if (h) {
      oldN = Number(h[1])
      newN = Number(h[2])
      inHunk = true
      out.push({ kind: 'hunk', text })
      continue
    }
    if (!inHunk) {
      if (!REDUNDANT.test(text)) out.push({ kind: 'meta', text })
      continue
    }
    if (text.startsWith('+')) out.push({ kind: 'add', text, new: newN, at: newN++ })
    else if (text.startsWith('-')) out.push({ kind: 'del', text, old: oldN++, at: newN })
    else if (text.startsWith(' ') || text === '') out.push({ kind: 'ctx', text, old: oldN++, new: newN, at: newN++ })
    else out.push({ kind: 'meta', text })
  }
  return out
}
