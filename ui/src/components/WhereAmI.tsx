/**
 * The way back to the dashboard (owner, 2026-10-16, translated: "there must
 * be a button to return to the dashboard"). On a dashboard page other than
 * Home it is *← Home*, a link to #/ in the same tab; on a page the app shows
 * in a tab of its own (the Pipeline, Mail) it is *← Dashboard*, which brings
 * the Dashboard tab to the front. .ai/04-ui.md § Where am I.
 */
import type { ReactNode } from 'react'

const BACK =
  'inline-flex h-[24px] shrink-0 items-center gap-1 whitespace-nowrap rounded-[6px] border border-border-strong bg-panel-2/60 px-2 text-[12px] font-medium text-fg no-underline hover:no-underline transition-colors hover:border-accent/60 hover:text-accent motion-reduce:transition-none max-sm:h-9 max-sm:px-3 max-sm:text-[13px]'

/** *← Home* on a dashboard page: back to Home, in this tab. */
export function BackHome({ onClick }: { onClick?: () => void }) {
  return (
    <a href="#/" data-back-home aria-label="Back to Home" onClick={onClick} title="Back to the dashboard's Home, in this tab" className={BACK}>
      <span aria-hidden>←</span> Home
    </a>
  )
}

/** *← Dashboard* on a page in a tab of its own: the Dashboard tab, brought to the front. */
export function BackToDashboard({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" data-back-dashboard aria-label="Back to the Dashboard" onClick={onClick} title="Back to the Dashboard tab" className={BACK}>
      <span aria-hidden>←</span> Dashboard
    </button>
  )
}

/**
 * The strip on top of a page the app shows in a tab of its own: the way back
 * and the page's name, since there is no dashboard header there to say it.
 */
export function TabPageBar({ title, onDashboard, children }: { title: string; onDashboard: () => void; children?: ReactNode }) {
  return (
    <div data-tab-page-bar className="sticky top-0 z-10 flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-panel px-3 py-1">
      <BackToDashboard onClick={onDashboard} />
      <span data-page-title className="min-w-0 truncate text-[13px] font-medium text-fg">{title}</span>
      {children}
    </div>
  )
}
