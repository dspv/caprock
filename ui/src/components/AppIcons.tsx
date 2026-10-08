/**
 * The app workspace's icons: 16px line icons on a 24px grid at a 1.75 stroke,
 * drawn inline like the rest of the dashboard's glyphs (no icon library ships
 * with the UI). Each takes `currentColor`, so state colours come from text.
 */
import type { ReactNode } from 'react'

function Icon({ size = 16, children, className = '' }: { size?: number; children: ReactNode; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 ${className}`}
    >
      {children}
    </svg>
  )
}

type P = { size?: number; className?: string }

export const ChevronIcon = (p: P) => <Icon {...p}><path d="m9 6 6 6-6 6" /></Icon>
export const PlusIcon = (p: P) => <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>
export const CloseIcon = (p: P) => <Icon {...p}><path d="M18 6 6 18M6 6l12 12" /></Icon>
export const TerminalIcon = (p: P) => <Icon {...p}><path d="m5 8 4 4-4 4M12 16h7" /></Icon>
export const SparkIcon = (p: P) => <Icon {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M17.7 6.3l-2.5 2.5M8.8 15.2l-2.5 2.5" /></Icon>
export const FolderIcon = (p: P) => <Icon {...p}><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" /></Icon>
export const FolderPlusIcon = (p: P) => <Icon {...p}><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5zM12 11v5M9.5 13.5h5" /></Icon>
export const BranchIcon = (p: P) => <Icon {...p}><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10M18 9c0 5-6 4-11.2 8.6" /></Icon>
export const PullRequestIcon = (p: P) => <Icon {...p}><circle cx="6" cy="6" r="2.25" /><circle cx="6" cy="18" r="2.25" /><circle cx="18" cy="18" r="2.25" /><path d="M6 8.25v7.5M18 15.75V9.5a3 3 0 0 0-3-3h-3.5M13.5 4l-2.5 2.5 2.5 2.5" /></Icon>
export const InspectorIcon = (p: P) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></Icon>
export const SidebarIcon = (p: P) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></Icon>
export const SearchIcon = (p: P) => <Icon {...p}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></Icon>
export const DashboardIcon = (p: P) => <Icon {...p}><rect x="3" y="3" width="7.5" height="9" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="5" rx="1.5" /><rect x="13.5" y="11" width="7.5" height="10" rx="1.5" /><rect x="3" y="15" width="7.5" height="6" rx="1.5" /></Icon>
export const InboxIcon = (p: P) => <Icon {...p}><path d="M3 13h5l1.5 2.5h5L16 13h5" /><path d="M5.5 5h13L21 13v5.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V13z" /></Icon>
export const SunIcon = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" /></Icon>
export const MoonIcon = (p: P) => <Icon {...p}><path d="M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a6.6 6.6 0 0 0 10 10z" /></Icon>
export const StopIcon = (p: P) => <Icon {...p}><rect x="6" y="6" width="12" height="12" rx="2" /></Icon>
export const ExternalIcon = (p: P) => <Icon {...p}><path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" /></Icon>
export const ChatIcon = (p: P) => <Icon {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></Icon>
export const SettingsIcon = (p: P) => <Icon {...p}><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></Icon>
export const EyeIcon = (p: P) => <Icon {...p}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.5" /></Icon>
export const CaprockMark = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
    <path d="M6 22 L16 8 L26 22 Z" fill="none" stroke="var(--color-accent)" strokeWidth="3" strokeLinejoin="round" />
    <rect x="6" y="22" width="20" height="3" fill="var(--color-accent)" />
  </svg>
)

/**
 * Which agent a session runs, as a two-letter monogram in a hairline square:
 * readable at 14px, and no vendor's logo is borrowed for it.
 */
const AGENT_MONO: Record<string, string> = {
  claude: 'Cl',
  codex: 'Cx',
  opencode: 'Oc',
  gemini: 'Ge',
  deepseek: 'Ds',
  shell: '$',
}

export function AgentGlyph({ agent, shell = false }: { agent?: string; shell?: boolean }) {
  const key = shell ? 'shell' : agent || 'claude'
  return (
    <span
      aria-hidden
      className="mono inline-flex h-[15px] min-w-[17px] shrink-0 items-center justify-center rounded-[4px] border border-[var(--app-hairline-strong)] px-[2px] text-[9px] font-semibold leading-none tracking-[-0.02em] text-fg-muted"
    >
      {AGENT_MONO[key] ?? key.slice(0, 2)}
    </span>
  )
}
