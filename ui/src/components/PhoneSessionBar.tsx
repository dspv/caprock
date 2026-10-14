/**
 * A session's one bar on a phone: back, the title, a dot for its state, and
 * the view switch — 44px, nothing else above the conversation.
 *
 * The owner, 2026-10-14, translated: "When I scroll, a lot of space is taken
 * by the header — project name, work mode etc. — and these tabs Terminal,
 * Chat and so on. It's inconvenient on mobile; I want the header to take
 * minimum space because I need to read this chat." The header was three rows
 * (project and title, the controls, the tabs), 133px of a 390×844 screen,
 * under the remote page's 45px machine bar: the conversation began at 178px. Project, permission mode, model, the controls and
 * the details are one tap away on the title (the sheet); the views are Chat |
 * Terminal and a third segment for the rest.
 *
 * Over the chat (`overlay`) the bar is drawn on top of the conversation, which
 * keeps its first 44px free, and slides away while the reader scrolls down
 * (lib/phone useHideOnScroll): the chat never moves when it does. A strip at
 * the top brings it back.
 */
import { useState, type ReactNode } from 'react'
import { HealthDot } from './ui'
import { machineSwitch } from '@/lib/machineswitch'
import type { Health } from '@/lib/api'

export type PhoneView = 'chat' | 'terminal' | 'changes' | 'timeline' | 'notes'

const LABEL: Record<PhoneView, string> = { chat: 'Chat', terminal: 'Terminal', changes: 'Changes', timeline: 'Timeline', notes: 'Answers' }

/** The bar's height, in px, without the safe area: what a chat keeps free under it. */
export const PHONE_BAR_PX = 44

export function PhoneSessionBar({
  backHref, title, health, alert, views, active, onPick, overlay = false, hidden = false, onReveal, children,
}: {
  backHref: string
  title: string
  /** The session's state, as a dot; none while the figures are a kept copy. */
  health?: Health
  /** Something about the connection worth a glance (a reconnect), as a dot. */
  alert?: { tone: 'warn' | 'danger' | 'muted'; label: string }
  views: PhoneView[]
  active: PhoneView
  onPick: (v: PhoneView) => void
  /** Drawn over the chat rather than above it. */
  overlay?: boolean
  /** Slid away (overlay only). */
  hidden?: boolean
  onReveal?: () => void
  /** The sheet: what the bar does not say. */
  children?: ReactNode
}) {
  const [sheet, setSheet] = useState(false)
  const [menu, setMenu] = useState(false)
  const talk = (['chat', 'terminal'] as PhoneView[]).filter((v) => views.includes(v))
  const rest = (['changes', 'timeline', 'notes'] as PhoneView[]).filter((v) => views.includes(v))
  const restActive = rest.includes(active)
  const away = overlay && hidden && !sheet && !menu
  const seg = (on: boolean) => `h-8 rounded-[7px] px-2.5 text-[13px] ${on ? 'bg-accent font-medium text-panel' : 'text-fg'}`
  return (
    <>
      <div
        data-phone-bar
        data-hidden={away ? '' : undefined}
        className={`${overlay ? 'absolute -left-3 -right-3 top-0' : 'relative -mx-3'} z-30 h-11 overflow-hidden ${away ? 'pointer-events-none' : ''}`}
      >
        <div className={`flex h-11 items-center gap-1 border-b border-border bg-panel pl-0.5 pr-2 transition-transform duration-200 motion-reduce:transition-none ${away ? '-translate-y-full' : ''}`}>
          <a href={backHref} aria-label="Back to Now" className="flex h-11 w-9 shrink-0 items-center justify-center text-[24px] leading-none text-fg-muted no-underline hover:no-underline">
            ‹
          </a>
          <button
            type="button"
            aria-expanded={sheet}
            aria-label={`${title} — session details`}
            onClick={() => { setMenu(false); setSheet((v) => !v) }}
            className="flex h-11 min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <span className="min-w-0 truncate text-[15px] font-medium text-fg">{title}</span>
            {health && <HealthDot health={health} />}
            {alert && <span role="img" aria-label={alert.label} title={alert.label} className={`inline-block h-2 w-2 shrink-0 rounded-full ring-2 ring-offset-1 ring-offset-panel ${alert.tone === 'danger' ? 'bg-danger ring-danger/40' : alert.tone === 'warn' ? 'bg-warn ring-warn/40' : 'bg-fg-faint ring-border'}`} />}
            <span aria-hidden className={`shrink-0 text-[10px] text-fg-faint transition-transform motion-reduce:transition-none ${sheet ? 'rotate-180' : ''}`}>▾</span>
          </button>
          <span role="tablist" aria-label="Session views" className="inline-flex shrink-0 items-center rounded-[9px] bg-panel-2 p-0.5">
            {talk.map((v) => (
              <button key={v} type="button" role="tab" aria-selected={active === v} onClick={() => { setMenu(false); setSheet(false); onPick(v) }} className={seg(active === v)}>
                {LABEL[v]}
              </button>
            ))}
            {rest.length > 0 && (
              <button
                type="button"
                role="tab"
                aria-selected={restActive}
                aria-haspopup="menu"
                aria-expanded={menu}
                aria-label={restActive ? `${LABEL[active]} — other views` : 'Other views'}
                onClick={() => { setSheet(false); setMenu((v) => !v) }}
                className={seg(restActive)}
              >
                {restActive ? <>{LABEL[active]} <span aria-hidden className="text-[10px]">▾</span></> : <span aria-hidden className="tracking-[1px]">···</span>}
              </button>
            )}
          </span>
        </div>
      </div>
      {away && (
        <button
          type="button"
          aria-label="Show the session bar"
          onClick={onReveal}
          className="absolute -left-3 -right-3 top-0 z-30 h-5"
        />
      )}
      {(sheet || menu) && (
        <>
          <div aria-hidden className="fixed inset-0 z-20 bg-black/30" onClick={() => { setSheet(false); setMenu(false) }} />
          {menu ? (
            <div role="menu" aria-label="Other views" className="absolute right-0 top-12 z-40 w-44 overflow-hidden rounded-md border border-border-strong bg-panel py-1 shadow-lg">
              {rest.map((v) => (
                <button
                  key={v}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active === v}
                  onClick={() => { setMenu(false); onPick(v) }}
                  className={`flex min-h-11 w-full items-center px-3 text-left text-[15px] hover:bg-panel-2 ${active === v ? 'font-medium text-accent' : 'text-fg'}`}
                >
                  {LABEL[v]}
                </button>
              ))}
            </div>
          ) : (
            <div data-phone-sheet className="absolute -left-3 -right-3 top-11 z-40 max-h-[75dvh] overflow-y-auto overflow-x-hidden border-b border-border bg-panel px-3 pb-3 pt-2.5 shadow-lg">
              {children}
              <MachineList />
            </div>
          )}
        </>
      )}
    </>
  )
}

/** The paired machines, when there are several (lib/machineswitch). */
function MachineList() {
  const sw = machineSwitch()
  const list = sw?.list() ?? []
  if (!sw || list.length < 2) return null
  return (
    <div className="mt-3 border-t border-border pt-2">
      <div className="pb-1 text-[11px] uppercase tracking-wide text-fg-faint">Computer</div>
      {list.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => { if (!m.current) sw.select(m.id) }}
          aria-current={m.current ? 'true' : undefined}
          className={`flex min-h-11 w-full items-center gap-2 text-left text-[15px] ${m.current ? 'font-medium text-fg' : 'text-fg-muted'}`}
        >
          <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${m.current ? 'bg-ok' : 'bg-transparent'}`} />
          {m.name}
          {!m.paired && <span className="text-[13px] text-warn">not paired</span>}
        </button>
      ))}
    </div>
  )
}
