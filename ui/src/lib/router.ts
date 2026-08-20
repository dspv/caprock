// Hash router — zero dependencies, good enough for five screens.
// Routes: #/ (Now) · #/session/:id · #/cost · #/history · #/tasks
import { useEffect, useState } from 'react'

export type Route =
  | { name: 'now' }
  // `at` is a unix-ms instant to reveal in the timeline: clicking a minute in
  // the pulse should land on those events, not at the top of a long session.
  | { name: 'session'; id: string; tab?: string; at?: number }
  | { name: 'cost' }
  | { name: 'history' }
  | { name: 'tasks' }
  | { name: 'graph' }
  | { name: 'notes' }
  | { name: 'settings' }

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
    case 'now':
      return { name: 'now' }
    case 'session':
      return parts[1] ? { name: 'session', id: decodeURIComponent(parts[1]), tab, at } : { name: 'now' }
    case 'cost':
      return { name: 'cost' }
    case 'history':
      return { name: 'history' }
    case 'tasks':
      return { name: 'tasks' }
    case 'graph':
      return { name: 'graph' }
    case 'notes':
      return { name: 'notes' }
    case 'settings':
      return { name: 'settings' }
    default:
      return { name: 'now' }
  }
}

export function href(r: Route): string {
  switch (r.name) {
    case 'now': return '#/'
    case 'session': {
      const q = new URLSearchParams()
      if (r.tab) q.set('tab', r.tab)
      if (r.at) q.set('at', String(r.at))
      const s = q.toString()
      return `#/session/${encodeURIComponent(r.id)}${s ? `?${s}` : ''}`
    }
    case 'cost': return '#/cost'
    case 'history': return '#/history'
    case 'tasks': return '#/tasks'
    case 'graph': return '#/graph'
    case 'notes': return '#/notes'
    case 'settings': return '#/settings'
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
