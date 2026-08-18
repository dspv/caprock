// Hash router — zero dependencies, good enough for five screens.
// Routes: #/ (Now) · #/session/:id · #/cost · #/history · #/tasks
import { useEffect, useState } from 'react'

export type Route =
  | { name: 'now' }
  | { name: 'session'; id: string; tab?: string }
  | { name: 'cost' }
  | { name: 'history' }
  | { name: 'tasks' }
  | { name: 'settings' }

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '')
  const [path, query] = h.split('?')
  const parts = (path ?? '').split('/').filter(Boolean)
  const tab = new URLSearchParams(query ?? '').get('tab') ?? undefined
  switch (parts[0]) {
    case undefined:
    case '':
    case 'now':
      return { name: 'now' }
    case 'session':
      return parts[1] ? { name: 'session', id: decodeURIComponent(parts[1]), tab } : { name: 'now' }
    case 'cost':
      return { name: 'cost' }
    case 'history':
      return { name: 'history' }
    case 'tasks':
      return { name: 'tasks' }
    case 'settings':
      return { name: 'settings' }
    default:
      return { name: 'now' }
  }
}

export function href(r: Route): string {
  switch (r.name) {
    case 'now': return '#/'
    case 'session': return `#/session/${encodeURIComponent(r.id)}${r.tab ? `?tab=${r.tab}` : ''}`
    case 'cost': return '#/cost'
    case 'history': return '#/history'
    case 'tasks': return '#/tasks'
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
