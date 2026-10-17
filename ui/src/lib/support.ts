/**
 * Report a bug (ADR-073): what the sheet sends, and how a screenshot is made
 * small enough to send.
 *
 * The report goes to Caprock support at caprock.dev through the daemon
 * (`POST /v1/support`, internal/api/support.go), never to GitHub, because it
 * may hold personal data. It is sent only when the user presses *Send to
 * support*, and the sheet names every field first. The daemon adds the
 * Caprock version and the OS and nothing else.
 *
 * The limits match the daemon's, so a report the sheet lets through is one
 * the daemon takes.
 */
import { api } from './api'
import { fitWithin } from './downscale'

export const SUPPORT_LIMITS = {
  /** Characters of text. */
  text: 8000,
  /** Screenshots per report. */
  shots: 3,
  /** Bytes of one screenshot, decoded. */
  shotBytes: 4 * 1024 * 1024,
  /** Bytes of all of them together, decoded. */
  totalBytes: 8 * 1024 * 1024,
  /** The long side a screenshot is drawn at before it is sent. */
  maxSide: 1600,
} as const

const JPEG_QUALITY = 0.85

export type SupportShotType = 'image/png' | 'image/jpeg' | 'image/webp'

/** One screenshot as it is sent: base64 data, no `data:` prefix. */
export type SupportShot = { name: string; type: SupportShotType; data: string }

export type SupportReport = { text: string; email?: string; screenshots?: SupportShot[] }

const SENDABLE = new Set<string>(['image/png', 'image/jpeg', 'image/webp'])

/** The bytes a base64 string decodes to. */
export function decodedBytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - pad
}

/** The number of characters in a text, as the daemon counts them (code points). */
export function textLength(s: string): number {
  return Array.from(s).length
}

/**
 * Why a report cannot be sent yet, or null when it can. The daemon checks the
 * same and the email's shape more strictly; its answer is shown as it comes.
 */
export function reportProblem(r: SupportReport): string | null {
  if (!r.text.trim()) return 'Say what happened first.'
  if (textLength(r.text) > SUPPORT_LIMITS.text) return `At most ${SUPPORT_LIMITS.text.toLocaleString('en-US')} characters, please.`
  const shots = r.screenshots ?? []
  if (shots.length > SUPPORT_LIMITS.shots) return `At most ${SUPPORT_LIMITS.shots} screenshots.`
  let total = 0
  for (const s of shots) {
    const n = decodedBytes(s.data)
    if (n > SUPPORT_LIMITS.shotBytes) return `“${s.name}” is over 4 MB.`
    total += n
  }
  if (total > SUPPORT_LIMITS.totalBytes) return 'The screenshots are over 8 MB together: remove one.'
  const email = r.email?.trim() ?? ''
  if (email && (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))) return 'That email does not look like an address.'
  return null
}

/** The body the daemon is sent: the email only when typed, screenshots only when attached. */
export function reportBody(r: SupportReport): SupportReport {
  const email = r.email?.trim()
  return {
    text: r.text,
    ...(email ? { email } : {}),
    ...(r.screenshots && r.screenshots.length > 0 ? { screenshots: r.screenshots } : {}),
  }
}

/** Send one report. Throws an ApiError the sheet shows with errText. */
export async function sendReport(r: SupportReport): Promise<void> {
  await api.sendSupport(reportBody(r))
}

function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => {
      const s = typeof fr.result === 'string' ? fr.result : ''
      resolve(s.slice(s.indexOf(',') + 1))
    }
    fr.onerror = () => reject(fr.error ?? new Error('could not read the file'))
    fr.readAsDataURL(blob)
  })
}

/** The file's name with a new extension, for a picture re-encoded as JPEG. */
function asJpegName(name: string): string {
  return `${name.replace(/\.[^.]*$/, '') || 'screenshot'}.jpg`
}

/**
 * A picked image made into a screenshot to send: drawn on a canvas with its
 * long side at most 1600 px and re-encoded as JPEG at 0.85, which takes a
 * phone screenshot from megabytes to a few hundred kilobytes. Where the
 * browser cannot decode it, a PNG, JPEG or WebP goes as it is; anything else
 * is refused with a sentence the sheet shows.
 */
export async function prepareShot(file: File): Promise<SupportShot> {
  if (!file.type.startsWith('image/')) throw new Error(`“${file.name}” is not an image.`)
  const drawn = await drawAsJpeg(file)
  if (drawn) return { name: asJpegName(file.name), type: 'image/jpeg', data: await readBase64(drawn) }
  if (!SENDABLE.has(file.type)) throw new Error(`“${file.name}” cannot be read here: attach a PNG, JPEG or WebP.`)
  if (file.size > SUPPORT_LIMITS.shotBytes) throw new Error(`“${file.name}” is over 4 MB.`)
  return { name: file.name || 'screenshot', type: file.type as SupportShotType, data: await readBase64(file) }
}

async function drawAsJpeg(file: File): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function') return null
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return null
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, SUPPORT_LIMITS.maxSide)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    // A transparent PNG would turn black as JPEG: draw it on white.
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(bitmap, 0, 0, width, height)
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
  } catch {
    return null
  } finally {
    bitmap.close()
  }
}
