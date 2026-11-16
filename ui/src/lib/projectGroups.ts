/**
 * The Per project list, folded into what a person calls a project.
 *
 * Agents run in throwaway folders named `<stem>-<random>`: 34 rows of
 * `ops-seo-boe0i4bn/caprock-web` at $1–2 each buried the eight that matter
 * (owner, 2026-11-16). Those become one row per stem. Chats started outside
 * any project become one row, and so do sessions started in `/` or in a
 * bare subfolder such as `src`, whose project the name cannot tell.
 */

export interface ProjectCost {
  project: string
  tokens: number
  cost_usd: number
}

export interface ProjectGroup extends ProjectCost {
  /** The display name: the project, `ops-seo-*` plus its subfolder, `chats`, `other folders`. */
  label: string
  /** The project names folded into this row; one for a plain project. */
  members: string[]
}

// A random suffix holds a digit or an underscore, which keeps a real name
// like `bloq-frontend` out; two members with the same stem are needed too.
const TEMP = /^(.+)-([a-z0-9_]{8})(\/.*)?$/i
const CHAT = /^chat · /
const BARE = new Set(['/', 'src', 'content', 'lib', 'docs', 'scripts', 'tmp', 'build', 'dist', 'test', 'tests'])

function keyOf(name: string): { key: string; label: string } | null {
  if (CHAT.test(name)) return { key: '\0chats', label: 'chats' }
  if (BARE.has(name)) return { key: '\0other', label: 'other folders' }
  const m = TEMP.exec(name)
  if (m && /[\d_]/.test(m[2]!)) return { key: `${m[1]}-*${m[3] ?? ''}`, label: `${m[1]}-*${m[3] ?? ''}` }
  return null
}

export function groupProjects(rows: ProjectCost[]): ProjectGroup[] {
  const by = new Map<string, ProjectGroup>()
  for (const r of rows) {
    const k = keyOf(r.project)
    const key = k?.key ?? r.project
    const g = by.get(key)
    if (g) {
      g.tokens += r.tokens
      g.cost_usd += r.cost_usd
      g.members.push(r.project)
    } else {
      by.set(key, { project: key, label: k?.label ?? (r.project || 'unknown'), tokens: r.tokens, cost_usd: r.cost_usd, members: [r.project] })
    }
  }
  const out: ProjectGroup[] = []
  for (const g of by.values()) {
    // A throwaway-folder stem seen once is just a project with that name.
    if (g.members.length === 1 && !g.project.startsWith('\0')) {
      out.push({ ...g, project: g.members[0]!, label: g.members[0] || 'unknown' })
    } else {
      out.push(g)
    }
  }
  return out.sort((a, b) => b.cost_usd - a.cost_usd)
}

/** A long list shows its first rows and folds the rest: never a fold of one or two. */
export const FOLD_SHOW = 8
export function foldRows<T>(rows: T[], open: boolean): { shown: T[]; hidden: T[] } {
  if (open || rows.length <= FOLD_SHOW + 2) return { shown: rows, hidden: [] }
  return { shown: rows.slice(0, FOLD_SHOW), hidden: rows.slice(FOLD_SHOW) }
}
