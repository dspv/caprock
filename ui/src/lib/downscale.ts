/** The longest side a photo is sent at. Claude reads images at about 1.5k px
 *  on the long side, so more is bytes over the network for nothing. */
export const PHOTO_MAX_SIDE = 2048

/** A photo smaller than this, and within PHOTO_MAX_SIDE, is sent as it is. */
export const PHOTO_KEEP_BYTES = 1.5 * 1024 * 1024

const JPEG_QUALITY = 0.85

/** Whether a photo needs making smaller before it is sent. */
export function needsDownscale(width: number, height: number, bytes: number): boolean {
  return Math.max(width, height) > PHOTO_MAX_SIDE || bytes > PHOTO_KEEP_BYTES
}

/** The size a photo is drawn at: the long side at most PHOTO_MAX_SIDE, the
 *  proportions kept, never enlarged. */
export function fitWithin(width: number, height: number, max = PHOTO_MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

/**
 * A phone photo made fit to send: 12 MP straight off a camera is 3–6 MB, over
 * the daemon's paste limit once encoded, and slow on Wi-Fi. Drawn onto a
 * canvas at PHOTO_MAX_SIDE and re-encoded as JPEG; the camera's rotation is
 * applied by the decoder, so the result stands the right way up.
 *
 * Anything that cannot be decoded here — a GIF (it would lose its frames), a
 * format this browser does not read — goes as it is, and the daemon says
 * whether it accepts it.
 */
export async function downscalePhoto(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type) || typeof createImageBitmap !== 'function') return file
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return file
  }
  try {
    if (!needsDownscale(bitmap.width, bitmap.height, file.size)) return file
    const { width, height } = fitWithin(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
    if (!blob) return file
    const stem = file.name.replace(/\.[^.]*$/, '') || 'photo'
    return new File([blob], `${stem}.jpg`, { type: 'image/jpeg' })
  } finally {
    bitmap.close()
  }
}
