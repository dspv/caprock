/**
 * One small line icon per Settings section, so the page and its menu read as
 * separate places at a glance (owner, 2026-10-11: "simple icons for the
 * sections"). Picked by the section's title; a title with none draws nothing.
 */

/** A brain in outline: Settings → Second Brain, and Second Brain's own mark
 *  (components/BrainDrop `BrainGlyph`), so the two never drift apart. */
export const BRAIN_PATH = 'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1'
const P: Record<string, string> = {
  play: 'M6 4l14 8-14 8z',
  coffee: 'M4 8h13v5a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6zM17 9h1.5a2.5 2.5 0 0 1 0 5H17M8 2v3M12 2v3',
  bookmark: 'M6 3h12v18l-6-4-6 4z',
  palette: 'M12 3a9 9 0 1 0 0 18c1.7 0 2-1.3 1.3-2.4-.8-1.2 0-2.6 1.4-2.6H17a4 4 0 0 0 4-4c0-5-4-9-9-9zM7.5 11.5h.01M10.5 7.5h.01M15 7.5h.01',
  phone: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  folder: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  key: 'M15 7a4 4 0 1 1-3.9 4.9L3 20v-3h3v-3h3l1.1-1.1A4 4 0 0 1 15 7zM16 8h.01',
  bot: 'M5 9h14v10H5zM12 5v4M9 13h.01M15 13h.01M3 13v3M21 13v3',
  bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  card: 'M3 6h18v12H3zM3 10h18M7 15h3',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  brain: BRAIN_PATH,
  graph: 'M4 7a2 2 0 1 0 4 0a2 2 0 1 0-4 0M16 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M10 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0M8 6.8l8-.6M7 8.8l4 7.4M17 8l-4 8.2',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-5M12 8h.01',
  alert: 'M12 3l10 18H2zM12 10v4M12 18h.01',
  disk: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  pause: 'M8 5v14M16 5v14',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z',
  monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
  refresh: 'M20 11a8 8 0 0 0-14.9-4M4 4v4h4M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4',
}

const BY_TITLE: [RegExp, string][] = [
  [/^new sessions/i, 'play'],
  [/keep awake/i, 'coffee'],
  [/saved prompts/i, 'bookmark'],
  [/project templates/i, 'folder'],
  [/appearance/i, 'palette'],
  [/browser/i, 'globe'],
  [/phone/i, 'phone'],
  [/^computers/i, 'monitor'],
  [/telegram/i, 'send'],
  [/terminal|status line/i, 'terminal'],
  [/editor/i, 'code'],
  [/worktree/i, 'branch'],
  [/folder|projects/i, 'folder'],
  [/subscription/i, 'key'],
  [/custom agents/i, 'bot'],
  [/notification|alert/i, 'bell'],
  [/shortcut|hotkey/i, 'keyboard'],
  [/github/i, 'branch'],
  [/plan|licen/i, 'card'],
  [/^updates/i, 'refresh'],
  [/privacy/i, 'shield'],
  [/second brain/i, 'graph'],
  [/memory/i, 'brain'],
  [/storage|disk|database/i, 'disk'],
  [/stop|window/i, 'pause'],
  [/about/i, 'info'],
  [/not found|not being|late|conflict|needs you/i, 'alert'],
]

export function SectionIcon({ title, size = 15 }: { title: string; size?: number }) {
  const name = BY_TITLE.find(([re]) => re.test(title))?.[1]
  if (!name) return null
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-fg-muted">
      <path d={P[name]} />
    </svg>
  )
}
