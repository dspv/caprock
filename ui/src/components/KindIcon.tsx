/**
 * A tool's kind as a line glyph on the app's 24px grid — the cockpit's tool
 * list, its Now line and a subagent's activity feed draw the same ones.
 */
import type { ReactNode } from 'react'
import type { ToolKind } from '@/lib/cockpit'

export type IconKind = ToolKind | 'think' | 'loop' | 'stop' | 'pause'

/** A tool's kind as a line glyph on the app's 24px grid. */
export function KindIcon({ kind, size = 15 }: { kind: IconKind; size?: number }) {
  const path = ICON_PATHS[kind]
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      {path}
    </svg>
  )
}

const ICON_PATHS: Record<IconKind, ReactNode> = {
  edit: <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4" />,
  read: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h4" /></>,
  run: <><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="m7 10 3 2.5L7 15M12.5 15H17" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></>,
  web: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.5 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.5-3.5-8.5s1-5.9 3.5-8.5z" /></>,
  agent: <><circle cx="9" cy="9" r="3" /><circle cx="17" cy="10" r="2.3" /><path d="M3.5 19c.6-3 2.8-5 5.5-5s4.9 2 5.5 5M15 14.6c2.6-.5 4.8 1.2 5.5 4.4" /></>,
  plan: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3.5 6 1.3 1.3L7 5M3.5 12l1.3 1.3L7 11" /><circle cx="5" cy="18" r="1" /></>,
  ask: <><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01" /></>,
  mcp: <><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" /></>,
  other: <><circle cx="12" cy="12" r="2.2" /><circle cx="12" cy="12" r="8" /></>,
  think: <><path d="M12 3.5 13.8 9l5.7.2-4.5 3.4 1.6 5.5L12 14.8 7.4 18l1.6-5.5-4.5-3.4L10.2 9z" /></>,
  loop: <><path d="M4 12a8 8 0 0 1 13.7-5.6L20 9M20 4v5h-5M20 12a8 8 0 0 1-13.7 5.6L4 15M4 20v-5h5" /></>,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
  pause: <path d="M9 6.5v11M15 6.5v11" />,
}
