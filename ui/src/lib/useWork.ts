/**
 * The Work board's reads (.ai/04-ui.md § Work).
 *
 * `GET /v1/work` is not polled: it is read once when the page is shown, and
 * again on a live frame that can move it — a session's state or cost, a turn,
 * a prompt, a queue, a task — at most once a second. Nothing is asked while
 * the page is behind another screen (ScreenShown) or the window is hidden; a
 * frame missed then is read once on coming back.
 *
 * The pull requests come from the Pipeline's own answer (usePipelineStats,
 * `…/ci/stats`, kept per repository), for at most STATS_REPOS repositories
 * with an agent running first, so the Work page and the Pipeline share one
 * kept answer and, one being hidden while the other shows, never both poll.
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api, type SessionCIStats, type SessionSummary, type Work, type WorkRepo } from './api'
import { live, useLiveConn, type Frame } from './live'
import { changesBoard } from './queueboard'
import { ScreenShown } from './refresh'
import { onPageVisibility, pageHidden } from './visible'
import { statsRepos } from './work'
import { usePipelineStats } from '@/components/PipelineView'

/** The least time between two reads driven by live frames. */
export const WORK_READ_MS = 1000

/** Whether a live frame can change the board. */
export function changesWork(f: Frame): boolean {
  switch (f.type) {
    case 'session': case 'task': case 'status': case 'github': case 'permission': case 'queue': case 'reset':
      return true
    default:
      return changesBoard(f)
  }
}

export interface WorkRead {
  data?: Work
  error?: Error
  /** When this page received `data` (its clock), to count estimates down from. */
  fetchedAt: number
  refresh: () => void
}

/** Only release news: a pull request moved (GitHub), or the link was reset. */
export function changesRelease(f: Frame): boolean {
  return f.type === 'github' || f.type === 'reset'
}

/**
 * The Work answer, read as described above. `on` false asks nothing (a
 * folded section); `changes` narrows the frames that read it again — the
 * right panel's Release section, always on screen beside an agent, reads it
 * again only on release news (changesRelease), never on every turn.
 */
export function useWork(opts: { on?: boolean; changes?: (f: Frame) => boolean } = {}): WorkRead {
  const shown = useContext(ScreenShown) && (opts.on ?? true)
  const changes = opts.changes ?? changesWork
  const changesRef = useRef(changes)
  changesRef.current = changes
  const [state, setState] = useState<{ data?: Work; error?: Error; fetchedAt: number }>({ fetchedAt: 0 })
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
    api.work().then(
      (data) => setState({ data, fetchedAt: Date.now() }),
      (error: Error) => setState((s) => ({ ...s, error })),
    ).finally(() => {
      inFlight.current = false
      if (again.current) { again.current = false; read() }
    })
  }, [])

  // Shown (or shown again after a frame was missed): read once.
  useEffect(() => { if (shown && missed.current) read() }, [shown, read])
  useEffect(() => onPageVisibility((hidden) => { if (!hidden && missed.current) read() }), [read])

  // A frame that can move it: one read, at most once a second.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = live.onFrame((f) => {
      if (!changesRef.current(f)) return
      if (!shownRef.current || pageHidden()) { missed.current = true; return }
      if (timer) return
      timer = setTimeout(() => { timer = undefined; read() }, WORK_READ_MS)
    })
    return () => { off(); if (timer) clearTimeout(timer) }
  }, [read])

  const conn = useLiveConn()
  const wasOpen = useRef(conn === 'open')
  useEffect(() => {
    // The link came back: frames were missed.
    if (conn === 'open' && !wasOpen.current) read()
    wasOpen.current = conn === 'open'
  }, [conn, read])

  return { ...state, refresh: read }
}

/** The Pipeline answers of the repositories read, by root. A fixed four hooks, so the order never changes. */
export function useWorkStats(repos: readonly WorkRepo[], on: boolean): Map<string, SessionCIStats | undefined> {
  const picked = useMemo(() => statsRepos(repos), [repos])
  const ids = picked.map((r) => `${r.root}\0${r.via_session}`).join('\n')
  // A stand-in session that names the repository, so the kept answer's key is the Pipeline's.
  const as = useMemo(() => picked.map((r) => ({ session_id: r.via_session, repo_root: r.root, cwd: r.root }) as unknown as SessionSummary),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ids])
  const [a] = usePipelineStats(as[0]?.session_id ?? '', as[0], on && !!as[0])
  const [b] = usePipelineStats(as[1]?.session_id ?? '', as[1], on && !!as[1])
  const [c] = usePipelineStats(as[2]?.session_id ?? '', as[2], on && !!as[2])
  const [d] = usePipelineStats(as[3]?.session_id ?? '', as[3], on && !!as[3])
  return useMemo(() => {
    const m = new Map<string, SessionCIStats | undefined>()
    ;[a, b, c, d].forEach((st, i) => { const r = picked[i]; if (r) m.set(r.root, st) })
    return m
  }, [a, b, c, d, picked])
}
