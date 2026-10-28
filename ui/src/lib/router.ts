// Hash router — zero dependencies, good enough for five screens.
// Routes: #/ (Home; #/home and the older #/now are the same screen) · #/session/:id · #/cost · #/history · #/week · #/tasks · #/queue · #/start · #/settings[/phone|/telegram] · #/mail · #/brain[?node=] · #/pipeline[?repo=&of=&pr=] · #/work · #/chats[?archived=1] · #/chats/:id · #/x/:id[?to=] · #/m/:machine[/session/:id]
import { useEffect, useState } from 'react'

export type Route =
  // Home: the dashboard's main screen, named 'now' in code (it was "Now" on
  // screen until 2026-10-14). `full` is #/home (or the older #/now): the whole
  // screen. #/ is the same screen on a desktop and the phone home at phone
  // width (components/PhoneHome).
  | { name: 'now'; full?: boolean }
  // `at` is a unix-ms instant to reveal in the timeline: clicking a minute in
  // the pulse should land on those events, not at the top of a long session.
  | { name: 'session'; id: string; tab?: string; at?: number }
  | { name: 'cost'; section?: string }
  | { name: 'history' }
  | { name: 'week'; start?: string }
  // view 'queue' is the Queue tab of Tasks, at #/queue.
  | { name: 'tasks'; view?: 'queue' }
  | { name: 'graph' }
  | { name: 'notes' }
  // section: a deep link to one part of Settings (#/settings/phone, #/settings/telegram).
  | { name: 'settings'; section?: SettingsSection }
  // Caprock Mail (internal/mail): every inbox the user added.
  | { name: 'mail' }
  // Second Brain (ADR-063); `node` opens one memory's detail.
  | { name: 'brain'; node?: number }
  // Start work from the phone (WP-15): clone, a new project, a worktree.
  | { name: 'start'; mode?: StartMode }
  // The Pipeline (.ai/04-ui.md § Pipeline): one repository's pull requests
  // on their way to a release. `repo` is the repository's folder on this
  // machine; `of` the agent session it was opened from (its This session
  // view, and its repository when `repo` is absent); `pr` a pull request
  // whose detail opens beside the list (a Work row's title links there).
  | { name: 'pipeline'; repo?: string; of?: string; pr?: number }
  // Work (.ai/04-ui.md § Work): every piece of work on the machine on its
  // way to a release.
  | { name: 'work' }
  // Chats (ADR-071, .ai/04-ui.md § Chats): the list, its archived half, and
  // one chat — a conversation, never a terminal.
  | { name: 'chats'; archived?: boolean }
  | { name: 'chat'; id: string }
  // A private module the admin key opens (ADR-076): its page at /x/<id>/.
  // `to` is a route inside the module's own page ("#review/42"), from an
  // item its sidebar row lists (ModuleRows): #/x/<id>?to=%23review%2F42.
  | { name: 'module'; id: string; to?: string }
  // Another computer this one reaches (ADR-067): its sessions, or one of
  // them — the Session view and terminal through /v1/m/{id}/… (screens/Machine).
  | { name: 'machine'; id: string; session?: string; tab?: string }
  // The Files tab on the dashboard (ADR-089): a project's two panels, read-only on a device.
  | { name: 'files'; project?: string; wt?: string }

export type StartMode = 'clone' | 'new' | 'worktree'

/** The parts of Settings a link can open on: the phone, Telegram beside it, and the other computers. */
export type SettingsSection = 'phone' | 'telegram' | 'computers'

/** A route inside a module's own page: '#' and then up to 511 characters, no spaces (as PUT /v1/x/<id>/attention takes it). */
export function isModuleHref(h: string): boolean {
  return h.length >= 2 && h.length <= 512 && h.startsWith('#') && !/[\s\u0000-\u001f\u007f]/.test(h)
}

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '')
  const [path, query] = h.split('?')
  const parts = (path ?? '').split('/').filter(Boolean)
  const params = new URLSearchParams(query ?? '')
  const tab = params.get('tab') ?? undefined
  const atRaw = Number(params.get('at'))
  const at = Number.isFinite(atRaw) && atRaw > 0 ? atRaw : undefined
  switch (parts[0]) {
    case undefined:
    case '':
      return { name: 'now' }
    case 'home':
    case 'now':
      return { name: 'now', full: true }
    case 'session':
      return parts[1] ? { name: 'session', id: decodeURIComponent(parts[1]), tab, at } : { name: 'now' }
    case 'cost': {
      const section = params.get('section') ?? ''
      return /^[a-z-]+$/.test(section) ? { name: 'cost', section } : { name: 'cost' }
    }
    case 'history':
      return { name: 'history' }
    case 'week': {
      const start = params.get('start') ?? ''
      return /^\d{4}-\d{2}-\d{2}$/.test(start) ? { name: 'week', start } : { name: 'week' }
    }
    case 'tasks':
      return { name: 'tasks' }
    case 'queue':
      return { name: 'tasks', view: 'queue' }
    case 'graph':
      return { name: 'graph' }
    case 'notes':
      return { name: 'notes' }
    case 'settings':
      return parts[1] === 'phone' || parts[1] === 'telegram' || parts[1] === 'computers' ? { name: 'settings', section: parts[1] } : { name: 'settings' }
    case 'mail':
      return { name: 'mail' }
    case 'brain': {
      const node = Number(params.get('node'))
      return Number.isInteger(node) && node > 0 ? { name: 'brain', node } : { name: 'brain' }
    }
    case 'pipeline': {
      const repo = params.get('repo') || undefined
      const of = params.get('of') || undefined
      const pr = Number(params.get('pr'))
      return { name: 'pipeline', ...(repo ? { repo } : {}), ...(of ? { of } : {}), ...(Number.isInteger(pr) && pr > 0 ? { pr } : {}) }
    }
    case 'work':
      return { name: 'work' }
    case 'chats':
      if (parts[1]) return { name: 'chat', id: decodeURIComponent(parts[1]) }
      return params.get('archived') === '1' ? { name: 'chats', archived: true } : { name: 'chats' }
    case 'x': {
      if (!parts[1] || !/^[a-z][a-z0-9-]{0,31}$/.test(parts[1])) return { name: 'now' }
      const to = params.get('to') ?? ''
      return isModuleHref(to) ? { name: 'module', id: parts[1], to } : { name: 'module', id: parts[1] }
    }
    case 'm': {
      const id = parts[1] ?? ''
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) return { name: 'now' }
      if (parts[2] === 'session' && parts[3]) return { name: 'machine', id, session: decodeURIComponent(parts[3]), ...(tab ? { tab } : {}) }
      return { name: 'machine', id }
    }
    case 'files': {
      const project = params.get('project') || undefined
      const wt = params.get('wt') || undefined
      return { name: 'files', ...(project ? { project } : {}), ...(wt ? { wt } : {}) }
    }
    case 'start': {
      const mode = params.get('mode')
      return mode === 'clone' || mode === 'new' || mode === 'worktree' ? { name: 'start', mode } : { name: 'start' }
    }
    default:
      return { name: 'now' }
  }
}

export function href(r: Route): string {
  switch (r.name) {
    case 'now': return r.full ? '#/home' : '#/'
    case 'session': {
      const q = new URLSearchParams()
      if (r.tab) q.set('tab', r.tab)
      if (r.at) q.set('at', String(r.at))
      const s = q.toString()
      return `#/session/${encodeURIComponent(r.id)}${s ? `?${s}` : ''}`
    }
    case 'cost': return r.section ? `#/cost?section=${r.section}` : '#/cost'
    case 'history': return '#/history'
    case 'week': return r.start ? `#/week?start=${r.start}` : '#/week'
    case 'tasks': return r.view === 'queue' ? '#/queue' : '#/tasks'
    case 'graph': return '#/graph'
    case 'notes': return '#/notes'
    case 'settings': return r.section ? `#/settings/${r.section}` : '#/settings'
    case 'mail': return '#/mail'
    case 'brain': return r.node ? `#/brain?node=${r.node}` : '#/brain'
    case 'start': return r.mode ? `#/start?mode=${r.mode}` : '#/start'
    case 'work': return '#/work'
    case 'chats': return r.archived ? '#/chats?archived=1' : '#/chats'
    case 'chat': return `#/chats/${encodeURIComponent(r.id)}`
    case 'module': return r.to && isModuleHref(r.to) ? `#/x/${r.id}?to=${encodeURIComponent(r.to)}` : `#/x/${r.id}`
    case 'machine': return r.session ? `#/m/${r.id}/session/${encodeURIComponent(r.session)}${r.tab ? `?tab=${encodeURIComponent(r.tab)}` : ''}` : `#/m/${r.id}`
    case 'files': {
      const q = new URLSearchParams()
      if (r.project) q.set('project', r.project)
      if (r.wt) q.set('wt', r.wt)
      const s = q.toString()
      return `#/files${s ? `?${s}` : ''}`
    }
    case 'pipeline': {
      const q = new URLSearchParams()
      if (r.repo) q.set('repo', r.repo)
      if (r.of) q.set('of', r.of)
      if (r.pr) q.set('pr', String(r.pr))
      const s = q.toString()
      return `#/pipeline${s ? `?${s}` : ''}`
    }
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash))
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

export function navigate(r: Route) {
  location.hash = href(r)
}
