/**
 * The link chooser: ⇧⌘-click (Ctrl+Shift+click off macOS) on a web link in
 * a terminal opens it at the pointer (lib/termlinks.ts; owner, 2026-10-17).
 * Two choices, then Copy link (owner, 2026-10-17, translated: "I just want
 * to choose either the default browser or the built-in one"):
 *
 *   - *Default browser*, its name as the hint, focused: exactly what ⌘-click
 *     does (the app's `open_external`).
 *   - *Caprock browser*: a Caprock browser tab (ADR-075), shown wherever one
 *     can exist (the desktop app). With the in-app browser off, picking it
 *     turns it on — the pick is the consent — and a toast says where to turn
 *     it off (lib/browsertab.ts `pickCaprock`).
 *   - *Copy link*, after a separator.
 *   - *Other browser…*, quiet and last, only when the daemon found another
 *     web browser (`GET /v1/browsers`, real browsers only): it expands the
 *     list in place, and one picked opens through `POST /v1/browsers/open`.
 *
 * Keyboard: the first row takes focus; ↑ ↓ Home End move, Enter or Space
 * picks, Esc or Tab closes and gives focus back (RowMenu's MenuBox). A click
 * outside, the window losing focus or a resize closes it too.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { api, errText, type InstalledBrowser } from '@/lib/api'
import { browserAvailable, pickCaprock } from '@/lib/browsertab'
import { chooserEntries, loadBrowsers, type ChooserEntry } from '@/lib/linkchooser'
import { copyText } from '@/lib/mdreader'
import { openLink } from '@/lib/termlinks'
import { CopyIcon, ExternalIcon, GlobeIcon, MoreIcon } from './AppIcons'
import { MenuBox, MenuItem, MenuSeparator, type MenuAt } from './RowMenu'

export interface LinkChooserProps {
  url: string
  at: MenuAt
  onClose: () => void
  /** For tests: the list, whether a Caprock browser tab can exist here, how one opens, how a browser opens it, the default opener and the clipboard. */
  load?: () => Promise<InstalledBrowser[] | null>
  caprock?: boolean
  openCaprock?: (url: string) => boolean
  openIn?: (browser: string, url: string) => Promise<unknown>
  openDefault?: (url: string) => void
  copy?: (text: string) => Promise<boolean>
}

const WIDTH = 288

export function LinkChooser({ url, at, onClose, load = loadBrowsers, caprock = browserAvailable(), openCaprock = pickCaprock, openIn, openDefault = openLink, copy = copyText }: LinkChooserProps) {
  const [list, setList] = useState<InstalledBrowser[] | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const others = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    load().then((l) => { if (live) setList(l) }, () => { if (live) setList(null) })
    return () => { live = false }
  }, [load])

  const entries = useMemo(() => chooserEntries(list, { caprock, expanded }), [list, caprock, expanded])

  // *Other browser…* gives its place, and the focus, to the first of them.
  useEffect(() => {
    if (expanded) others.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [expanded])

  const pick = useCallback(async (e: ChooserEntry) => {
    setError('')
    switch (e.kind) {
      case 'default':
        openDefault(url)
        onClose()
        return
      case 'caprock':
        if (openCaprock(url)) onClose()
        else setError('Could not open a Caprock tab: Settings → In-app browser (beta).')
        return
      case 'copy':
        if (await copy(url)) onClose()
        else setError('The clipboard refused the link.')
        return
      case 'more':
        setExpanded(true)
        return
      case 'browser':
        setBusy(true)
        try {
          await (openIn ?? ((b: string, u: string) => api.openInBrowser({ browser: b, url: u })))(e.id, url)
          onClose()
        } catch (err) {
          setError(`Could not open it in ${e.name}: ${errText(err)}`)
        } finally {
          setBusy(false)
        }
        return
    }
  }, [url, onClose, openCaprock, openIn, openDefault, copy])

  const browsers = entries.filter((e): e is Extract<ChooserEntry, { kind: 'browser' }> => e.kind === 'browser')

  return (
    <MenuBox at={at} label="Open link in" width={WIDTH} onClose={onClose}>
      <div className="truncate px-2 pb-1 pt-0.5 text-[11px] text-fg-faint" title={url}>{url}</div>
      {entries.map((e) => {
        switch (e.kind) {
          case 'default':
            return <MenuItem key="default" icon={<ExternalIcon size={14} />} label="Default browser" hint={e.name} disabled={busy} onClick={() => void pick(e)} />
          case 'caprock':
            return <MenuItem key="caprock" icon={<GlobeIcon size={14} />} label="Caprock browser" disabled={busy} onClick={() => void pick(e)} />
          case 'copy':
            return (
              <div key="copy" className="contents">
                <MenuSeparator />
                <MenuItem icon={<CopyIcon size={14} />} label="Copy link" onClick={() => void pick(e)} />
              </div>
            )
          case 'more':
            return <MenuItem key="more" icon={<MoreIcon size={14} />} label="Other browser…" tone="quiet" disabled={busy} onClick={() => void pick(e)} />
          case 'browser':
            return null
        }
      })}
      {browsers.length > 0 && (
        <div ref={others} className="contents">
          {browsers.map((e) => <MenuItem key={`b:${e.id}`} icon={<ExternalIcon size={14} />} label={e.name} disabled={busy} onClick={() => void pick(e)} />)}
        </div>
      )}
      {error && <p role="alert" className="px-2 py-1 text-[11.5px] leading-[1.4] text-danger">{error}</p>}
    </MenuBox>
  )
}

let current: { root: Root; host: HTMLElement; before: HTMLElement | null } | null = null

function closeCurrent(): void {
  if (!current) return
  const { root, host, before } = current
  current = null
  root.unmount()
  host.remove()
  before?.focus?.()
}

/** Opens the chooser for `url` at `at`, closing one already open. */
export function showLinkChooser(url: string, at: MenuAt): void {
  closeCurrent()
  const before = document.activeElement as HTMLElement | null
  const host = document.createElement('div')
  host.setAttribute('data-link-chooser', '')
  document.body.append(host)
  const root = createRoot(host)
  current = { root, host, before }
  root.render(<LinkChooser url={url} at={at} onClose={() => queueMicrotask(closeCurrent)} />)
}
