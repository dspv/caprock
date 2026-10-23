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
 * The file picker's `accept`: every image (a phone photo is HEIC, which the
 * downscale turns into JPEG) plus each allowed extension, so iOS Safari's
 * sheet offers *Choose File* beside Photo Library and Take Photo and the
 * Files browser lets a document be picked; with `image/*` alone only images
 * could be. Not an empty `accept`: that would let anything be picked only for
 * the daemon to refuse it. No `capture`: with it iOS opens the camera and
 * nothing else.
 */
export const ATTACH_ACCEPT = ['image/*', ...PASTE_EXTS.map((e) => `.${e}`)].join(',')

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
