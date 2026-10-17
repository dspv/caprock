/**
 * The browser chooser: ⇧⌘-click (Ctrl+Shift+click off macOS) on a web link
 * in a terminal opens it at the pointer (lib/termlinks.ts; owner,
 * 2026-10-17). It lists the browsers the daemon found on this machine
 * (`GET /v1/browsers`), the system's default first and marked, then *Copy
 * link*. Picking the default opens the link exactly as ⌘-click does (the
 * app's `open_external`); any other goes to `POST /v1/browsers/open`.
 *
 * Keyboard: the first row takes focus; ↑ ↓ Home End move, Enter or Space
 * picks, Esc or Tab closes and gives focus back (RowMenu's MenuBox). A click
 * outside, the window losing focus or a resize closes it too.
 *
 * The rows are `ChooserEntry`s (lib/linkchooser.ts); *Open in Caprock*
 * shows while the in-app browser is on (ADR-075) and opens a Caprock tab.
 */
import { useCallback, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { api, errText, type InstalledBrowser } from '@/lib/api'
import { caprockEntry, openInCaprock } from '@/lib/browsertab'
import { chooserEntries, loadBrowsers, type ChooserEntry } from '@/lib/linkchooser'
import { copyText } from '@/lib/mdreader'
import { openLink } from '@/lib/termlinks'
import { CopyIcon, ExternalIcon } from './AppIcons'
import { MenuBox, MenuItem, MenuSeparator, type MenuAt } from './RowMenu'

export interface LinkChooserProps {
  url: string
  at: MenuAt
  onClose: () => void
  /** For tests: the list, whether Caprock's own browser is on, how a browser opens it, the default opener and the clipboard. */
  load?: () => Promise<InstalledBrowser[] | null>
  inCaprock?: boolean
  openIn?: (browser: string, url: string) => Promise<unknown>
  openDefault?: (url: string) => void
  copy?: (text: string) => Promise<boolean>
}

const WIDTH = 288

export function LinkChooser({ url, at, onClose, load = loadBrowsers, inCaprock = caprockEntry() !== null, openIn, openDefault = openLink, copy = copyText }: LinkChooserProps) {
  const [entries, setEntries] = useState<ChooserEntry[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    load().then((l) => { if (live) setEntries(chooserEntries(l, inCaprock)) }, () => { if (live) setEntries(chooserEntries(null, inCaprock)) })
    return () => { live = false }
  }, [load, inCaprock])

  const pick = useCallback(async (e: ChooserEntry) => {
    setError('')
    switch (e.kind) {
      case 'system':
        openDefault(url)
        onClose()
        return
      case 'browser':
        if (e.isDefault) { openDefault(url); onClose(); return }
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
      case 'caprock':
        if (openInCaprock(url)) onClose()
        else setError('The in-app browser is off: Settings → In-app browser (beta).')
        return
      case 'copy':
        if (await copy(url)) onClose()
        else setError('The clipboard refused the link.')
        return
    }
  }, [url, onClose, openIn, openDefault, copy])

  return (
    <MenuBox at={at} label="Open link in" width={WIDTH} refocusKey={entries === null} onClose={onClose}>
      <div className="truncate px-2 pb-1 pt-0.5 text-[11px] text-fg-faint" title={url}>{url}</div>
      {entries === null ? (
        <MenuItem icon={<ExternalIcon size={14} />} label="Finding browsers…" disabled onClick={() => {}} />
      ) : entries.map((e) => {
        switch (e.kind) {
          case 'browser':
            return <MenuItem key={`b:${e.id}`} icon={<ExternalIcon size={14} />} label={e.name} hint={e.isDefault ? 'default' : undefined} disabled={busy} onClick={() => void pick(e)} />
          case 'system':
            return <MenuItem key="system" icon={<ExternalIcon size={14} />} label="Default browser" hint="default" disabled={busy} onClick={() => void pick(e)} />
          case 'caprock':
            return <MenuItem key="caprock" icon={<ExternalIcon size={14} />} label="Open in Caprock" hint="tab" disabled={busy} onClick={() => void pick(e)} />
          case 'copy':
            return (
              <div key="copy" className="contents">
                <MenuSeparator />
                <MenuItem icon={<CopyIcon size={14} />} label="Copy link" onClick={() => void pick(e)} />
              </div>
            )
        }
      })}
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
