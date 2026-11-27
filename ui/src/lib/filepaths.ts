/**
 * The absolute file paths in a prompt's words, found so Caprock can draw
 * each as a file rather than as its path (.ai/04-ui.md § File chips).
 *
 * A file dropped or pasted into a session is typed in as its quoted path
 * (lib/xtermInput.ts `quotePath`). An image becomes `[Image #N]` there,
 * because Claude Code attaches an image path that arrives as a paste; any
 * other file — a PDF, a Markdown note — stays its path, so a prompt read
 * back was `"/Users/me/Library/Application Support/caprock/paste/drop-…/CV.pdf"
 * how is my CV?` (owner, 2026-11-27, translated: "can PDFs also be
 * optimized the way images are displayed?"). What Claude Code draws in its
 * own terminal cannot change; what Caprock draws can.
 *
 * One parser for every surface: the chat's bubbles (components/FileChip),
 * the one-line prompt previews and session titles (`pathsAsNames`), and the
 * video tiles (lib/attach `videoParts`).
 *
 * A path is taken when it is absolute (`/…`, `~/…`, `C:\…` or `C:/…`) and
 * ends in a file name with an extension, written as a terminal types it:
 *
 * - **double-quoted**, an inner `"` escaped as `\"` (Caprock's own drop);
 * - **single-quoted**;
 * - **bare**, after a space or at the start, its spaces backslash-escaped
 *   (a shell's drop) — and then only with a folder in it (`/a/b.pdf`, not
 *   `/b.pdf`), and none of `{ } * ? = & # % < >`, so a route such as
 *   `/v1/events/{id}` or `/api/users?id=1.json` stays text.
 *
 * Never a URL (`https://host/a.pdf` — its path follows the host, not a
 * space), a relative name (`notes/a.md`), `//server/share` or a folder.
 */

/** One piece of a prompt's words: text, or a file path in them. */
export type PathPart =
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string; raw: string; file: FileKind }

/** What a chip draws for a file: its icon, by the extension. */
export type FileKind = 'pdf' | 'image' | 'video' | 'text' | 'sheet' | 'code' | 'archive' | 'file'

const ABS = String.raw`(?:\/(?!\/)|~\/|[A-Za-z]:[\\/])`
const PATH_RE = new RegExp(
  [
    // "…": an escaped `\"` or any backslash pair stays inside.
    String.raw`"(${ABS}(?:\\.|[^"\\\n])*)"`,
    // '…'
    String.raw`'(${ABS}[^'\n]*)'`,
    // bare, after a space, a bracket or the start; `\ ` is a space.
    String.raw`(^|[\s(\[])(${ABS}(?:\\ |[^\s"'\`<>()\[\]{}*?=&#%])+)`,
  ].join('|'),
  'g',
)

/** What a sentence put after a bare path, not part of it. */
const TRAILING = /[.,;:!?…]+$/

/** A file name's extension, lowercased; '' for none (or a dotfile's name). */
export function extOf(path: string): string {
  const name = baseName(path)
  const m = /^.+\.([A-Za-z0-9]{1,8})$/.exec(name)
  if (!m || !/[A-Za-z]/.test(m[1]!)) return ''
  return m[1]!.toLowerCase()
}

/** The last part of a path, either separator: what a file chip shows. */
export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i >= 0 ? path.slice(i + 1) : path
}

const KINDS: Record<string, FileKind> = {}
const kind = (k: FileKind, exts: string) => { for (const e of exts.split(' ')) KINDS[e] = k }
kind('pdf', 'pdf')
kind('image', 'png jpg jpeg gif webp heic heif bmp tif tiff svg')
kind('video', 'mov mp4 m4v webm')
kind('text', 'txt md markdown rst rtf doc docx odt pages html htm xml log')
kind('sheet', 'csv tsv xls xlsx ods numbers')
kind('code', 'go py ts tsx js jsx rb rs java kt swift c h cpp hpp cs php sh css diff patch json jsonl yaml yml toml ini sql')
kind('archive', 'zip tar gz tgz bz2 xz 7z rar')

/** The kind of file a path names, by its extension. */
export function fileKind(path: string): FileKind {
  return KINDS[extOf(path)] ?? 'file'
}

/** Whether a path, once unquoted, names a file a chip may stand for. */
function isFilePath(path: string, bare: boolean): boolean {
  if (!extOf(path)) return false
  if (path.endsWith('/') || path.endsWith('\\')) return false
  // A bare path needs a folder in it: `/b.pdf` alone reads as a route.
  if (bare && path.replace(/^(?:[A-Za-z]:|~)/, '').split(/[\\/]/).filter(Boolean).length < 2) return false
  return true
}

/**
 * `text` split around the absolute file paths in it, in order. Each file
 * keeps `raw`, the characters as written, to fall back to; `path` is the
 * file's, unquoted and unescaped. Adjacent text is one part; no file, one
 * text part (an empty one for '').
 */
export function pathParts(text: string): PathPart[] {
  const out: PathPart[] = []
  let at = 0
  const words = (s: string) => {
    if (!s) return
    const last = out[out.length - 1]
    if (last?.kind === 'text') last.text += s
    else out.push({ kind: 'text', text: s })
  }
  for (const m of text.matchAll(PATH_RE)) {
    let path: string
    let start = m.index
    let raw = m[0]
    if (m[1] !== undefined) {
      path = m[1].replace(/\\"/g, '"')
      if (!isFilePath(path, false)) continue
    } else if (m[2] !== undefined) {
      path = m[2]
      if (!isFilePath(path, false)) continue
    } else {
      const lead = m[3] ?? ''
      start += lead.length
      raw = (m[4] ?? '').replace(TRAILING, '')
      path = raw.replace(/\\ /g, ' ')
      if (!isFilePath(path, true)) continue
    }
    words(text.slice(at, start))
    out.push({ kind: 'file', path, raw, file: fileKind(path) })
    at = start + raw.length
  }
  words(text.slice(at))
  if (out.length === 0) out.push({ kind: 'text', text: '' })
  return out
}

/** Whether `text` names a file a chip would stand for. */
export function hasFilePath(text: string): boolean {
  return pathParts(text).some((p) => p.kind === 'file')
}

/**
 * `text` with each file path in it cut to the file's name: what a one-line
 * preview or a session's title shows of a prompt that opened with a dropped
 * file (`"/…/paste/drop-…/CV.pdf" how is my CV?` → `CV.pdf how is my CV?`).
 */
export function pathsAsNames(text: string): string {
  if (!text || !/[/\\]/.test(text)) return text
  return pathParts(text).map((p) => (p.kind === 'file' ? baseName(p.path) : p.text)).join('')
}

/**
 * A file name cut in the middle to at most `max` characters, its extension
 * and the end of its stem kept (`Quarterly_Report_…_final.pdf`): the end of
 * a name is what tells two drafts apart. Counted in code points, so an emoji
 * is never split.
 */
export function middleTruncate(name: string, max = 32): string {
  const chars = Array.from(name)
  if (chars.length <= max || max < 5) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 9 ? Array.from(name.slice(dot)) : []
  const room = max - 1 - ext.length
  const stem = chars.slice(0, chars.length - ext.length)
  const tail = Math.min(Math.floor(room / 3), stem.length)
  const head = room - tail
  return [...stem.slice(0, head), '…', ...stem.slice(stem.length - tail), ...ext].join('')
}
