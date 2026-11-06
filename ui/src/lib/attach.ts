import { ApiError, errText } from './api'

/**
 * What a phone may attach: photos, and the documents the daemon keeps.
 *
 * PASTE_EXTS mirrors `pasteKinds` in internal/api/paste.go — the allow-list
 * POST /v1/paste and POST /v1/inbox write by — and must stay in step with it;
 * attach.test.ts reads paste.go and fails when the two differ. The daemon is
 * still the one that decides: this list only shapes the picker, and a file
 * it refuses comes back with its reason.
 */
export const PASTE_EXTS: readonly string[] = [
  // images
  'png', 'jpg', 'jpeg', 'gif', 'webp',
  // PDF
  'pdf',
  // text and documents
  'txt', 'md', 'markdown', 'rst', 'rtf', 'html', 'htm', 'xml',
  // office
  'docx', 'xlsx', 'pptx', 'odt', 'ods',
  // data
  'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'log', 'sql',
  // source
  'go', 'py', 'ts', 'tsx', 'js', 'jsx', 'rb', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'css', 'diff', 'patch',
]

/**
 * The one picker's `accept`, where a mouse attaches (components/AttachPicker):
 * every image (a phone photo is HEIC, which the downscale turns into JPEG)
 * plus each allowed extension. A touch screen splits it into PHOTOS_ACCEPT
 * and FILES_ACCEPT instead. Not an empty `accept`: that would let anything
 * be picked only for the daemon to refuse it. No `capture`: with it iOS
 * opens the camera and nothing else.
 */
export const ATTACH_ACCEPT = ['image/*', ...PASTE_EXTS.map((e) => `.${e}`)].join(',')

/** The images among PASTE_EXTS: what Photos offers, and what Files leaves out. */
export const IMAGE_EXTS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp']

/**
 * What Files leaves out besides the images: extensions iOS reads as media.
 * To Apple `.ts` is an MPEG-2 transport stream (public.mpeg-2-transport-stream,
 * a movie), not TypeScript; in ATTACH_ACCEPT it was why the iPhone's sheet
 * said *Take Photo or Video* and its library offered videos (2026-11-06).
 * A `.ts` file still attaches from a computer.
 */
export const MEDIA_LOOKALIKE_EXTS: readonly string[] = ['ts']

/** The Photos choice on a phone: every image, so iOS offers its library and camera. */
export const PHOTOS_ACCEPT = 'image/*'

/**
 * The Files choice on a phone: the documents the daemon keeps, and nothing
 * iOS takes for an image or a video. iOS shows its Photo Library / Take Photo
 * sheet whenever a photo or a video may be picked; with neither it opens the
 * Files browser straight away, which is what a button named Files should do.
 * Images go through Photos.
 */
export const FILES_ACCEPT = PASTE_EXTS
  .filter((e) => !IMAGE_EXTS.includes(e) && !MEDIA_LOOKALIKE_EXTS.includes(e))
  .map((e) => `.${e}`)
  .join(',')

/** Whether a name or a saved path is an image Claude Code shows as `[Image #N]`. */
export function isImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(name)
}

/** Whether a picked file is a photo: by type, or by name where the type is empty. */
export function isPhotoFile(f: { name: string; type: string }): boolean {
  return f.type.startsWith('image/') || isImageName(f.name)
}

/** The last part of a path, either separator: what a file chip shows. */
export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i >= 0 ? path.slice(i + 1) : path
}

/**
 * Each attached path's label, in order: an image is "Image N", counted among
 * the images only, as Claude Code numbers them; any other file is its name.
 */
export function attachLabels(paths: readonly string[]): string[] {
  let n = 0
  return paths.map((p) => (isImageName(p) ? `Image ${++n}` : baseName(p)))
}

/** The daemon's paste limit (`pasteLimit` in paste.go): ten megabytes. */
export const ATTACH_LIMIT_BYTES = 10 << 20

const KINDS_SENTENCE = 'Photos, PDFs, text, Markdown, office, data and source files can.'

/** The daemon's `{error}` on a refusal, lowercased, or ''. */
function refusalHead(e: unknown): string {
  if (!(e instanceof ApiError)) return ''
  const b = e.body as { error?: string } | undefined
  return (b?.error ?? '').toLowerCase()
}

/** The extension the daemon turned a file away for ('' for none), or null
 *  when the refusal was not about the type. */
function refusedType(e: unknown): string | null {
  const m = /^unsupported file type: (.+)$/.exec(refusalHead(e))
  if (m) return m[1] ?? ''
  return e instanceof ApiError && e.status === 415 ? '' : null
}

/** Whether the daemon turned a file away for its size, or the file is past the limit. */
function refusedSize(e: unknown, size?: number): boolean {
  if (size !== undefined && size > ATTACH_LIMIT_BYTES) return true
  return (e instanceof ApiError && e.status === 413) || refusalHead(e).includes('larger than 10 mb')
}

/**
 * One short line for a file the phone could not attach. The daemon's own
 * refusal carries its whole allow-list — six red lines at 390 px — so the
 * two reasons a person can act on are said briefly here (owner, 2026-10-23):
 * the type, and the 10 MB limit. Any other reason is the daemon's text as it
 * is. The desktop's drop keeps the daemon's full message.
 */
export function attachRefusal(file: { name: string; size?: number }, e: unknown): string {
  const name = file.name || 'This file'
  if (refusedSize(e, file.size)) return `${name} is over 10 MB`
  const ext = refusedType(e)
  if (ext !== null) {
    const what = ext.startsWith('.') ? `${ext} isn't a supported type` : "a file with no extension isn't supported"
    return `${name} can't be attached: ${what}. ${KINDS_SENTENCE}`
  }
  return `${name}: not added — ${errText(e)}`
}

/**
 * attachRefusal for a request that carried several files (the Inbox's Save):
 * the daemon does not say which one it refused, so it is found by its size
 * or its extension; any other reason is the daemon's text as it is.
 */
export function attachRefusalOf(files: readonly { name: string; size?: number }[], e: unknown): string {
  const big = files.find((f) => (f.size ?? 0) > ATTACH_LIMIT_BYTES)
  if (big && refusedSize(e)) return attachRefusal(big, e)
  const ext = refusedType(e)
  if (ext !== null) {
    const hit = files.find((f) => (ext.startsWith('.') ? f.name.toLowerCase().endsWith(ext) : !/\.[^./\\]+$/.test(f.name)))
    return attachRefusal({ name: hit?.name ?? '' }, e)
  }
  if (refusedSize(e)) return attachRefusal({ name: '' }, e)
  return errText(e)
}
