/**
 * Jarvis's read (.ai/04-ui.md § Jarvis): `GET /v1/jarvis` once when the
 * screen is shown, again on a live frame that can move it (lib/useWork's
 * changesWork) at most once a second, and every JARVIS_POLL_MS while it is
 * in front — the "now" lines and the plan bars move between frames. Nothing
 * while the screen is behind another one (ScreenShown) or the window is
 * hidden; one read on coming back.
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { api, type JarvisDigest } from './api'
import { live, useLiveConn } from './live'
import { ScreenShown } from './refresh'
import { onPageVisibility, pageHidden } from './visible'
import { changesWork, WORK_READ_MS } from './useWork'

/** The steady read while the screen is in front. */
export const JARVIS_POLL_MS = 3000

export interface JarvisRead {
  data?: JarvisDigest
  error?: Error
  refresh: () => void
}

export function useJarvis(): JarvisRead {
  const shown = useContext(ScreenShown)
  const [state, setState] = useState<{ data?: JarvisDigest; error?: Error }>({})
  const shownRef = useRef(shown)
  shownRef.current = shown
  const inFlight = useRef(false)
  const again = useRef(false)
  const missed = useRef(true)

  const read = useCallback(() => {
    if (!shownRef.current || pageHidden()) { missed.current = true; return }
    if (inFlight.current) { again.current = true; return }
    inFlight.current = true
    missed.current = false
    api.jarvis().then(
      (data) => setState({ data }),
      (error: Error) => setState((s) => ({ ...s, error })),
    ).finally(() => {
      inFlight.current = false
      if (again.current) { again.current = false; read() }
    })
  }, [])

  useEffect(() => { if (shown && missed.current) read() }, [shown, read])
  useEffect(() => onPageVisibility((hidden) => { if (!hidden && missed.current) read() }), [read])

  // Every few seconds while in front; the timer is not even set otherwise.
  useEffect(() => {
    if (!shown) return
    const t = setInterval(read, JARVIS_POLL_MS)
    return () => clearInterval(t)
  }, [shown, read])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = live.onFrame((f) => {
      if (!changesWork(f)) return
      if (!shownRef.current || pageHidden()) { missed.current = true; return }
      if (timer) return
      timer = setTimeout(() => { timer = undefined; read() }, WORK_READ_MS)
    })
    return () => { off(); if (timer) clearTimeout(timer) }
  }, [read])

  const conn = useLiveConn()
  const wasOpen = useRef(conn === 'open')
  useEffect(() => {
    if (conn === 'open' && !wasOpen.current) read()
    wasOpen.current = conn === 'open'
  }, [conn, read])

  return { ...state, refresh: read }
}
