/**
 * A worktree's changes, kept current: read once, then again when its
 * project's git state moves (a `project` frame from the .git watcher), when
 * the window comes back into focus, and after every action here. No timer:
 * an idle worktree runs no git.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { live } from './live'
import { changesApi, failureOf, type ChangeFailure, type Changes, type WorktreeRef } from './changes'

/** Frames arrive in bursts while an agent edits; one read per burst. */
const FRAME_DEBOUNCE_MS = 400

export interface WorktreeChanges {
  changes?: Changes
  error?: ChangeFailure
  loading: boolean
  refresh: () => void
  /** Take the status an action answered with, so the list moves at once. */
  accept: (c: Changes) => void
}

export function useChanges(ref: WorktreeRef | undefined): WorktreeChanges {
  const [changes, setChanges] = useState<Changes | undefined>(undefined)
  const [error, setError] = useState<ChangeFailure | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  const projectId = ref?.projectId
  const worktree = ref?.worktree

  const refresh = useCallback(() => {
    if (projectId === undefined || worktree === undefined) return
    const n = ++seq.current
    setLoading(true)
    changesApi.status({ projectId, worktree })
      .then((c) => { if (n === seq.current) { setChanges(c); setError(undefined) } })
      .catch((e: unknown) => { if (n === seq.current) setError(failureOf(e)) })
      .finally(() => { if (n === seq.current) setLoading(false) })
  }, [projectId, worktree])

  const accept = useCallback((c: Changes) => {
    seq.current += 1
    setChanges(c)
    setError(undefined)
    setLoading(false)
  }, [])

  useEffect(() => {
    setChanges(undefined)
    setError(undefined)
    refresh()
  }, [refresh])

  useEffect(() => {
    if (projectId === undefined) return
    let timer = 0
    live.start()
    const off = live.onFrame((f) => {
      if (f.type !== 'project' && f.type !== 'reset') return
      if (f.type === 'project' && String(f.data.id) !== projectId) return
      window.clearTimeout(timer)
      timer = window.setTimeout(refresh, FRAME_DEBOUNCE_MS)
    })
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => { off(); window.clearTimeout(timer); window.removeEventListener('focus', onFocus) }
  }, [projectId, refresh])

  return { changes, error, loading, refresh, accept }
}
