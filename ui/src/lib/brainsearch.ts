/**
 * Second Brain's search, the screen's side (03-contracts.md § Second Brain).
 * The daemon matches and ranks; this finds where a search's terms sit in a
 * title so the list can mark them. It folds text exactly as the daemon's
 * `store.FoldSearch` does — NFKD, the combining accents of U+0300–U+036F
 * dropped, lower case, the final sigma made the ordinary one — so a term the
 * daemon matched is found again here, in any script and any case.
 */

const ACCENTS = /[̀-ͯ]/g

/** One character (a code point), folded. */
function foldChar(ch: string): string {
  const c = ch.charCodeAt(0)
  if (c < 0x80) return c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : ch
  return ch.normalize('NFKD').replace(ACCENTS, '').toLowerCase().replace(/ς/g, 'σ')
}

/** Text folded for matching, as the daemon folds it. */
export function foldSearch(s: string): string {
  let out = ''
  for (const ch of s) out += foldChar(ch)
  return out
}

/**
 * The spans of `text` — [start, end) in UTF-16 offsets, sorted, not
 * overlapping — where any of the folded `terms` occurs, matched on the
 * folded text and mapped back to the original characters.
 */
export function matchRanges(text: string, terms: readonly string[] | undefined): [number, number][] {
  const want = (terms ?? []).filter((t) => t.length > 0)
  if (want.length === 0 || !text) return []
  let folded = ''
  // at[k] is where, in `text`, the character folded into folded[k] starts.
  const at: number[] = []
  let i = 0
  for (const ch of text) {
    const f = foldChar(ch)
    for (let k = 0; k < f.length; k++) at.push(i)
    folded += f
    i += ch.length
  }
  at.push(text.length)
  const found: [number, number][] = []
  for (const t of want) {
    for (let j = folded.indexOf(t); j >= 0; j = folded.indexOf(t, j + t.length)) {
      const start = at[j] ?? 0
      const end = at[j + t.length] ?? text.length
      if (end > start) found.push([start, end])
    }
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const out: [number, number][] = []
  for (const r of found) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}
