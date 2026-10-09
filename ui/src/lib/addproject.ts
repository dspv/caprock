/**
 * The Add project sheet's rules, apart from its markup so they can be tested:
 * where it starts (the default folder), what it says under a typed path, and
 * which keys do what (owner, 2026-10-09).
 */
import type { BrowseStat } from './api'

export type AddMode = 'folder' | 'new' | 'clone'

/** Where the sheet starts: the user's default folder, else the home folder. */
export function defaultFolder(setting?: string): string {
  return setting?.trim() || '~'
}

/** A folder written so a name can be typed straight after it: `~/`, `~/dev/`. */
export function withSlash(dir: string): string {
  return /[\\/]$/.test(dir) ? dir : `${dir}/`
}

export type NoteTone = 'bad' | 'ok' | 'muted'
export interface TargetNote { text: string; tone: NoteTone }

/**
 * What the sheet says under its folder field, from the daemon's stat of the
 * path: `null` while there is nothing to say (no path, a folder still being
 * typed as `~/`, a guarded place nobody read, or outside the browse root).
 */
export function targetNote(mode: AddMode, stat: BrowseStat | null | undefined): TargetNote | null {
  if (!stat || stat.guarded) return null
  if (mode === 'folder') {
    if (!stat.exists) return { text: 'no such folder', tone: 'bad' }
    if (!stat.is_dir) return { text: 'not a folder', tone: 'bad' }
    if (stat.project_id) return { text: `already in Caprock${stat.project_name ? ` · ${stat.project_name}` : ''}`, tone: 'ok' }
    return null
  }
  if (mode === 'new') {
    if (stat.exists) return { text: stat.is_dir ? 'exists — add it as an existing folder instead' : 'exists, and is not a folder', tone: 'bad' }
    if (!stat.parent_exists) return { text: 'the folder above does not exist', tone: 'bad' }
    return { text: 'will be created', tone: 'muted' }
  }
  if (!stat.exists) return { text: 'will be created', tone: 'muted' }
  if (!stat.is_dir) return { text: 'exists, and is not a folder — clone will fail', tone: 'bad' }
  if (!stat.empty) return { text: 'exists — not empty, clone will fail', tone: 'bad' }
  return { text: 'exists, empty — will clone here', tone: 'ok' }
}

/** A path worth asking the daemon about: not empty, and not a folder still open for a name. */
export function statWorthy(mode: AddMode, path: string): boolean {
  const p = path.trim()
  if (!p) return false
  // "~/" in New project or Clone is the default folder waiting for a name.
  return mode === 'folder' || !/[\\/]$/.test(p)
}

export type SheetKey = 'submit' | 'folder' | 'new' | 'clone' | 'toggle-list'

/**
 * The sheet's own keys: ⌘↩ adds (from anywhere in it), ⌘1/⌘2/⌘3 the modes,
 * ⌘B Browse ⇄ Recent. Ctrl stands for ⌘ off macOS. Esc is the sheet's own.
 */
export function sheetKey(e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing'>, isMac: boolean): SheetKey | null {
  if (e.isComposing || e.altKey || e.shiftKey) return null
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod) return null
  if (e.key === 'Enter') return 'submit'
  const digit = e.code?.startsWith('Digit') ? e.code.slice(5) : e.key
  if (digit === '1') return 'folder'
  if (digit === '2') return 'new'
  if (digit === '3') return 'clone'
  if ((e.code === 'KeyB') || e.key.toLowerCase() === 'b') return 'toggle-list'
  return null
}

/** The key a sheet button shows, in the platform's words. */
export function keyLabel(k: SheetKey | 'esc', isMac: boolean): string {
  const mod = isMac ? '⌘' : 'Ctrl+'
  switch (k) {
    case 'submit': return isMac ? '⌘↩' : 'Ctrl+↵'
    case 'folder': return `${mod}1`
    case 'new': return `${mod}2`
    case 'clone': return `${mod}3`
    case 'toggle-list': return `${mod}B`
    case 'esc': return 'Esc'
  }
}
