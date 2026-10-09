/**
 * Screenshots on a feedback report, and how they reach GitHub without
 * Caprock uploading anything.
 *
 * A prefilled new-issue URL carries a title, a body and labels — never a
 * file. Sending the images to GitHub (or anywhere) from here would be the
 * outbound call the product promises not to make (CLAUDE.md rule 4). So they
 * travel the way a person would carry them: the first one is put on the
 * clipboard as the issue opens, the user presses ⌘V in GitHub's comment box,
 * and *Copy next* puts the next one there. GitHub uploads what is pasted
 * into its own page, from the user's own browser, under their own account.
 *
 * The clipboard takes `image/png` only (Chromium refuses anything else in a
 * ClipboardItem), so an image of another type is redrawn as PNG when it is
 * attached — then the copy at click time starts at once, with no drawing in
 * between, which Safari's WebKit needs: a clipboard write must begin
 * inside the click.
 *
 * **In the desktop app the clipboard is the shell's**, not the webview's:
 * the PNG's bytes go to the app's `clipboard_image` command, which writes
 * them through the OS clipboard (app/src-tauri/src/capture.rs). Whether a
 * webview lets a page write an image differs by OS and version; the shell's
 * clipboard does not.
 */
import { isTauri } from './appmode'
import { shell } from './shell'

/** At most this many screenshots on one report. */
export const MAX_SHOTS = 4

/**
 * And at most this large, each: GitHub's own limit for an image pasted into
 * an issue is 10 MB, so a larger one would be refused there, after the
 * user has already left this dialog.
 */
export const MAX_SHOT_BYTES = 10 * 1024 * 1024

export interface Shot {
  id: number
  /** The bytes put on the clipboard: always image/png when it could be drawn. */
  png: Blob
  /** An object URL for the thumbnail; revoked when the shot is removed. */
  url: string
  name: string
}

/** What `accept` keeps from a paste, a drop or a pick, and what it says about the rest. */
export interface Accepted {
  take: File[]
  /** Why something was left out, for the line under the thumbnails; '' when nothing was. */
  note: string
}

/**
 * accept picks the images that fit: images only, each under MAX_SHOT_BYTES,
 * and no more than MAX_SHOTS in all with the `have` already attached.
 */
export function accept(have: number, files: File[]): Accepted {
  const images = files.filter((f) => f.type.startsWith('image/'))
  const notes: string[] = []
  if (images.length < files.length) notes.push('Only images can be attached.')
  const small = images.filter((f) => f.size <= MAX_SHOT_BYTES)
  if (small.length < images.length) notes.push('An image over 10 MB was left out — GitHub would refuse it.')
  const room = Math.max(0, MAX_SHOTS - have)
  const take = small.slice(0, room)
  if (take.length < small.length) notes.push(`Up to ${MAX_SHOTS} screenshots.`)
  return { take, note: notes.join(' ') }
}

const DROP_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** The image type of a dropped path by its extension, or '' when the app would not read it. */
export function imageTypeOfPath(path: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? ''
  return DROP_TYPES[ext] ?? ''
}

/** The file name at the end of a path, on any OS. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || 'screenshot'
}

/** The images in a paste or a drop, in order. */
export function imagesIn(data: DataTransfer | null | undefined): File[] {
  if (!data) return []
  const out: File[] = []
  for (const f of Array.from(data.files ?? [])) if (f.type.startsWith('image/')) out.push(f)
  if (out.length > 0) return out
  // Some sources (a screenshot tool's copy) put the image in items but not files.
  for (const it of Array.from(data.items ?? [])) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile()
      if (f) out.push(f)
    }
  }
  return out
}

/**
 * toPNG redraws an image as PNG for the clipboard. A PNG, or anything this
 * browser cannot decode (it is then attached as it is and copying it may be
 * refused, which the step says), goes through unchanged.
 */
export async function toPNG(file: Blob): Promise<Blob> {
  if (file.type === 'image/png') return file
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file
  try {
    const bitmap = await createImageBitmap(file)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return file
      ctx.drawImage(bitmap, 0, 0)
      const png = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
      return png ?? file
    } finally {
      bitmap.close()
    }
  } catch {
    return file
  }
}

/**
 * copyImage puts one image on the clipboard. Returns whether it got there: a
 * browser without image clipboard support, an unfocused page or a refused
 * permission all answer false, and the step offers saving the file instead.
 * The write is started before anything is awaited, so it is still inside
 * the click that asked for it.
 */
export async function copyImage(png: Blob, clip: Clipboard | undefined = navigator.clipboard): Promise<boolean> {
  if (isTauri()) {
    if (png.type !== 'image/png') return false
    try {
      await shell.clipboardImage(new Uint8Array(await png.arrayBuffer()))
      return true
    } catch {
      return false
    }
  }
  try {
    const Item = (globalThis as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem
    if (!Item || !clip?.write) return false
    await clip.write([new Item({ [png.type || 'image/png']: png })])
    return true
  } catch {
    return false
  }
}

/** The screenshot after `i`, wrapping round, so *Copy next* can be pressed again after the last. */
export function nextShot(i: number, total: number): number {
  return total <= 0 ? 0 : (i + 1) % total
}

/**
 * The line in the attach step: which screenshot is on the clipboard and
 * where to paste it, or, when the copy was refused, what to do instead.
 */
export function stepLine(i: number, total: number, copied: boolean, pasteKey: string, saved = false): string {
  const n = total > 1 ? `Screenshot ${i + 1} of ${total}` : 'Your screenshot'
  if (copied) return `${n} is on your clipboard — press ${pasteKey} in the GitHub comment box.`
  const them = total > 1 ? 'them' : 'it'
  return saved
    ? `Saved to your downloads — drag ${them} into the GitHub comment box.`
    : `One more step: save the ${total > 1 ? 'screenshots' : 'screenshot'}, then drag ${them} into the GitHub comment box.`
}
