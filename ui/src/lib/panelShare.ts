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
 *
 * A name also hides where it shows in part: a folder's last segment (and the
 * repository a worktree sits in) and a GitHub slug's two halves are swept as
 * names of their own, in any letter case. An element marked
 * `data-share-name="<kind>"` is a name whatever it says (a branch the panel
 * read late); one marked `data-share-activity` is a line of what a session
 * does ("editing x.go", "running git push origin feat/y"), whose file names
 * and paths become "file 1", "path 1".
 *
 * What is not the panel's content (a fold chevron, a More toggle, a Hide or
 * Settings link, a hover-only button, a tooltip) is marked `data-share-skip`
 * or matched by SHARE_CHROME, and is left out of the picture.
 */

/** What a name is, which decides the word it is replaced with. */
export type ShareNameKind = 'project' | 'session' | 'branch' | 'folder' | 'pull request' | 'person' | 'file' | 'path'

const KINDS: readonly ShareNameKind[] = ['project', 'session', 'branch', 'folder', 'pull request', 'person', 'file', 'path']

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
 * first seen — `names` first, so the picture and the text number alike; then
 * the parts of those names that name the project too (`partsOf`). Letter case
 * does not make a second name: "Caprock" in a title is "caprock".
 */
export class Aliaser {
  private readonly map = new Map<string, string>()
  private readonly next: Record<ShareNameKind, number> = { project: 0, session: 0, branch: 0, folder: 0, 'pull request': 0, person: 0, file: 0, path: 0 }
  constructor(readonly hide: boolean, names: ShareName[] = []) {
    for (const n of names) this.alias(n.kind, n.value)
    for (const n of names) for (const p of partsOf(n)) this.alias(p.kind, p.value)
  }

  alias: Alias = (kind, value) => {
    const v = (value ?? '').trim()
    if (!this.hide || !v) return v
    // One value is one stand-in whatever kind asked first: a repository named
    // like its project must not read as two different things.
    const key = v.toLowerCase()
    const got = this.map.get(key)
    if (got) return got
    const a = `${kind} ${++this.next[kind]}`
    this.map.set(key, a)
    this.re = undefined
    return a
  }

  /** Every name this export hides (lower-cased) and its stand-in, longest first. */
  pairs(): [string, string][] {
    return [...this.map.entries()].filter(([v]) => v.length >= MIN_SWEEP).sort((a, b) => b[0].length - a[0].length)
  }

  /**
   * `text` with every known name replaced, where it stands as a whole: not
   * inside a longer word ("ui" in "build"), but beside a slash, a space or a
   * dot it is still the name.
   */
  sweep(text: string): string {
    if (!this.hide) return text
    const re = this.pattern()
    return re ? text.replace(re, (m) => this.map.get(m.toLowerCase()) ?? m) : text
  }

  /**
   * An activity line ("editing caprock/internal/api/x.go", "running git push
   * origin feat/y"): every path or branch-like word (one with a slash) becomes
   * "path N", every file name "file N", then the names are swept as anywhere.
   */
  activity(text: string): string {
    if (!this.hide) return text
    const out = text.replace(WORD, (w) => {
      const [, core, tail] = /^(.*?)([.,:;…]*)$/u.exec(w) ?? [w, w, '']
      if (!/\p{L}/u.test(core)) return w
      if (/[/\\]/.test(core)) return this.alias('path', core) + tail
      if (FILE.test(core)) return this.alias('file', core) + tail
      return w
    })
    return this.sweep(out)
  }

  private re?: RegExp | null
  private pattern(): RegExp | null {
    if (this.re !== undefined) return this.re
    const pairs = this.pairs()
    this.re = pairs.length
      ? new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${pairs.map(([v]) => escapeRe(v)).join('|')})(?![\\p{L}\\p{N}_-])`, 'giu')
      : null
    return this.re
  }
}

/** A run of text between spaces and quotes: one word of an activity line. */
const WORD = /[^\s"'“”‘’`()[\]{}<>]+/gu
/** A file name: a stem and an extension that starts with a letter ("x.go", "README.md"), not "v0.16.1". */
const FILE = /^[\p{L}\p{N}_@+-][\p{L}\p{N}_@+.-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/u

/**
 * The parts of a name that give it away on their own: a folder's last
 * segment, and for a worktree the repository folder it sits in (the project,
 * "…/dev/caprock" read as "caprock"); a GitHub slug's owner and repository.
 */
export function partsOf(n: ShareName): ShareName[] {
  const v = (n.value ?? '').trim()
  if (!v) return []
  const segs = v.split(/[/\\]+/).filter(Boolean)
  if (segs.length < 2) return []
  if (n.kind === 'folder' || /^([/\\~]|[A-Za-z]:)/.test(v)) {
    const out: ShareName[] = []
    const wt = segs.findIndex((s, i) => s === 'worktrees' || (s === '.claude' && segs[i + 1] === 'worktrees'))
    if (wt > 0) {
      const repo = segs[wt - 1] === '.claude' ? segs[wt - 2] : segs[wt - 1]
      if (repo) out.push({ kind: 'project', value: repo })
      out.push({ kind: 'folder', value: segs[segs.length - 1] })
    } else {
      out.push({ kind: 'project', value: segs[segs.length - 1] })
    }
    return out
  }
  // owner/name: a GitHub repository.
  if (n.kind === 'project' && segs.length === 2) return [{ kind: 'person', value: segs[0] }, { kind: 'project', value: segs[1] }]
  return []
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every text node under `root` swept of the names (the picture's clone, never
 * the screen). Text inside `[data-share-keep]` — the panel's own title — is
 * left: a project called "Repos" must not rename the Repos panel. An element
 * marked `data-share-name` is replaced whole as that kind of name; text under
 * `data-share-activity` also loses its file names and paths.
 */
export function hideNamesIn(root: Node, aliaser: Aliaser): void {
  if (!aliaser.hide) return
  const el = root as Element
  if (typeof el.querySelectorAll === 'function') {
    for (const n of el.querySelectorAll<HTMLElement>('[data-share-name]')) {
      if (n.closest('[data-share-keep]')) continue
      const kind = n.getAttribute('data-share-name') as ShareNameKind
      const text = (n.textContent ?? '').trim()
      if (text && KINDS.includes(kind)) n.textContent = aliaser.alias(kind, text)
    }
  }
  const doc = root.ownerDocument ?? document
  const walk = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const lines: Text[] = []
  const rest: Text[] = []
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const p = n.parentElement
    if (p?.closest('[data-share-keep]')) continue
    ;(p?.closest('[data-share-activity]') ? lines : rest).push(n as Text)
  }
  // Activity lines first, so a path they hide is swept from the rest too.
  for (const t of lines) {
    const v = t.nodeValue ?? ''
    const s = aliaser.activity(v)
    if (s !== v) t.nodeValue = s
  }
  if (aliaser.pairs().length === 0) return
  for (const t of rest) {
    const v = t.nodeValue ?? ''
    const s = aliaser.sweep(v)
    if (s !== v) t.nodeValue = s
  }
}

/**
 * What is a panel's chrome, not its content, and stays out of its picture:
 * the share button and menu, anything marked `data-share-skip` (fold
 * chevrons, More/Less, Hide, links to Settings), tooltips and hover cards,
 * and controls that show only on hover (`opacity-0` until the panel is hovered).
 */
export const SHARE_CHROME = '[data-panel-share], [data-panel-share-menu], [data-share-skip], [role="tooltip"], [data-stat-hint], .opacity-0'

export function isShareChrome(node: Node): boolean {
  return node.nodeType === 1 && (node as Element).matches(SHARE_CHROME)
}

/** `root` with its chrome taken out (the picture's clone, never the screen). */
export function stripChrome(root: Element): void {
  for (const el of root.querySelectorAll(SHARE_CHROME)) el.remove()
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
