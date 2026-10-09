import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import { useLiveConn } from './live'

/**
 * The version of the daemon this page is talking to, for the status strip.
 *
 * Read once at mount, it went stale: the desktop app swaps its daemon under a
 * page that stays loaded (an upgrade, a restart), and the strip said 0.78.0 to
 * a 0.78.1 daemon. A new daemon is a new socket, so the version is read again
 * every time the live link comes back open, and when the window regains focus.
 */
export function useDaemonVersion(): string | undefined {
  const conn = useLiveConn()
  const [version, setVersion] = useState<string | undefined>(undefined)
  const [focused, setFocused] = useState(0)
  const asked = useRef(false)
  useEffect(() => {
    const onFocus = () => setFocused((n) => n + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  useEffect(() => {
    // The first read does not wait for the socket; later ones follow it.
    if (asked.current && conn !== 'open') return
    asked.current = true
    let alive = true
    api.status()
      .then((s) => { if (alive) setVersion(s.version) })
      .catch(() => { /* keep the last one: the strip shows what it knew */ })
    return () => { alive = false }
  }, [conn, focused])
  return version
}
