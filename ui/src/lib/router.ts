// Hash router — zero dependencies, good enough for five screens.
// Routes: #/ (Home; #/home and the older #/now are the same screen) · #/session/:id · #/cost · #/history · #/week · #/tasks · #/queue · #/start · #/settings[/phone|/telegram] · #/mail · #/brain[?node=] · #/pipeline[?repo=&of=]
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
  // view, and its repository when `repo` is absent).
  | { name: 'pipeline'; repo?: string; of?: string }

export type StartMode = 'clone' | 'new' | 'worktree'

/** The parts of Settings a link can open on: the phone, and Telegram beside it. */
export type SettingsSection = 'phone' | 'telegram'

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
      return parts[1] === 'phone' || parts[1] === 'telegram' ? { name: 'settings', section: parts[1] } : { name: 'settings' }
    case 'mail':
      return { name: 'mail' }
    case 'brain': {
      const node = Number(params.get('node'))
      return Number.isInteger(node) && node > 0 ? { name: 'brain', node } : { name: 'brain' }
    }
    case 'pipeline': {
      const repo = params.get('repo') || undefined
      const of = params.get('of') || undefined
      return { name: 'pipeline', ...(repo ? { repo } : {}), ...(of ? { of } : {}) }
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
    case 'pipeline': {
      const q = new URLSearchParams()
      if (r.repo) q.set('repo', r.repo)
      if (r.of) q.set('of', r.of)
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
