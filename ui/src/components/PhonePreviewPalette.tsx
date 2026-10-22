/**
 * ⌘K → *Preview on phone…* (lib/devservers): the local dev servers this
 * window has seen in its terminals, newest first, then *Preview a URL on
 * phone…*, which asks for an address. Typing an address into either list
 * previews it at once. Every pick opens the page beside the terminal, in
 * Phone mode with Touch on (AppShell `openPreview`).
 */
import { useMemo } from 'react'
import { agoText } from '@/lib/github'
import { devServers, type DevServer } from '@/lib/devservers'
import { pageUrl } from '@/lib/browsertab'
import { CommandPalette, type PaletteItem } from './CommandPalette'
import { GlobeIcon, PhoneIcon } from './AppIcons'

/** An address as a row names it: host and port, and the path when there is one. */
export function serverLabel(url: string): string {
  try {
    const u = new URL(url)
    const path = `${u.pathname === '/' ? '' : u.pathname}${u.search}`
    return `${u.host}${path}`
  } catch {
    return url
  }
}

export function PhonePreviewPalette({
  mode,
  onPreview,
  onAskUrl,
  onClose,
  sessionName,
  servers,
  now,
}: {
  /** `list`: the servers seen, then *Preview a URL on phone…*; `url`: only the address. */
  mode: 'list' | 'url'
  onPreview: (url: string, sessionId?: string) => void
  /** *Preview a URL on phone…*: the address-only list. */
  onAskUrl: () => void
  onClose: () => void
  /** The name of the session a server was seen in, for its row. */
  sessionName?: (id: string) => string | undefined
  /** Tests: the servers and the time. */
  servers?: readonly DevServer[]
  now?: number
}) {
  const items = useMemo<PaletteItem[]>(() => {
    if (mode === 'url') return []
    const at = now ?? Date.now()
    const rows: PaletteItem[] = (servers ?? devServers()).map((s) => {
      const where = s.sessionId ? sessionName?.(s.sessionId) : undefined
      return {
        id: `pv-${s.url}`,
        group: 'Servers' as const,
        label: serverLabel(s.url),
        detail: `${where ? `seen in ${where}` : 'seen in a terminal'} · ${agoText(s.seen, at)}`,
        icon: <PhoneIcon size={14} />,
        run: () => onPreview(s.url, s.sessionId),
      }
    })
    rows.push({ id: 'pv-url', group: 'Actions', label: 'Preview a URL on phone…', detail: 'type its address', icon: <GlobeIcon size={14} />, run: onAskUrl })
    return rows
  }, [mode, servers, now, sessionName, onPreview, onAskUrl])
  const fallback = (q: string): PaletteItem | undefined => {
    const url = pageUrl(q)
    if (!url) return undefined
    return { id: 'pv-typed', group: 'Actions', label: `Preview ${serverLabel(url)} on phone`, detail: 'beside the terminal, as a phone shows it', icon: <PhoneIcon size={14} />, run: () => onPreview(url) }
  }
  return mode === 'url' ? (
    <CommandPalette
      label="Preview a URL on phone"
      placeholder="An address: localhost:5173, :3000, example.com…"
      empty="Type the address of the page to see on a phone."
      items={items}
      fallback={fallback}
      onClose={onClose}
    />
  ) : (
    <CommandPalette
      label="Preview on phone"
      placeholder="A local server, or type an address…"
      items={items}
      fallback={fallback}
      onClose={onClose}
    />
  )
}
