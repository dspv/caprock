/**
 * A file a prompt names, drawn as the file rather than as its path
 * (.ai/04-ui.md § File chips): an icon for its kind (a PDF says so), its
 * name cut in the middle, and the whole path on hover and on a click, which
 * opens it under the chip to read or select. The session itself got the
 * path, and Claude Code's own terminal still shows it; only Caprock's
 * drawing changes. The paths come from lib/filepaths `pathParts`, the one
 * parser every surface uses.
 *
 * An image path is left as written (`[Image #N]` is what an attached image
 * already shows), and a video is its tile where the page can draw one
 * (components/VideoTile).
 */
import { useState } from 'react'
import { baseName, fileKind, middleTruncate, pathParts, type FileKind } from '@/lib/filepaths'
import { LinkedText } from './Prose'

const ICON = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }

/** The icon for a kind of file: a page, with what sets the kind apart on it. */
export function FileKindIcon({ kind, size = 16 }: { kind: FileKind; size?: number }) {
  const page = <path d="M6 3h8l4 4v14H6z" />
  const fold = <path d="M14 3v4h4" />
  if (kind === 'pdf') {
    return (
      <svg {...ICON} width={size} height={size} data-file-icon="pdf" className="shrink-0 text-danger">
        {page}{fold}
        <text x="12" y="17.5" textAnchor="middle" fontSize="6.4" fontWeight="700" fill="currentColor" stroke="none" fontFamily="system-ui, sans-serif">PDF</text>
      </svg>
    )
  }
  if (kind === 'image') return <svg {...ICON} width={size} height={size} data-file-icon="image" className="shrink-0 text-fg-muted"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-8 8" /></svg>
  if (kind === 'video') return <svg {...ICON} width={size} height={size} data-file-icon="video" className="shrink-0 text-fg-muted"><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10l5-3v10l-5-3z" /></svg>
  const mark = kind === 'sheet'
    ? <path d="M9 11h6M9 14h6M9 17h6M12 11v6" />
    : kind === 'code'
      ? <path d="M10 12l-2 2 2 2M14 12l2 2-2 2" />
      : kind === 'archive'
        ? <path d="M11 6h2M11 9h2M11 12h2M10.5 15h3v3h-3z" />
        : <path d="M9 12h6M9 16h4" />
  return <svg {...ICON} width={size} height={size} data-file-icon={kind} className="shrink-0 text-fg-muted">{page}{fold}{mark}</svg>
}

/** One file as a chip: inline with the words around it. */
export function FileChip({ path }: { path: string }) {
  const [open, setOpen] = useState(false)
  const name = baseName(path)
  const kind = fileKind(path)
  return (
    <span data-path-chip={kind} className="inline-flex max-w-full flex-col align-middle">
      <button
        type="button"
        title={path}
        aria-expanded={open}
        aria-label={`${name}, ${open ? 'hide' : 'show'} its path`}
        onClick={() => setOpen((v) => !v)}
        className="my-0.5 inline-flex h-7 self-start min-w-0 max-w-full items-center gap-1.5 rounded-[8px] border border-border-strong bg-bg/60 px-2 text-[13px] leading-none text-fg hover:border-fg-faint"
      >
        <FileKindIcon kind={kind} />
        <span className="min-w-0 truncate whitespace-nowrap">{middleTruncate(name)}</span>
      </button>
      {open && (
        <span data-file-path className="mono mb-0.5 select-all whitespace-pre-wrap text-[11.5px] leading-snug text-fg-muted [overflow-wrap:anywhere]">{path}</span>
      )}
    </span>
  )
}

/**
 * `text` with each file path in it a chip, inline, the words around it as
 * written (their web addresses tappable). An image path stays as written.
 * A video is a chip here; the chat draws its tile before it gets this far.
 */
export function FileText({ text }: { text: string }) {
  const parts = pathParts(text)
  if (!parts.some((p) => p.kind === 'file' && p.file !== 'image')) return <LinkedText text={text} />
  return (
    <>
      {parts.map((p, i) => {
        if (p.kind === 'text') return <LinkedText key={i} text={p.text} />
        if (p.file === 'image') return <LinkedText key={i} text={p.raw} />
        return <FileChip key={i} path={p.path} />
      })}
    </>
  )
}
