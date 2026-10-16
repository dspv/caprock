/**
 * What a chat produced (ADR-071): the files its agent wrote in the chat's own
 * folder, listed under the chat and opened in a viewer (owner, 2026-10-16,
 * translated: "the results of chats may be files — HTML, Markdown, PDF — and
 * I need to see them").
 *
 * - **Markdown** is rendered with the file tab's renderer (Prose.tsx
 *   ProseDoc); its pictures are read from the chat's folder.
 * - **HTML** is shown in a frame with `sandbox=""` — no script, no same
 *   origin, no forms — and a policy that fetches nothing from the network
 *   (lib/chats sandboxedHTML), so a page an agent wrote can be looked at and
 *   cannot act.
 * - **PDF** goes to the browser's own viewer, from an object URL.
 * - **Images** are shown; text is shown as text; anything else is offered as
 *   a download. Every file can be downloaded, on the phone too.
 *
 * Files are fetched as blobs with the device's token (lib/api chatFile): an
 * iframe or an <img> cannot carry it.
 */
import { useEffect, useMemo, useState } from 'react'
import { api, errText, type ChatFile } from '@/lib/api'
import { fileFolder, fileName, kindLabel, resolveChatPath, sandboxedHTML, saveBlob } from '@/lib/chats'
import { fmtBytes } from '@/lib/files'
import { fmtAgo } from '@/lib/format'
import { extTitle } from '@/lib/externalLinks'
import { ProseDoc } from './Prose'
import { ChatSheet } from './ChatStart'
import { CloseIcon } from './AppIcons'

/** The chat's files, newest first; refreshed when `bump` changes. */
export function useChatFiles(sessionId: string, bump: unknown) {
  const [files, setFiles] = useState<ChatFile[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let gone = false
    api.chatFiles(sessionId)
      .then((r) => { if (!gone) { setFiles(r.files ?? []); setError('') } })
      .catch((e) => { if (!gone) { setFiles((f) => f ?? []); setError(errText(e)) } })
    return () => { gone = true }
  }, [sessionId, bump])
  return { files, error }
}

function KindBadge({ kind }: { kind: ChatFile['kind'] }) {
  const tone = kind === 'html' ? 'text-accent' : kind === 'pdf' ? 'text-danger' : kind === 'markdown' ? 'text-ok' : 'text-fg-muted'
  return (
    <span aria-hidden className={`mono grid h-10 w-10 shrink-0 place-items-center rounded-[8px] border border-border bg-panel-2 text-[10px] font-semibold uppercase ${tone}`}>
      {kind === 'markdown' ? 'MD' : kind === 'other' ? 'FILE' : kind === 'image' ? 'IMG' : kind === 'text' ? 'TXT' : kind.toUpperCase()}
    </span>
  )
}

/** The list of a chat's files, each one tap from its viewer. */
export function ChatFileList({ files, now, onOpen }: { files: ChatFile[]; now: number; onOpen: (f: ChatFile) => void }) {
  if (files.length === 0) {
    return <p className="py-2 text-[14px] text-fg-muted">Nothing yet. Files the agent writes in this chat — a page, a report, a PDF — show up here.</p>
  }
  return (
    <ul aria-label="Files" className="overflow-hidden rounded-[12px] border border-border bg-bg">
      {files.map((f) => (
        <li key={f.path} className="border-b border-border last:border-b-0">
          <button type="button" onClick={() => onOpen(f)} className="flex min-h-[56px] w-full items-center gap-3 px-3 py-2 text-left active:bg-panel-2">
            <KindBadge kind={f.kind} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium text-fg">{fileName(f.path)}</span>
              <span className="block truncate text-[12.5px] text-fg-faint">
                {[kindLabel(f.kind), fmtBytes(f.size), fmtAgo(f.modified, now), fileFolder(f.path)].filter(Boolean).join(' · ')}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** The files sheet under a chat. */
export function ChatFilesSheet({ files, now, onOpen, onClose }: { files: ChatFile[]; now: number; onOpen: (f: ChatFile) => void; onClose: () => void }) {
  return (
    <ChatSheet title={`Files · ${files.length}`} onClose={onClose}>
      <ChatFileList files={files} now={now} onOpen={onOpen} />
    </ChatSheet>
  )
}

/** A picture in a chat's Markdown file, read from the chat's folder. */
function ChatImage({ sessionId, from, src, alt }: { sessionId: string; from: string; src: string; alt: string }) {
  const path = resolveChatPath(from, src)
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!path) return
    let gone = false
    let made = ''
    api.chatFile(sessionId, path)
      .then((b) => { if (!gone) { made = URL.createObjectURL(b); setUrl(made) } })
      .catch(() => { /* the alt text stands */ })
    return () => { gone = true; if (made) URL.revokeObjectURL(made) }
  }, [sessionId, path])
  if (!path || !url) return <span className="italic text-fg-muted">[{alt || 'image'}]</span>
  return <img src={url} alt={alt} className="max-w-full rounded-[8px]" />
}

type Loaded = { blob: Blob; text?: string; url: string }

/** One file, full screen on a phone and in a wide sheet elsewhere, with Download. */
export function ChatFileViewer({ sessionId, file, onClose }: { sessionId: string; file: ChatFile; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState('')
  const name = fileName(file.path)
  useEffect(() => {
    let gone = false
    let url = ''
    setLoaded(null)
    setError('')
    api.chatFile(sessionId, file.path)
      .then(async (blob) => {
        // A PDF goes to the browser under its own type; an object URL of
        // the response keeps it.
        const typed = file.kind === 'pdf' && blob.type !== 'application/pdf' ? new Blob([blob], { type: 'application/pdf' }) : blob
        const text = file.kind === 'markdown' || file.kind === 'html' || file.kind === 'text' ? await typed.text() : undefined
        if (gone) return
        url = URL.createObjectURL(typed)
        setLoaded({ blob: typed, text, url })
      })
      .catch((e) => { if (!gone) setError(errText(e)) })
    return () => { gone = true; if (url) URL.revokeObjectURL(url) }
  }, [sessionId, file.path, file.kind])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const html = useMemo(() => (file.kind === 'html' && loaded?.text !== undefined ? sandboxedHTML(loaded.text) : ''), [file.kind, loaded?.text])

  const body = error ? (
    <p role="alert" className="text-[14px] text-danger">{error}</p>
  ) : !loaded ? (
    <p className="text-[14px] text-fg-muted">Opening…</p>
  ) : file.kind === 'markdown' ? (
    <div className="mx-auto max-w-[72ch] py-2">
      <ProseDoc text={loaded.text ?? ''} image={(src, alt) => <ChatImage sessionId={sessionId} from={file.path} src={src} alt={alt} />} />
    </div>
  ) : file.kind === 'html' ? (
    <iframe title={name} sandbox="" srcDoc={html} referrerPolicy="no-referrer" className="h-[calc(100dvh-140px)] min-h-[360px] w-full rounded-[8px] border border-border bg-white" />
  ) : file.kind === 'pdf' ? (
    <div className="grid gap-2">
      <iframe title={name} src={loaded.url} className="h-[calc(100dvh-170px)] min-h-[360px] w-full rounded-[8px] border border-border bg-white" />
      <a href={loaded.url} target="_blank" rel="noopener noreferrer" title={extTitle()} className="text-[14px] text-accent">Open in the browser’s viewer</a>
    </div>
  ) : file.kind === 'image' ? (
    <img src={loaded.url} alt={name} className="mx-auto max-h-[calc(100dvh-160px)] max-w-full rounded-[8px]" />
  ) : file.kind === 'text' ? (
    <pre className="mono app-scroll max-h-[calc(100dvh-160px)] overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-border bg-bg p-3 text-[12.5px] leading-[1.5]">{loaded.text}</pre>
  ) : (
    <p className="text-[14px] text-fg-muted">This kind of file is not shown here. Download it to open it.</p>
  )

  return (
    <div role="dialog" aria-modal="true" aria-label={name} className="fixed inset-0 z-[60] flex flex-col bg-panel text-fg">
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-2 pt-[env(safe-area-inset-top)]">
        <button type="button" aria-label="Close" onClick={onClose} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-fg-muted hover:text-fg"><CloseIcon size={20} /></button>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium">{name}</span>
          <span className="block truncate text-[12px] text-fg-faint">{kindLabel(file.kind)} · {fmtBytes(file.size)}</span>
        </span>
        <button
          type="button"
          disabled={!loaded}
          onClick={() => loaded && saveBlob(loaded.blob, name)}
          className="min-h-10 shrink-0 rounded-[10px] border border-border-strong bg-bg px-3.5 text-[14px] font-medium text-fg disabled:opacity-50"
        >
          Download
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{body}</div>
    </div>
  )
}
