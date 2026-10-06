/**
 * Open in editor (F18): the editors the daemon found on this machine, asked
 * for once per page, and the one call that opens a folder or a file in one.
 *
 * The daemon refuses both off this machine, so a paired phone never sees the
 * actions at all (`useEditors` answers null there without asking).
 */
import { useEffect, useState } from 'react'
import { api, isPairedDevice, type EditorList } from '@/lib/api'

let cached: Promise<EditorList> | null = null
const listeners = new Set<(l: EditorList) => void>()

/** Forget the list (tests, and after the default editor changes in Settings). */
export function resetEditors(): void {
  cached = null
  void loadEditors().then((l) => { for (const f of listeners) f(l) }).catch(() => { /* none to offer */ })
}

function loadEditors(): Promise<EditorList> {
  if (!cached) {
    cached = api.editors()
    cached.catch(() => { cached = null })
  }
  return cached
}

/** The installed editors and the default, or null until known, on a phone, or with none installed. */
export function useEditors(): EditorList | null {
  const [list, setList] = useState<EditorList | null>(null)
  useEffect(() => {
    if (isPairedDevice()) return
    let live = true
    const on = (l: EditorList) => { if (live) setList(l) }
    listeners.add(on)
    loadEditors().then(on).catch(() => { /* an older daemon, or none installed: no actions */ })
    return () => {
      live = false
      listeners.delete(on)
    }
  }, [])
  return list && list.editors.length > 0 ? list : null
}

/** The default editor's name, for a button's label. */
export function preferredName(list: EditorList): string {
  return list.editors.find((e) => e.id === list.preferred)?.name ?? list.editors[0]?.name ?? 'editor'
}

/** A file inside a checkout, from the diff's root and a path relative to it. */
export function joinPath(root: string, rel: string): string {
  return `${root.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`
}

/**
 * The first changed line of a file from its unified diff: the new side's start
 * in the first hunk header (`@@ -12,4 +14,6 @@` → 14). 0 when there is none —
 * a binary file, an empty patch, or a deletion.
 */
export function firstChangedLine(patch?: string): number {
  const m = patch?.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/m)
  const n = m ? Number(m[1]) : 0
  return Number.isFinite(n) && n > 0 ? n : 0
}
