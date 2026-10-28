/**
 * Share any dashboard panel (.ai/04-ui.md § Share, "Any panel"; owner,
 * 2026-10-28, translated: "I want to be able to share every block, in any
 * convenient form").
 *
 * The parts that are not React: which names a panel shows, how they are
 * hidden, and the words and file names that go with a panel's picture.
 *
 * **Hide project names** is on by default and remembered per viewer. On, every
 * project, repository, session title, branch and folder the panel names
 * becomes "project 1", "session 2", "branch 1", "folder 1"… — and a pull
 * request's title and a GitHub login "pull request 1", "person 1" — numbered in the
 * order the panel lists them, the same number in the picture and in the text
 * of one export. Costs, counts and everything else stay. A panel says which
 * names it shows (`names()`); the picture is then swept for those strings,
 * and the text is written through the same aliaser, so the two agree.
 */

/** What a name is, which decides the word it is replaced with. */
export type ShareNameKind = 'project' | 'session' | 'branch' | 'folder' | 'pull request' | 'person'

export interface ShareName {
  kind: ShareNameKind
  value: string | undefined | null
}

/** A name as an export writes it: the name itself, or its stand-in. */
export type Alias = (kind: ShareNameKind, value: string | undefined | null) => string

/** What a panel offers its share menu, registered from inside its body. */
export interface PanelShareData {
  /** Every name the panel shows, in the order it shows them. */
  names?: () => ShareName[]
  /** The panel as Markdown; without it the menu has no Copy as text. */
  toText?: (alias: Alias) => string
}

/** The viewer's Hide project names choice; on unless they turned it off. */
export const HIDE_NAMES_KEY = 'caprock.panelShare.hideNames'

export function loadHideNames(): boolean {
  try { return localStorage.getItem(HIDE_NAMES_KEY) !== 'off' } catch { return true }
}

export function saveHideNames(on: boolean): void {
  try { localStorage.setItem(HIDE_NAMES_KEY, on ? 'on' : 'off') } catch { /* a convenience */ }
}

/** The shortest a name may be and still be swept from the picture: one letter would eat ordinary words. */
const MIN_SWEEP = 2

/**
 * The aliaser for one export. With `hide` off it is the identity. On, each
 * distinct value of a kind gets the next number of that kind, in the order
 * first seen — `names` first, so the picture and the text number alike.
 */
export class Aliaser {
  private readonly map = new Map<string, string>()
  private readonly next: Record<ShareNameKind, number> = { project: 0, session: 0, branch: 0, folder: 0, 'pull request': 0, person: 0 }
  constructor(readonly hide: boolean, names: ShareName[] = []) {
    for (const n of names) this.alias(n.kind, n.value)
  }

  alias: Alias = (kind, value) => {
    const v = (value ?? '').trim()
    if (!this.hide || !v) return v
    // One value is one stand-in whatever kind asked first: a repository named
    // like its project must not read as two different things.
    const got = this.map.get(v)
    if (got) return got
    const a = `${kind} ${++this.next[kind]}`
    this.map.set(v, a)
    return a
  }

  /** Every name this export hides and its stand-in, longest first. */
  pairs(): [string, string][] {
    return [...this.map.entries()].filter(([v]) => v.length >= MIN_SWEEP).sort((a, b) => b[0].length - a[0].length)
  }

  /**
   * `text` with every known name replaced, where it stands as a whole: not
   * inside a longer word ("ui" in "build"), but beside a slash, a space or a
   * dot it is still the name.
   */
  sweep(text: string): string {
    const re = this.pattern()
    return re ? text.replace(re, (m) => this.map.get(m) ?? m) : text
  }

  private re?: RegExp | null
  private pattern(): RegExp | null {
    if (this.re !== undefined) return this.re
    const pairs = this.pairs()
    this.re = pairs.length
      ? new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${pairs.map(([v]) => escapeRe(v)).join('|')})(?![\\p{L}\\p{N}_-])`, 'gu')
      : null
    return this.re
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every text node under `root` swept of the names (the picture's clone, never
 * the screen). Text inside `[data-share-keep]` — the panel's own title — is
 * left: a project called "Repos" must not rename the Repos panel.
 */
export function hideNamesIn(root: Node, aliaser: Aliaser): void {
  if (!aliaser.hide || aliaser.pairs().length === 0) return
  const doc = root.ownerDocument ?? document
  const walk = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.parentElement?.closest('[data-share-keep]')) nodes.push(n as Text)
  }
  for (const t of nodes) {
    const v = t.nodeValue ?? ''
    const s = aliaser.sweep(v)
    if (s !== v) t.nodeValue = s
  }
}

/** A Markdown table: a header row and the rows, pipes in cells escaped. */
export function mdTable(head: string[], rows: (string | number)[][]): string {
  const cell = (c: string | number) => String(c).replace(/\|/g, '\\|').replace(/\n/g, ' ')
  return [
    `| ${head.map(cell).join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n')
}

/** The heading and footer every panel's text carries. */
export function panelText(title: string, body: string, at = new Date()): string {
  return `## ${title}\n\n${body.trim()}\n\n${shareStamp(at)} · via caprock.dev\n`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "28 Oct 2026, 14:05": when the picture was taken. */
export function shareStamp(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`
}

/** "caprock-live-pulse-2026-10-28.png". */
export function panelFileName(title: string, at = new Date(), ext = 'png'): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'panel'
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
  return `caprock-${slug}-${day}.${ext}`
}

/** The post's first draft: the panel's name, then how it was tracked. Counts stay on the picture. */
export function panelPostText(title: string): string {
  return `${title}, from my Caprock dashboard.\n\nTracked on my own machine with Caprock — free and open source.`
}
