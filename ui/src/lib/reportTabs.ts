/**
 * The daemon cannot see tabs — they live in this browser — so the app tells
 * it which sessions it has a tab for (PUT /v1/tabs): the whole list at once
 * when it changes, and every few minutes while it is open. A session in any
 * viewer's list is never ended for idling (lib/idleEnd.ts, .ai/03-contracts.md
 * § Open tabs).
 */
import { useEffect, useMemo } from 'react'
import { api } from './api'

export const VIEWER_KEY = 'caprock.app.viewer-id'
/** How often the list is said again while nothing changes. */
export const TABS_HEARTBEAT_MS = 10 * 60 * 1000

/** This browser's id for PUT /v1/tabs, made once and kept. */
export function viewerId(): string {
  try {
    const have = localStorage.getItem(VIEWER_KEY)
    if (have) return have
  } catch { /* private window: one for this page */ }
  const id = `v-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
  try { localStorage.setItem(VIEWER_KEY, id) } catch { /* not kept */ }
  return id
}

let pageViewer = ''
function viewer(): string {
  if (!pageViewer) pageViewer = viewerId()
  return pageViewer
}

/**
 * Tells the daemon which sessions this viewer has a tab for: at once when
 * the list changes, and every TABS_HEARTBEAT_MS. A failure is let go: the
 * next change or beat says it again.
 */
export function useReportTabs(sessionIds: readonly string[], enabled = true): void {
  const key = useMemo(() => [...new Set(sessionIds)].sort().join('\n'), [sessionIds])
  useEffect(() => {
    if (!enabled) return
    const ids = key ? key.split('\n') : []
    const send = () => { api.putTabs(viewer(), ids).catch(() => { /* said again later */ }) }
    send()
    const t = window.setInterval(send, TABS_HEARTBEAT_MS)
    return () => window.clearInterval(t)
  }, [key, enabled])
}
