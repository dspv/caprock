/**
 * Settings search (owner, 2026-10-18, translated: "the settings menu is
 * already complicated — there's no search").
 *
 * The index is the page itself: each `[data-settings-section]` section's
 * title and every piece of text inside it — labels, hints, button names,
 * placeholders and aria-labels — read from the rendered DOM, so a new option
 * is found the day it is drawn, with nothing to keep in sync. A folded
 * section has no body on the page; what it said the last time it was open is
 * kept in memory, and until then its title and the synonyms below find it.
 *
 * Pure apart from `indexPage`, `findTarget` and `highlight`, which read the
 * DOM; `searchSections` is what the tests drive.
 */

/** Dispatched on window by ⌘F (Ctrl+Shift+F off macOS) when Settings is in front of the app (AppShell). */
export const SETTINGS_FIND_EVENT = 'caprock:settings-find'

export interface SectionIndex {
  id: string
  title: string
  /** The section's texts, in page order, each as written. */
  entries: string[]
}

export interface SectionMatch {
  id: string
  title: string
  /** The text inside the section that matched; absent when the title or a synonym did. */
  hit?: string
}

/**
 * Words people type for a section whose title says it differently. A typed
 * word finds the sections whose title matches the pattern; it matches a word
 * here when it is that word, or the start of it from three letters on.
 */
const SYNONYMS: [words: string[], title: RegExp][] = [
  [['token', 'bot', 'botfather', 'telegram', 'alert', 'alerts', 'message'], /^telegram$/i],
  [['chat', 'reply', 'telegram'], /talk to your agents/i],
  [['phone', 'mobile', 'iphone', 'android', 'tablet', 'qr', 'pair', 'pairing', 'remote', 'anywhere', 'tailscale'], /use on your phone/i],
  [['theme', 'dark', 'light', 'colour', 'color', 'palette', 'mode', 'sidebar', 'zoom', 'scale', 'size'], /appearance/i],
  [['font', 'shell', 'cursor', 'scrollback'], /^terminal$/i],
  [['keys', 'shortcut', 'shortcuts', 'hotkey', 'keyboard', 'chord'], /shortcut|hotkey|keyboard/i],
  [['licence', 'license', 'premium', 'pay', 'paid', 'price', 'pro', 'max', 'billing'], /plan & licence/i],
  [['account', 'login', 'signin', 'sign', 'profile'], /subscriptions/i],
  [['notification', 'notify', 'sound', 'banner'], /notifications/i],
  [['sleep', 'awake', 'caffeinate', 'lid'], /keep awake/i],
  [['update', 'upgrade', 'version', 'release'], /^updates$|about this install/i],
  [['disk', 'database', 'space', 'storage', 'cleanup'], /^storage$/i],
  [['git', 'pull', 'ci', 'actions'], /github/i],
  [['ide', 'vscode', 'code', 'zed', 'open'], /^editor$/i],
  [['limit', 'quota', 'pause', 'window'], /plan limit/i],
  [['brain', 'graph', 'notes'], /second brain/i],
  [['memory', 'remember'], /memory between sessions/i],
  [['prompt', 'prompts', 'snippet', 'command', 'commands'], /saved prompts/i],
  [['template', 'scaffold'], /project templates/i],
  [['privacy', 'telemetry', 'data', 'tracking'], /privacy/i],
  [['agent', 'agents', 'codex', 'gemini', 'opencode'], /custom agents|own coding agents|new sessions/i],
  [['permission', 'permissions', 'bypass', 'dangerous', 'model'], /new sessions/i],
  [['worktree', 'worktrees', 'branch'], /worktrees/i],
  [['folder', 'directory', 'path'], /default folder|projects/i],
  [['statusline', 'status'], /status line/i],
  [['browser', 'web'], /browser/i],
  [['close', 'tab'], /closing a tab/i],
]

/** Lower case, accents off, one space between words: what is compared. */
export function fold(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function synonymHits(term: string, title: string): boolean {
  for (const [words, re] of SYNONYMS) {
    if (!re.test(title)) continue
    if (words.some((w) => w === term || (term.length >= 3 && w.startsWith(term)))) return true
  }
  return false
}

/**
 * The sections a query finds, best first: the whole query in the title, then
 * every word in the title or a synonym of it, then the whole query in one
 * text inside, then every word somewhere in the section. Ties keep the
 * page's order. An empty query finds nothing (the caller shows everything).
 */
export function searchSections(index: SectionIndex[], query: string): SectionMatch[] {
  const q = fold(query)
  if (!q) return []
  const terms = q.split(' ')
  const ranked: { m: SectionMatch; rank: number; at: number }[] = []
  index.forEach((s, at) => {
    const title = fold(s.title)
    const folded = s.entries.map(fold)
    const whole = folded.findIndex((e) => e.includes(q))
    let rank = -1
    let hit: string | undefined
    if (title.includes(q)) rank = 0
    else if (terms.every((t) => title.includes(t) || synonymHits(t, s.title))) rank = 1
    else if (whole >= 0) { rank = 2; hit = s.entries[whole] }
    else if (terms.every((t) => title.includes(t) || synonymHits(t, s.title) || folded.some((e) => e.includes(t)))) {
      rank = 3
      const first = terms.find((t) => !title.includes(t))
      const i = first ? folded.findIndex((e) => e.includes(first)) : -1
      if (i >= 0) hit = s.entries[i]
    }
    if (rank >= 0) ranked.push({ m: { id: s.id, title: s.title, hit }, rank, at })
  })
  return ranked.sort((a, b) => a.rank - b.rank || a.at - b.at).map((r) => r.m)
}

/** What a folded section said the last time it was open, by id. */
const seen = new Map<string, string[]>()

/** Attributes a control is named by when it has no text of its own. */
const NAMED = ['aria-label', 'placeholder', 'title'] as const

/** A section's texts, the drawn ones first: the line a result shows is one
 *  on screen, an explanation hidden by *Show explanations* only after them. */
function textsOf(section: Element): string[] {
  const drawn: string[] = []
  const hidden: string[] = []
  const add = (t: string | null | undefined, el: Element | null) => {
    const v = t?.replace(/\s+/g, ' ').trim()
    if (!v || v.length < 2) return
    const to = el && rendered(el) ? drawn : hidden
    if (to[to.length - 1] !== v) to.push(v)
  }
  const walk = document.createTreeWalker(section, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  for (let n: Node | null = walk.currentNode; n; n = walk.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) add(n.nodeValue, n.parentElement)
    else if (!(n as Element).hasAttribute('data-explain-toggle')) for (const a of NAMED) add((n as Element).getAttribute(a), n as Element)
  }
  return [...drawn, ...hidden]
}

/** Whether a section shows its body: its title's fold button says so. */
function isOpen(section: Element): boolean {
  return section.querySelector('header [aria-expanded]')?.getAttribute('aria-expanded') !== 'false'
}

/** The page's sections, each with its texts (a folded one with what it said when open). */
export function indexPage(root: HTMLElement): SectionIndex[] {
  return [...root.querySelectorAll<HTMLElement>('[data-settings-section]')].map((s) => {
    const title = s.dataset.settingsSection ?? ''
    let entries: string[]
    if (isOpen(s)) {
      entries = textsOf(s)
      seen.set(s.id, entries)
    } else entries = seen.get(s.id) ?? []
    return { id: s.id, title, entries }
  })
}

const BLOCK = 'label, button, summary, a, [role="radiogroup"], li, p, h2, h3, dt, dd, [data-secret-input]'

function rendered(el: Element): boolean {
  return el.getClientRects().length > 0
}

/**
 * The control in a section a hit names: the label, button or line holding
 * that text, opening any `<details>` it is folded in, and climbing to what
 * is drawn when the text itself is hidden (an explanation, with explanations
 * off). The section itself when nothing names it.
 */
export function findTarget(section: HTMLElement, hit?: string): HTMLElement {
  if (!hit) return section
  const want = fold(hit)
  const found: Element[] = []
  const walk = document.createTreeWalker(section, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  for (let n: Node | null = walk.currentNode; n; n = walk.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      if (n.parentElement && n.nodeValue && fold(n.nodeValue).includes(want)) found.push(n.parentElement)
    } else if (!(n as Element).hasAttribute('data-explain-toggle') && NAMED.some((a) => fold((n as Element).getAttribute(a) ?? '').includes(want))) found.push(n as Element)
  }
  // The first place the text is drawn; a hidden explanation only when the
  // text is nowhere else, and then the label or line around it, never a
  // whole panel.
  for (const f of found) {
    for (let d = f.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true
    const el = f.closest(BLOCK) ?? f
    if (rendered(el)) return el as HTMLElement
  }
  for (const f of found) {
    for (let el = f.parentElement?.closest(BLOCK); el && section.contains(el); el = el.parentElement?.closest(BLOCK)) {
      if (rendered(el)) return el as HTMLElement
    }
  }
  return section
}

/** Light a control for a moment: where a jump landed. */
export function flash(el: HTMLElement): void {
  el.scrollIntoView?.({ block: 'center' })
  el.dataset.settingsFlash = ''
  setTimeout(() => { delete el.dataset.settingsFlash }, 1600)
}

const HIGHLIGHT = 'settings-search'

/**
 * Mark every place the query's words appear in the sections shown, through
 * the CSS Custom Highlight API: nothing in the page is rewritten, so React's
 * nodes stay its own. An engine without the API simply marks nothing.
 */
export function highlight(root: HTMLElement | null, query: string): void {
  const reg = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights
  const H = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight
  if (!reg || !H) return
  reg.delete(HIGHLIGHT)
  const terms = fold(query).split(' ').filter((t) => t.length > 0)
  if (!root || terms.length === 0) return
  const ranges: Range[] = []
  for (const s of root.querySelectorAll<HTMLElement>('[data-settings-section]:not([hidden])')) {
    const walk = document.createTreeWalker(s, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n && ranges.length < 400; n = walk.nextNode()) {
      const text = (n.nodeValue ?? '').toLowerCase()
      for (const t of terms) {
        for (let i = text.indexOf(t); i >= 0 && ranges.length < 400; i = text.indexOf(t, i + t.length)) {
          const r = document.createRange()
          r.setStart(n, i)
          r.setEnd(n, i + t.length)
          ranges.push(r)
        }
      }
    }
  }
  if (ranges.length) reg.set(HIGHLIGHT, new H(...ranges))
}
