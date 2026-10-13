/**
 * The Inbox (03-contracts.md § Inbox): a note, a link or a photo saved for
 * later from the phone's Save, another app's Share, or the machine. Read by
 * every screen that shows it through `useInbox`, which re-reads the list when
 * the live socket says an item was saved or deleted (an `inbox` frame) and
 * after a replay gap (`reset`).
 *
 * Starting a chat from an item is a quick chat whose first message is the
 * item: its text, then each file's path quoted as a pasted file's is, so the
 * agent reads the photo. An item saved to a project starts in that project's
 * folder. The item stays after the chat starts; the user deletes it, so a
 * chat that fails to start or goes nowhere loses nothing.
 */
import { useCallback, useEffect, useState } from 'react'
import { api, isPairedDevice, type InboxItem } from './api'
import { live } from './live'
import { quotePath } from './xtermInput'

export type { InboxItem }

/** The first message a chat started from an item is sent: its text, then its files' paths, quoted. */
export function inboxPrompt(item: Pick<InboxItem, 'text' | 'files'>): string {
  const files = item.files.map(quotePath).join(' ')
  return [item.text.trim(), files].filter(Boolean).join('\n\n')
}

/** What a chat started from an item is sent: the prompt, and the project's folder when it has one. */
export function inboxStart(item: InboxItem): { prompt: string; cwd?: string } {
  const prompt = inboxPrompt(item)
  return item.project_root ? { prompt, cwd: item.project_root } : { prompt }
}

/** Where an item was saved, as a list row says it: the project's name, else "Inbox". */
export function inboxWhere(item: Pick<InboxItem, 'project_name' | 'project_id'>): string {
  return item.project_name || (item.project_id ? 'a project' : 'Inbox')
}

/** Whether a file is an image the daemon serves a thumbnail of (the contract's list). */
export function isInboxImage(path: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(path)
}

/** The URL of an item's n-th file, for its thumbnail. */
export function inboxFileUrl(id: number, n: number): string {
  return `/v1/inbox/${id}/files/${n}`
}

export interface InboxState {
  items: InboxItem[]
  loaded: boolean
  error: string
  /** Read the list again now. */
  reload: () => void
  /** The same as reload, under the name the phone home uses. */
  refresh: () => void
  /** Delete an item and its files; the list drops it at once. */
  remove: (id: number) => Promise<void>
}

/** The Inbox, newest first, kept current by the live socket. */
export function useInbox(): InboxState {
  const [items, setItems] = useState<InboxItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const reload = useCallback(() => {
    api.inbox().then(
      (r) => { setItems(r.items ?? []); setError(''); setLoaded(true) },
      (e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setLoaded(true) },
    )
  }, [])
  useEffect(() => {
    reload()
    return live.onFrame((f) => {
      if (f.type === 'inbox' || f.type === 'reset') reload()
    })
  }, [reload])
  const remove = useCallback(async (id: number) => {
    await api.removeInbox(id)
    setItems((cur) => cur.filter((i) => i.id !== id))
  }, [])
  return { items, loaded, error, reload, refresh: reload, remove }
}

/**
 * A thumbnail's `src`. On the machine the URL itself; on a paired device an
 * `<img>` cannot send the device token, so the picture is fetched with it and
 * shown from a blob URL, revoked when the row goes. '' while it loads or when
 * it cannot be read.
 */
export function useInboxThumb(id: number, n: number): string {
  const paired = isPairedDevice()
  const [src, setSrc] = useState(paired ? '' : inboxFileUrl(id, n))
  useEffect(() => {
    if (!paired) { setSrc(inboxFileUrl(id, n)); return }
    let url = ''
    let gone = false
    api.inboxFile(id, n)
      .then((b) => {
        if (!b || gone) return
        url = URL.createObjectURL(b)
        setSrc(url)
      })
      .catch(() => { /* no thumbnail; the row still reads */ })
    return () => {
      gone = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [id, n, paired])
  return src
}
