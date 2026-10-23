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
export const DeckIcon = (p: P) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 13h18M7.5 17v-1M10.5 17v-2M13.5 17v-1M16.5 17v-1.5" /></Icon>
/** Four stops on a line, the last a ring: the Pipeline (open → CI → merged → released). */
export const PipelineIcon = (p: P) => <Icon {...p}><path d="M5.5 12h3M11 12h2.5M16 12h1.5" /><circle cx="4" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="9.7" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="14.8" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="19.8" cy="12" r="2.3" /></Icon>
export const SidebarIcon =(p: P) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></Icon>
export const SearchIcon = (p: P) => <Icon {...p}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></Icon>
/** An envelope: Caprock Mail (the sidebar footer, its tab). */
export const MailIcon = (p: P) => <Icon {...p}><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m4 7 8 6 8-6" /></Icon>
export const DashboardIcon = (p: P) => <Icon {...p}><rect x="3" y="3" width="7.5" height="9" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="5" rx="1.5" /><rect x="13.5" y="11" width="7.5" height="10" rx="1.5" /><rect x="3" y="15" width="7.5" height="6" rx="1.5" /></Icon>
export const InboxIcon = (p: P) => <Icon {...p}><path d="M3 13h5l1.5 2.5h5L16 13h5" /><path d="M5.5 5h13L21 13v5.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V13z" /></Icon>
export const SunIcon = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" /></Icon>
export const MoonIcon = (p: P) => <Icon {...p}><path d="M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a6.6 6.6 0 0 0 10 10z" /></Icon>
export const StopIcon = (p: P) => <Icon {...p}><rect x="6" y="6" width="12" height="12" rx="2" /></Icon>
export const FileIcon = (p: P) => <Icon {...p}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h4" /></Icon>
export const PaperclipIcon = (p: P) => <Icon {...p}><path d="m20.5 11.5-8.3 8.3a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" /></Icon>
/** A globe: a browser tab, a web page inside Caprock (ADR-075). */
export const GlobeIcon = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z" /></Icon>
/** An arrow back, for a page's history (its mirror image is forward). */
export const BackIcon = (p: P) => <Icon {...p}><path d="M19 12H5M11 18l-6-6 6-6" /></Icon>
export const ForwardIcon = (p: P) => <Icon {...p}><path d="M5 12h14M13 18l6-6-6-6" /></Icon>
/** A turning arrow: load the page again. */
export const ReloadIcon = (p: P) => <Icon {...p}><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></Icon>
/** A phone upright: a browser tab's phone mode. */
export const PhoneIcon = (p: P) => <Icon {...p}><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></Icon>
/** Two arrows turning: rotate the phone. */
export const RotateIcon = (p: P) => <Icon {...p}><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4" /></Icon>
/** A fingertip: the mouse acts as a finger. */
export const TouchIcon = (p: P) => <Icon {...p}><circle cx="12" cy="9" r="4" /><path d="M12 13v8" /></Icon>
export const ExternalIcon = (p: P) => <Icon {...p}><path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" /></Icon>
/** A megaphone: feedback, set apart from Quick chat's speech bubble. */
// A bug, drawn in amber where it stands for Feedback: the speech bubble was
// one more grey glyph among many (owner, 2026-10-11). Lucide's "bug" shape
// (ISC licence).
export const BugIcon = (p: P) => <Icon {...p}><path d="m8 2 1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3 3 0 1 1 6 0v1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4" /></Icon>
// The feedback form's Idea and Question cards: Lucide's "lightbulb" and
// "circle-help" shapes (ISC licence).
export const LightbulbIcon = (p: P) => <Icon {...p}><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4" /></Icon>
export const QuestionIcon = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" /></Icon>
export const ChatIcon =(p: P) => <Icon {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></Icon>
/** The chat bubble with a plus: start a new chat (the phone home's New chat). */
export const ChatPlusIcon = (p: P) => <Icon {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path d="M12 7v6M9 10h6" /></Icon>
export const MoreIcon = (p: P) => <Icon {...p}><circle cx="5.5" cy="12" r="1.1" fill="currentColor" /><circle cx="12" cy="12" r="1.1" fill="currentColor" /><circle cx="18.5" cy="12" r="1.1" fill="currentColor" /></Icon>
export const TrashIcon = (p: P) => <Icon {...p}><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 12a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12" /></Icon>
// A gear: sliders did not read as Settings (owner, 2026-10-11). Lucide's
// "settings" shape (ISC licence).
export const SettingsIcon = (p: P) => <Icon {...p}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></Icon>
export const EyeIcon = (p: P) => <Icon {...p}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.5" /></Icon>
export const EyeOffIcon = (p: P) => <Icon {...p}><path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4M6.6 6.6C4 8.3 2.5 12 2.5 12S6 18.5 12 18.5c1.9 0 3.5-.6 4.9-1.5M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" /></Icon>
export const PencilIcon = (p: P) => <Icon {...p}><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4" /></Icon>
export const CoffeeIcon =(p: P) => <Icon {...p}><path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM16 10.5h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5V6M12 3.5V6" /></Icon>
export const CaprockMark = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
    <path d="M6 22 L16 8 L26 22 Z" fill="none" stroke="var(--color-accent)" strokeWidth="3" strokeLinejoin="round" />
    <rect x="6" y="22" width="20" height="3" fill="var(--color-accent)" />
  </svg>
)
/** Two sheets, one over the other: copy. */
export const CopyIcon = (p: P) => <Icon {...p}><rect x="8.5" y="8.5" width="12" height="12" rx="2" /><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" /></Icon>
/** An at sign: a file reference an agent reads (`@path`). */
export const AtIcon = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="3.75" /><path d="M15.75 8.5v4.75a2.5 2.5 0 0 0 5 0V12a8.75 8.75 0 1 0-3.5 7" /></Icon>
export const DownloadIcon = (p: P) => <Icon {...p}><path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14" /></Icon>
/** A paper plane: hand something to a session. */
export const SendIcon = (p: P) => <Icon {...p}><path d="M20.5 3.5 10 14M20.5 3.5 14 20.5l-4-6.5-6.5-4z" /></Icon>
/** Lines of differing length: a document's contents. */
export const ListIcon = (p: P) => <Icon {...p}><path d="M4 6h16M7 12h13M10 18h10" /></Icon>
